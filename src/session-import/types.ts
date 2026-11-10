/**
 * DSH 会话历史导入：类型契约（实现见 docs/session-import-contract.md）。
 *
 * 本文件只放类型，不 import 任何运行时模块——浏览器半区与服务端半区都不得从
 * `src/session-import/` 取运行时符号（服务端模块会拉 node:zlib）。
 */

/** 一个待解析的会话文件（一层子目录下的 session.v4.jsonl.zstd 等）。 */
export interface DshSessionFile {
  /** 绝对路径。 */
  path: string
  /** 会话目录名（session-<uuid> 或裸 uuid），作为 sessionId 兜底。 */
  dirName: string
  sessionId: string
  sizeBytes: number
  mtimeMs: number
}

/** 会话事件流的一行（只保留导入关心的字段）。 */
export interface DshSessionEvent {
  type: string
  seq?: number
  time?: number
  data?: Record<string, unknown>
}

/** 会话里的一条人类消息。 */
export interface DshSessionText {
  seq: number
  messageId: string
  timeMs: number
  text: string
}

/** 会话里显式存过的一条记忆（tool/call、command/run 或「记：」消息）。 */
export interface DshSessionExplicit {
  seq: number
  timeMs: number
  title: string
  content: string
  tags: string[]
}

export interface DshSessionParseStats {
  lines: number
  badLines: number
  events: number
}

/** 一个解析完成的会话。 */
export interface DshSession {
  file: DshSessionFile
  id: string
  cwd: string
  /** 毫秒；未知为 0。 */
  createdAt: number
  /** 毫秒；最后一条带 time 的事件；未知为 0。 */
  updatedAt: number
  title: string
  userTexts: DshSessionText[]
  explicit: DshSessionExplicit[]
  stats: DshSessionParseStats
  warnings: string[]
}

export type SessionCandidateKind = 'explicit' | 'session-summary' | 'user-fact'

/** 一条待写入 memlite 的候选记忆。 */
export interface SessionCandidate {
  kind: SessionCandidateKind
  /** 稳定锚：dsh:<sessionId>:<kind>:<key>。 */
  anchor: string
  title: string
  content: string
  tags: string[]
  project: string
  /** 秒级时间戳（与 memlite remember 的 ts 一致）。 */
  ts: number
  /** 平铺进 memlite 记录的元数据（source/dsh_anchor/dsh_session_id/dsh_kind/source_hash/dsh_project…）。 */
  extra: Record<string, unknown>
}

export interface SessionImportOptions {
  /** 会话根目录；缺省 ~/.dsh/sessions。 */
  root?: string
  /** 只导入该 cwd 的会话（精确匹配，或匹配目录编码）。 */
  cwd?: string
  /** 覆盖所有候选的 project；缺省由 cwd basename 推导。 */
  project?: string
  /** 只导入该会话（全 id 或前缀）。 */
  sessionId?: string
  /** 取最新 N 个会话（默认 20，硬上限 200）。 */
  limit?: number
  /** ISO 字符串或 epoch（>1e12 当毫秒，否则当秒）。 */
  since?: string | number
  /** 抽取显式记忆，默认 true。 */
  explicit?: boolean
  /** 抽取会话摘要，默认 true。 */
  summary?: boolean
  /** 抽取用户事实，默认 false。 */
  facts?: boolean
  /** 只报告不写库。 */
  dryRun?: boolean
  onProgress?: (done: number, total: number, label: string) => void
}

export interface SessionListOptions {
  root?: string
  cwd?: string
  sessionId?: string
  limit?: number
  since?: string | number
}

export interface SessionImportSkip {
  anchor: string
  reason: 'sensitive' | 'empty' | 'write-error'
  detail?: string
}

export interface SessionImportReport {
  sessionsScanned: number
  sessionsSkipped: number
  events: number
  candidates: number
  created: string[]
  updated: string[]
  unchanged: number
  skipped: SessionImportSkip[]
  warnings: string[]
  wouldCreate: number
  wouldUpdate: number
}

/** `memlite-session-list` / 配置页「列出会话」的一行。 */
export interface DshSessionOverview {
  sessionId: string
  dirName: string
  title: string
  cwd: string
  /** 毫秒。 */
  createdAt: number
  messages: number
  explicit: number
  sizeBytes: number
  mtimeMs: number
}
