/**
 * 记忆浏览器（M8）Host ↔ Client 契约。
 *
 * - 纯类型 + 常量，**没有任何运行时依赖**：浏览器半区可以按需 value-import 路径常量，
 *   宿主半区（`src/memory-routes.ts`）用同一份类型校验/投影，避免两侧含义漂移。
 * - 契约只描述**白名单字段**：正文只出现在 show 响应里，列表/搜索/树响应不含正文；
 *   向量、凭据引用、原始查询日志、本地路径、未筛选的 `extra` 一律不出现。
 * - 所有响应包在 `MemoryApiResponse<T>` 里；`ok:false` 的 `error` 由宿主生成，
 *   不含路径/密钥/原始请求内容。
 */
import type { MemRecord } from '@rsrsai/memlite'

/** 重要性：`extra.importance` 的投影；老数据/未标注为空串。 */
export type MemoryImportance = 'important' | 'trivial' | ''

/** 记忆形态：`extra.kind` 的投影。 */
export type MemoryKind = string

/** Host↔Client 的记忆摘要（列表/搜索/树节点共用字段；搜索额外带 score）。 */
export interface MemorySummaryItem {
  id: string
  title: string
  /** 正文前两行摘要（宿主截断；列表不传全文）。 */
  summary: string
  tags: string[]
  project: string
  /** 创建时间（秒）。 */
  ts: number
  importance: MemoryImportance
  kind: MemoryKind
  /** 条件写版本（老数据由 ts 推导；更新后递增）。 */
  revision: number
  /** 直接子条数量（因果树入口用）。 */
  childCount: number
  /** 无子条。 */
  leaf: boolean
}

export interface MemoryListRequest {
  /** 项目名；缺省/空串=全部项目。 */
  project?: string
  /** 标签；缺省/空串=全部标签。 */
  tag?: string
  /** 重要性筛选；缺省/空串=全部。 */
  importance?: MemoryImportance
  /** 游标：上一页最后一条的 `nextCursor`；缺省=第一页。 */
  cursor?: string
  /** 1..50，默认 20。 */
  limit?: number
}

export interface MemoryListResponse {
  /** 引擎代次：配置结构性变化重建引擎后 +1；浏览器据此清理失效详情。 */
  engine: number
  items: MemorySummaryItem[]
  nextCursor: string | null
  /** 当前筛选下的总条数（仅数字，不含正文）。 */
  total: number
  /** 筛选下拉数据（频次降序，已截断）。 */
  projects: Array<[string, number]>
  tags: Array<[string, number]>
}

export interface MemorySearchRequest {
  /** 1..500 字符。 */
  query: string
  project?: string
  /** 1..20，默认 10。 */
  limit?: number
}

export interface MemorySearchItem extends MemorySummaryItem {
  /** 召回原始分数：BM25 可 >1（RRF 融合分通常 ≤1），只保证非负。 */
  score: number
}

export interface MemorySearchResponse {
  engine: number
  backend: string
  fallback: string
  ms: number
  items: MemorySearchItem[]
}

export interface MemoryShowRequest {
  /** 完整 id / 前 8 位 / 唯一纲名皆可（memlite resolve 语义），1..200 字符。 */
  id: string
}

/** 单条详情（正文只在这里出现，长度有上限，超出置 truncated）。 */
export interface MemoryDetail {
  id: string
  title: string
  content: string
  /** 正文被宿主截断（超长防爆）。 */
  truncated: boolean
  tags: string[]
  project: string
  ts: number
  importance: MemoryImportance
  kind: MemoryKind
  /** 条件写版本；写请求必须回传。 */
  revision: number
  /** 因果父 id（空串=根）；用于改挂编辑器预选。 */
  parentId: string
  childCount: number
  leaf: boolean
}

export interface MemoryNeighbor {
  id: string
  title: string
}

export interface MemoryShowResponse {
  engine: number
  /** 记忆已删除/不存在时为 false（不当作错误：会话历史要显示“原记忆已删除”）。 */
  found: boolean
  record?: MemoryDetail
  ancestors: MemoryNeighbor[]
  children: Array<MemoryNeighbor & { summary: string }>
  /** 有界完整链（因链标题 + 本条 + 果链下探层，深度已截断）。 */
  chain: {
    ancestors: MemoryNeighbor[]
    entry: MemoryNeighbor
    descendants: Array<MemoryNeighbor & { depth: number }>
  }
}

export interface MemoryTreeRequest {
  /** 父节点；缺省/空串=根层。 */
  parentId?: string
  project?: string
  /** 1..200，默认 100。 */
  limit?: number
}

export interface MemoryTreeNode {
  id: string
  title: string
  kind: MemoryKind
  importance: MemoryImportance
  ts: number
  childCount: number
  leaf: boolean
}

export interface MemoryTreeResponse {
  engine: number
  parentId: string
  nodes: MemoryTreeNode[]
  trimmed: boolean
}

export type MemoryRecallStatus = 'ok' | 'empty' | 'skipped' | 'error'
export type MemoryRecallExclusion = 'threshold' | 'budget'
export type MemorySkipReason = 'nomem' | 'short' | 'sensitive' | 'store' | 'disabled'

export interface MemorySessionHit {
  id: string
  /** 召回原始分数（BM25 可 >1）；与 `selectRecallTitles` 判定用的同一个值。 */
  score: number
  /** 召回当时的标题快照（原记忆删除后仍可显示）。 */
  title: string
  /** 是否真正追加进了 decision.messages。 */
  injected: boolean
  /** 未注入原因：低于阈值 / 预算截断。 */
  exclusion?: MemoryRecallExclusion
  /** 该 id 当前是否仍在库中（false=原记忆已删除）。 */
  exists: boolean
}

export interface MemorySessionRecall {
  agentId: string
  turn: number
  messageId: string
  /** 秒级时间戳（与 `MemRecord.ts` 同口径；UI 直接 ×1000 渲染）。 */
  timestamp: number
  backend: string
  fallback: string
  status: MemoryRecallStatus
  /** status=skipped 的原因。 */
  skipReason?: MemorySkipReason
  hits: MemorySessionHit[]
  /** 本轮实际追加进 decision.messages 的标题块（不含原始提示词/正文；长度受预算上限）。 */
  injectedText?: string
  /** 召回当时的阈值快照。 */
  threshold?: number
  /** 召回当时的字符预算快照。 */
  budgetChars?: number
  /** 实际注入标题块使用的字符数。 */
  usedChars?: number
  /** 召回条数上限快照。 */
  limit?: number
  /** 召回耗时（毫秒）。 */
  elapsedMs?: number
  /** 显式反馈（按 memory id；只存内存，重载清空，不自动调权）。 */
  feedback?: Record<string, 'helpful' | 'irrelevant'>
}

export interface MemorySessionRecallsRequest {
  /** 与 agentId 至少给一个；两者都给时以 sessionId 为准。 */
  sessionId?: string
  agentId?: string
  /** 1..100，默认 30（按时间倒序）。 */
  limit?: number
}

export interface MemorySessionRecallsResponse {
  engine: number
  /** 实际作用域：'session'=按会话；'agent'=无法取得稳定 sessionId 时的明示降级。 */
  scope: 'session' | 'agent'
  entries: MemorySessionRecall[]
  trimmed: boolean
}

/** 宿主统一响应外壳。 */
export type MemoryApiResponse<T> =
  | { ok: true; data: T }
  | {
      ok: false
      error: string
      disabled?: boolean
      /** 稳定错误码（如 STALE_VERSION），只用于已知业务错误。 */
      code?: string
      /** 写操作失败/冲突时的统一回执，供 UI 保留草稿与展示当前版本。 */
      receipt?: MemoryWriteReceipt
    }

/** document-relative 路径（与 Obsidian 路由同一约定，由 connection 负责认证/信任栅栏）。 */
export const MEMORY_BROWSER_PATHS = {
  list: 'api/memlite/browser/list',
  search: 'api/memlite/browser/search',
  show: 'api/memlite/browser/show',
  tree: 'api/memlite/browser/tree',
  sessionRecalls: 'api/memlite/browser/session-recalls',
  status: 'api/memlite/browser/status',
  remember: 'api/memlite/browser/remember',
  update: 'api/memlite/browser/update',
  attach: 'api/memlite/browser/attach',
  forget: 'api/memlite/browser/forget',
  feedback: 'api/memlite/browser/recall-feedback',
  sync: 'api/memlite/browser/sync',
  reembed: 'api/memlite/browser/reembed',
} as const

export type MemoryBrowserRoute = keyof typeof MEMORY_BROWSER_PATHS

/* -------------------------------------------------------------------------- */
/* 写操作契约（M9b）                                                           */
/* -------------------------------------------------------------------------- */

export type MemoryWriteKind = 'remember' | 'update' | 'attach' | 'forget'

/**
 * 写入回执状态。词典与 `docs/ui-complete-plan.md §6.1` 一致；
 * 当前引擎没有 pending 审批域，因此不出现「已提交等待确认」。
 */
export type MemoryWriteStatus =
  | 'saved'
  | 'saved-degraded'
  | 'skipped'
  | 'partial'
  | 'rejected'
  | 'conflict'
  | 'failed'
  | 'unconfirmed'

export type MemoryEmbeddedStatus = 'updated' | 'disabled' | 'pending' | 'failed' | 'not-applicable'

/** 一次 UI 写操作的统一回执；服务端按 operationId 幂等。 */
export interface MemoryWriteReceipt {
  operationId: string
  kind: MemoryWriteKind
  status: MemoryWriteStatus
  id: string
  title: string
  /** 写后读回：id/标题/正文（或 attach 的父链、forget 的不存在）一致。 */
  verified: boolean
  embedded: MemoryEmbeddedStatus
  /** 稳定错误码（STALE_VERSION / SENSITIVE / NOT_FOUND / INVALID / ENGINE / UNCONFIRMED）。 */
  code?: string
  /** 面向用户的安全说明；不含路径、密钥、原始异常栈。 */
  message?: string
  /** 秒级时间戳。 */
  timestamp: number
  /** 更新/改挂后的新版本号。 */
  revision?: number
  /** 冲突时的当前安全投影（供 UI 并排展示草稿）。正文限长。 */
  current?: MemoryDetail
}

export interface MemoryWriteResponse {
  receipt: MemoryWriteReceipt
}

/** 回执按会话/agent 隔离；只影响内存回执分组，不影响写入目标。 */
export interface MemoryWriteScope {
  sessionId?: string
  agentId?: string
}

export interface MemoryRememberRequest extends MemoryWriteScope {
  operationId: string
  title: string
  content: string
  tags?: string[]
  project?: string
  importance?: 'important' | 'trivial'
  /** 因果父条；缺省=根。 */
  parentId?: string
}

export interface MemoryUpdateRequest extends MemoryWriteScope {
  operationId: string
  id: string
  expectedRevision: number
  title?: string
  content?: string
  tags?: string[]
  importance?: MemoryImportance
}

export interface MemoryAttachRequest extends MemoryWriteScope {
  operationId: string
  id: string
  expectedRevision: number
  /** 新父条；空串=升根。 */
  parentId: string
}

export interface MemoryForgetRequest extends MemoryWriteScope {
  operationId: string
  id: string
  expectedRevision: number
  /** 必须与当前标题一致，防止误删。 */
  confirmTitle: string
}

export interface MemoryRecallFeedbackRequest {
  sessionId?: string
  agentId?: string
  turn: number
  messageId: string
  memoryId: string
  feedback: 'helpful' | 'irrelevant'
}

export interface MemoryRecallFeedbackResponse {
  updated: boolean
  feedback: 'helpful' | 'irrelevant'
}

/* -------------------------------------------------------------------------- */
/* 状态视图契约（M11）                                                         */
/* -------------------------------------------------------------------------- */

export type MemoryDataScope = 'project' | 'user' | 'custom'

export interface MemoryStatusResponse {
  engine: number
  library: {
    enabled: boolean
    records: number
    badLines: number
    vectors: number
    /** 只给语义类别，不给完整路径。 */
    dataScope: MemoryDataScope
    files: number
  }
  search: {
    /** 'bm25' 或 'semantic+bm25'；只是当前配置，不宣称本次请求使用。 */
    backend: 'bm25' | 'semantic+bm25'
    embeddingProvider: 'none' | 'host' | 'openai-compatible'
    embeddingConfigured: boolean
    /** 本次运行降级次数（无法精确时保持 0，不猜测）。 */
    fallbacks: number
  }
  sync: {
    available: boolean
    hasRemote: boolean
    dirty: boolean
    /** 最近一次显式同步是否完成双通道 sha 核验；未同步过为 false。 */
    verified: boolean
    localSha: string
    note?: string
  }
  obsidian: {
    state: 'unchecked' | 'busy' | 'ok' | 'error'
    lastOperation?: 'status' | 'preview' | 'import' | 'export'
    timestamp?: number
  }
  /** 当前会话/agent 的最近回执（最多 50；内存态，重载清空）。 */
  receipts: MemoryWriteReceipt[]
}

export interface MemorySyncRequest {
  operationId: string
}

export interface MemorySyncResponse {
  committed: boolean
  localSha: string
  remoteSha: string
  verified: boolean
}

export interface MemoryReembedRequest {
  operationId: string
}

export interface MemoryReembedResponse {
  total: number
  embedded: number
  failed: number
}

/** 宿主侧内部使用的投影选项（不属于线上契约）。 */
export interface ProjectionLimits {
  /** 列表摘要字符上限。 */
  summaryChars: number
  /** 详情正文字符上限。 */
  contentChars: number
  /** 标题字符上限。 */
  titleChars: number
  /** tags 数组上限。 */
  tags: number
}

export const DEFAULT_PROJECTION_LIMITS: ProjectionLimits = {
  summaryChars: 160,
  contentChars: 20_000,
  titleChars: 200,
  tags: 10,
}

/** 一条记忆记录 → 重要性投影（老数据无此字段时为空串）。 */
export function recordImportance(record: MemRecord): MemoryImportance {
  const value = record.extra?.['importance']
  return value === 'important' || value === 'trivial' ? value : ''
}

/** 一条记忆记录 → 形态投影。 */
export function recordKind(record: MemRecord): MemoryKind {
  const value = record.extra?.['kind']
  return typeof value === 'string' ? value.slice(0, 40) : ''
}
