/**
 * DSH 会话历史导入：配置页使用的精确 HTTP 路由。
 *
 * 与 Obsidian 桥同构：经宿主 `connection.fetch` 注册在 `/api/memlite/session/*`，
 * 浏览器认证、Host/Origin 信任栅栏与 owner Peer 校验由宿主负责（不另建鉴权）。
 * - 只接受 POST + application/json；请求体小（路径与选项），走 buffered。
 * - 两条路由共享**同一把** busy 锁：导入与列出会话都会读会话目录，避免两个任务互相踩；
 *   冲突回 409 安全文案。
 * - 已知 HttpError 用其状态码与安全文案；其余异常统一 400（不回堆栈/路径细节）。
 */
import type { Memlite } from '@rsrsai/memlite'
import {
  formatSessionImportReport,
  formatSessionList,
  importDshSessionsWith,
  listDshSessions,
  resolveSessionsRoot,
} from '../session-import'
import {
  HttpError,
  errorText,
  json,
  optionalBoolean,
  optionalInteger,
  optionalString,
  readJson,
  type ConnectionService,
  type FetchRoute,
} from '../http'

export const SESSION_IMPORT_PATH = '/api/memlite/session/import'
export const SESSION_LIST_PATH = '/api/memlite/session/list'

/** 配置页使用的 document-relative 路径（与官方文件上传一致，去掉前导斜杠）。 */
export const SESSION_CLIENT_PATHS = {
  import: SESSION_IMPORT_PATH.slice(1),
  list: SESSION_LIST_PATH.slice(1),
} as const

/** 会话目录根最多 1000 字符（与 resolveSessionsRoot 的守卫一致）。 */
const MAX_ROOT_CHARS = 1000
const MAX_PATH_CHARS = 1000
const MAX_SESSION_ID_CHARS = 200
const MAX_SINCE_CHARS = 100
/** 会话数硬上限（与契约第五节一致）。 */
const MAX_LIMIT = 200

/** 两条路由共享一个 busy 锁。 */
const BUSY_MESSAGE = '另一个会话导入操作尚未完成，请稍后再试'

/** 请求体解析后的选项（布尔字段为 undefined 时交给核心模块的默认值）。 */
interface SessionRouteOptions {
  root?: string
  cwd?: string
  project?: string
  sessionId?: string
  limit?: number
  since?: string | number
  explicit?: boolean
  summary?: boolean
  facts: boolean
  dryRun: boolean
}

/** 三态布尔：缺省/空 → undefined（保留核心默认值），非布尔 → 400。 */
function optionalBooleanTriState(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  return optionalBoolean(value, field)
}

/** `since`：ISO 字符串或 epoch 数字；其余类型 → 400。 */
function optionalSince(value: unknown): string | number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return optionalString(value, 'since', MAX_SINCE_CHARS)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new HttpError(400, 'since 必须是字符串或数字')
    return value
  }
  throw new HttpError(400, 'since 必须是字符串或数字')
}

/** 请求体 → 导入/列表选项（全部字段可选；形状与长度错误回 400）。 */
function parseSessionOptions(body: Record<string, unknown>): SessionRouteOptions {
  const limit = optionalInteger(body['limit'], 'limit')
  if (limit !== undefined && (limit < 1 || limit > MAX_LIMIT)) {
    throw new HttpError(400, `limit 必须在 1..${MAX_LIMIT} 之间`)
  }
  return {
    root: optionalString(body['root'], 'root', MAX_ROOT_CHARS),
    cwd: optionalString(body['cwd'], 'cwd', MAX_PATH_CHARS),
    project: optionalString(body['project'], 'project'),
    sessionId: optionalString(body['sessionId'], 'sessionId', MAX_SESSION_ID_CHARS),
    limit,
    since: optionalSince(body['since']),
    explicit: optionalBooleanTriState(body['explicit'], 'explicit'),
    summary: optionalBooleanTriState(body['summary'], 'summary'),
    facts: optionalBoolean(body['facts'], 'facts'),
    dryRun: optionalBoolean(body['dryRun'], 'dryRun'),
  }
}

export interface SessionHttpHandlers {
  import(request: Request): Promise<Response>
  list(request: Request): Promise<Response>
}

/**
 * 建立一组会话路由 handler；`getMem` 每次调用取当前引擎
 * （配置热更新重建后仍指向新实例）。
 */
export function createSessionImportHandlers(getMem: () => Memlite): SessionHttpHandlers {
  let busy = false

  const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (busy) throw new HttpError(409, BUSY_MESSAGE)
    busy = true
    try {
      return await operation()
    } finally {
      busy = false
    }
  }

  const respond = async (
    operation: () => Promise<{ text: string; report: Record<string, unknown> }>,
  ): Promise<Response> => {
    try {
      const result = await exclusive(operation)
      return json({ ok: true, text: result.text, report: result.report })
    } catch (error) {
      if (error instanceof HttpError) return json({ ok: false, error: error.message }, error.status)
      return json({ ok: false, error: errorText(error) }, 400)
    }
  }

  return {
    import(request) {
      return respond(async () => {
        const options = parseSessionOptions(await readJson(request))
        const dryRun = options.dryRun
        const report = await importDshSessionsWith(getMem(), options)
        return {
          text: formatSessionImportReport(report, dryRun),
          report: {
            dryRun,
            sessionsScanned: report.sessionsScanned,
            sessionsSkipped: report.sessionsSkipped,
            events: report.events,
            candidates: report.candidates,
            created: report.created,
            updated: report.updated,
            unchanged: report.unchanged,
            skipped: report.skipped,
            warnings: report.warnings,
            wouldCreate: report.wouldCreate,
            wouldUpdate: report.wouldUpdate,
          },
        }
      })
    },
    list(request) {
      return respond(async () => {
        const options = parseSessionOptions(await readJson(request))
        const root = resolveSessionsRoot(options.root)
        const sessions = listDshSessions({
          root,
          cwd: options.cwd,
          sessionId: options.sessionId,
          limit: options.limit,
          since: options.since,
        })
        return {
          text: formatSessionList(sessions, root),
          report: { sessions: sessions.length },
        }
      })
    },
  }
}

/** 注册两条精确路由；返回 disposers（由调用方放进清理列表）。 */
export function registerSessionRoutes(
  connection: ConnectionService,
  handlers: SessionHttpHandlers,
): Array<() => void> {
  const routes: FetchRoute[] = [
    {
      path: SESSION_IMPORT_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handlers.import(request),
    },
    {
      path: SESSION_LIST_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handlers.list(request),
    },
  ]
  return routes.map((route) => connection.fetch.register(route))
}
