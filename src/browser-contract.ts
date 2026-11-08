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
  | { ok: false; error: string; disabled?: boolean }

/** document-relative 路径（与 Obsidian 路由同一约定，由 connection 负责认证/信任栅栏）。 */
export const MEMORY_BROWSER_PATHS = {
  list: 'api/memlite/browser/list',
  search: 'api/memlite/browser/search',
  show: 'api/memlite/browser/show',
  tree: 'api/memlite/browser/tree',
  sessionRecalls: 'api/memlite/browser/session-recalls',
} as const

export type MemoryBrowserRoute = keyof typeof MEMORY_BROWSER_PATHS

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
