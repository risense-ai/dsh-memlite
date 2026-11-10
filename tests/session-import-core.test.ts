/** DSH 会话历史导入核心：读取/解析/抽取/去重写入/报告（真 Memlite，临时会话目录）。 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { gzipSync, zstdCompressSync } from 'node:zlib'
import { Memlite, parentId as recordParentId } from '@rsrsai/memlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extractCandidates,
  formatSessionImportReport,
  formatSessionList,
  importDshSessionsWith,
  listDshSessions,
  listSessionFiles,
  parseSession,
  readSessionEvents,
  resolveSessionsRoot,
} from '../src/session-import'

const roots: string[] = []
const mems: Memlite[] = []

afterEach(() => {
  for (const mem of mems.splice(0)) mem.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function openMem(): Memlite {
  const mem = new Memlite({ dataDir: tempDir('memlite-session-core-') }, {})
  mem.open()
  mems.push(mem)
  return mem
}

interface MessageFixture {
  text: string
  id?: string
  role?: string
  sourceKind?: string
}

interface FixtureOptions {
  root: string
  /** 文件所在目录（相对 root；缺省直接用 sessionId 一层）。真实 DSH 是 `<cwd 编码>/<session id>`。 */
  dir?: string
  sessionId?: string
  cwd?: string
  titles?: string[]
  createdAt?: number
  messages?: MessageFixture[]
  toolCalls?: Array<Record<string, unknown>>
  commands?: Array<{ name: string; args: string }>
  /** 追加一行坏 JSON。 */
  badLine?: boolean
  compress?: 'zstd' | 'gzip' | 'plain'
  /** 直接写入的原始字节（制造坏文件）。 */
  rawBytes?: Buffer
}

const SESSION_ID = 'session-11111111-2222-3333-4444-555555555555'
const CREATED_AT = Date.UTC(2026, 0, 2, 3, 4, 5)

const DEFAULT_MESSAGES: MessageFixture[] = [
  { text: '帮我排查 nginx 504 上游超时' },
  { text: '记：项目约定：所有服务必须走统一网关' },
  { text: '以后部署必须先跑统一网关的健康检查' },
]

function defaultToolCall(): Record<string, unknown> {
  return {
    name: 'memlite_remember',
    arguments: JSON.stringify({ content: '显式记忆正文：网关统一', title: '显式标题', tags: ['gateway'] }),
  }
}

/** 造真实形状的会话文件；返回会话目录绝对路径。 */
function writeFixture(options: FixtureOptions): string {
  const sessionId = options.sessionId ?? SESSION_ID
  const cwd = options.cwd ?? '/work/alpha'
  const createdAt = options.createdAt ?? CREATED_AT
  const dir = path.join(options.root, options.dir ?? sessionId)
  fs.mkdirSync(dir, { recursive: true })

  if (options.rawBytes !== undefined) {
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), options.rawBytes)
    return dir
  }

  const events: unknown[] = [{ type: 'session', version: 4, id: sessionId, createdAt, cwd }]
  for (const title of options.titles ?? []) events.push({ type: 'session/title', data: { title } })
  let seq = 1
  for (const [index, message] of (options.messages ?? DEFAULT_MESSAGES).entries()) {
    events.push({
      type: 'user/message',
      seq: seq++,
      time: createdAt + (index + 1) * 1000,
      data: {
        role: message.role ?? 'user',
        source: { kind: message.sourceKind ?? 'user' },
        id: message.id ?? `message-${index + 1}`,
        content: [{ type: 'text', text: message.text }],
      },
    })
  }
  for (const toolCall of options.toolCalls ?? [defaultToolCall()]) {
    events.push({ type: 'tool/call', seq: seq++, time: createdAt + 8000, data: toolCall })
  }
  for (const command of options.commands ?? []) {
    events.push({ type: 'command/run', seq: seq++, time: createdAt + 9000, data: command })
  }
  events.push({ type: 'assistant/message', seq: seq++, time: createdAt + 10000, data: { role: 'assistant' } })

  const body =
    events.map((event) => JSON.stringify(event)).join('\n') + '\n' + (options.badLine === true ? '{not json}\n' : '')
  const compress = options.compress ?? 'zstd'
  const encoded =
    compress === 'zstd'
      ? zstdCompressSync(Buffer.from(body, 'utf8'))
      : compress === 'gzip'
        ? gzipSync(Buffer.from(body, 'utf8'))
        : Buffer.from(body, 'utf8')
  const name =
    compress === 'zstd'
      ? 'session.v4.jsonl.zstd'
      : compress === 'gzip'
        ? 'session.v4.jsonl.gz'
        : 'session.v4.jsonl'
  fs.writeFileSync(path.join(dir, name), encoded)
  return dir
}

function realDir(cwd: string): string {
  return `--${cwd.replace(/^\/+/u, '').replace(/\//gu, '-')}--`
}

describe('resolveSessionsRoot', () => {
  it('缺省 ~/.dsh/sessions，支持 ~ 展开，拒绝空串/非字符串/过长', () => {
    const homeRoot = path.join(os.homedir(), '.dsh', 'sessions')
    expect(resolveSessionsRoot()).toBe(homeRoot)
    expect(resolveSessionsRoot('~/.dsh/sessions')).toBe(homeRoot)
    expect(resolveSessionsRoot('~/x/../.dsh/sessions')).toBe(homeRoot)
    expect(() => resolveSessionsRoot('   ')).toThrow('不能为空串')
    expect(() => resolveSessionsRoot(42)).toThrow('必须是字符串')
    expect(() => resolveSessionsRoot(`${'x'.repeat(1001)}`)).toThrow('过长')
  })
})

describe('listSessionFiles', () => {
  it('目录不存在抛「会话目录不存在」', () => {
    expect(() => listSessionFiles(path.join(tempDir('memlite-missing-'), 'nope'))).toThrow('会话目录不存在')
  })

  it('同时发现一层与真实两层布局，跳过非会话目录', () => {
    const root = tempDir('memlite-session-structure-')
    writeFixture({ root })
    writeFixture({ root, sessionId: 'session-bbbb', dir: path.join(realDir('/work/beta'), 'session-bbbb') })
    fs.mkdirSync(path.join(root, 'not-a-session', 'deeper'), { recursive: true })
    const files = listSessionFiles(root)
    expect(files).toHaveLength(2)
    expect(files.map((file) => file.sessionId).sort()).toEqual([SESSION_ID, 'session-bbbb'].sort())
  })

  it('空目录返回空列表', () => {
    expect(listSessionFiles(tempDir('memlite-session-empty-'))).toEqual([])
  })
})

describe('parseSession / readSessionEvents', () => {
  it('zstd / gzip / 明文三种封装解析出同样的事件数', () => {
    for (const compress of ['zstd', 'gzip', 'plain'] as const) {
      const root = tempDir(`memlite-session-${compress}-`)
      writeFixture({ root, compress })
      const file = listSessionFiles(root)[0]!
      const events = readSessionEvents(file)
      expect(events.length, compress).toBe(6) // session + 3 user/message + tool/call + assistant
      const session = parseSession(file)
      expect(session.stats.events, compress).toBe(events.length)
      expect(session.stats.badLines, compress).toBe(0)
      expect(session.cwd, compress).toBe('/work/alpha')
      expect(session.id, compress).toBe(SESSION_ID)
      expect(session.createdAt, compress).toBe(CREATED_AT)
    }
  })

  it('标题取最后一次非空；会话元数据读事件顶层（真实格式）', () => {
    const root = tempDir('memlite-session-title-')
    writeFixture({ root, titles: ['旧标题', 'Nginx 排查'] })
    const session = parseSession(listSessionFiles(root)[0]!)
    expect(session.title).toBe('Nginx 排查')
    expect(session.userTexts).toHaveLength(3)
  })

  it('人类消息只认 role=user + source.kind=user，并按 message id 去重', () => {
    const root = tempDir('memlite-session-messages-')
    writeFixture({
      root,
      messages: [
        { text: '真正的人类消息', id: 'm-1' },
        { text: '真正的人类消息', id: 'm-1' }, // 同一 id 的重复面
        { text: 'assistant 伪装', role: 'assistant' },
        { text: '系统来源', sourceKind: 'system' },
      ],
    })
    const session = parseSession(listSessionFiles(root)[0]!)
    expect(session.userTexts.map((item) => item.text)).toEqual(['真正的人类消息'])
  })

  it('显式记忆三路来源：工具、命令、「记：」消息；会话内去重', () => {
    const root = tempDir('memlite-session-explicit-')
    writeFixture({
      root,
      commands: [{ name: 'memlite-remember', args: '命令显式内容 --title 命令标题 --tags a,b' }],
      messages: [...DEFAULT_MESSAGES, { text: '记：项目约定：所有服务必须走统一网关' }],
    })
    const session = parseSession(listSessionFiles(root)[0]!)
    expect(session.explicit).toHaveLength(3) // 工具 + 命令 + 记： 消息（重复内容已去重）
    const fromTool = session.explicit.find((item) => item.title === '显式标题')
    expect(fromTool?.content).toBe('显式记忆正文：网关统一')
    expect(fromTool?.tags).toEqual(['gateway'])
    const fromCommand = session.explicit.find((item) => item.title === '命令标题')
    expect(fromCommand?.content).toBe('命令显式内容')
    expect(fromCommand?.tags).toEqual(['a', 'b'])
    const fromMessage = session.explicit.find((item) => item.content === '项目约定：所有服务必须走统一网关')
    expect(fromMessage).toBeDefined()
  })

  it('坏行只计数不抛错，并进 warnings', () => {
    const root = tempDir('memlite-session-badline-')
    writeFixture({ root, badLine: true })
    const session = parseSession(listSessionFiles(root)[0]!)
    expect(session.stats.badLines).toBe(1)
    expect(session.stats.lines).toBe(session.stats.events + 1)
    expect(session.warnings.join('\n')).toContain('无法解析')
  })
})

describe('extractCandidates', () => {
  function parsedSession(): ReturnType<typeof parseSession> {
    const root = tempDir('memlite-session-extract-')
    writeFixture({ root, titles: ['Nginx 排查'] })
    return parseSession(listSessionFiles(root)[0]!)
  }

  it('默认抽取摘要 + 显式；摘要为第一条且模板固定', () => {
    const candidates = extractCandidates(parsedSession(), { explicit: true, summary: true, facts: false })
    expect(candidates).toHaveLength(3)
    const summary = candidates[0]!
    expect(summary.kind).toBe('session-summary')
    expect(summary.title).toBe('DSH 会话：Nginx 排查')
    expect(summary.project).toBe('alpha')
    expect(summary.content).toContain('【前因】DSH 历史会话：alpha，2026-01-02，3 条人类消息。')
    expect(summary.content).toContain('【行为】主要请求：')
    expect(summary.content).toContain('【后果】会话标题「Nginx 排查」；source=dsh-session（session-1111）。')
    expect(summary.tags).toEqual(['dsh-session', 'session'])

    const explicit = candidates.filter((candidate) => candidate.kind === 'explicit')
    expect(explicit).toHaveLength(2)
    expect(explicit.some((candidate) => candidate.title === '显式标题')).toBe(true)
    expect(explicit.some((candidate) => candidate.content === '项目约定：所有服务必须走统一网关')).toBe(true)
  })

  it('extra 元数据齐全，且不含绝对路径', () => {
    const candidates = extractCandidates(parsedSession(), { explicit: true, summary: true, facts: true })
    for (const candidate of candidates) {
      expect(candidate.extra['source']).toBe('dsh-session')
      expect(String(candidate.extra['dsh_anchor'])).toBe(candidate.anchor)
      expect(candidate.anchor).toMatch(new RegExp(`^dsh:${SESSION_ID}:`))
      expect(candidate.extra['dsh_session_id']).toBe(SESSION_ID)
      expect(String(candidate.extra['source_hash'])).toMatch(/^[0-9a-f]{40}$/)
      expect(candidate.extra['dsh_project']).toBe('alpha')
      expect(JSON.stringify(candidate.extra)).not.toContain('/work/alpha')
    }
    const summary = candidates.find((candidate) => candidate.kind === 'session-summary')!
    expect(summary.extra['dsh_kind']).toBe('session-summary')
    expect(summary.extra['dsh_messages']).toBe(3)
    expect(summary.ts).toBe(Math.floor(CREATED_AT / 1000))
  })

  it('用户事实默认关闭；--facts 只收约定式句子', () => {
    const session = parsedSession()
    expect(extractCandidates(session, { explicit: true, summary: true, facts: false })).toHaveLength(3)
    const withFacts = extractCandidates(session, { explicit: true, summary: true, facts: true })
    expect(withFacts).toHaveLength(4)
    const fact = withFacts[3]!
    expect(fact.kind).toBe('user-fact')
    expect(fact.content).toBe('以后部署必须先跑统一网关的健康检查')
    expect(fact.tags).toEqual(['dsh-session', 'user-fact'])
  })

  it('三个开关独立：explicit=false 只剩摘要，summary=false 只剩显式', () => {
    const session = parsedSession()
    expect(extractCandidates(session, { explicit: false, summary: true, facts: false })).toHaveLength(1)
    expect(extractCandidates(session, { explicit: true, summary: false, facts: false })).toHaveLength(2)
  })

  it('无人类消息的会话不产生摘要', () => {
    const root = tempDir('memlite-session-empty-msg-')
    writeFixture({ root, messages: [], toolCalls: [] })
    const session = parseSession(listSessionFiles(root)[0]!)
    expect(extractCandidates(session, { explicit: true, summary: true, facts: true })).toEqual([])
  })
})

describe('importDshSessionsWith', () => {
  it('dry-run 只报告、不写库', async () => {
    const mem = openMem()
    const root = tempDir('memlite-session-dry-')
    writeFixture({ root })
    const report = await importDshSessionsWith(mem, { root, dryRun: true })
    expect(report.sessionsScanned).toBe(1)
    expect(report.candidates).toBe(3)
    expect(report.wouldCreate).toBe(3)
    expect(report.wouldUpdate).toBe(0)
    expect(report.created).toEqual([])
    expect(mem.snapshot().count()).toBe(0)
  })

  it('正式导入：摘要为根，显式记忆挂在摘要之下且可召回', async () => {
    const mem = openMem()
    const root = tempDir('memlite-session-import-')
    writeFixture({ root, titles: ['Nginx 排查'] })
    const report = await importDshSessionsWith(mem, { root })
    expect(report.created).toHaveLength(3)
    expect(report.wouldCreate).toBe(3)

    const records = mem.snapshot().all()
    const summary = records.find((record) => record.extra['dsh_kind'] === 'session-summary')
    expect(summary).toBeDefined()
    const explicit = records.filter((record) => record.extra['dsh_kind'] === 'explicit')
    expect(explicit).toHaveLength(2)
    for (const record of explicit) {
      expect(recordParentId(record)).toBe(summary!.id)
      expect(record.extra['source']).toBe('dsh-session')
    }
    expect(recordParentId(summary!)).toBe('')
    expect(summary!.ts).toBe(Math.floor(CREATED_AT / 1000))

    const recalled = await mem.recall('统一网关', { limit: 5 })
    expect(recalled.hits.length).toBeGreaterThan(0)
  })

  it('二次导入幂等：全部 unchanged', async () => {
    const mem = openMem()
    const root = tempDir('memlite-session-idempotent-')
    writeFixture({ root })
    await importDshSessionsWith(mem, { root })
    const second = await importDshSessionsWith(mem, { root })
    expect(second.created).toEqual([])
    expect(second.updated).toEqual([])
    expect(second.unchanged).toBe(3)
    expect(mem.snapshot().count()).toBe(3)
  })

  it('内容变化走 update 而非重复新建', async () => {
    const mem = openMem()
    const root = tempDir('memlite-session-update-')
    writeFixture({
      root,
      toolCalls: [
        {
          name: 'memlite_remember',
          arguments: JSON.stringify({ content: '显式记忆正文：v1', title: '显式标题' }),
        },
      ],
    })
    await importDshSessionsWith(mem, { root })
    const dir = path.join(root, SESSION_ID)
    fs.rmSync(dir, { recursive: true, force: true })
    writeFixture({
      root,
      toolCalls: [
        {
          name: 'memlite_remember',
          arguments: JSON.stringify({ content: '显式记忆正文：v2', title: '显式标题' }),
        },
      ],
    })
    const second = await importDshSessionsWith(mem, { root })
    expect(second.updated).toHaveLength(1)
    expect(second.created).toEqual([])
    const record = mem.snapshot().all().find((item) => item.title === '显式标题')
    expect(record?.content).toBe('显式记忆正文：v2')
  })

  it('抽取开关、过滤与进度回调', async () => {
    const mem = openMem()
    const root = tempDir('memlite-session-flags-')
    writeFixture({ root })
    const seen: number[] = []
    const onlySummary = await importDshSessionsWith(mem, {
      root,
      dryRun: true,
      explicit: false,
      onProgress: (done) => seen.push(done),
    })
    expect(onlySummary.candidates).toBe(1)
    expect(seen).toEqual([1])

    const onlyExplicit = await importDshSessionsWith(mem, { root, dryRun: true, summary: false })
    expect(onlyExplicit.candidates).toBe(2)

    const withFacts = await importDshSessionsWith(mem, { root, dryRun: true, facts: true })
    expect(withFacts.candidates).toBe(4)
  })

  it('过滤：sessionId 前缀、cwd、since、limit（真实两层布局）', async () => {
    const mem = openMem()
    const root = tempDir('memlite-session-filter-')
    writeFixture({
      root,
      sessionId: 'session-aaaaaaaa-0000-0000-0000-000000000001',
      dir: path.join(realDir('/work/alpha'), 'session-aaaaaaaa-0000-0000-0000-000000000001'),
      createdAt: Date.UTC(2026, 0, 2),
    })
    writeFixture({
      root,
      sessionId: 'session-bbbbbbbb-0000-0000-0000-000000000002',
      dir: path.join(realDir('/work/beta'), 'session-bbbbbbbb-0000-0000-0000-000000000002'),
      createdAt: Date.UTC(2026, 1, 2),
      cwd: '/work/beta',
      titles: ['Beta 会话'],
    })

    const all = await importDshSessionsWith(mem, { root, dryRun: true })
    expect(all.sessionsScanned).toBe(2)

    const byId = await importDshSessionsWith(mem, { root, dryRun: true, sessionId: 'session-aaaaaaaa' })
    expect(byId.sessionsScanned).toBe(1)

    const byCwd = await importDshSessionsWith(mem, { root, dryRun: true, cwd: '/work/alpha' })
    expect(byCwd.sessionsScanned).toBe(1)

    const noCwd = await importDshSessionsWith(mem, { root, dryRun: true, cwd: '/work/gamma' })
    expect(noCwd.sessionsScanned).toBe(0)

    const sinceFuture = await importDshSessionsWith(mem, { root, dryRun: true, since: '2099-01-01' })
    expect(sinceFuture.sessionsScanned).toBe(0)

    const limited = await importDshSessionsWith(mem, { root, dryRun: true, limit: 1 })
    expect(limited.sessionsScanned).toBe(1)
  })

  it('敏感内容被敏感闸跳过（dry-run 也如实报告；摘要摘录到敏感句同样跳过）', async () => {
    const mem = openMem()
    const root = tempDir('memlite-session-sensitive-')
    writeFixture({ root, messages: [{ text: '记：数据库连接串 password=abc123456 不要外泄' }], toolCalls: [] })
    const preview = await importDshSessionsWith(mem, { root, dryRun: true })
    // 摘要会摘录这条人类消息，因此摘要与显式记忆都命中敏感闸
    expect(preview.skipped).toHaveLength(2)
    expect(preview.skipped.every((item) => item.reason === 'sensitive')).toBe(true)
    expect(preview.wouldCreate).toBe(0)
    const report = await importDshSessionsWith(mem, { root })
    expect(report.skipped).toHaveLength(2)
    expect(report.created).toHaveLength(0)
    expect(mem.snapshot().count()).toBe(0)
  })

  it('坏会话文件被跳过，不影响其它会话', async () => {
    const mem = openMem()
    const root = tempDir('memlite-session-corrupt-')
    writeFixture({ root })
    writeFixture({
      root,
      sessionId: 'session-cccccccc-0000-0000-0000-000000000003',
      rawBytes: Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('garbage')]),
    })
    const report = await importDshSessionsWith(mem, { root })
    expect(report.sessionsSkipped).toBe(1)
    expect(report.warnings.join('\n')).toContain('读取失败')
    expect(report.sessionsScanned).toBe(1)
    expect(report.created).toHaveLength(3)
  })

  it('listDshSessions 返回标题/项目/计数（只读）', () => {
    const root = tempDir('memlite-session-list-')
    writeFixture({ root, titles: ['Nginx 排查'] })
    const overviews = listDshSessions({ root })
    expect(overviews).toHaveLength(1)
    const overview = overviews[0]!
    expect(overview.title).toBe('Nginx 排查')
    expect(overview.cwd).toBe('/work/alpha')
    expect(overview.messages).toBe(3)
    expect(overview.explicit).toBe(2)
    expect(overview.sizeBytes).toBeGreaterThan(0)
  })
})

describe('报告文本', () => {
  it('import 报告：dry-run 与正式两套文案', async () => {
    const mem = openMem()
    const root = tempDir('memlite-session-report-')
    writeFixture({ root })
    const dry = await importDshSessionsWith(mem, { root, dryRun: true })
    const dryText = formatSessionImportReport(dry, true)
    expect(dryText.split('\n')[0]).toContain('[dry-run] 扫描 1 个会话（跳过 0）')
    expect(dryText).toContain('候选 3 条 → 将新建 3，将更新 0，不变 0，跳过 0')
    expect(dryText).toContain('去掉 --dry-run')

    const real = await importDshSessionsWith(mem, { root })
    const realText = formatSessionImportReport(real, false)
    expect(realText.split('\n')[0]).not.toContain('[dry-run]')
    expect(realText).toContain('新建 3，更新 0，不变 0，跳过 0')
    expect(realText).not.toContain('去掉 --dry-run')
  })

  it('import 报告：跳过明细与警告折叠', async () => {
    const mem = openMem()
    const root = tempDir('memlite-session-report-warn-')
    writeFixture({ root, badLine: true })
    const report = await importDshSessionsWith(mem, { root, dryRun: true })
    const text = formatSessionImportReport(report, true)
    expect(text).toContain('警告 1 条：')
    expect(text).toContain('无法解析')
  })

  it('list 报告：空列表、行格式与 30 行折叠', () => {
    expect(formatSessionList([], '/root')).toBe('未发现会话（根：/root）。')
    const overview = {
      sessionId: 'session-1111',
      dirName: 'session-1111',
      title: 'Nginx 排查',
      cwd: '/work/alpha',
      createdAt: CREATED_AT,
      messages: 3,
      explicit: 2,
      sizeBytes: 10,
      mtimeMs: CREATED_AT,
    }
    const text = formatSessionList([overview], '/root')
    expect(text).toContain('发现 1 个会话（根：/root）：')
    expect(text).toContain('alpha')
    expect(text).toContain('3 条人类消息 / 2 条显式记忆')
    expect(text).toContain('Nginx 排查')
    const many = Array.from({ length: 31 }, (_, index) => ({ ...overview, sessionId: `session-${index}` }))
    expect(formatSessionList(many, '/root')).toContain('…另 1 个会话')
  })
})
