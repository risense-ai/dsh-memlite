/**
 * DSH 会话历史读取：根目录解析、文件发现、解压、逐行事件解析与会话清单。
 *
 * 落盘格式（实测）：
 *   <sessionsRoot>/<cwd 编码>/<session-id>/session.v4.jsonl.zstd
 * 也兼容更浅的 <sessionsRoot>/<session-id>/session.v4.jsonl.zstd（测试/旧布局），
 * 以及 .gz / 明文 .jsonl 变体——按文件名优先、再按魔数判定压缩格式。
 *
 * 只读：本模块不写任何文件；路径只用于读会话，不写入记忆元数据（见 extract）。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { STORE_PREFIX } from '../rules'
import { parseArgs, flagString } from '../args'
import type {
  DshSession,
  DshSessionEvent,
  DshSessionExplicit,
  DshSessionFile,
  DshSessionOverview,
  DshSessionText,
  SessionListOptions,
} from './types'

/** 会话根目录最大字符数（与 HTTP 层守卫一致）。 */
const MAX_ROOT_CHARS = 1000
/** 一层目录内允许的会话文件名（按优先顺序取第一个存在的）。 */
const SESSION_FILE_NAMES = [
  'session.v4.jsonl.zstd',
  'session.v4.jsonl.gz',
  'session.v4.jsonl',
  'session.jsonl.zstd',
] as const
/** 目录扫描深度：root/<cwd>/<session-id> 为 2 层；更深的目录不再下探。 */
const MAX_SCAN_DEPTH = 2
const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 200

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `~` / `~/` 展开（不解析其他 shell 变量）。 */
function expandHome(input: string): string {
  if (input === '~') return os.homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2))
  return input
}

/**
 * 会话根目录：缺省 `~/.dsh/sessions`；支持 `~` 展开；不做存在性检查
 * （存在性由 listSessionFiles 负责，报错文案是「会话目录不存在」）。
 */
export function resolveSessionsRoot(raw?: unknown): string {
  if (raw === undefined || raw === null) return path.join(os.homedir(), '.dsh', 'sessions')
  if (typeof raw !== 'string') throw new TypeError('会话根目录必须是字符串')
  const input = raw.trim()
  if (input === '' || input === '""' || input === "''") throw new TypeError('会话根目录不能为空串')
  if (input.length > MAX_ROOT_CHARS) throw new TypeError('会话根目录过长')
  if (input.includes('\0')) throw new TypeError('会话根目录含非法字符')
  return path.resolve(expandHome(input))
}

/** 目录内按优先顺序找一个会话文件。 */
function findSessionFileIn(dir: string): { name: string; sizeBytes: number; mtimeMs: number } | undefined {
  for (const name of SESSION_FILE_NAMES) {
    const full = path.join(dir, name)
    let stat: fs.Stats
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    return { name, sizeBytes: stat.size, mtimeMs: stat.mtimeMs }
  }
  return undefined
}

/**
 * 发现会话文件：递归到 root/<cwd>/<session>（depth 2）或 root/<session>（depth 1），
 * 会话 id 取文件所在目录名；按 mtime 降序。
 */
export function listSessionFiles(root: string): DshSessionFile[] {
  let rootStat: fs.Stats
  try {
    rootStat = fs.statSync(root)
  } catch {
    throw new Error(`会话目录不存在: ${root}`)
  }
  if (!rootStat.isDirectory()) throw new Error(`会话目录不存在: ${root}`)

  const files: DshSessionFile[] = []
  const visit = (dir: string, depth: number): void => {
    const direct = findSessionFileIn(dir)
    if (direct !== undefined) {
      files.push({
        path: path.join(dir, direct.name),
        dirName: path.basename(dir),
        sessionId: path.basename(dir),
        sizeBytes: direct.sizeBytes,
        mtimeMs: direct.mtimeMs,
      })
      return
    }
    if (depth >= MAX_SCAN_DEPTH) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      visit(path.join(dir, entry.name), depth + 1)
    }
  }
  visit(root, 0)
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

function startsWithMagic(buffer: Buffer, magic: readonly number[]): boolean {
  if (buffer.length < magic.length) return false
  return magic.every((byte, index) => buffer[index] === byte)
}

/** 机身 zstd 解压函数（Node ≥ 22.15 / 24 才有；取不到时给出可诊断错误）。 */
function zstdDecompress(buffer: Buffer, file: DshSessionFile): Buffer {
  const fn = (zlib as unknown as { zstdDecompressSync?: (value: Buffer) => Buffer }).zstdDecompressSync
  if (typeof fn !== 'function') {
    throw new Error(`当前 Node 不支持 zstd 解压（需要 Node 22.15+）：${file.path}`)
  }
  return fn(buffer)
}

/** 按扩展名 + 魔数解出会话文本：zstd / gzip / 明文。 */
function decodeSessionText(file: DshSessionFile): string {
  const raw = fs.readFileSync(file.path)
  if (startsWithMagic(raw, [0x28, 0xb5, 0x2f, 0xfd])) {
    return zstdDecompress(raw, file).toString('utf8')
  }
  if (startsWithMagic(raw, [0x1f, 0x8b])) {
    return zlib.gunzipSync(raw).toString('utf8')
  }
  // 扩展名 .zstd 但魔数不匹配：仍然当 zstd 试一次，失败回退明文
  if (file.path.endsWith('.zstd')) {
    try {
      return zstdDecompress(raw, file).toString('utf8')
    } catch {
      return raw.toString('utf8')
    }
  }
  return raw.toString('utf8')
}

interface DecodedSession {
  events: DshSessionEvent[]
  /** 非空行数（含坏行）。 */
  lines: number
  badLines: number
}

/** 解压 + 逐行 JSON 解析；坏行只计数不抛错。 */
function decodeSessionFile(file: DshSessionFile): DecodedSession {
  const text = decodeSessionText(file)
  const events: DshSessionEvent[] = []
  let lines = 0
  let badLines = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    lines++
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      badLines++
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      badLines++
      continue
    }
    events.push(parsed as DshSessionEvent)
  }
  return { events, lines, badLines }
}

/** 会话事件流（对外轻量面：只要事件数组；坏行统计见 parseSession）。 */
export function readSessionEvents(file: DshSessionFile): DshSessionEvent[] {
  return decodeSessionFile(file).events
}

/** 消息 content 只取 text 块（丢弃 reasoning / tool-call），多块按行拼接。 */
function messageText(data: Record<string, unknown>): string {
  const content = data['content']
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as { type?: unknown; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') parts.push(b.text)
  }
  return parts.join('\n').trim()
}

/** 首句事实标题（≤ max 字符）：显式标题缺失时用。 */
export function titleFromContent(content: string, max = 60): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  const sentence = flat.match(/^.*?[。！？!?](?:\s|$)/u)?.[0] ?? flat
  return sentence.trim().slice(0, max)
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '')
  }
  if (typeof value === 'string') {
    return value
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '')
  }
  return []
}

/** memlite_remember 工具调用 → 显式记忆（arguments 是 JSON 字符串）。 */
function parseRememberToolCall(
  data: Record<string, unknown>,
  seq: number,
  timeMs: number,
  warnings: string[],
): DshSessionExplicit | undefined {
  const rawArguments = data['arguments']
  if (typeof rawArguments !== 'string' || rawArguments.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    warnings.push(`memlite_remember 参数不是合法 JSON（seq ${seq}）`)
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const args = parsed as Record<string, unknown>
  const content = typeof args['content'] === 'string' ? args['content'].trim() : ''
  if (content === '') return undefined
  const titleRaw = typeof args['title'] === 'string' ? args['title'].trim() : ''
  return {
    seq,
    timeMs,
    title: (titleRaw !== '' ? titleRaw : titleFromContent(content)).slice(0, 60),
    content,
    tags: normalizeTags(args['tags']),
  }
}

/** command/run 的 /memlite-remember → 显式记忆（args 是命令原始输入）。 */
function parseRememberCommand(
  data: Record<string, unknown>,
  seq: number,
  timeMs: number,
): DshSessionExplicit | undefined {
  const rawArgs = typeof data['args'] === 'string' ? data['args'] : ''
  const { rest, flags } = parseArgs(rawArgs)
  const content = rest.trim()
  if (content === '') return undefined
  const title = flagString(flags, 'title')
  return {
    seq,
    timeMs,
    title: (title !== undefined ? title : titleFromContent(content)).slice(0, 60),
    content,
    tags: normalizeTags(flagString(flags, 'tags')),
  }
}

/**
 * 解析一个会话：元数据、人类消息、显式记忆（工具/命令/「记：」消息）、统计与告警。
 * 只认 `data.role==='user' && data.source.kind==='user'` 的人类消息；
 * `agent/inbox/spliced` 是同一批消息的副本，忽略。
 */
export function parseSession(file: DshSessionFile): DshSession {
  const decoded = decodeSessionFile(file)
  const warnings: string[] = []
  let id = file.sessionId
  let cwd = ''
  let createdAt = 0
  let updatedAt = 0
  let firstEventTime = 0
  let title = ''

  const userTexts: DshSessionText[] = []
  const seenMessageKeys = new Set<string>()
  const explicit: DshSessionExplicit[] = []

  for (const [index, event] of decoded.events.entries()) {
    const data = (event.data ?? {}) as Record<string, unknown>
    const timeMs = typeof event.time === 'number' && Number.isFinite(event.time) && event.time > 0 ? event.time : 0
    if (timeMs > 0) {
      if (firstEventTime === 0) firstEventTime = timeMs
      updatedAt = timeMs
    }
    const seq = typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : index

    switch (event.type) {
      case 'session': {
        // 实测 session 事件的元数据在事件顶层（不是 data 里），这里两处都认。
        const raw = event as unknown as Record<string, unknown>
        const sessionId = raw['id'] ?? data['id']
        if (typeof sessionId === 'string' && sessionId.trim() !== '') id = sessionId.trim()
        const sessionCwd = raw['cwd'] ?? data['cwd']
        if (typeof sessionCwd === 'string') cwd = sessionCwd
        const created = raw['createdAt'] ?? data['createdAt']
        if (typeof created === 'number' && Number.isFinite(created) && created > 0) createdAt = created
        break
      }
      case 'session/title': {
        const value = data['title']
        if (typeof value === 'string' && value.trim() !== '') title = value.trim()
        break
      }
      case 'user/message': {
        if (data['role'] !== 'user') break
        const source = data['source'] as { kind?: unknown } | undefined
        if (source?.kind !== 'user') break
        const text = messageText(data)
        if (text === '') break
        const messageId = typeof data['id'] === 'string' ? data['id'] : ''
        const key = messageId !== '' ? `id:${messageId}` : `seq:${seq}`
        if (seenMessageKeys.has(key)) break
        seenMessageKeys.add(key)
        userTexts.push({ seq, messageId, timeMs, text })
        const store = STORE_PREFIX.exec(text)
        if (store !== null) {
          const content = text.slice(store[0].length).trim()
          if (content !== '') {
            explicit.push({ seq, timeMs, title: titleFromContent(content), content, tags: [] })
          }
        }
        break
      }
      case 'tool/call': {
        if (data['name'] !== 'memlite_remember') break
        const candidate = parseRememberToolCall(data, seq, timeMs, warnings)
        if (candidate !== undefined) explicit.push(candidate)
        break
      }
      case 'command/run': {
        if (data['name'] !== 'memlite-remember') break
        const candidate = parseRememberCommand(data, seq, timeMs)
        if (candidate !== undefined) explicit.push(candidate)
        break
      }
      default:
        break
    }
  }

  // 显式记忆会话内去重（同一 title+content 只保留最早一条）
  const seenExplicit = new Set<string>()
  const dedupedExplicit: DshSessionExplicit[] = []
  for (const item of explicit) {
    const key = `${item.title}\n${item.content}`
    if (seenExplicit.has(key)) continue
    seenExplicit.add(key)
    dedupedExplicit.push(item)
  }

  const sessionCreatedAt = createdAt > 0 ? createdAt : firstEventTime > 0 ? firstEventTime : file.mtimeMs
  if (decoded.badLines > 0) warnings.push(`会话 ${file.dirName}: ${decoded.badLines} 行无法解析`)

  return {
    file,
    id,
    cwd,
    createdAt: sessionCreatedAt,
    updatedAt: updatedAt > 0 ? updatedAt : sessionCreatedAt,
    title,
    userTexts,
    explicit: dedupedExplicit,
    stats: { lines: decoded.lines, badLines: decoded.badLines, events: decoded.events.length },
    warnings: warnings.slice(0, 5),
  }
}

/** cwd → 宿主会话目录编码（`/Users/a/b` → `--Users-a-b--`）。 */
export function encodeSessionCwd(cwd: string): string {
  const flat = cwd.replace(/[\\/]+/gu, '/')
  if (flat === '' || flat === '/') return '--'
  return `--${flat.replace(/^\/+|\/+$/gu, '').replace(/\//gu, '-')}--`
}

/** since：ISO 字符串或 epoch（>1e12 当毫秒，否则当秒）→ 毫秒。 */
export function parseSince(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new TypeError('since 必须是 ISO 字符串或 epoch 数字')
    return raw > 1e12 ? Math.round(raw) : Math.round(raw * 1000)
  }
  if (typeof raw !== 'string') throw new TypeError('since 必须是 ISO 字符串或 epoch 数字')
  const input = raw.trim()
  if (input === '') return undefined
  const parsed = Date.parse(input)
  if (Number.isNaN(parsed)) throw new Error(`since 不是合法时间: ${input}`)
  return parsed
}

function matchesCwd(session: DshSession, filter: string): boolean {
  const raw = filter.trim()
  if (raw === '') return true
  const resolved = path.resolve(expandHome(raw))
  if (session.cwd === resolved || session.cwd === raw) return true
  const encoded = encodeSessionCwd(resolved)
  if (session.file.dirName === encoded) return true
  return path.basename(path.dirname(session.file.path)) === encoded
}

function sessionTime(session: DshSession): number {
  return Math.max(session.createdAt, session.updatedAt, session.file.mtimeMs)
}

/**
 * 过滤 + 解析会话（list 与 import 共用）。
 *
 * 过滤顺序：sessionId（全 id / 前缀）→ cwd（精确 / 目录编码）→ since；
 * 再按 createdAt 取最新 limit 个（默认 20，上限 200），最后按 createdAt 升序返回
 * （导入时摘要先写，保证因果父条先落库）。
 */
export function collectSessions(options: SessionListOptions = {}): {
  sessions: DshSession[]
  warnings: string[]
  skipped: number
} {
  const root = resolveSessionsRoot(options.root)
  const files = listSessionFiles(root)
  const since = parseSince(options.since)
  const limitRaw = options.limit
  const limit =
    typeof limitRaw === 'number' && Number.isSafeInteger(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, MAX_LIST_LIMIT)
      : DEFAULT_LIST_LIMIT
  const sessionFilter = options.sessionId?.trim() ?? ''
  const cwdFilter = options.cwd?.trim() ?? ''

  const warnings: string[] = []
  let skipped = 0
  const sessions: DshSession[] = []
  for (const file of files) {
    let session: DshSession
    try {
      session = parseSession(file)
    } catch (error) {
      skipped++
      warnings.push(`会话 ${file.dirName}: 读取失败（${errorText(error)}）`)
      continue
    }
    if (sessionFilter !== '' && session.id !== sessionFilter && !session.id.startsWith(sessionFilter)) continue
    if (cwdFilter !== '' && !matchesCwd(session, cwdFilter)) continue
    if (since !== undefined && sessionTime(session) < since) continue
    sessions.push(session)
  }
  sessions.sort((a, b) => b.createdAt - a.createdAt)
  const limited = sessions.slice(0, limit)
  limited.sort((a, b) => a.createdAt - b.createdAt)
  return { sessions: limited, warnings, skipped }
}

/** 会话清单（只读，不写库）：`memlite-session-list` 与配置页「列出会话」用。 */
export function listDshSessions(options: SessionListOptions = {}): DshSessionOverview[] {
  const { sessions } = collectSessions(options)
  return sessions.map((session) => ({
    sessionId: session.id,
    dirName: session.file.dirName,
    title: session.title,
    cwd: session.cwd,
    createdAt: session.createdAt,
    messages: session.userTexts.length,
    explicit: session.explicit.length,
    sizeBytes: session.file.sizeBytes,
    mtimeMs: session.file.mtimeMs,
  }))
}
