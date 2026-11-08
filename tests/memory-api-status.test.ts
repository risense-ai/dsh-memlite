/**
 * 路由客户端状态判别回归（M8 验收发现）：
 * 503 只有宿主明确 `disabled:true` 时才算「已禁用」；引擎异常的 500/503 必须按可重试失败处理，
 * 否则面板会显示「memlite 已禁用」且不给重试。
 */
import { describe, expect, it } from 'vitest'
import { MemoryApiError, createMemoryApi } from '../src/client/memory-api'
import { MEMORY_BROWSER_PATHS } from '../src/browser-contract'

function fakeFetch(response: { status: number; body: unknown }): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

async function capture(promise: Promise<unknown>): Promise<MemoryApiError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof MemoryApiError) return error
    throw error
  }
  throw new Error('expected rejection')
}

describe('memory api 禁用态判别', () => {
  it('503 + disabled:true 才算禁用（面板显示禁用态）', async () => {
    const api = createMemoryApi(
      fakeFetch({ status: 503, body: { ok: false, error: 'memlite 已禁用', disabled: true } }),
    )
    const error = await capture(api.list({}))
    expect(error.code).toBe('disabled')
    expect(error.disabled).toBe(true)
    expect(error.status).toBe(503)
  })

  it('503 但无 disabled 标记 → 可重试失败（不是禁用）', async () => {
    const api = createMemoryApi(
      fakeFetch({ status: 503, body: { ok: false, error: '记忆引擎暂时不可用' } }),
    )
    const error = await capture(api.list({}))
    expect(error.code).toBe('http')
    expect(error.disabled).toBe(false)
    expect(error.status).toBe(503)
    expect(error.message).toContain('记忆引擎')
  })

  it('500 引擎失败 → http 错误且不带禁用标志', async () => {
    const api = createMemoryApi(
      fakeFetch({ status: 500, body: { ok: false, error: '记忆引擎暂时不可用' } }),
    )
    const error = await capture(api.sessionRecalls({ sessionId: 's1' }))
    expect(error.code).toBe('http')
    expect(error.disabled).toBe(false)
    expect(error.status).toBe(500)
  })

  it('非 JSON 响应 → 可重试 http 错误（不是禁用）', async () => {
    const api = createMemoryApi(
      (async () => new Response('<html>proxy error</html>', { status: 503 })) as unknown as typeof fetch,
    )
    const error = await capture(api.tree({}))
    expect(error.code).toBe('http')
    expect(error.disabled).toBe(false)
    expect(error.status).toBe(503)
  })

  it('请求体走 document-relative 路径 + credentials include', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const api = createMemoryApi((async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(
        JSON.stringify({
          ok: true,
          data: { engine: 1, items: [], nextCursor: null, total: 0, projects: [], tags: [] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch)
    await api.list({ limit: 5 })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(MEMORY_BROWSER_PATHS.list)
    expect(calls[0]?.url.startsWith('/')).toBe(false)
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.credentials).toBe('include')
  })
})
