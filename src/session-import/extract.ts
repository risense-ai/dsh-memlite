/**
 * DSH 会话 → memlite 候选记忆。
 *
 * 三路候选（契约 docs/session-import-contract.md 第六节）：
 * - session-summary：每个至少有 1 条人类消息的会话一条，作为该会话其它候选的因果父；
 * - explicit：会话里真的存过的内容（memlite_remember 工具、/memlite-remember 命令、「记：」消息）；
 * - user-fact（默认关）：人类消息里像可复用约定的句子，供用户显式开启后复核。
 *
 * 记忆元数据只放 source/dsh_anchor/dsh_session_id/dsh_kind/source_hash/dsh_project，
 * **不放绝对路径**（隐私边界与 Obsidian 桥一致：只回本地可行动信息）。
 */
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { STORE_PREFIX } from '../rules'
import { titleFromContent } from './reader'
import { formatDate, formatDateTime } from './report'
import type { DshSession, SessionCandidate } from './types'

/** 用户事实启发式：出现这些词的人类消息才可能进候选（默认关闭，宁缺勿滥）。 */
const FACT_PATTERN =
  /(决定|约定|以后|默认|必须|不要|别用|禁止|务必|记住|注意|要求|偏好|统一|只用|改用|优先|不能|应该)/u
/** 用户事实长度边界：太短没信息量，太长多半是任务描述而不是约定。 */
const FACT_MIN_CHARS = 10
const FACT_MAX_CHARS = 800
/** 摘要里摘录的人类消息条数。 */
const SUMMARY_REQUESTS = 8
const SUMMARY_EXCERPT_CHARS = 80
const MAX_TITLE_CHARS = 60

export interface ExtractOptions {
  explicit: boolean
  summary: boolean
  facts: boolean
  /** 覆盖 project；缺省由 cwd basename 推导。 */
  project?: string
}

function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

function projectOf(session: DshSession, override?: string): string {
  const explicit = override?.trim() ?? ''
  if (explicit !== '') return explicit
  const cwd = session.cwd.trim()
  if (cwd === '') return ''
  return path.basename(cwd)
}

/** 候选通用 extra：稳定锚 + 会话来源 + 内容 hash（去重主键）。 */
function buildExtra(params: {
  anchor: string
  sessionId: string
  kind: SessionCandidate['kind']
  title: string
  content: string
  project: string
  seq?: number
  messages?: number
}): Record<string, unknown> {
  const extra: Record<string, unknown> = {
    source: 'dsh-session',
    dsh_anchor: params.anchor,
    dsh_session_id: params.sessionId,
    dsh_kind: params.kind,
    source_hash: sha1(`${params.title}\n${params.content}`),
    dsh_project: params.project,
  }
  if (params.seq !== undefined) extra['dsh_event_seq'] = params.seq
  if (params.messages !== undefined) extra['dsh_messages'] = params.messages
  return extra
}

/** 秒级时间：事件时间优先，缺失回退会话创建时间，再回退文件 mtime。 */
function tsOf(timeMs: number, session: DshSession): number {
  const fallback = session.createdAt > 0 ? session.createdAt : session.file.mtimeMs
  const source = timeMs > 0 ? timeMs : fallback
  return Math.floor(source / 1000)
}

/** 人类消息摘要摘录：单行化 + 截断。 */
function excerpt(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, SUMMARY_EXCERPT_CHARS)
}

function summaryCandidate(session: DshSession, project: string, ts: number): SessionCandidate {
  const anchor = `dsh:${session.id}:summary`
  const count = session.userTexts.length
  const shortId = session.id.slice(0, 12)
  const contentLines = [
    `【前因】DSH 历史会话：${project !== '' ? project : '未标注项目'}，${formatDate(session.createdAt)}，${count} 条人类消息。`,
    '【行为】主要请求：',
  ]
  for (const text of session.userTexts.slice(0, SUMMARY_REQUESTS)) {
    contentLines.push(`- ${excerpt(text.text)}`)
  }
  if (count > SUMMARY_REQUESTS) contentLines.push(`- …另 ${count - SUMMARY_REQUESTS} 条`)
  contentLines.push(
    session.title !== ''
      ? `【后果】会话标题「${session.title}」；source=dsh-session（${shortId}）。`
      : `【后果】source=dsh-session（${shortId}）。`,
  )
  const content = contentLines.join('\n')
  const title =
    session.title !== ''
      ? titleFromContent(`DSH 会话：${session.title}`, MAX_TITLE_CHARS)
      : titleFromContent(
          `DSH 会话 ${formatDateTime(session.createdAt)}（${project !== '' ? project : '未标注项目'}）`,
          MAX_TITLE_CHARS,
        )
  return {
    kind: 'session-summary',
    anchor,
    title,
    content,
    tags: ['dsh-session', 'session'],
    project,
    ts,
    extra: buildExtra({
      anchor,
      sessionId: session.id,
      kind: 'session-summary',
      title,
      content,
      project,
      messages: count,
    }),
  }
}

function explicitCandidates(session: DshSession, project: string): SessionCandidate[] {
  const out: SessionCandidate[] = []
  const seen = new Set<string>()
  for (const [index, item] of session.explicit.entries()) {
    const content = item.content.trim()
    if (content === '') continue
    const key = `${item.title}\n${content}`
    if (seen.has(key)) continue
    seen.add(key)
    const anchorKey = Number.isFinite(item.seq) ? String(item.seq) : `i${index}`
    const anchor = `dsh:${session.id}:explicit:${anchorKey}`
    const title = (item.title.trim() !== '' ? item.title.trim() : titleFromContent(content)).slice(0, MAX_TITLE_CHARS)
    const tags = ['dsh-session', 'explicit']
    for (const tag of item.tags) if (!tags.includes(tag)) tags.push(tag)
    out.push({
      kind: 'explicit',
      anchor,
      title,
      content,
      tags,
      project,
      ts: tsOf(item.timeMs, session),
      extra: buildExtra({
        anchor,
        sessionId: session.id,
        kind: 'explicit',
        title,
        content,
        project,
        ...(Number.isFinite(item.seq) ? { seq: item.seq } : {}),
      }),
    })
  }
  return out
}

function factCandidates(session: DshSession, project: string): SessionCandidate[] {
  const out: SessionCandidate[] = []
  const seen = new Set<string>()
  for (const [index, message] of session.userTexts.entries()) {
    const text = message.text.trim()
    if (text.length < FACT_MIN_CHARS || text.length > FACT_MAX_CHARS) continue
    if (text.startsWith('/')) continue
    if (STORE_PREFIX.test(text)) continue
    if (/[？?]$/u.test(text)) continue
    if (!FACT_PATTERN.test(text)) continue
    if (seen.has(text)) continue
    seen.add(text)
    const anchorKey = message.messageId !== '' ? message.messageId : String(message.seq)
    const anchor = `dsh:${session.id}:user-fact:${anchorKey}`
    const title = titleFromContent(text, MAX_TITLE_CHARS)
    out.push({
      kind: 'user-fact',
      anchor,
      title,
      content: text,
      tags: ['dsh-session', 'user-fact'],
      project,
      ts: tsOf(message.timeMs, session),
      extra: buildExtra({
        anchor,
        sessionId: session.id,
        kind: 'user-fact',
        title,
        content: text,
        project,
        seq: message.seq,
      }),
    })
  }
  return out
}

/**
 * 抽取候选：顺序固定为「摘要 → 显式 → 用户事实」，保证导入时摘要先落库、
 * 同会话其它候选能挂到摘要之下（因果树按会话分组）。
 */
export function extractCandidates(session: DshSession, options: ExtractOptions): SessionCandidate[] {
  const project = projectOf(session, options.project)
  const candidates: SessionCandidate[] = []
  if (options.summary && session.userTexts.length > 0) {
    const ts = tsOf(session.createdAt, session)
    candidates.push(summaryCandidate(session, project, ts))
  }
  if (options.explicit) candidates.push(...explicitCandidates(session, project))
  if (options.facts) candidates.push(...factCandidates(session, project))
  return candidates
}
