/**
 * M8 独立验收探针（verifier 新建，不属于实现者的测试基线）。
 *
 * 目的：核对 docs/m8-contract.md §七 中既有测试未覆盖的边界：
 * - keyset 游标在「同 ts 多条」时的正确性、边界 limit 0/1/上限；
 * - show 正文 20k 截断与字段白名单（列表/搜索/树/show）；
 * - 5 条路由的禁用 503、engine 代次（结构性 vs 非结构性）、旧引擎不串数据；
 * - 断链树、8 位前缀解析、树项目筛选下 childCount 与子层一致性；
 * - 账本中止/ reject 不记录、agent/disposed 清理；
 * - 浏览器半区：bundle 只 require react / react/jsx-runtime、无 @deepseek-ai；
 * - package.json dsh.client.inject 含 sidebar-right；client inject 数组未变。
 *
 * 验收中发现的问题（search「（无）」、树 childCount、引擎失败 503 误判）已由 Lead 修复，
 * 本文件保留对应回归防护。
 * 本文件只读源码/跑命令，不修改实现。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Memlite } from '@rsrsai/memlite'
import { apply } from '../src/index'
import { id8 } from '../src/rules'
import { MemoryApiError, createMemoryApi } from '../src/client/memory-api'
import { MEMORY_BROWSER_PATHS } from '../src/browser-contract'
import type {
  MemoryListResponse,
  MemorySearchResponse,
  MemorySessionRecallsResponse,
  MemoryShowResponse,
  MemoryTreeResponse,
} from '../src/browser-contract'
import type { ConfigRef, PluginConfig } from '../src/schema'
import { resolveConfig } from '../src/schema'
import { createTestHost, dispatchPreStep, emitEvent, injectedTexts, type TestHost } from './harness'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.dispose()
})

interface SeedRecord {
  content: string
  title?: string
  tags?: string[]
  project?: string
  importance?: 'important' | 'trivial'
  ts?: number
  parentIndex?: number
}

async function seed(dataDir: string, records: SeedRecord[]): Promise<string[]> {
  const mem = new Memlite({ dataDir, sensitiveGate: false })
  mem.open()
  const ids: string[] = []
  try {
    for (const [index, record] of records.entries()) {
      const parent = record.parentIndex === undefined ? undefined : ids[record.parentIndex]
      ids.push(
        await mem.remember(record.content, {
          title: record.title,
          tags: record.tags ?? [],
          project: record.project ?? '',
          parent,
          ts: record.ts ?? 1_700_000_000 + index,
          extra: record.importance === undefined ? {} : { importance: record.importance },
        }),
      )
    }
  } finally {
    mem.close()
  }
  return ids
}

interface MutableConfig {
  ref: ConfigRef
  set(patch: Partial<PluginConfig>): void
}

function mutableConfig(overrides: Partial<PluginConfig> = {}): MutableConfig {
  let current = resolveConfig({ sync: { auto: false }, embedding: { provider: 'none' }, ...overrides })
  return {
    ref: { get: () => current },
    set(patch) {
      current = { ...current, ...patch }
    },
  }
}

async function setup(
  overrides: Partial<PluginConfig> = {},
  records: SeedRecord[] = [],
  dataDirOverride?: string,
): Promise<{ host: TestHost; config: MutableConfig; ids: string[] }> {
  const host = await createTestHost()
  hosts.push(host)
  const dataDir = dataDirOverride ?? host.dataDir
  const ids = records.length === 0 ? [] : await seed(dataDir, records)
  const config = mutableConfig({ dataDir, ...overrides })
  host.cleanup = apply(host.ctx as never, config.ref)
  await new Promise((resolve) => setTimeout(resolve, 10))
  return { host, config, ids }
}

interface Envelope {
  status: number
  json: { ok?: boolean; data?: unknown; error?: string; disabled?: boolean }
}

async function post(host: TestHost, route: string, body: unknown): Promise<Envelope> {
  const request = new Request(`http://127.0.0.1/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const response = await host.connection.invoke(`/${route}`, request)
  return { status: response.status, json: (await response.json()) as Envelope['json'] }
}

function human(id: string, text: string) {
  return { id, role: 'user' as const, content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/* -------------------------------------------------------------------------- */
/* 1. 游标 keyset：同 ts 多条                                               */
/* -------------------------------------------------------------------------- */

describe('verification: keyset 游标（同 ts）', () => {
  it('同 ts 多条时翻页不重不漏，且按 id 升序稳定', async () => {
    const ts = 1_700_000_500
    const records = Array.from({ length: 5 }, (_, index) => ({
      content: `同时间记忆 ${index}`,
      title: `同 ts ${index}`,
      ts,
    }))
    const { host, ids } = await setup({}, records)
    const expectedIds = [...ids].sort()

    const seen: string[] = []
    let cursor: string | null | undefined
    for (let page = 0; page < 5; page++) {
      const response = await post(host, MEMORY_BROWSER_PATHS.list, {
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      })
      const data = response.json.data as MemoryListResponse
      expect(response.status).toBe(200)
      expect(data.items.length).toBeLessThanOrEqual(2)
      for (const item of data.items) {
        expect(seen).not.toContain(item.id)
        seen.push(item.id)
      }
      cursor = data.nextCursor
      if (cursor === null) break
    }
    expect(seen).toEqual(expectedIds)
  })

  it('游标在边界/非法值上稳定：末页后空页、非法游标 400', async () => {
    const { host } = await setup({}, [
      { content: 'a', title: 'a', ts: 10 },
      { content: 'b', title: 'b', ts: 20 },
    ])
    const first = await post(host, MEMORY_BROWSER_PATHS.list, { limit: 2 })
    const cursor = (first.json.data as MemoryListResponse).nextCursor
    expect(cursor).toBeNull()
    // 用最后一条（ts=10）的 ts + 最大 id 造游标：严格在末条之后 → 空页
    const fake = `10:${encodeURIComponent('~')}`
    const empty = await post(host, MEMORY_BROWSER_PATHS.list, { cursor: fake })
    expect((empty.json.data as MemoryListResponse).items).toEqual([])
    expect((empty.json.data as MemoryListResponse).nextCursor).toBeNull()
    for (const bad of ['x', '12:', ':', ':abc', `${'-1'}:abc`, '1.5:abc']) {
      expect((await post(host, MEMORY_BROWSER_PATHS.list, { cursor: bad })).status, bad).toBe(400)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* 2. show 正文截断与白名单                                                   */
/* -------------------------------------------------------------------------- */

describe('verification: show 正文限长与白名单', () => {
  it('超长正文被截断为 20k 并置 truncated', async () => {
    const long = 'x'.repeat(25_000)
    const { host, ids } = await setup({}, [{ content: long, title: '超长' }])
    const response = await post(host, MEMORY_BROWSER_PATHS.show, { id: ids[0] })
    const data = response.json.data as MemoryShowResponse
    expect(data.found).toBe(true)
    expect(data.record?.truncated).toBe(true)
    expect(data.record?.content.length).toBeLessThanOrEqual(20_001)
    expect(data.record?.content.startsWith('x'.repeat(1000))).toBe(true)
  })

  it('8 位前缀与唯一标题都能解析到同一条；未知 8 位前缀 found=false', async () => {
    const { host, ids } = await setup({}, [{ content: '前缀解析测试正文', title: '唯一标题' }])
    const byPrefix = await post(host, MEMORY_BROWSER_PATHS.show, { id: ids[0]!.slice(0, 8) })
    expect((byPrefix.json.data as MemoryShowResponse).record?.id).toBe(ids[0])
    const byTitle = await post(host, MEMORY_BROWSER_PATHS.show, { id: '唯一标题' })
    expect((byTitle.json.data as MemoryShowResponse).record?.id).toBe(ids[0])
    const unknown = await post(host, MEMORY_BROWSER_PATHS.show, { id: 'deadbeef' })
    expect((unknown.json.data as MemoryShowResponse).found).toBe(false)
  })

  it('show/列表/搜索/树的响应字段都是白名单（无正文/extra/向量/路径）', async () => {
    const { host, ids } = await setup({}, [
      {
        content: 'nginx 504 超时排查',
        title: 'nginx',
        tags: ['ops'],
        project: 'proj-a',
        importance: 'important',
      },
    ])
    const list = await post(host, MEMORY_BROWSER_PATHS.list, {})
    const listItem = (list.json.data as MemoryListResponse).items[0] as unknown as Record<string, unknown>
    expect(new Set(Object.keys(listItem))).toEqual(
      new Set([
        'id',
        'title',
        'summary',
        'tags',
        'project',
        'ts',
        'importance',
        'kind',
        'childCount',
        'leaf',
      ]),
    )

    const search = await post(host, MEMORY_BROWSER_PATHS.search, { query: 'nginx 504' })
    const searchItem = (search.json.data as MemorySearchResponse).items[0] as unknown as Record<
      string,
      unknown
    >
    expect(Object.keys(searchItem).sort()).toEqual([...Object.keys(listItem), 'score'].sort())

    const tree = await post(host, MEMORY_BROWSER_PATHS.tree, {})
    const node = (tree.json.data as MemoryTreeResponse).nodes[0] as unknown as Record<string, unknown>
    expect(new Set(Object.keys(node))).toEqual(
      new Set(['id', 'title', 'kind', 'importance', 'ts', 'childCount', 'leaf']),
    )

    const show = await post(host, MEMORY_BROWSER_PATHS.show, { id: ids[0] })
    const data = show.json.data as MemoryShowResponse
    expect(new Set(Object.keys(data.record as unknown as Record<string, unknown>))).toEqual(
      new Set([
        'id',
        'title',
        'content',
        'truncated',
        'tags',
        'project',
        'ts',
        'importance',
        'kind',
        'childCount',
        'leaf',
      ]),
    )
    const serialized = JSON.stringify(show.json)
    for (const forbidden of ['"extra"', '"vector"', '"embedding"', '"querylog"', 'parent_id', '"path"']) {
      expect(serialized).not.toContain(forbidden)
    }
    // 列表/搜索/树序列化后不得出现 content 字段（summary 是截断摘要）
    for (const body of [list.json, search.json, tree.json]) {
      expect(JSON.stringify(body)).not.toContain('"content":')
    }
  })
})

/* -------------------------------------------------------------------------- */
/* 3. 入参守卫 / 禁用 / engine 代次                                           */
/* -------------------------------------------------------------------------- */

describe('verification: 入参守卫与上限边界', () => {
  it('limit 边界值 1/上限被接受，上限 +1 被拒绝', async () => {
    const { host } = await setup({}, [{ content: '边界', title: '边界' }])
    expect((await post(host, MEMORY_BROWSER_PATHS.list, { limit: 1 })).status).toBe(200)
    expect((await post(host, MEMORY_BROWSER_PATHS.list, { limit: 50 })).status).toBe(200)
    expect((await post(host, MEMORY_BROWSER_PATHS.list, { limit: 51 })).status).toBe(400)
    expect((await post(host, MEMORY_BROWSER_PATHS.search, { query: 'x', limit: 1 })).status).toBe(200)
    expect((await post(host, MEMORY_BROWSER_PATHS.search, { query: 'x', limit: 20 })).status).toBe(200)
    expect((await post(host, MEMORY_BROWSER_PATHS.search, { query: 'x', limit: 21 })).status).toBe(400)
    expect((await post(host, MEMORY_BROWSER_PATHS.tree, { limit: 1 })).status).toBe(200)
    expect((await post(host, MEMORY_BROWSER_PATHS.tree, { limit: 200 })).status).toBe(200)
    expect((await post(host, MEMORY_BROWSER_PATHS.tree, { limit: 201 })).status).toBe(400)
    expect(
      (await post(host, MEMORY_BROWSER_PATHS.sessionRecalls, { sessionId: 's', limit: 100 })).status,
    ).toBe(200)
  })

  it('非 JSON / 非对象请求体被安全拒绝；超长请求体 413', async () => {
    const { host } = await setup({})
    const call = async (body: string): Promise<number> => {
      const request = new Request(`http://127.0.0.1/${MEMORY_BROWSER_PATHS.list}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      const response = await host.connection.invoke(`/${MEMORY_BROWSER_PATHS.list}`, request)
      return response.status
    }
    expect(await call('not json')).toBe(400)
    expect(await call('{"limit": [1,2]}')).toBe(400)
    expect(await call('[1,2,3]')).toBe(400)
    expect(await call(`{"x":"${'a'.repeat(70 * 1024)}"}`)).toBe(413)
  })

  it('所有 5 条路由在 disabled 时回 503 + disabled:true', async () => {
    const { host, config } = await setup({})
    config.set({ enabled: false })
    const requests: Array<[string, unknown]> = [
      [MEMORY_BROWSER_PATHS.list, {}],
      [MEMORY_BROWSER_PATHS.search, { query: 'x' }],
      [MEMORY_BROWSER_PATHS.show, { id: 'x' }],
      [MEMORY_BROWSER_PATHS.tree, {}],
      [MEMORY_BROWSER_PATHS.sessionRecalls, { sessionId: 's' }],
    ]
    for (const [route, body] of requests) {
      const response = await post(host, route, body)
      expect(response.status, route).toBe(503)
      expect(response.json.disabled, route).toBe(true)
      expect(response.json.ok, route).toBe(false)
    }
  })
})

describe('verification: engine 代次与旧引擎隔离', () => {
  it('结构性变化 +1；非结构性变化不变；5 条响应都带 engine', async () => {
    const { host, config, ids } = await setup({}, [{ content: '记忆', title: '记忆' }])
    const list1 = await post(host, MEMORY_BROWSER_PATHS.list, {})
    const engines = [
      (list1.json.data as MemoryListResponse).engine,
      ((await post(host, MEMORY_BROWSER_PATHS.search, { query: '记忆' })).json
        .data as MemorySearchResponse).engine,
      ((await post(host, MEMORY_BROWSER_PATHS.show, { id: ids[0] })).json.data as MemoryShowResponse)
        .engine,
      ((await post(host, MEMORY_BROWSER_PATHS.tree, {})).json.data as MemoryTreeResponse).engine,
      (
        (await post(host, MEMORY_BROWSER_PATHS.sessionRecalls, { sessionId: 's' })).json
          .data as MemorySessionRecallsResponse
      ).engine,
    ]
    expect(engines.every((engine) => engine === engines[0])).toBe(true)
    const base = engines[0]!

    // 非结构性：recallThreshold 只影响召回参数，不应重建引擎
    config.set({ recallThreshold: 0.7 })
    expect((((await post(host, MEMORY_BROWSER_PATHS.list, {})).json.data as MemoryListResponse)).engine).toBe(base)

    // 结构性：dataDir 变化 → 重建，旧 id 在新引擎中不存在
    const otherDir = `${host.dataDir}-alt`
    config.set({ dataDir: otherDir })
    const after = (await post(host, MEMORY_BROWSER_PATHS.list, {})).json.data as MemoryListResponse
    expect(after.engine).toBe(base + 1)
    expect(after.items).toEqual([])
    const old = (await post(host, MEMORY_BROWSER_PATHS.show, { id: ids[0] })).json.data as MemoryShowResponse
    expect(old.found).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* 4. 树：断链 / 项目筛选 / 只取一层                                          */
/* -------------------------------------------------------------------------- */

describe('verification: 因果树边界', () => {
  it('断链（parent_id 指向不存在的记录）按根展示、row 不崩溃', async () => {
    // 直接写 JSONL 制造脏数据（正常写入路径不会产生悬空父指针）
    const host = await createTestHost()
    hosts.push(host)
    const lines = [
      { op: 'put', id: 'a'.repeat(32), ts: 1_700_000_001, title: '根', content: '根', tags: [], project: '' },
      {
        op: 'put',
        id: 'b'.repeat(32),
        ts: 1_700_000_002,
        title: '断链子',
        content: '断链子',
        tags: [],
        project: '',
        parent_id: 'ghost-parent',
      },
    ]
    writeFileSync(path.join(host.dataDir, 'memory.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')
    host.cleanup = apply(host.ctx as never, mutableConfig({ dataDir: host.dataDir }).ref)
    await new Promise((resolve) => setTimeout(resolve, 10))

    const roots = (await post(host, MEMORY_BROWSER_PATHS.tree, {})).json.data as MemoryTreeResponse
    expect(roots.nodes.map((node) => node.title).sort()).toEqual(['断链子', '根'])
    const broken = await post(host, MEMORY_BROWSER_PATHS.show, { id: 'b'.repeat(32) })
    expect(broken.status).toBe(200)
    expect((broken.json.data as MemoryShowResponse).found).toBe(true)
  })

  it('树一层只返回直接子条，不带孙条', async () => {
    const { host, ids } = await setup({}, [
      { content: '一层', title: '一层' },
      { content: '二层', title: '二层', parentIndex: 0 },
      { content: '三层', title: '三层', parentIndex: 1 },
    ])
    const layer = (await post(host, MEMORY_BROWSER_PATHS.tree, { parentId: ids[0] })).json
      .data as MemoryTreeResponse
    expect(layer.nodes.map((node) => node.title)).toEqual(['二层'])
    const deeper = (await post(host, MEMORY_BROWSER_PATHS.tree, { parentId: ids[1] })).json
      .data as MemoryTreeResponse
    expect(deeper.nodes.map((node) => node.title)).toEqual(['三层'])
  })
})

/* -------------------------------------------------------------------------- */
/* 5. 账本集成：中止 / reject 不写，agent/disposed 清理                       */
/* -------------------------------------------------------------------------- */

describe('verification: 账本生命周期', () => {
  it('中止的 pre-step 不写成功记录；reject 也不写', async () => {
    const { host } = await setup({}, [{ content: 'nginx 504 超时排查手册', title: 'nginx 手册' }])
    const aborted = new AbortController()
    aborted.abort()
    await dispatchPreStep(
      host,
      { agent: { id: 's-abort', session: { id: 's-abort' } }, turn: 1, signal: aborted.signal },
      { kind: 'enter', messages: [human('m-abort', 'nginx 504 怎么排查')] },
    )
    expect(
      ((await post(host, MEMORY_BROWSER_PATHS.sessionRecalls, { sessionId: 's-abort' })).json
        .data as MemorySessionRecallsResponse).entries,
    ).toEqual([])

    await dispatchPreStep(
      host,
      {
        agent: { id: 's-reject', session: { id: 's-reject' } },
        turn: 1,
        signal: new AbortController().signal,
      },
      { kind: 'reject' },
    )
    expect(
      ((await post(host, MEMORY_BROWSER_PATHS.sessionRecalls, { sessionId: 's-reject' })).json
        .data as MemorySessionRecallsResponse).entries,
    ).toEqual([])
  })

  it('agent/disposed 清理该会话账本；其他会话不受影响', async () => {
    const { host } = await setup({}, [{ content: 'nginx 504 超时排查手册', title: 'nginx 手册' }])
    const agentA = { id: 's-a', session: { id: 's-a' } }
    const agentB = { id: 's-b', session: { id: 's-b' } }
    for (const agent of [agentA, agentB]) {
      await dispatchPreStep(
        host,
        { agent, turn: 1, signal: new AbortController().signal },
        { kind: 'enter', messages: [human(`m-${agent.id}`, 'nginx 504 怎么排查')] },
      )
    }
    const count = async (sessionId: string): Promise<number> =>
      ((await post(host, MEMORY_BROWSER_PATHS.sessionRecalls, { sessionId })).json
        .data as MemorySessionRecallsResponse).entries.length
    expect(await count('s-a')).toBe(1)
    expect(await count('s-b')).toBe(1)
    emitEvent(host, 'agent/disposed', { agent: agentA })
    expect(await count('s-a')).toBe(0)
    expect(await count('s-b')).toBe(1)
  })
})


/* -------------------------------------------------------------------------- */
/* 7. 注入状态与渲染同源（index.ts ↔ selectRecallTitles ↔ 账本）              */
/* -------------------------------------------------------------------------- */

describe('verification: 注入状态与渲染同源', () => {
  it('账本 injected 标记与 decision.messages 里实际出现的 id8 一一对应', async () => {
    const { host } = await setup({}, [
      { content: 'nginx 504 超时排查手册：上游超时 → 连接池 → keepalive', title: 'nginx 手册' },
      { content: '发版流程约定：周五不发布', title: '发版' },
    ])
    const decision = await dispatchPreStep(
      host,
      { agent: { id: 's-src', session: { id: 's-src' } }, turn: 1, signal: new AbortController().signal },
      { kind: 'enter', messages: [human('m-src', 'nginx 504 超时怎么排查')] },
    )
    const text = injectedTexts(decision).join('\n')
    const entries = ((await post(host, MEMORY_BROWSER_PATHS.sessionRecalls, { sessionId: 's-src' })).json
      .data as MemorySessionRecallsResponse).entries
    expect(entries).toHaveLength(1)
    const hits = entries[0]!.hits
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((hit) => hit.injected)).toBe(true)
    for (const hit of hits) {
      if (hit.injected) expect(text, `injected hit ${hit.id}`).toContain(id8(hit.id))
      else expect(text, `non-injected hit ${hit.id}`).not.toContain(id8(hit.id))
    }
  })

  it('agent 级降级记录 scope=agent，sessionId 优先', async () => {
    const { host } = await setup({}, [{ content: 'nginx 504 超时排查手册', title: 'nginx 手册' }])
    const agent = { id: 'agent-only-2' } // 无 session：必须明示降级
    await dispatchPreStep(
      host,
      { agent, turn: 2, signal: new AbortController().signal },
      { kind: 'enter', messages: [human('m-degrade', 'nginx 504 怎么排查')] },
    )
    const degraded = ((await post(host, MEMORY_BROWSER_PATHS.sessionRecalls, { agentId: 'agent-only-2' })).json
      .data as MemorySessionRecallsResponse)
    expect(degraded.scope).toBe('agent')
    expect(degraded.entries).toHaveLength(1)
    // 同时给 sessionId 与 agentId：以 sessionId 为准
    const bySession = ((await post(host, MEMORY_BROWSER_PATHS.sessionRecalls, {
      sessionId: 'agent-only-2',
      agentId: 'agent-only-2',
    })).json.data as MemorySessionRecallsResponse)
    expect(bySession.scope).toBe('session')
    expect(bySession.entries).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* 8. 项目「（无）」筛选：list 与 search 语义一致性                          */
/* -------------------------------------------------------------------------- */

describe('verification: 项目「（无）」筛选', () => {
  it('list 传「（无）」只返回无项目记忆；默认返回全部项目', async () => {
    const { host } = await setup({}, [
      { content: '无项目记忆', title: '无项目', project: '' },
      { content: '项目记忆', title: '有项目', project: 'proj-a' },
    ])
    const all = (await post(host, MEMORY_BROWSER_PATHS.list, {})).json.data as MemoryListResponse
    expect(all.total).toBe(2)
    expect(all.projects.map(([name]) => name).sort()).toEqual(['proj-a', '（无）'])
    const none = (await post(host, MEMORY_BROWSER_PATHS.list, { project: '（无）' })).json
      .data as MemoryListResponse
    expect(none.total).toBe(1)
    expect(none.items[0]?.title).toBe('无项目')
    expect(none.items[0]?.project).toBe('')
  })

  it('search 传「（无）」只返回无项目记忆（与 list 语义一致）', async () => {
    const { host } = await setup({}, [
      { content: '无项目记忆 nginx 超时', title: '无项目', project: '' },
      { content: '项目记忆 nginx 超时', title: '有项目', project: 'proj-a' },
    ])
    const all = (await post(host, MEMORY_BROWSER_PATHS.search, { query: 'nginx 超时', limit: 20 })).json
      .data as MemorySearchResponse
    expect(all.items.map((item) => item.project).sort()).toEqual(['', 'proj-a'])
    const none = (await post(host, MEMORY_BROWSER_PATHS.search, {
      query: 'nginx 超时',
      project: '（无）',
      limit: 20,
    })).json.data as MemorySearchResponse
    expect(none.items.map((item) => item.project)).toEqual([''])
    expect(none.items[0]?.title).toBe('无项目')
    const projectA = (await post(host, MEMORY_BROWSER_PATHS.search, {
      query: 'nginx 超时',
      project: 'proj-a',
    })).json.data as MemorySearchResponse
    expect(projectA.items.map((item) => item.project)).toEqual(['proj-a'])
  })
})

/* -------------------------------------------------------------------------- */
/* 9. 验收问题回归防护（验收发现后由 Lead 修复，保留为回归测试）               */
/* -------------------------------------------------------------------------- */

describe('verification: 验收问题回归防护', () => {
  it('树在项目筛选下 childCount 与展开子层一致（不再显示假断链）', async () => {
    const { host } = await setup({}, [
      { content: '父', title: '父', project: 'proj-a' },
      { content: '子', title: '子', project: 'proj-b', parentIndex: 0 },
    ])
    const roots = (await post(host, MEMORY_BROWSER_PATHS.tree, { project: 'proj-a' })).json
      .data as MemoryTreeResponse
    const parent = roots.nodes.find((node) => node.title === '父')!
    const children = (await post(host, MEMORY_BROWSER_PATHS.tree, {
      project: 'proj-a',
      parentId: parent.id,
    })).json.data as MemoryTreeResponse
    expect(parent.childCount).toBe(children.nodes.length)
    expect(parent.leaf).toBe(children.nodes.length === 0)
    // 未筛选时仍按全库子条计数（父条可见 1 个子条）
    const unfiltered = (await post(host, MEMORY_BROWSER_PATHS.tree, {})).json.data as MemoryTreeResponse
    const unfilteredParent = unfiltered.nodes.find((node) => node.title === '父')!
    expect(unfilteredParent.childCount).toBe(1)
    expect(unfilteredParent.leaf).toBe(false)
  })

  it('引擎失败回 500（非禁用）：客户端按可重试 http 错误处理，不显示「已禁用」', async () => {
    const engineError = {
      ok: false,
      error: '记忆引擎暂时不可用',
    }
    const fake = (async () =>
      ({
        ok: false,
        status: 500,
        json: async () => engineError,
      }) as unknown as Response) as typeof fetch
    const error = await createMemoryApi(fake).list({}).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MemoryApiError)
    expect((error as MemoryApiError).disabled).toBe(false)
    expect((error as MemoryApiError).code).toBe('http')

    // 兼容旧宿主：503 但没有 disabled 标记时同样按可重试失败处理
    const legacy = (async () =>
      ({
        ok: false,
        status: 503,
        json: async () => engineError,
      }) as unknown as Response) as typeof fetch
    const legacyError = await createMemoryApi(legacy).list({}).catch((caught: unknown) => caught)
    expect((legacyError as MemoryApiError).disabled).toBe(false)
  })
})

/* 10. show 内容边界                                                          */
/* -------------------------------------------------------------------------- */

describe('verification: show 正文边界', () => {
  it('20000 字符不截断；20001 字符截断（边界精确）', async () => {
    const { host, ids } = await setup({}, [
      { content: 'a'.repeat(20_000), title: '边界内' },
      { content: 'b'.repeat(20_001), title: '边界外' },
    ])
    const inside = (await post(host, MEMORY_BROWSER_PATHS.show, { id: ids[0] })).json
      .data as MemoryShowResponse
    expect(inside.record?.content.length).toBe(20_000)
    expect(inside.record?.truncated).toBe(false)
    const outside = (await post(host, MEMORY_BROWSER_PATHS.show, { id: ids[1] })).json
      .data as MemoryShowResponse
    expect(outside.record?.truncated).toBe(true)
    expect(outside.record?.content.length).toBeLessThanOrEqual(20_001)
  })
})

/* -------------------------------------------------------------------------- */
/* 6. 浏览器半区产物                                                          */
/* -------------------------------------------------------------------------- */

describe('verification: 浏览器 bundle 与注册声明', () => {
  const bundle = path.join(process.cwd(), 'dist', 'client.js')

  it.skipIf(!existsSync(bundle))('bundle 只 require react / react/jsx-runtime，无 @deepseek-ai 运行时依赖', () => {
    const source = readFileSync(bundle, 'utf8')
    const requires = new Set<string>()
    for (const match of source.matchAll(/require\("([^"]+)"\)/g)) requires.add(match[1]!)
    expect([...requires].sort()).toEqual(['react', 'react/jsx-runtime'])
    expect(source).not.toContain('@deepseek-ai/')
    expect(source).not.toMatch(/dangerouslySetInnerHTML\s*[:=]/)
  })

  it('package.json dsh.client.inject 含 sidebar-right；client 导出的 inject 数组未变', async () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      dsh?: { client?: { inject?: string[] } }
    }
    expect(pkg.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-sidebar-right')
    const clientIndex = (await import('../src/client/index')) as { inject: string[] }
    expect(clientIndex.inject).toEqual(['slots', 'locale', 'configForms'])
  })
})
