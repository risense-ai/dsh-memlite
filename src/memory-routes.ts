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
  type MemoryRecallFeedbackResponse,
  type MemoryReembedResponse,
  type MemorySearchResponse,
  type MemorySessionRecallsResponse,
  type MemoryShowResponse,
  type MemoryStatusResponse,
  type MemorySyncResponse,
  type MemoryTreeResponse,
  type MemoryWriteReceipt,
  type MemoryWriteScope,
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
import type { MemoryWriteService } from './memory-write-service'
import type { SyncActivity } from './memory-status'
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
  /** 会话召回账本（M8c/M10）。 */
  ledger: RecallLedger
  /** 写服务（M9b）。 */
  write: MemoryWriteService
  /** 状态投影（M11）。 */
  status(scope: MemoryWriteScope): Promise<MemoryStatusResponse>
  /** 最近一次显式同步的核验状态。 */
  syncActivity: SyncActivity
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

const MAX_OPERATION_ID = 100
const MAX_CONTENT_CHARS = 20_000
const MAX_TAGS = 10
const MAX_TAG_CHARS = 80

function requireOperationId(value: unknown): string {
  const text = optionalString(value, 'operationId', MAX_OPERATION_ID)
  if (text === undefined || !/^[A-Za-z0-9._:-]{8,100}$/u.test(text)) {
    throw new HttpError(400, 'operationId 格式无效')
  }
  return text
}

function requireRevision(value: unknown, field = 'expectedRevision'): number {
  const revision = optionalInteger(value, field)
  if (revision === undefined || revision < 0) {
    throw new HttpError(400, `${field} 必须是非负整数`)
  }
  return revision
}

function requireContent(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, 'content 不能为空')
  if (value.length > MAX_CONTENT_CHARS) throw new HttpError(413, 'content 过长')
  return value
}

function optionalTags(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new HttpError(400, 'tags 必须是数组')
  if (value.length > MAX_TAGS) throw new HttpError(400, `tags 最多 ${MAX_TAGS} 个`)
  return value.map((tag) => {
    if (typeof tag !== 'string') throw new HttpError(400, 'tags 必须是字符串数组')
    const text = tag.trim()
    if (text === '') throw new HttpError(400, 'tags 不能为空串')
    if (text.length > MAX_TAG_CHARS) throw new HttpError(400, 'tag 过长')
    return text
  })
}

function optionalScope(body: Record<string, unknown>): MemoryWriteScope {
  const sessionId = optionalString(body['sessionId'], 'sessionId', 200)
  const agentId = optionalString(body['agentId'], 'agentId', 200)
  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
  }
}

/** 写操作统一出口：成功 200；冲突 409；拒绝 400；失败/未确认 500。 */
function writeResponse(receipt: MemoryWriteReceipt): Response {
  if (receipt.status === 'conflict') {
    return json(
      { ok: false, error: receipt.message ?? '版本冲突', code: receipt.code ?? 'STALE_VERSION', receipt },
      409,
    )
  }
  if (receipt.status === 'rejected') {
    return json({ ok: false, error: receipt.message ?? '请求被拒绝', code: receipt.code ?? 'REJECTED', receipt }, 400)
  }
  if (receipt.status === 'failed' || receipt.status === 'unconfirmed') {
    return json({ ok: false, error: receipt.message ?? '操作未完成', code: receipt.code ?? 'ENGINE', receipt }, 500)
  }
  return json({ ok: true, data: { receipt } })
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

/** status：库/检索/同步/Obsidian/回执安全投影。 */
export function createMemoryStatusHandler(deps: MemoryRouteDeps): Handler {
  return route(deps, async (body) => {
    const data = await deps.status(optionalScope(body))
    return success(data)
  })
}

/** remember：新建 + 读回；operationId 幂等。 */
export function createMemoryRememberHandler(deps: MemoryRouteDeps): Handler {
  return route(deps, async (body) => {
    const operationId = requireOperationId(body['operationId'])
    const content = requireContent(body['content'])
    const title = optionalString(body['title'], 'title', 200) ?? ''
    const tags = optionalTags(body['tags'])
    const project = optionalString(body['project'], 'project', 100)
    const importance = optionalImportance(body['importance'])
    const parentId = optionalString(body['parentId'], 'parentId', MAX_ID_CHARS)
    const response = await deps.write.remember(
      {
        operationId,
        title,
        content,
        ...(tags !== undefined ? { tags } : {}),
        ...(project !== undefined ? { project } : {}),
        ...(importance === 'important' || importance === 'trivial' ? { importance } : {}),
        ...(parentId !== undefined ? { parentId } : {}),
      },
      optionalScope(body),
    )
    return writeResponse(response.receipt)
  })
}

/** update：编辑标题/正文/标签/重要性；expectedRevision 条件写。 */
export function createMemoryUpdateHandler(deps: MemoryRouteDeps): Handler {
  return route(deps, async (body) => {
    const operationId = requireOperationId(body['operationId'])
    const id = requireText(body['id'], 'id', MAX_ID_CHARS)
    const expectedRevision = requireRevision(body['expectedRevision'])
    const title = optionalString(body['title'], 'title', 200)
    const content = body['content'] === undefined ? undefined : requireContent(body['content'])
    const tags = optionalTags(body['tags'])
    const importance = 'importance' in body ? (optionalImportance(body['importance']) ?? '') : undefined
    const response = await deps.write.update(
      {
        operationId,
        id,
        expectedRevision,
        ...(title !== undefined ? { title } : {}),
        ...(content !== undefined ? { content } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(importance !== undefined ? { importance } : {}),
      },
      optionalScope(body),
    )
    return writeResponse(response.receipt)
  })
}

/** attach：改挂因果（空 parentId=升根）；expectedRevision 条件写。 */
export function createMemoryAttachHandler(deps: MemoryRouteDeps): Handler {
  return route(deps, (body) => {
    const operationId = requireOperationId(body['operationId'])
    const id = requireText(body['id'], 'id', MAX_ID_CHARS)
    const expectedRevision = requireRevision(body['expectedRevision'])
    const parentId = optionalString(body['parentId'], 'parentId', MAX_ID_CHARS) ?? ''
    const response = deps.write.attach(
      { operationId, id, expectedRevision, parentId },
      optionalScope(body),
    )
    return writeResponse(response.receipt)
  })
}

/** forget：确认标题 + 条件写；删除后读回不存在。 */
export function createMemoryForgetHandler(deps: MemoryRouteDeps): Handler {
  return route(deps, (body) => {
    const operationId = requireOperationId(body['operationId'])
    const id = requireText(body['id'], 'id', MAX_ID_CHARS)
    const expectedRevision = requireRevision(body['expectedRevision'])
    const confirmTitle = requireText(body['confirmTitle'], 'confirmTitle', 200)
    const response = deps.write.forget(
      { operationId, id, expectedRevision, confirmTitle },
      optionalScope(body),
    )
    return writeResponse(response.receipt)
  })
}

/** recall-feedback：只接受账本里已有的 id；不自动调权。 */
export function createMemoryRecallFeedbackHandler(deps: MemoryRouteDeps): Handler {
  return route(deps, (body) => {
    const sessionId = optionalString(body['sessionId'], 'sessionId', 200)
    const agentId = optionalString(body['agentId'], 'agentId', 200)
    if (sessionId === undefined && agentId === undefined) {
      throw new HttpError(400, 'sessionId 与 agentId 至少给一个')
    }
    const turn = requireRevision(body['turn'], 'turn')
    const messageId = requireText(body['messageId'], 'messageId', MAX_ID_CHARS)
    const memoryId = requireText(body['memoryId'], 'memoryId', MAX_ID_CHARS)
    const feedback = body['feedback']
    if (feedback !== 'helpful' && feedback !== 'irrelevant') {
      throw new HttpError(400, 'feedback 必须是 helpful/irrelevant')
    }
    const updated = deps.ledger.setFeedback({
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
      turn,
      messageId,
      memoryId,
      feedback,
    })
    if (!updated) throw new HttpError(404, '反馈目标不存在或已过期')
    const data: MemoryRecallFeedbackResponse = { updated, feedback }
    return success(data)
  })
}

/** 同一时刻只允许一个同步/回填任务。 */
let syncBusy = false
let reembedBusy = false

/** sync：显式触发 git 同步；结果只给四字段。 */
export function createMemorySyncHandler(deps: MemoryRouteDeps): Handler {
  return route(deps, async () => {
    if (syncBusy) throw new HttpError(409, '同步正在进行，请稍后再试')
    syncBusy = true
    try {
      let report: Awaited<ReturnType<Memlite['sync']>>
      try {
        report = await deps.getMem().sync()
      } catch (error) {
        deps.log?.(`memlite: 同步失败: ${error instanceof Error ? error.message : String(error)}`)
        throw new HttpError(400, '同步未完成：请检查 git 仓库与 origin 配置。')
      }
      deps.syncActivity.record(report.verified === true)
      const data: MemorySyncResponse = {
        committed: report.committed === true,
        localSha: String(report.local_sha ?? '').slice(0, 12),
        remoteSha: String(report.remote_sha ?? '').slice(0, 12),
        verified: report.verified === true,
      }
      return success(data)
    } finally {
      syncBusy = false
    }
  })
}

/** reembed：回填缺失向量；只回计数，不回失败原文。 */
export function createMemoryReembedHandler(deps: MemoryRouteDeps): Handler {
  return route(deps, async () => {
    if (reembedBusy) throw new HttpError(409, '回填正在进行，请稍后再试')
    reembedBusy = true
    try {
      let result: Awaited<ReturnType<Memlite['reembed']>>
      try {
        result = await deps.getMem().reembed()
      } catch (error) {
        if (error instanceof Error && error.message.includes('嵌入档未开启')) {
          throw new HttpError(400, '嵌入档未启用')
        }
        throw error
      }
      const data: MemoryReembedResponse = {
        total: result.total,
        embedded: result.embedded,
        failed: result.failed,
      }
      return success(data)
    } finally {
      reembedBusy = false
    }
  })
}

/** 精确路由（host 侧带前导斜杠，浏览器侧用 document-relative 路径）。 */
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
    register(MEMORY_BROWSER_PATHS.status, createMemoryStatusHandler(deps)),
    register(MEMORY_BROWSER_PATHS.remember, createMemoryRememberHandler(deps)),
    register(MEMORY_BROWSER_PATHS.update, createMemoryUpdateHandler(deps)),
    register(MEMORY_BROWSER_PATHS.attach, createMemoryAttachHandler(deps)),
    register(MEMORY_BROWSER_PATHS.forget, createMemoryForgetHandler(deps)),
    register(MEMORY_BROWSER_PATHS.feedback, createMemoryRecallFeedbackHandler(deps)),
    register(MEMORY_BROWSER_PATHS.sync, createMemorySyncHandler(deps)),
    register(MEMORY_BROWSER_PATHS.reembed, createMemoryReembedHandler(deps)),
  ]
}

/** 注册五条路由；返回 disposers（调用方放进清理列表）。 */
export function registerMemoryRoutes(connection: ConnectionService, deps: MemoryRouteDeps): Array<() => void> {
  return memoryRoutes(deps).map((route) => connection.fetch.register(route))
}
