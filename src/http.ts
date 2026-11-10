/**
 * 宿主 HTTP 小工具：Obsidian 桥、DSH 会话导入与记忆浏览器路由共用。
 *
 * 只服务 `connection.fetch` 的精确路由：同样是「只接受 POST + application/json、
 * 请求体有上限、错误只回安全文案」这一套，避免多条路由各自漂移。
 */

export const MAX_REQUEST_BYTES = 64 * 1024

/** 宿主 `connection.fetch` 精确路由的形状（dsh-client-connection Host 面）。 */
export interface FetchRoute {
  path: string
  methods: string[]
  requestBody?: 'buffered' | 'streaming'
  fetch(request: Request): Promise<Response> | Response
}

/** 宿主侧 connection 服务的最小子集（只用到精确路由注册）。 */
export interface ConnectionService {
  fetch: {
    register(route: FetchRoute): () => void
  }
}

/** 路由内部错误：status 决定 HTTP 状态码，message 是可以回给浏览器的安全文案。 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

/** 读取并校验 JSON 对象请求体；超限/非 JSON/非对象都转成 4xx 安全文案。 */
export async function readJson(
  request: Request,
  maxBytes = MAX_REQUEST_BYTES,
): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, '请求体过大')
  }
  let text: string
  try {
    text = await request.text()
  } catch {
    throw new HttpError(400, '读取请求体失败')
  }
  // 按 UTF-8 字节数计（text.length 是 UTF-16 码元，中文会被低估约 3 倍）
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new HttpError(413, '请求体过大')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, '请求体必须是对象')
  }
  return parsed as Record<string, unknown>
}

/** 可选字符串：缺省/空串 → undefined；非字符串/超长 → 400。 */
export function optionalString(value: unknown, field: string, max = 200): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new HttpError(400, `${field} 必须是字符串`)
  const text = value.trim()
  if (text === '') return undefined
  if (text.length > max) throw new HttpError(400, `${field} 过长`)
  return text
}

/** 可选布尔：缺省/空 → false；非布尔 → 400。 */
export function optionalBoolean(value: unknown, field: string): boolean {
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') throw new HttpError(400, `${field} 必须是布尔值`)
  return value
}

/** 可选整数：缺省 → undefined；非整数 → 400；范围校验交给调用方（clamp 或拒绝）。 */
export function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new HttpError(400, `${field} 必须是整数`)
  }
  return value
}
