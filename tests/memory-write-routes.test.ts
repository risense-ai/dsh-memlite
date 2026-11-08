/**
 * M9b/M11 写入与状态路由测试：
 * - remember 新建 + 读回 + operationId 幂等；
 * - update 条件写成功/冲突（409 + STALE_VERSION + 当前投影）；
 * - attach 改挂与读回；forget 确认标题与删除验证；
 * - 敏感闸拒绝、status 白名单、feedback 边界。
 *
 * 种子直接经 Memlite 主类写入同一 dataDir，插件随后加载（与 memory-routes.test 同法）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index'
import {
  MEMORY_BROWSER_PATHS,
  type MemorySessionRecallsResponse,
  type MemoryShowResponse,
  type MemoryStatusResponse,
  type MemoryWriteResponse,
} from '../src/browser-contract'
import type { ConfigRef, PluginConfig } from '../src/schema'
import { resolveConfig } from '../src/schema'
import { createTestHost, dispatchPreStep, type TestHost } from './harness'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.dispose()
})

interface Setup {
  host: TestHost
  config: { ref: ConfigRef; set(patch: Partial<PluginConfig>): void }
}

async function setup(overrides: Partial<PluginConfig> = {}): Promise<Setup> {
  const host = await createTestHost()
  hosts.push(host)
  let current = resolveConfig({
    sync: { auto: false },
    embedding: { provider: 'none' },
    dataDir: host.dataDir,
    ...overrides,
  })
  const config = {
    ref: { get: () => current } as ConfigRef,
    set(patch: Partial<PluginConfig>) {
      current = { ...current, ...patch }
    },
  }
  host.cleanup = apply(host.ctx as never, config.ref)
  await new Promise((resolve) => setTimeout(resolve, 10))
  return { host, config }
}

async function post<T>(
  host: TestHost,
  path: string,
  body: unknown,
): Promise<{ status: number; json: { ok?: boolean; data?: T; error?: string; code?: string; receipt?: MemoryWriteResponse['receipt'] } }> {
  const request = new Request(`http://127.0.0.1/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const response = await host.connection.invoke(`/${path}`, request)
  return {
    status: response.status,
    json: (await response.json()) as {
      ok?: boolean
      data?: T
      error?: string
      code?: string
      receipt?: MemoryWriteResponse['receipt']
    },
  }
}

function op(prefix: string): string {
  return `${prefix}-0000-4000-8000-000000000000`
}

describe('remember / update / attach / forget', () => {
  it('新建成功：回执 verified、详情 revision=0、正文读回一致', async () => {
    const { host } = await setup()
    const created = await post<MemoryWriteResponse>(host, MEMORY_BROWSER_PATHS.remember, {
      operationId: op('remember'),
      title: '新记忆',
      content: '正文第一行\n正文第二行',
      tags: ['tag-a'],
      importance: 'important',
      project: 'proj',
    })
    expect(created.status).toBe(200)
    const receipt = created.json.data?.receipt
    expect(receipt?.status).toBe('saved')
    expect(receipt?.verified).toBe(true)
    expect(receipt?.embedded).toBe('disabled')

    const shown = await post<MemoryShowResponse>(host, MEMORY_BROWSER_PATHS.show, { id: receipt?.id })
    expect(shown.json.data?.record?.content).toBe('正文第一行\n正文第二行')
    expect(shown.json.data?.record?.revision).toBe(0)
    expect(shown.json.data?.record?.importance).toBe('important')

    // operationId 幂等：重复请求返回同一回执，不新建第二条。
    const repeated = await post<MemoryWriteResponse>(host, MEMORY_BROWSER_PATHS.remember, {
      operationId: op('remember'),
      title: '新记忆',
      content: '正文第一行\n正文第二行',
    })
    expect(repeated.json.data?.receipt?.id).toBe(receipt?.id)
    const status = await post<MemoryStatusResponse>(host, MEMORY_BROWSER_PATHS.status, {
      sessionId: 's-1',
    })
    expect(status.json.data?.library.records).toBe(1)
  })

  it('编辑：条件成功 + 后写者 409 且保留当前投影', async () => {
    const { host } = await setup()
    const created = await post<MemoryWriteResponse>(host, MEMORY_BROWSER_PATHS.remember, {
      operationId: op('create'),
      title: '原标题',
      content: '原正文',
    })
    const id = created.json.data!.receipt.id

    const updated = await post<MemoryWriteResponse>(host, MEMORY_BROWSER_PATHS.update, {
      operationId: op('update'),
      id,
      expectedRevision: 0,
      title: '新标题',
      content: '新正文',
      tags: ['x'],
      importance: 'trivial',
    })
    expect(updated.status).toBe(200)
    expect(updated.json.data?.receipt.status).toBe('saved')
    expect(updated.json.data?.receipt.revision).toBe(1)

    const stale = await post<MemoryWriteResponse>(host, MEMORY_BROWSER_PATHS.update, {
      operationId: op('stale'),
      id,
      expectedRevision: 0,
      content: '旧窗口的草稿',
    })
    expect(stale.status).toBe(409)
    expect(stale.json.code).toBe('STALE_VERSION')
    expect(stale.json.receipt?.status).toBe('conflict')
    expect(stale.json.receipt?.current?.content).toBe('新正文')
    expect(stale.json.receipt?.current?.revision).toBe(1)

    const shown = await post<MemoryShowResponse>(host, MEMORY_BROWSER_PATHS.show, { id })
    expect(shown.json.data?.record?.content).toBe('新正文')
    expect(shown.json.data?.record?.title).toBe('新标题')
    expect(shown.json.data?.record?.tags).toEqual(['x'])
  })

  it('改挂：父链读回一致；旧版本改挂冲突', async () => {
    const { host } = await setup()
    const parent = await post<MemoryWriteResponse>(host, MEMORY_BROWSER_PATHS.remember, {
      operationId: op('parent'),
      title: '父条',
      content: '父正文',
    })
    const child = await post<MemoryWriteResponse>(host, MEMORY_BROWSER_PATHS.remember, {
      operationId: op('child'),
      title: '子条',
      content: '子正文',
    })
    const attached = await post<MemoryWriteResponse>(host, MEMORY_BROWSER_PATHS.attach, {
      operationId: op('attach'),
      id: child.json.data!.receipt.id,
      expectedRevision: 0,
      parentId: parent.json.data!.receipt.id,
    })
    expect(attached.status).toBe(200)
    expect(attached.json.data?.receipt.status).toBe('saved')
    expect(attached.json.data?.receipt.verified).toBe(true)
    const shown = await post<MemoryShowResponse>(host, MEMORY_BROWSER_PATHS.show, {
      id: child.json.data!.receipt.id,
    })
    expect(shown.json.data?.record?.parentId).toBe(parent.json.data!.receipt.id)

    const stale = await post<MemoryWriteResponse>(host, MEMORY_BROWSER_PATHS.attach, {
      operationId: op('attach-stale'),
      id: child.json.data!.receipt.id,
      expectedRevision: 0,
      parentId: '',
    })
    expect(stale.status).toBe(409)
    expect(stale.json.receipt?.current?.parentId).toBe(parent.json.data!.receipt.id)

    const cycle = await post<MemoryWriteResponse>(host, MEMORY_BROWSER_PATHS.attach, {
      operationId: op('attach-cycle'),
      id: parent.json.data!.receipt.id,
      expectedRevision: 0,
      parentId: child.json.data!.receipt.id,
    })
    expect(cycle.status).toBe(400)
    expect(cycle.json.receipt?.code).toBe('CYCLE')
  })

  it('忘记：标题确认不符拒绝；正确后读回不存在', async () => {
    const { host } = await setup()
    const created = await post<MemoryWriteResponse>(host, MEMORY_BROWSER_PATHS.remember, {
      operationId: op('forget-create'),
      title: '要忘的记忆',
      content: '正文',
    })
    const id = created.json.data!.receipt.id

    const wrong = await post<MemoryWriteResponse>(host, MEMORY_BROWSER_PATHS.forget, {
      operationId: op('forget-wrong'),
      id,
      expectedRevision: 0,
      confirmTitle: '不对',
    })
    expect(wrong.status).toBe(400)
    expect(wrong.json.receipt?.status).toBe('rejected')
    expect(wrong.json.receipt?.code).toBe('CONFIRM_MISMATCH')

    const done = await post<MemoryWriteResponse>(host, MEMORY_BROWSER_PATHS.forget, {
      operationId: op('forget-ok'),
      id,
      expectedRevision: 0,
      confirmTitle: '要忘的记忆',
    })
    expect(done.status).toBe(200)
    expect(done.json.data?.receipt.status).toBe('saved')
    expect(done.json.data?.receipt.verified).toBe(true)
    const shown = await post<MemoryShowResponse>(host, MEMORY_BROWSER_PATHS.show, { id })
    expect(shown.json.data?.found).toBe(false)
  })

  it('父条不存在：400 + PARENT_NOT_FOUND，不落库', async () => {
    const { host } = await setup()
    const rejected = await post<MemoryWriteResponse>(host, MEMORY_BROWSER_PATHS.remember, {
      operationId: op('parent-missing'),
      title: '子条',
      content: '正文',
      parentId: 'no-such-parent',
    })
    expect(rejected.status).toBe(400)
    expect(rejected.json.receipt?.code).toBe('PARENT_NOT_FOUND')
    const status = await post<MemoryStatusResponse>(host, MEMORY_BROWSER_PATHS.status, {})
    expect(status.json.data?.library.records).toBe(0)
  })

  it('敏感内容：400 + SENSITIVE，不落库', async () => {
    const { host } = await setup()
    const rejected = await post<MemoryWriteResponse>(host, MEMORY_BROWSER_PATHS.remember, {
      operationId: op('sensitive'),
      title: '凭据',
      content: 'password: hunter2',
    })
    expect(rejected.status).toBe(400)
    expect(rejected.json.receipt?.status).toBe('rejected')
    expect(rejected.json.receipt?.code).toBe('SENSITIVE')
    const status = await post<MemoryStatusResponse>(host, MEMORY_BROWSER_PATHS.status, {})
    expect(status.json.data?.library.records).toBe(0)
    expect(JSON.stringify(rejected.json)).not.toContain('hunter2')
  })

  it('status：返回库/检索/同步/回执，序列化不含路径与 remote', async () => {
    const { host } = await setup()
    await post<MemoryWriteResponse>(host, MEMORY_BROWSER_PATHS.remember, {
      operationId: op('status'),
      title: '状态测试',
      content: '正文',
      sessionId: 'session-status',
    })
    const status = await post<MemoryStatusResponse>(host, MEMORY_BROWSER_PATHS.status, {
      sessionId: 'session-status',
    })
    expect(status.status).toBe(200)
    expect(status.json.data?.library.records).toBe(1)
    expect(status.json.data?.search.backend).toBe('bm25')
    expect(status.json.data?.receipts.length).toBe(1)
    const serialized = JSON.stringify(status.json)
    expect(serialized).not.toContain('data_dir')
    expect(serialized).not.toContain('remote')
    expect(serialized).not.toContain(host.dataDir)
  })

  it('recall-feedback：账本内目标可评价，写入 feedback 后会话视图可见', async () => {
    const { host } = await setup({ recallThreshold: 0, minPromptChars: 1 })
    await post<MemoryWriteResponse>(host, MEMORY_BROWSER_PATHS.remember, {
      operationId: op('feedback-memory'),
      title: 'nginx 504 排查手册',
      content: 'nginx 504 先区分上游超时与主动断连。',
    })
    const agent = { id: 'feedback-agent', session: { id: 'feedback-session' } }
    await dispatchPreStep(
      host,
      { agent, turn: 2, signal: new AbortController().signal },
      {
        kind: 'enter',
        messages: [
          {
            id: 'm-feedback',
            role: 'user',
            content: [{ type: 'text', text: 'nginx 504 怎么排查' }],
            source: { kind: 'user' },
          },
        ],
      },
    )
    const recalls = await post<MemorySessionRecallsResponse>(host, MEMORY_BROWSER_PATHS.sessionRecalls, {
      sessionId: 'feedback-session',
    })
    const entry = recalls.json.data?.entries[0]
    expect(entry?.hits.length).toBeGreaterThan(0)
    expect(entry?.injectedText).toContain('nginx')
    const hit = entry!.hits[0]!
    const feedback = await post(host, MEMORY_BROWSER_PATHS.feedback, {
      sessionId: 'feedback-session',
      turn: 2,
      messageId: 'm-feedback',
      memoryId: hit.id,
      feedback: 'helpful',
    })
    expect(feedback.status).toBe(200)
    const after = await post<MemorySessionRecallsResponse>(host, MEMORY_BROWSER_PATHS.sessionRecalls, {
      sessionId: 'feedback-session',
    })
    expect(after.json.data?.entries[0]?.feedback?.[hit.id]).toBe('helpful')
  })

  it('recall-feedback：未知目标 404；入参不足 400', async () => {
    const { host } = await setup()
    expect((await post(host, MEMORY_BROWSER_PATHS.feedback, { turn: 1 })).status).toBe(400)
    const missing = await post(host, MEMORY_BROWSER_PATHS.feedback, {
      sessionId: 's',
      turn: 1,
      messageId: 'm',
      memoryId: 'x',
      feedback: 'helpful',
    })
    expect(missing.status).toBe(404)
  })

  it('reembed：嵌入未启用时 400，不伪造进度', async () => {
    const { host } = await setup()
    const response = await post(host, MEMORY_BROWSER_PATHS.reembed, { operationId: op('reembed') })
    expect(response.status).toBe(400)
    expect(response.json.error).toContain('嵌入')
  })
})
