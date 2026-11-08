/**
 * 记忆浏览器只读路由（M8a/M8b/M8c Host 半区）。
 *
 * 经 DSH `connection.fetch` 注册在 `/api/memlite/browser/*`：
 * 浏览器认证、Host/Origin 信任栅栏、owner Peer 校验由宿主负责（与 Obsidian 路由同一套）。
 * 本文件只做：入参形状/长度/上限校验 → 调用 `browse` / `recall-ledger` → 白名单 JSON。
 *
 * 红线：不读 JSONL；不返回正文（show 除外且限长）；不返回向量/凭据/querylog/本地路径；
 * 未预期异常只回通用文案（细节写宿主日志）。
 */
import type { Memlite } from '@rsrsai/memlite'
import {
  MEMORY_BROWSER_PATHS,
  type MemoryApiResponse,
  type MemoryImportance,
  type MemoryListResponse,
  type MemorySearchResponse,
  type MemorySessionRecallsResponse,
  type MemoryShowResponse,
  type MemoryTreeResponse,
} from './browser-contract'
import {
  MAX_LIST_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_TREE_LIMIT,
  decodeCursor,
  listMemories,
  searchMemories,
  showMemory,
  treeLayer,
} from './browse'
import { HttpError, json, optionalInteger, optionalString, readJson } from './http'
import type { RecallLedger } from './recall-ledger'
import type { ConnectionService, FetchRoute } from './obsidian'

/** 浏览器请求体上限（与 Obsidian 路由一致）。 */
const MAX_BODY_BYTES = 64 * 1024

export interface MemoryRouteDeps {
  /** 每次调用取当前引擎（配置热更新重建后自动指向新实例）。 */
  getMem(): Memlite
  /** 引擎代次（配置结构性变化重建后 +1）。 */
  getGeneration(): number
  /** 总开关；关闭时路由统一回 503 + disabled（不读库）。 */
  isEnabled(): boolean
  /** 会话召回账本（M8c）。 */
  ledger: RecallLedger
  /** 宿主日志（未预期异常只记这里，不回给浏览器）。 */
  log?(message: string): void
}

type Handler = (request: Request) => Promise<Response>

function success<T>(data: T): Response {
  const body: MemoryApiResponse<T> = { ok: true, data }
  return json(body)
}

function failure(message: string, status: number, disabled = false): Response {
  const body: MemoryApiResponse<never> = disabled
    ? { ok: false, error: message, disabled: true }
    : { ok: false, error: message }
  return json(body, status)
}

/**
 * 统一包装：开关检查 → body 解析 → 操作 → 外壳。
 * 已知 HttpError 用其安全文案与状态；未预期异常回通用文案（细节走 log）。
 */
function route(deps: MemoryRouteDeps, operation: (body: Record<string, unknown>) => Response | Promise<Response>): Handler {
  return async (request: Request): Promise<Response> => {
    if (!deps.isEnabled()) return failure('memlite 已禁用', 503, true)
    try {
      const body = await readJson(request, MAX_BODY_BYTES)
      return await operation(body)
    } catch (error) {
      if (error instanceof HttpError) return failure(error.message, error.status)
      deps.log?.(`memlite: 记忆浏览器路由失败: ${error instanceof Error ? error.message : String(error)}`)
      // 引擎异常用 500（503 只保留给「插件已禁用」，客户端据此区分禁用与失败）。
      return failure('记忆引擎暂时不可用', 500)
    }
  }
}

function requireText(value: unknown, field: string, max: number): string {
  const text = optionalString(value, field, max)
  if (text === undefined) throw new HttpError(400, `${field} 不能为空`)
  return text
}

function requireLimit(value: unknown, field: string, max: number, fallback: number): number {
  const limit = optionalInteger(value, field)
  if (limit === undefined) return fallback
  if (limit < 1 || limit > max) throw new HttpError(400, `${field} 必须在 1..${max} 之间`)
  return limit
}

function optionalImportance(value: unknown): MemoryImportance | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (value !== 'important' && value !== 'trivial') {
    throw new HttpError(400, 'importance 必须是 important/trivial')
  }
  return value
}

const MAX_ID_CHARS = 200
const MAX_QUERY_CHARS = 500
const MAX_SESSION_LIMIT = 100

/** list：项目/标签/重要性筛选 + keyset 游标分页。 */
export function createMemoryListHandler(deps: MemoryRouteDeps): Handler {
  return route(deps, (body) => {
    const mem = deps.getMem()
    const project = optionalString(body['project'], 'project', 100)
    const tag = optionalString(body['tag'], 'tag', 80)
    const importance = optionalImportance(body['importance'])
    const cursor = optionalString(body['cursor'], 'cursor', 300)
    if (cursor !== undefined && decodeCursor(cursor) === undefined) {
      throw new HttpError(400, 'cursor 无效')
    }
    const limit = requireLimit(body['limit'], 'limit', MAX_LIST_LIMIT, 20)
    const data: MemoryListResponse = {
      engine: deps.getGeneration(),
      ...listMemories(mem, { project, tag, importance, cursor, limit }),
    }
    return success(data)
  })
}

/** search：语义/词面召回（bounded），只投影摘要字段。 */
export function createMemorySearchHandler(deps: MemoryRouteDeps): Handler {
  return route(deps, async (body) => {
    const query = requireText(body['query'], 'query', MAX_QUERY_CHARS)
    const project = optionalString(body['project'], 'project', 100)
    const limit = requireLimit(body['limit'], 'limit', MAX_SEARCH_LIMIT, 10)
    const mem = deps.getMem()
    const data: MemorySearchResponse = {
      engine: deps.getGeneration(),
      ...(await searchMemories(mem, { query, project, limit })),
    }
    return success(data)
  })
}

/** show：单条全文 + 因果邻居 + 有界完整链；已删除条目 found=false。 */
export function createMemoryShowHandler(deps: MemoryRouteDeps): Handler {
  return route(deps, (body) => {
    const id = requireText(body['id'], 'id', MAX_ID_CHARS)
    const mem = deps.getMem()
    const data: MemoryShowResponse = {
      engine: deps.getGeneration(),
      ...showMemory(mem, id),
    }
    return success(data)
  })
}

/** tree：逐层取子条，不返回全深树。 */
export function createMemoryTreeHandler(deps: MemoryRouteDeps): Handler {
  return route(deps, (body) => {
    const parentId = optionalString(body['parentId'], 'parentId', MAX_ID_CHARS)
    const project = optionalString(body['project'], 'project', 100)
    const limit = requireLimit(body['limit'], 'limit', MAX_TREE_LIMIT, 100)
    const mem = deps.getMem()
    if (parentId !== undefined && mem.store.resolve(parentId) === undefined) {
      throw new HttpError(400, '父节点不存在')
    }
    const data: MemoryTreeResponse = {
      engine: deps.getGeneration(),
      ...treeLayer(mem, { parentId, project, limit }),
    }
    return success(data)
  })
}

/** session-recalls：读召回账本，并按当前库补 exists（原记忆已删除标记）。 */
export function createMemorySessionRecallsHandler(deps: MemoryRouteDeps): Handler {
  return route(deps, (body) => {
    const sessionId = optionalString(body['sessionId'], 'sessionId', MAX_ID_CHARS)
    const agentId = optionalString(body['agentId'], 'agentId', MAX_ID_CHARS)
    if (sessionId === undefined && agentId === undefined) {
      throw new HttpError(400, 'sessionId 与 agentId 至少给一个')
    }
    const limit = requireLimit(body['limit'], 'limit', MAX_SESSION_LIMIT, 30)
    const listed = deps.ledger.list({ sessionId, agentId, limit })
    let mem: Memlite | undefined
    const entries = listed.entries.map((entry) => ({
      ...entry,
      hits: entry.hits.map((hit) => {
        let exists = true
        try {
          mem ??= deps.getMem()
          exists = mem.store.get(hit.id) !== undefined
        } catch {
          exists = true // 引擎异常不把历史标成已删除
        }
        return { ...hit, exists }
      }),
    }))
    const data: MemorySessionRecallsResponse = {
      engine: deps.getGeneration(),
      scope: listed.scope,
      entries,
      trimmed: listed.trimmed,
    }
    return success(data)
  })
}

/** 五条精确路由（host 侧带前导斜杠，浏览器侧用 document-relative 路径）。 */
export function memoryRoutes(deps: MemoryRouteDeps): FetchRoute[] {
  const register = (path: string, handler: Handler): FetchRoute => ({
    path: `/${path}`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: handler,
  })
  return [
    register(MEMORY_BROWSER_PATHS.list, createMemoryListHandler(deps)),
    register(MEMORY_BROWSER_PATHS.search, createMemorySearchHandler(deps)),
    register(MEMORY_BROWSER_PATHS.show, createMemoryShowHandler(deps)),
    register(MEMORY_BROWSER_PATHS.tree, createMemoryTreeHandler(deps)),
    register(MEMORY_BROWSER_PATHS.sessionRecalls, createMemorySessionRecallsHandler(deps)),
  ]
}

/** 注册五条路由；返回 disposers（调用方放进清理列表）。 */
export function registerMemoryRoutes(connection: ConnectionService, deps: MemoryRouteDeps): Array<() => void> {
  return memoryRoutes(deps).map((route) => connection.fetch.register(route))
}
