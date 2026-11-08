/**
 * 聊天记忆浏览器（M8）路由客户端（浏览器半区）。
 *
 * - 只访问 `MEMORY_BROWSER_PATHS` 里的 5 条 document-relative 只读路由；
 *   全部 `POST` + `credentials: 'include'` + `application/json`，认证/信任栅栏由宿主负责。
 * - 响应外壳是 `MemoryApiResponse<T>`（`{ok:true,data}` / `{ok:false,error,disabled?}`）。
 * - **不把原始 JSON `as T`**：每个响应都过形状校验（字段类型、枚举、数组上限、字符串截断），
 *   不合规抛 `MemoryApiError`（code='shape'），面板据此显示“响应格式不符合契约”。
 * - 网络错误转成可读的 `MemoryApiError`（code='network'）；请求中止（AbortError）原样透出，
 *   由调用方静默处理。
 *
 * 本模块不 import 任何 `@deepseek-ai/*` 运行时包；`../browser-contract` 只有类型与常量。
 */
import {
  DEFAULT_PROJECTION_LIMITS,
  MEMORY_BROWSER_PATHS,
  type MemoryDetail,
  type MemoryImportance,
  type MemoryListRequest,
  type MemoryListResponse,
  type MemoryNeighbor,
  type MemoryRecallExclusion,
  type MemoryRememberRequest,
  type MemoryUpdateRequest,
  type MemoryAttachRequest,
  type MemoryForgetRequest,
  type MemoryRecallFeedbackRequest,
  type MemoryRecallFeedbackResponse,
  type MemoryRecallStatus,
  type MemoryReembedResponse,
  type MemorySearchItem,
  type MemorySearchRequest,
  type MemorySearchResponse,
  type MemorySessionHit,
  type MemorySessionRecall,
  type MemorySessionRecallsRequest,
  type MemorySessionRecallsResponse,
  type MemoryShowRequest,
  type MemoryShowResponse,
  type MemorySkipReason,
  type MemoryStatusResponse,
  type MemorySummaryItem,
  type MemorySyncResponse,
  type MemoryTreeRequest,
  type MemoryTreeResponse,
  type MemoryTreeNode,
  type MemoryWriteReceipt,
  type MemoryWriteResponse,
} from '../browser-contract'

/** 面板只读三个视图的请求上限（契约 §三）。 */
const LIST_LIMIT = 20
const SEARCH_LIMIT = 20
const TREE_LIMIT = 100
const RECALLS_LIMIT = 50

/** 数组/字符串的防御上限：超过说明宿主违约或数据异常。 */
const MAX_LIST_ITEMS = 200
const MAX_SEARCH_ITEMS = 200
const MAX_TREE_NODES = 200
const MAX_RECALL_ENTRIES = 100
const MAX_RECALL_HITS = 50
const MAX_NEIGHBORS = 200
const MAX_CHAIN_NODES = 500
const MAX_FACETS = 100
const MAX_ID = 200
const MAX_TAG = 80
const MAX_PROJECT = 120
const MAX_KIND = 40
const MAX_BACKEND = 120
const MAX_CURSOR = 400
const MAX_ERROR_MESSAGE = 300

export type MemoryApiErrorCode = 'http' | 'network' | 'shape' | 'disabled'

export interface MemoryApiErrorOptions {
  code: MemoryApiErrorCode
  /** HTTP 状态码（网络/形状错误时可能缺省）。 */
  status?: number
  /** 宿主以 `disabled:true` / HTTP 503 明确表示插件禁用。 */
  disabled?: boolean
  /** 稳定业务错误码（如 STALE_VERSION）。 */
  businessCode?: string
  /** 写操作失败/冲突回执（保留草稿与当前版本）。 */
  receipt?: MemoryWriteReceipt
  cause?: unknown
}

/** 路由客户端统一错误：面板按 `code`/`disabled` 决定展示哪个状态。 */
export class MemoryApiError extends Error {
  readonly code: MemoryApiErrorCode
  readonly status: number | undefined
  readonly disabled: boolean
  readonly businessCode: string | undefined
  readonly receipt: MemoryWriteReceipt | undefined

  constructor(message: string, options: MemoryApiErrorOptions) {
    super(message)
    this.name = 'MemoryApiError'
    this.code = options.code
    this.status = options.status
    this.disabled = options.disabled === true
    this.businessCode = options.businessCode
    this.receipt = options.receipt
    if (options.cause !== undefined) this.cause = options.cause
    // 兼容以 ES5 目标转译时 instanceof 失效的旧工具链。
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** 中止错误判断：fetch/AbortSignal 在不同运行时给出不同形状。 */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const record = error as { name?: unknown; code?: unknown }
  if (record.name === 'AbortError') return true
  if (record.code === 20) return true // DOMException.ABORT_ERR
  if (record.code === 'ABORT_ERR') return true // Node 风格
  return false
}

/** `api` 的五个方法全部接受 AbortSignal，面板在切视图/换会话/刷新/卸载时中止旧请求。 */
export interface MemoryApi {
  list(req: MemoryListRequest, signal?: AbortSignal): Promise<MemoryListResponse>
  search(req: MemorySearchRequest, signal?: AbortSignal): Promise<MemorySearchResponse>
  show(req: MemoryShowRequest, signal?: AbortSignal): Promise<MemoryShowResponse>
  tree(req: MemoryTreeRequest, signal?: AbortSignal): Promise<MemoryTreeResponse>
  sessionRecalls(
    req: MemorySessionRecallsRequest,
    signal?: AbortSignal,
  ): Promise<MemorySessionRecallsResponse>
  status(
    req: { sessionId?: string; agentId?: string },
    signal?: AbortSignal,
  ): Promise<MemoryStatusResponse>
  remember(req: MemoryRememberRequest, signal?: AbortSignal): Promise<MemoryWriteReceipt>
  update(req: MemoryUpdateRequest, signal?: AbortSignal): Promise<MemoryWriteReceipt>
  attach(req: MemoryAttachRequest, signal?: AbortSignal): Promise<MemoryWriteReceipt>
  forget(req: MemoryForgetRequest, signal?: AbortSignal): Promise<MemoryWriteReceipt>
  feedback(
    req: MemoryRecallFeedbackRequest,
    signal?: AbortSignal,
  ): Promise<MemoryRecallFeedbackResponse>
  sync(req: { operationId: string }, signal?: AbortSignal): Promise<MemorySyncResponse>
  reembed(req: { operationId: string }, signal?: AbortSignal): Promise<MemoryReembedResponse>
}

/** 面板实际使用的请求上限（导出便于测试断言）。 */
export const MEMORY_API_LIMITS = {
  list: LIST_LIMIT,
  search: SEARCH_LIMIT,
  tree: TREE_LIMIT,
  sessionRecalls: RECALLS_LIMIT,
} as const

/* -------------------------------------------------------------------------- */
/* 形状校验工具                                                                */
/* -------------------------------------------------------------------------- */

function shapeError(message: string): MemoryApiError {
  return new MemoryApiError(`响应格式不符合契约：${message}`, { code: 'shape' })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw shapeError(`${path} 必须是对象`)
  return value
}

function requireArray(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw shapeError(`${path} 必须是数组`)
  if (value.length > max) throw shapeError(`${path} 超出上限 ${max}`)
  return value
}

function requireString(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string') throw shapeError(`${path} 必须是字符串`)
  return value.slice(0, max)
}

/** id 类字符串不允许为空（空 id 无意义，也防止 UI 死循环选中）。 */
function requireNonEmptyString(value: unknown, path: string, max: number): string {
  const text = requireString(value, path, max)
  if (text.trim() === '') throw shapeError(`${path} 不能为空`)
  return text
}

function optionalString(value: unknown, path: string, max: number): string {
  if (value === undefined || value === null) return ''
  return requireString(value, path, max)
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw shapeError(`${path} 必须是有限数字`)
  }
  return value
}

function requireInt(value: unknown, path: string, min: number, max: number): number {
  const number = requireNumber(value, path)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw shapeError(`${path} 必须是 ${min}..${max} 的整数`)
  }
  return number
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw shapeError(`${path} 必须是布尔值`)
  return value
}

function requireEnum<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw shapeError(`${path} 必须是 ${values.join('|')}`)
  }
  return value as T
}

function optionalEnum<T extends string>(
  value: unknown,
  path: string,
  values: readonly T[],
): T | undefined {
  if (value === undefined || value === null) return undefined
  return requireEnum(value, path, values)
}

/**
 * 召回分数：契约是「召回原始分数」（BM25 可 >1，RRF 融合分通常 ≤1），
 * 只做非负截断，不做上限截断——上限截断会把 5.47 与 1.0 都显示成 1.000。
 */
function clampScore(value: number): number {
  return value < 0 ? 0 : value
}

const IMPORTANCE_VALUES: readonly MemoryImportance[] = ['important', 'trivial', '']
const RECALL_STATUS_VALUES: readonly MemoryRecallStatus[] = ['ok', 'empty', 'skipped', 'error']
const EXCLUSION_VALUES: readonly MemoryRecallExclusion[] = ['threshold', 'budget']
const SKIP_REASON_VALUES: readonly MemorySkipReason[] = [
  'nomem',
  'short',
  'sensitive',
  'store',
  'disabled',
]

/** `[name, count]` 频次数组（项目/标签筛选下拉）。 */
function parseFacet(value: unknown, path: string): [string, number] {
  if (!Array.isArray(value) || value.length !== 2) throw shapeError(`${path} 必须是 [名, 次数]`)
  const name = requireString(value[0], `${path}[0]`, MAX_PROJECT)
  const count = requireInt(value[1], `${path}[1]`, 0, Number.MAX_SAFE_INTEGER)
  return [name, count]
}

function parseFacets(value: unknown, path: string): Array<[string, number]> {
  return requireArray(value, path, MAX_FACETS).map((entry, index) =>
    parseFacet(entry, `${path}[${index}]`),
  )
}

/* -------------------------------------------------------------------------- */
/* 逐资源校验                                                                  */
/* -------------------------------------------------------------------------- */

/** 列表/搜索/树节点共用的摘要字段。 */
export function parseSummaryItem(value: unknown, path = 'item'): MemorySummaryItem {
  const record = requireRecord(value, path)
  return {
    id: requireNonEmptyString(record['id'], `${path}.id`, MAX_ID),
    title: requireString(record['title'], `${path}.title`, DEFAULT_PROJECTION_LIMITS.titleChars),
    summary: requireString(record['summary'], `${path}.summary`, DEFAULT_PROJECTION_LIMITS.summaryChars),
    tags: requireArray(record['tags'], `${path}.tags`, DEFAULT_PROJECTION_LIMITS.tags).map(
      (tag, index) => requireString(tag, `${path}.tags[${index}]`, MAX_TAG),
    ),
    project: requireString(record['project'], `${path}.project`, MAX_PROJECT),
    ts: requireNumber(record['ts'], `${path}.ts`),
    importance: requireEnum(record['importance'], `${path}.importance`, IMPORTANCE_VALUES),
    kind: requireString(record['kind'], `${path}.kind`, MAX_KIND),
    revision: requireInt(record['revision'], `${path}.revision`, 0, Number.MAX_SAFE_INTEGER),
    childCount: requireInt(record['childCount'], `${path}.childCount`, 0, Number.MAX_SAFE_INTEGER),
    leaf: requireBoolean(record['leaf'], `${path}.leaf`),
  }
}

function parseSearchItem(value: unknown, path: string): MemorySearchItem {
  const summary = parseSummaryItem(value, path)
  const record = requireRecord(value, path)
  return { ...summary, score: clampScore(requireNumber(record['score'], `${path}.score`)) }
}

function parseNeighbor(value: unknown, path: string): MemoryNeighbor {
  const record = requireRecord(value, path)
  return {
    id: requireNonEmptyString(record['id'], `${path}.id`, MAX_ID),
    title: requireString(record['title'], `${path}.title`, DEFAULT_PROJECTION_LIMITS.titleChars),
  }
}

/** 链入口允许空 id/title：宿主降级时用 `{id:'',title:''}` 占位（契约 §六 补充）。 */
function parseChainEntry(value: unknown, path: string): MemoryNeighbor {
  const record = requireRecord(value, path)
  return {
    id: optionalString(record['id'], `${path}.id`, MAX_ID),
    title: optionalString(record['title'], `${path}.title`, DEFAULT_PROJECTION_LIMITS.titleChars),
  }
}

function parseNeighbors(value: unknown, path: string): MemoryNeighbor[] {
  return requireArray(value, path, MAX_NEIGHBORS).map((entry, index) =>
    parseNeighbor(entry, `${path}[${index}]`),
  )
}

function parseChildNeighbor(value: unknown, path: string): MemoryNeighbor & { summary: string } {
  const record = requireRecord(value, path)
  return {
    ...parseNeighbor(value, path),
    summary: requireString(record['summary'], `${path}.summary`, DEFAULT_PROJECTION_LIMITS.summaryChars),
  }
}

/** list 响应（`api/memlite/browser/list`）。 */
export function parseListResponse(data: unknown): MemoryListResponse {
  const record = requireRecord(data, 'data')
  return {
    engine: requireInt(record['engine'], 'data.engine', 0, Number.MAX_SAFE_INTEGER),
    items: requireArray(record['items'], 'data.items', MAX_LIST_ITEMS).map((item, index) =>
      parseSummaryItem(item, `data.items[${index}]`),
    ),
    nextCursor: (() => {
      const raw = record['nextCursor']
      if (raw === null || raw === undefined) return null
      const cursor = requireString(raw, 'data.nextCursor', MAX_CURSOR)
      return cursor === '' ? null : cursor
    })(),
    total: requireInt(record['total'], 'data.total', 0, Number.MAX_SAFE_INTEGER),
    projects: parseFacets(record['projects'], 'data.projects'),
    tags: parseFacets(record['tags'], 'data.tags'),
  }
}

/** search 响应（`api/memlite/browser/search`）。 */
export function parseSearchResponse(data: unknown): MemorySearchResponse {
  const record = requireRecord(data, 'data')
  return {
    engine: requireInt(record['engine'], 'data.engine', 0, Number.MAX_SAFE_INTEGER),
    backend: requireString(record['backend'], 'data.backend', MAX_BACKEND),
    fallback: optionalString(record['fallback'], 'data.fallback', MAX_BACKEND),
    ms: requireNumber(record['ms'], 'data.ms'),
    items: requireArray(record['items'], 'data.items', MAX_SEARCH_ITEMS).map((item, index) =>
      parseSearchItem(item, `data.items[${index}]`),
    ),
  }
}

/** 单条详情（show 与写回执 current 共用）。 */
export function parseDetail(value: unknown, path = 'detail'): MemoryDetail {
  const item = requireRecord(value, path)
  return {
    id: requireNonEmptyString(item['id'], `${path}.id`, MAX_ID),
    title: requireString(item['title'], `${path}.title`, DEFAULT_PROJECTION_LIMITS.titleChars),
    content: requireString(item['content'], `${path}.content`, DEFAULT_PROJECTION_LIMITS.contentChars),
    truncated: requireBoolean(item['truncated'], `${path}.truncated`),
    tags: requireArray(item['tags'], `${path}.tags`, DEFAULT_PROJECTION_LIMITS.tags).map(
      (tag, index) => requireString(tag, `${path}.tags[${index}]`, MAX_TAG),
    ),
    project: requireString(item['project'], `${path}.project`, MAX_PROJECT),
    ts: requireNumber(item['ts'], `${path}.ts`),
    importance: requireEnum(item['importance'], `${path}.importance`, IMPORTANCE_VALUES),
    kind: requireString(item['kind'], `${path}.kind`, MAX_KIND),
    revision: requireInt(item['revision'], `${path}.revision`, 0, Number.MAX_SAFE_INTEGER),
    parentId: optionalString(item['parentId'], `${path}.parentId`, MAX_ID),
    childCount: requireInt(item['childCount'], `${path}.childCount`, 0, Number.MAX_SAFE_INTEGER),
    leaf: requireBoolean(item['leaf'], `${path}.leaf`),
  }
}

/** show 响应（`api/memlite/browser/show`）；正文只在这里出现。 */
export function parseShowResponse(data: unknown): MemoryShowResponse {
  const record = requireRecord(data, 'data')
  const found = requireBoolean(record['found'], 'data.found')
  const rawRecord = record['record']
  let detail: MemoryShowResponse['record']
  if (rawRecord !== undefined) {
    detail = parseDetail(rawRecord, 'data.record')
  } else if (found) {
    throw shapeError('data.record 在 found=true 时必须存在')
  }

  const chainRecord = requireRecord(record['chain'], 'data.chain')
  const chain = {
    ancestors: parseNeighbors(chainRecord['ancestors'], 'data.chain.ancestors'),
    entry: parseChainEntry(chainRecord['entry'], 'data.chain.entry'),
    descendants: requireArray(
      chainRecord['descendants'],
      'data.chain.descendants',
      MAX_CHAIN_NODES,
    ).map((entry, index) => {
      const node = requireRecord(entry, `data.chain.descendants[${index}]`)
      return {
        ...parseNeighbor(entry, `data.chain.descendants[${index}]`),
        depth: requireInt(node['depth'], `data.chain.descendants[${index}].depth`, 0, 64),
      }
    }),
  }

  return {
    engine: requireInt(record['engine'], 'data.engine', 0, Number.MAX_SAFE_INTEGER),
    found,
    ...(detail === undefined ? {} : { record: detail }),
    ancestors: parseNeighbors(record['ancestors'], 'data.ancestors'),
    children: requireArray(record['children'], 'data.children', MAX_NEIGHBORS).map(
      (entry, index) => parseChildNeighbor(entry, `data.children[${index}]`),
    ),
    chain,
  }
}

const WRITE_KIND_VALUES = ['remember', 'update', 'attach', 'forget'] as const
const WRITE_STATUS_VALUES = [
  'saved',
  'saved-degraded',
  'skipped',
  'partial',
  'rejected',
  'conflict',
  'failed',
  'unconfirmed',
] as const
const EMBEDDED_VALUES = ['updated', 'disabled', 'pending', 'failed', 'not-applicable'] as const

/** 写回执（`api/memlite/browser/{remember,update,attach,forget}`）。 */
export function parseWriteReceipt(value: unknown, path = 'receipt'): MemoryWriteReceipt {
  const record = requireRecord(value, path)
  const id = optionalString(record['id'], `${path}.id`, MAX_ID)
  const code = optionalString(record['code'], `${path}.code`, 80)
  const message = optionalString(record['message'], `${path}.message`, 300)
  const revisionRaw = record['revision']
  const currentRaw = record['current']
  return {
    operationId: requireNonEmptyString(record['operationId'], `${path}.operationId`, 100),
    kind: requireEnum(record['kind'], `${path}.kind`, WRITE_KIND_VALUES),
    status: requireEnum(record['status'], `${path}.status`, WRITE_STATUS_VALUES),
    id: id ?? '',
    title: requireString(record['title'], `${path}.title`, DEFAULT_PROJECTION_LIMITS.titleChars),
    verified: requireBoolean(record['verified'], `${path}.verified`),
    embedded: requireEnum(record['embedded'], `${path}.embedded`, EMBEDDED_VALUES),
    ...(code !== undefined ? { code } : {}),
    ...(message !== undefined ? { message } : {}),
    timestamp: requireNumber(record['timestamp'], `${path}.timestamp`),
    ...(revisionRaw === undefined || revisionRaw === null
      ? {}
      : { revision: requireInt(revisionRaw, `${path}.revision`, 0, Number.MAX_SAFE_INTEGER) }),
    ...(currentRaw === undefined || currentRaw === null
      ? {}
      : { current: parseDetail(currentRaw, `${path}.current`) }),
  }
}

export function parseWriteResponse(data: unknown): MemoryWriteResponse {
  const record = requireRecord(data, 'data')
  return { receipt: parseWriteReceipt(record['receipt'], 'data.receipt') }
}

/** status 响应（`api/memlite/browser/status`）。 */
export function parseStatusResponse(data: unknown): MemoryStatusResponse {
  const record = requireRecord(data, 'data')
  const library = requireRecord(record['library'], 'data.library')
  const search = requireRecord(record['search'], 'data.search')
  const sync = requireRecord(record['sync'], 'data.sync')
  const obsidian = requireRecord(record['obsidian'], 'data.obsidian')
  const concurrencyRaw = record['concurrency']
  const concurrencyRecord =
    concurrencyRaw === undefined || concurrencyRaw === null
      ? undefined
      : requireRecord(concurrencyRaw, 'data.concurrency')
  const dataScope = requireEnum(library['dataScope'], 'data.library.dataScope', ['project', 'user', 'custom'] as const)
  const backend = requireEnum(search['backend'], 'data.search.backend', ['bm25', 'semantic+bm25'] as const)
  const embeddingProvider = requireEnum(
    search['embeddingProvider'],
    'data.search.embeddingProvider',
    ['none', 'host', 'openai-compatible'] as const,
  )
  const obsidianState = requireEnum(
    obsidian['state'],
    'data.obsidian.state',
    ['unchecked', 'busy', 'ok', 'error'] as const,
  )
  const lastOperation = optionalEnum(
    obsidian['lastOperation'],
    'data.obsidian.lastOperation',
    ['status', 'preview', 'import', 'export'] as const,
  )
  const obsidianTimestampRaw = obsidian['timestamp']
  return {
    engine: requireInt(record['engine'], 'data.engine', 0, Number.MAX_SAFE_INTEGER),
    ...(concurrencyRecord === undefined
      ? {}
      : {
          concurrency: {
            mode: requireEnum(concurrencyRecord['mode'], 'data.concurrency.mode', [
              'single-writer',
              'multi-process',
            ] as const),
            lockBackend: requireEnum(concurrencyRecord['lockBackend'], 'data.concurrency.lockBackend', [
              'flock',
              'in-process',
            ] as const),
            crossProcess: requireBoolean(concurrencyRecord['crossProcess'], 'data.concurrency.crossProcess'),
            storageProtocol: requireInt(
              concurrencyRecord['storageProtocol'],
              'data.concurrency.storageProtocol',
              0,
              Number.MAX_SAFE_INTEGER,
            ),
          },
        }),
    library: {
      enabled: requireBoolean(library['enabled'], 'data.library.enabled'),
      records: requireInt(library['records'], 'data.library.records', 0, Number.MAX_SAFE_INTEGER),
      badLines: requireInt(library['badLines'], 'data.library.badLines', 0, Number.MAX_SAFE_INTEGER),
      vectors: requireInt(library['vectors'], 'data.library.vectors', 0, Number.MAX_SAFE_INTEGER),
      dataScope,
      files: requireInt(library['files'], 'data.library.files', 0, Number.MAX_SAFE_INTEGER),
    },
    search: {
      backend,
      embeddingProvider,
      embeddingConfigured: requireBoolean(search['embeddingConfigured'], 'data.search.embeddingConfigured'),
      fallbacks: requireInt(search['fallbacks'], 'data.search.fallbacks', 0, Number.MAX_SAFE_INTEGER),
    },
    sync: {
      available: requireBoolean(sync['available'], 'data.sync.available'),
      hasRemote: requireBoolean(sync['hasRemote'], 'data.sync.hasRemote'),
      dirty: requireBoolean(sync['dirty'], 'data.sync.dirty'),
      verified: requireBoolean(sync['verified'], 'data.sync.verified'),
      localSha: requireString(sync['localSha'], 'data.sync.localSha', 40),
    },
    obsidian: {
      state: obsidianState,
      ...(lastOperation !== undefined ? { lastOperation } : {}),
      ...(obsidianTimestampRaw === undefined || obsidianTimestampRaw === null
        ? {}
        : { timestamp: requireNumber(obsidianTimestampRaw, 'data.obsidian.timestamp') }),
    },
    receipts: requireArray(record['receipts'], 'data.receipts', 50).map((item, index) =>
      parseWriteReceipt(item, `data.receipts[${index}]`),
    ),
  }
}

export function parseSyncResponse(data: unknown): MemorySyncResponse {
  const record = requireRecord(data, 'data')
  return {
    committed: requireBoolean(record['committed'], 'data.committed'),
    localSha: requireString(record['localSha'], 'data.localSha', 40),
    remoteSha: requireString(record['remoteSha'], 'data.remoteSha', 40),
    verified: requireBoolean(record['verified'], 'data.verified'),
  }
}

export function parseReembedResponse(data: unknown): MemoryReembedResponse {
  const record = requireRecord(data, 'data')
  return {
    total: requireInt(record['total'], 'data.total', 0, Number.MAX_SAFE_INTEGER),
    embedded: requireInt(record['embedded'], 'data.embedded', 0, Number.MAX_SAFE_INTEGER),
    failed: requireInt(record['failed'], 'data.failed', 0, Number.MAX_SAFE_INTEGER),
  }
}

export function parseFeedbackResponse(data: unknown): MemoryRecallFeedbackResponse {
  const record = requireRecord(data, 'data')
  return {
    updated: requireBoolean(record['updated'], 'data.updated'),
    feedback: requireEnum(record['feedback'], 'data.feedback', ['helpful', 'irrelevant'] as const),
  }
}

function parseTreeNode(value: unknown, path: string): MemoryTreeNode {
  const record = requireRecord(value, path)
  return {
    id: requireNonEmptyString(record['id'], `${path}.id`, MAX_ID),
    title: requireString(record['title'], `${path}.title`, DEFAULT_PROJECTION_LIMITS.titleChars),
    kind: requireString(record['kind'], `${path}.kind`, MAX_KIND),
    importance: requireEnum(record['importance'], `${path}.importance`, IMPORTANCE_VALUES),
    ts: requireNumber(record['ts'], `${path}.ts`),
    childCount: requireInt(record['childCount'], `${path}.childCount`, 0, Number.MAX_SAFE_INTEGER),
    leaf: requireBoolean(record['leaf'], `${path}.leaf`),
  }
}

/** tree 响应（`api/memlite/browser/tree`）；`parentId` 缺省/`''` 表示根层。 */
export function parseTreeResponse(data: unknown): MemoryTreeResponse {
  const record = requireRecord(data, 'data')
  return {
    engine: requireInt(record['engine'], 'data.engine', 0, Number.MAX_SAFE_INTEGER),
    parentId: optionalString(record['parentId'], 'data.parentId', MAX_ID),
    nodes: requireArray(record['nodes'], 'data.nodes', MAX_TREE_NODES).map((node, index) =>
      parseTreeNode(node, `data.nodes[${index}]`),
    ),
    trimmed: record['trimmed'] === undefined ? false : requireBoolean(record['trimmed'], 'data.trimmed'),
  }
}

function parseHit(value: unknown, path: string): MemorySessionHit {
  const record = requireRecord(value, path)
  return {
    id: requireNonEmptyString(record['id'], `${path}.id`, MAX_ID),
    score: clampScore(requireNumber(record['score'], `${path}.score`)),
    title: requireString(record['title'], `${path}.title`, DEFAULT_PROJECTION_LIMITS.titleChars),
    injected: requireBoolean(record['injected'], `${path}.injected`),
    ...(() => {
      const exclusion = optionalEnum(record['exclusion'], `${path}.exclusion`, EXCLUSION_VALUES)
      return exclusion === undefined ? {} : { exclusion }
    })(),
    // 宿主补的字段；缺省按“仍存在”处理（宁可少报删除，不误报删除）。
    exists: record['exists'] === undefined ? true : requireBoolean(record['exists'], `${path}.exists`),
  }
}

function parseRecallEntry(value: unknown, path: string): MemorySessionRecall {
  const record = requireRecord(value, path)
  const optionalNumber = (key: string, max: number): number | undefined => {
    const raw = record[key]
    if (raw === undefined || raw === null) return undefined
    const value = requireNumber(raw, `${path}.${key}`)
    if (value < 0 || value > max) throw shapeError(`${path}.${key} 超出范围`)
    return value
  }
  const feedbackRaw = record['feedback']
  let feedback: Record<string, 'helpful' | 'irrelevant'> | undefined
  if (isRecord(feedbackRaw)) {
    feedback = {}
    for (const [key, raw] of Object.entries(feedbackRaw)) {
      if (raw === 'helpful' || raw === 'irrelevant') feedback[key.slice(0, MAX_ID)] = raw
    }
  }
  return {
    agentId: optionalString(record['agentId'], `${path}.agentId`, MAX_ID),
    turn: requireInt(record['turn'], `${path}.turn`, 0, Number.MAX_SAFE_INTEGER),
    messageId: optionalString(record['messageId'], `${path}.messageId`, MAX_ID),
    timestamp: requireNumber(record['timestamp'], `${path}.timestamp`),
    backend: optionalString(record['backend'], `${path}.backend`, MAX_BACKEND),
    fallback: optionalString(record['fallback'], `${path}.fallback`, MAX_BACKEND),
    status: requireEnum(record['status'], `${path}.status`, RECALL_STATUS_VALUES),
    ...(() => {
      const skipReason = optionalEnum(record['skipReason'], `${path}.skipReason`, SKIP_REASON_VALUES)
      return skipReason === undefined ? {} : { skipReason }
    })(),
    hits: requireArray(record['hits'], `${path}.hits`, MAX_RECALL_HITS).map((hit, index) =>
      parseHit(hit, `${path}.hits[${index}]`),
    ),
    ...(() => {
      const text = optionalString(record['injectedText'], `${path}.injectedText`, 20_000)
      return text === undefined ? {} : { injectedText: text }
    })(),
    ...(() => {
      const threshold = optionalNumber('threshold', 1000)
      return threshold === undefined ? {} : { threshold }
    })(),
    ...(() => {
      const value = optionalNumber('budgetChars', 1_000_000)
      return value === undefined ? {} : { budgetChars: value }
    })(),
    ...(() => {
      const value = optionalNumber('usedChars', 1_000_000)
      return value === undefined ? {} : { usedChars: value }
    })(),
    ...(() => {
      const value = optionalNumber('limit', 1000)
      return value === undefined ? {} : { limit: value }
    })(),
    ...(() => {
      const value = optionalNumber('elapsedMs', 1_000_000)
      return value === undefined ? {} : { elapsedMs: value }
    })(),
    ...(feedback !== undefined && Object.keys(feedback).length > 0 ? { feedback } : {}),
  }
}

/** session-recalls 响应（`api/memlite/browser/session-recalls`）。 */
export function parseSessionRecallsResponse(data: unknown): MemorySessionRecallsResponse {
  const record = requireRecord(data, 'data')
  const scope = record['scope'] === undefined ? 'session' : requireEnum(record['scope'], 'data.scope', ['session', 'agent'] as const)
  return {
    engine: requireInt(record['engine'], 'data.engine', 0, Number.MAX_SAFE_INTEGER),
    scope,
    entries: requireArray(record['entries'], 'data.entries', MAX_RECALL_ENTRIES).map((entry, index) =>
      parseRecallEntry(entry, `data.entries[${index}]`),
    ),
    trimmed: record['trimmed'] === undefined ? false : requireBoolean(record['trimmed'], 'data.trimmed'),
  }
}

/* -------------------------------------------------------------------------- */
/* 请求外壳                                                                    */
/* -------------------------------------------------------------------------- */

function truncateMessage(text: string): string {
  return text.slice(0, MAX_ERROR_MESSAGE)
}

function envelopeError(payload: Record<string, unknown>, httpStatus: number): MemoryApiError {
  const raw = payload['error']
  const message = typeof raw === 'string' && raw.trim() !== '' ? truncateMessage(raw) : ''
  // 只信宿主明确写出的 `disabled:true`：503 也可能是引擎暂不可用（可重试），不能都当禁用。
  const disabled = payload['disabled'] === true
  const businessCode =
    typeof payload['code'] === 'string' && payload['code'].trim() !== ''
      ? payload['code'].slice(0, 80)
      : undefined
  let receipt: MemoryWriteReceipt | undefined
  if (isRecord(payload['receipt'])) {
    try {
      receipt = parseWriteReceipt(payload['receipt'], 'receipt')
    } catch {
      receipt = undefined
    }
  }
  return new MemoryApiError(message === '' ? `请求失败（HTTP ${httpStatus}）` : message, {
    code: disabled ? 'disabled' : 'http',
    status: httpStatus,
    disabled,
    ...(businessCode !== undefined ? { businessCode } : {}),
    ...(receipt !== undefined ? { receipt } : {}),
  })
}

function parseEnvelope<T>(
  payload: unknown,
  httpStatus: number,
  parse: (data: unknown) => T,
): T {
  if (!isRecord(payload)) throw shapeError('响应外壳必须是对象')
  if (payload['ok'] === false) throw envelopeError(payload, httpStatus)
  if (!('data' in payload)) throw shapeError('响应外壳缺少 data')
  if (payload['ok'] !== true) throw shapeError('响应外壳缺少 ok:true')
  return parse(payload['data'])
}

/** 创建 document-relative 路由客户端；测试可注入假 `fetchImpl`。 */
export function createMemoryApi(fetchImpl?: typeof fetch): MemoryApi {
  const request = async <T>(
    route: keyof typeof MEMORY_BROWSER_PATHS,
    body: unknown,
    parse: (data: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> => {
    const impl = fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined)
    if (impl === undefined) {
      throw new MemoryApiError('当前环境不支持网络请求', { code: 'network' })
    }

    let response: Response
    try {
      response = await impl(MEMORY_BROWSER_PATHS[route], {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal,
      })
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw error
      throw new MemoryApiError(
        `网络请求失败：${error instanceof Error ? error.message : String(error)}`,
        { code: 'network', cause: error },
      )
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw error
      // 非 JSON 响应无法判断是否禁用：一律按「非禁用」处理（宿主总会回 JSON 外壳）。
      // 2xx 却不是 JSON = 契约违背（shape）；非 2xx = 可重试的 HTTP 失败。
      throw new MemoryApiError(`服务器返回的不是 JSON（HTTP ${response.status}）`, {
        code: response.ok ? 'shape' : 'http',
        status: response.status,
        cause: error,
      })
    }

    if (isRecord(payload) && payload['ok'] === false) throw envelopeError(payload, response.status)
    if (!response.ok) {
      throw new MemoryApiError(`请求失败（HTTP ${response.status}）`, {
        code: 'http',
        status: response.status,
      })
    }
    return parseEnvelope(payload, response.status, parse)
  }

  const write = async (
    route: keyof typeof MEMORY_BROWSER_PATHS,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<MemoryWriteReceipt> => {
    try {
      const data = await request(route, body, parseWriteResponse, signal)
      return data.receipt
    } catch (error) {
      // 业务拒绝/冲突/失败：宿主仍返回统一回执；交给面板显示，不丢弃草稿。
      if (error instanceof MemoryApiError && error.receipt !== undefined) return error.receipt
      throw error
    }
  }

  return {
    list: (req, signal) => request('list', req, parseListResponse, signal),
    search: (req, signal) => request('search', req, parseSearchResponse, signal),
    show: (req, signal) => request('show', req, parseShowResponse, signal),
    tree: (req, signal) => request('tree', req, parseTreeResponse, signal),
    sessionRecalls: (req, signal) =>
      request('sessionRecalls', req, parseSessionRecallsResponse, signal),
    status: (req, signal) => request('status', req, parseStatusResponse, signal),
    remember: (req, signal) => write('remember', req, signal),
    update: (req, signal) => write('update', req, signal),
    attach: (req, signal) => write('attach', req, signal),
    forget: (req, signal) => write('forget', req, signal),
    feedback: (req, signal) => request('feedback', req, parseFeedbackResponse, signal),
    sync: (req, signal) => request('sync', req, parseSyncResponse, signal),
    reembed: (req, signal) => request('reembed', req, parseReembedResponse, signal),
  }
}
