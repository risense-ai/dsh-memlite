/**
 * M8 记忆浏览器 Host 半区测试：
 * - 5 条只读路由的注册契约与统一响应外壳；
 * - list 的筛选/游标分页/上限；search；show（含已删除）；tree 逐层；
 * - session-recalls 的会话隔离、注入状态、agent 级降级与 exists 标记；
 * - 入参守卫、禁用 503、响应白名单（不含正文/敏感字段）、引擎代次。
 *
 * 种子数据必须在插件 apply **之前**写入同一 dataDir：插件实例在 apply 时加载 JSONL 索引，
 * 之后不会感知外部进程追加的行（真实宿主里写入永远经插件自己的 Memlite）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import { Memlite } from '@rsrsai/memlite'
import { apply } from '../src/index'
import {
  MEMORY_BROWSER_PATHS,
  type MemoryListResponse,
  type MemorySearchResponse,
  type MemorySessionRecallsResponse,
  type MemoryShowResponse,
  type MemoryTreeResponse,
} from '../src/browser-contract'
import type { ConfigRef, PluginConfig } from '../src/schema'
import { resolveConfig } from '../src/schema'
import { createTestHost, dispatchPreStep, type TestHost } from './harness'

const hosts: TestHost[] = []
const extraDirs: string[] = []

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.dispose()
  for (const dir of extraDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

interface SeedRecord {
  content: string
  title?: string
  tags?: string[]
  project?: string
  importance?: 'important' | 'trivial'
  /** 显式秒级时间戳；缺省用递增的固定值，保证「最近优先」断言确定。 */
  ts?: number
  parentIndex?: number
}

/** 直接经 Memlite 主类写入种子数据（插件随后从同一 dataDir 加载）。 */
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

interface SetupResult {
  host: TestHost
  config: MutableConfig
  ids: string[]
}

/** 建测试宿主 → 写种子 → apply 插件（顺序固定，插件才能读到种子）。 */
async function setup(
  overrides: Partial<PluginConfig> = {},
  records: SeedRecord[] = [],
): Promise<SetupResult> {
  const host = await createTestHost()
  hosts.push(host)
  const ids = records.length === 0 ? [] : await seed(host.dataDir, records)
  const config = mutableConfig({ dataDir: host.dataDir, ...overrides })
  host.cleanup = apply(host.ctx as never, config.ref)
  await new Promise((resolve) => setTimeout(resolve, 10))
  return { host, config, ids }
}

async function post<T>(
  host: TestHost,
  path: string,
  body: unknown,
): Promise<{ status: number; json: { ok?: boolean; data?: T; error?: string; disabled?: boolean } }> {
  const request = new Request(`http://127.0.0.1/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const response = await host.connection.invoke(`/${path}`, request)
  return {
    status: response.status,
    json: (await response.json()) as { ok?: boolean; data?: T; error?: string; disabled?: boolean },
  }
}

function human(id: string, text: string) {
  return { id, role: 'user' as const, content: [{ type: 'text', text }], source: { kind: 'user' } }
}

describe('记忆浏览器路由注册', () => {
  it('注册五条 buffered POST 路由，路径与契约一致', async () => {
    const { host } = await setup()
    const paths = Object.values(MEMORY_BROWSER_PATHS).map((path) => `/${path}`)
    expect(paths).toHaveLength(13)
    for (const path of paths) {
      const route = host.connection.routes.get(path)
      expect(route, path).toBeDefined()
      expect(route?.methods).toEqual(['POST'])
      expect(route?.requestBody).toBe('buffered')
    }
  })
})

describe('全部记忆列表', () => {
  it('按项目/标签/重要性筛选，最近优先，游标分页且 nextCursor 终止', async () => {
    const { host } = await setup({}, [
      { content: 'nginx 反代超时排查', title: 'nginx 题', tags: ['ops'], project: 'proj-a', importance: 'important' },
      { content: 'redis 大 key 排查', title: 'redis 题', tags: ['ops', 'redis'], project: 'proj-a', importance: 'trivial' },
      { content: '发版流程约定', title: '发版题', tags: ['release'], project: 'proj-b', importance: 'important' },
    ])

    const all = await post<MemoryListResponse>(host, MEMORY_BROWSER_PATHS.list, { limit: 2 })
    expect(all.status).toBe(200)
    expect(all.json.ok).toBe(true)
    expect(all.json.data?.total).toBe(3)
    expect(all.json.data?.items).toHaveLength(2)
    expect(all.json.data?.nextCursor).not.toBeNull()
    // ts 递增种子 → 最近优先：最后写入的「发版题」在最前
    expect(all.json.data?.items[0]?.title).toBe('发版题')
    // 白名单：列表不含正文/向量/路径
    const firstItem = all.json.data?.items[0] as unknown as Record<string, unknown>
    expect(firstItem['content']).toBeUndefined()
    expect(firstItem['extra']).toBeUndefined()
    expect(String(firstItem['summary']).length).toBeLessThanOrEqual(200)
    expect(all.json.data?.projects.length).toBeGreaterThan(0)
    expect(all.json.data?.tags.length).toBeGreaterThan(0)

    const page2 = await post<MemoryListResponse>(host, MEMORY_BROWSER_PATHS.list, {
      limit: 2,
      cursor: all.json.data?.nextCursor,
    })
    expect(page2.json.data?.items).toHaveLength(1)
    expect(page2.json.data?.nextCursor).toBeNull()
    const titles = [...(all.json.data?.items ?? []), ...(page2.json.data?.items ?? [])].map((item) => item.title)
    expect(new Set(titles)).toEqual(new Set(['nginx 题', 'redis 题', '发版题']))

    const byProject = await post<MemoryListResponse>(host, MEMORY_BROWSER_PATHS.list, { project: 'proj-a' })
    expect(byProject.json.data?.total).toBe(2)
    expect(byProject.json.data?.items.every((item) => item.project === 'proj-a')).toBe(true)

    const byTag = await post<MemoryListResponse>(host, MEMORY_BROWSER_PATHS.list, { tag: 'redis' })
    expect(byTag.json.data?.total).toBe(1)
    expect(byTag.json.data?.items[0]?.title).toBe('redis 题')

    const byImportance = await post<MemoryListResponse>(host, MEMORY_BROWSER_PATHS.list, { importance: 'important' })
    expect(byImportance.json.data?.total).toBe(2)

    const combined = await post<MemoryListResponse>(host, MEMORY_BROWSER_PATHS.list, {
      project: 'proj-a',
      tag: 'ops',
      importance: 'trivial',
    })
    expect(combined.json.data?.total).toBe(1)
    expect(combined.json.data?.items[0]?.title).toBe('redis 题')
  })

  it('空库返回空列表与空筛选数据（不是错误）', async () => {
    const { host } = await setup()
    const response = await post<MemoryListResponse>(host, MEMORY_BROWSER_PATHS.list, {})
    expect(response.status).toBe(200)
    expect(response.json.data?.items).toEqual([])
    expect(response.json.data?.total).toBe(0)
    expect(response.json.data?.nextCursor).toBeNull()
  })

  it('入参守卫：非法游标/超上限/非法重要性均 400', async () => {
    const { host } = await setup()
    expect((await post(host, MEMORY_BROWSER_PATHS.list, { cursor: 'not-a-cursor' })).status).toBe(400)
    expect((await post(host, MEMORY_BROWSER_PATHS.list, { limit: 51 })).status).toBe(400)
    expect((await post(host, MEMORY_BROWSER_PATHS.list, { limit: 0 })).status).toBe(400)
    expect((await post(host, MEMORY_BROWSER_PATHS.list, { importance: 'critical' })).status).toBe(400)
    expect((await post(host, MEMORY_BROWSER_PATHS.list, { project: 42 })).status).toBe(400)
  })
})

describe('搜索', () => {
  it('命中返回摘要与分数，可按项目过滤，不返回正文', async () => {
    const { host } = await setup({}, [
      { content: 'nginx 504 超时排查：上游超时 → 连接池 → keepalive', title: 'nginx 手册', project: 'proj-a' },
      { content: '发版流程约定', title: '发版', project: 'proj-b' },
    ])
    const response = await post<MemorySearchResponse>(host, MEMORY_BROWSER_PATHS.search, { query: 'nginx 504', limit: 5 })
    expect(response.status).toBe(200)
    expect(response.json.data?.items.length).toBeGreaterThan(0)
    const hit = response.json.data!.items[0]!
    expect(hit.title).toContain('nginx')
    // 召回原始分数：BM25 可 >1（本用例 ≈1.75），只保证非负有限
    expect(hit.score).toBeGreaterThan(0)
    expect(Number.isFinite(hit.score)).toBe(true)
    expect((hit as unknown as Record<string, unknown>)['content']).toBeUndefined()

    const filtered = await post<MemorySearchResponse>(host, MEMORY_BROWSER_PATHS.search, {
      query: 'nginx 504',
      project: 'proj-b',
    })
    expect(filtered.json.data?.items).toHaveLength(0)
  })

  it('入参守卫：空 query/超长 query/超上限 limit', async () => {
    const { host } = await setup()
    expect((await post(host, MEMORY_BROWSER_PATHS.search, {})).status).toBe(400)
    expect((await post(host, MEMORY_BROWSER_PATHS.search, { query: 'x'.repeat(501) })).status).toBe(400)
    expect((await post(host, MEMORY_BROWSER_PATHS.search, { query: 'x', limit: 21 })).status).toBe(400)
  })
})

describe('详情', () => {
  it('返回全文、因果邻居与有界链；删除后 found=false', async () => {
    const { host, ids } = await setup({}, [
      { content: '根因：连接池配置过小', title: '根因' },
      { content: '现象：nginx 504', title: '现象', parentIndex: 0 },
      { content: '处置：扩连接池并加监控', title: '处置', parentIndex: 1 },
    ])
    const response = await post<MemoryShowResponse>(host, MEMORY_BROWSER_PATHS.show, { id: ids[1] })
    expect(response.status).toBe(200)
    expect(response.json.data?.found).toBe(true)
    expect(response.json.data?.record?.content).toContain('nginx 504')
    expect(response.json.data?.ancestors.map((item) => item.title)).toContain('根因')
    expect(response.json.data?.children.map((item) => item.title)).toContain('处置')
    expect(response.json.data?.chain.entry.title).toBe('现象')
    expect(response.json.data?.chain.ancestors.length).toBeGreaterThan(0)
    expect((response.json.data?.record as unknown as Record<string, unknown>)['extra']).toBeUndefined()

    // 走命令面删除（软删除）
    const forget = await host.commands.invoke('x', `/memlite-forget ${ids[1]}`)
    expect(forget.kind).toBe('success')
    const gone = await post<MemoryShowResponse>(host, MEMORY_BROWSER_PATHS.show, { id: ids[1] })
    expect(gone.status).toBe(200)
    expect(gone.json.data?.found).toBe(false)
  })

  it('入参守卫：缺 id / 超长 id 400；未知 id found=false', async () => {
    const { host } = await setup()
    expect((await post(host, MEMORY_BROWSER_PATHS.show, {})).status).toBe(400)
    expect((await post(host, MEMORY_BROWSER_PATHS.show, { id: 'x'.repeat(201) })).status).toBe(400)
    const unknown = await post<MemoryShowResponse>(host, MEMORY_BROWSER_PATHS.show, { id: 'deadbeef' })
    expect(unknown.status).toBe(200)
    expect(unknown.json.data?.found).toBe(false)
  })
})

describe('因果树', () => {
  it('根层只给根，子层按 parentId 逐层取，limit 截断置 trimmed', async () => {
    const { host, ids } = await setup({}, [
      { content: '根一', title: '根一' },
      { content: '根二', title: '根二' },
      { content: '子一', title: '子一', parentIndex: 0 },
      { content: '子二', title: '子二', parentIndex: 0 },
    ])
    const roots = await post<MemoryTreeResponse>(host, MEMORY_BROWSER_PATHS.tree, {})
    expect(roots.status).toBe(200)
    expect(roots.json.data?.parentId).toBe('')
    expect(roots.json.data?.nodes.map((node) => node.title).sort()).toEqual(['根一', '根二'])
    expect(roots.json.data?.nodes.find((node) => node.title === '根一')?.childCount).toBe(2)

    const children = await post<MemoryTreeResponse>(host, MEMORY_BROWSER_PATHS.tree, { parentId: ids[0] })
    expect(children.json.data?.parentId).toBe(ids[0])
    expect(children.json.data?.nodes.map((node) => node.title).sort()).toEqual(['子一', '子二'])

    const limited = await post<MemoryTreeResponse>(host, MEMORY_BROWSER_PATHS.tree, { parentId: ids[0], limit: 1 })
    expect(limited.json.data?.nodes).toHaveLength(1)
    expect(limited.json.data?.trimmed).toBe(true)

    const missing = await post(host, MEMORY_BROWSER_PATHS.tree, { parentId: 'no-such-node' })
    expect(missing.status).toBe(400)
    expect((await post(host, MEMORY_BROWSER_PATHS.tree, { limit: 201 })).status).toBe(400)
  })
})

describe('本次对话召回（session-recalls）', () => {
  it('pre-step 召回后按会话隔离返回注入状态，删除原记忆后 exists=false', async () => {
    const { host, ids } = await setup({}, [{ content: 'nginx 504 超时排查手册', title: 'nginx 手册' }])
    const agent = { id: 'session-x', session: { id: 'session-x' } }
    const decision = await dispatchPreStep(
      host,
      { agent, turn: 3, signal: new AbortController().signal },
      { kind: 'enter', messages: [human('m1', 'nginx 504 怎么排查')] },
    )
    const injected = (decision['messages'] as Array<{ source?: { kind?: string } }>).filter(
      (message) => message.source?.kind === 'memlite',
    )
    expect(injected.length).toBeGreaterThan(0)

    const mine = await post<MemorySessionRecallsResponse>(host, MEMORY_BROWSER_PATHS.sessionRecalls, {
      sessionId: 'session-x',
    })
    expect(mine.status).toBe(200)
    expect(mine.json.data?.scope).toBe('session')
    expect(mine.json.data?.entries).toHaveLength(1)
    const entry = mine.json.data!.entries[0]!
    expect(entry.turn).toBe(3)
    expect(entry.messageId).toBe('m1')
    expect(entry.status).toBe('ok')
    expect(entry.hits.length).toBeGreaterThan(0)
    expect(entry.hits[0]?.injected).toBe(true)
    expect(entry.hits[0]?.exists).toBe(true)
    // 不保存提示词原文
    expect(JSON.stringify(mine.json)).not.toContain('怎么排查')

    const other = await post<MemorySessionRecallsResponse>(host, MEMORY_BROWSER_PATHS.sessionRecalls, {
      sessionId: 'session-y',
    })
    expect(other.json.data?.entries).toEqual([])

    await host.commands.invoke('x', `/memlite-forget ${ids[0]}`)
    const afterDelete = await post<MemorySessionRecallsResponse>(host, MEMORY_BROWSER_PATHS.sessionRecalls, {
      sessionId: 'session-x',
    })
    expect(afterDelete.json.data?.entries[0]?.hits[0]?.exists).toBe(false)
    // 标题快照仍在
    expect(afterDelete.json.data?.entries[0]?.hits[0]?.title).toContain('nginx')
  })

  it('threshold 排除的候选 injected=false / exclusion=threshold（同一轮里既有注入也有排除）', async () => {
    // 两条种子：强命中（BM25≈2.95）与弱命中（≈0.18）；threshold=1 让弱命中必然被排除。
    const { host } = await setup({ recallThreshold: 1 }, [
      {
        content: '生产环境 nginx 反向代理 504 超时，根因是上游连接池过小（默认 32），已扩到 256 并加 P95 延迟监控。',
        title: 'nginx 504 根因与处置',
        ts: 1794000000,
      },
      {
        content: '记忆库写入前会做敏感扫描：密码 / API key / 身份证 / 银行卡 Luhn / 手机号 / JWT / PEM 私钥，命中直接拒绝写入。',
        title: '敏感闸规则',
        ts: 1794000001,
      },
    ])
    const agent = { id: 'session-t', session: { id: 'session-t' } }
    await dispatchPreStep(
      host,
      { agent, turn: 1, signal: new AbortController().signal },
      { kind: 'enter', messages: [human('m1', '连接池')] },
    )
    const response = await post<MemorySessionRecallsResponse>(host, MEMORY_BROWSER_PATHS.sessionRecalls, {
      sessionId: 'session-t',
    })
    const entry = response.json.data?.entries[0]
    expect(entry?.status).toBe('ok')
    expect(entry?.hits.length).toBeGreaterThanOrEqual(2)
    const injected = entry!.hits.filter((hit) => hit.injected)
    const excluded = entry!.hits.filter((hit) => hit.exclusion === 'threshold')
    // 对照：强命中被注入、弱命中被阈值排除（不是「全注入」的假绿）
    expect(injected.length).toBeGreaterThan(0)
    expect(excluded.length).toBeGreaterThan(0)
    expect(injected.every((hit) => hit.exclusion === undefined)).toBe(true)
    expect(excluded.every((hit) => hit.injected === false)).toBe(true)
    expect(injected.some((hit) => hit.title.includes('nginx'))).toBe(true)
    expect(excluded.some((hit) => hit.title.includes('敏感闸'))).toBe(true)
  })

  it('budget 截断的候选 injected=false / exclusion=budget', async () => {
    const longTitle = 'A'.repeat(80)
    const { host } = await setup({ budgetChars: 200 }, [
      { content: `${longTitle} 第一条超长标题记忆`, title: `${longTitle}1`, ts: 1794000000 },
      { content: `${longTitle} 第二条超长标题记忆`, title: `${longTitle}2`, ts: 1794000001 },
    ])
    const agent = { id: 'session-b', session: { id: 'session-b' } }
    await dispatchPreStep(
      host,
      { agent, turn: 1, signal: new AbortController().signal },
      { kind: 'enter', messages: [human('m1', '超长标题记忆')] },
    )
    const response = await post<MemorySessionRecallsResponse>(host, MEMORY_BROWSER_PATHS.sessionRecalls, {
      sessionId: 'session-b',
    })
    const entry = response.json.data?.entries[0]
    expect(entry?.hits.some((hit) => hit.injected)).toBe(true)
    expect(entry?.hits.some((hit) => hit.exclusion === 'budget' && hit.injected === false)).toBe(true)
  })

  it('无法取得稳定 sessionId 时 agent 级降级；skipped 记录不冒充召回', async () => {
    const { host } = await setup({ minPromptChars: 5 }, [{ content: 'nginx 504 超时排查手册', title: 'nginx 手册' }])
    const agent = { id: 'agent-only' }
    await dispatchPreStep(
      host,
      { agent, turn: 1, signal: new AbortController().signal },
      { kind: 'enter', messages: [human('m1', '/nomem 随便说说'), human('m2', '继续')] },
    )
    const response = await post<MemorySessionRecallsResponse>(host, MEMORY_BROWSER_PATHS.sessionRecalls, {
      agentId: 'agent-only',
    })
    expect(response.json.data?.scope).toBe('agent')
    expect(response.json.data?.entries).toHaveLength(2)
    const statuses = response.json.data!.entries.map((entry) => entry.status).sort()
    expect(statuses).toEqual(['skipped', 'skipped'])

    expect((await post(host, MEMORY_BROWSER_PATHS.sessionRecalls, {})).status).toBe(400)
    expect(
      (await post(host, MEMORY_BROWSER_PATHS.sessionRecalls, { sessionId: 's', limit: 101 })).status,
    ).toBe(400)
  })
})

describe('禁用与引擎代次', () => {
  it('enabled=false 时路由回 503 + disabled', async () => {
    const host = await createTestHost()
    hosts.push(host)
    const config = mutableConfig({ dataDir: host.dataDir })
    host.cleanup = apply(host.ctx as never, config.ref)
    await new Promise((resolve) => setTimeout(resolve, 10))
    config.set({ enabled: false })
    const response = await post(host, MEMORY_BROWSER_PATHS.list, {})
    expect(response.status).toBe(503)
    expect(response.json.disabled).toBe(true)
    expect(response.json.ok).toBe(false)
  })

  it('结构性配置变化重建引擎后 generation 递增（客户端据此清旧详情）', async () => {
    const host = await createTestHost()
    hosts.push(host)
    const otherDir = `${host.dataDir}-alt`
    extraDirs.push(otherDir)
    const config = mutableConfig({ dataDir: host.dataDir })
    host.cleanup = apply(host.ctx as never, config.ref)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const first = await post<MemoryListResponse>(host, MEMORY_BROWSER_PATHS.list, {})
    expect(first.json.data?.engine).toBe(1)
    config.set({ dataDir: otherDir })
    const second = await post<MemoryListResponse>(host, MEMORY_BROWSER_PATHS.list, {})
    expect(second.json.data?.engine).toBe(2)
  })
})

describe('时间戳口径（回归：会话召回按秒存，UI 直接乘 1000）', () => {
  it('session-recalls 的 timestamp 是秒级，与 MemRecord.ts 同口径，量级不得是毫秒', async () => {
    const { host } = await setup({}, [{ content: 'nginx 504 超时排查手册', title: 'nginx 手册' }])
    const agent = { id: 'session-ts', session: { id: 'session-ts' } }
    await dispatchPreStep(
      host,
      { agent, turn: 1, signal: new AbortController().signal },
      { kind: 'enter', messages: [human('m1', 'nginx 504 怎么排查')] },
    )
    const response = await post<MemorySessionRecallsResponse>(host, MEMORY_BROWSER_PATHS.sessionRecalls, {
      sessionId: 'session-ts',
    })
    const timestamp = response.json.data?.entries[0]?.timestamp
    expect(typeof timestamp).toBe('number')
    // 秒级 ~1.7e9；毫秒会是 ~1.7e12（UI 乘 1000 后变成 5 万年）
    expect(timestamp).toBeLessThan(4_000_000_000)
    expect(timestamp).toBeGreaterThan(1_000_000_000)
    const rendered = new Date(timestamp! * 1000).getUTCFullYear()
    expect(rendered).toBeGreaterThanOrEqual(2024)
    expect(rendered).toBeLessThanOrEqual(2100)
  })
})

describe('筛选语义回归（verifier 发现）', () => {
  it('搜索 project=「（无）」只返回无项目条目（不是「全部项目」）', async () => {
    const { host } = await setup({}, [
      { content: 'nginx 连接池 排查手册（项目内）', title: '项目内手册', project: 'proj-a' },
      { content: 'nginx 连接池 排查手册（无项目）', title: '无项目手册', project: '' },
    ])
    const all = await post<MemorySearchResponse>(host, MEMORY_BROWSER_PATHS.search, { query: '连接池' })
    expect(all.json.data?.items.length).toBe(2)

    const noProject = await post<MemorySearchResponse>(host, MEMORY_BROWSER_PATHS.search, {
      query: '连接池',
      project: '（无）',
    })
    expect(noProject.status).toBe(200)
    expect(noProject.json.data?.items.length).toBe(1)
    expect(noProject.json.data?.items[0]?.project).toBe('')
    expect(noProject.json.data?.items[0]?.title).toBe('无项目手册')

    const projectA = await post<MemorySearchResponse>(host, MEMORY_BROWSER_PATHS.search, {
      query: '连接池',
      project: 'proj-a',
    })
    expect(projectA.json.data?.items.length).toBe(1)
    expect(projectA.json.data?.items[0]?.title).toBe('项目内手册')
  })

  it('项目筛选下，跨项目子条不计入 childCount（避免展开后显示断链）', async () => {
    const { host, ids } = await setup({}, [
      { content: '父条在 proj-a', title: '父条', project: 'proj-a' },
      { content: '子条在 proj-b', title: '子条', project: 'proj-b', parentIndex: 0 },
    ])
    const filtered = await post<MemoryTreeResponse>(host, MEMORY_BROWSER_PATHS.tree, { project: 'proj-a' })
    const parent = filtered.json.data?.nodes.find((node) => node.title === '父条')
    expect(parent?.childCount).toBe(0)
    expect(parent?.leaf).toBe(true)
    // 该父条在筛选集内的子层确实为空（与 childCount 一致，不是断链）
    const children = await post<MemoryTreeResponse>(host, MEMORY_BROWSER_PATHS.tree, {
      project: 'proj-a',
      parentId: ids[0],
    })
    expect(children.json.data?.nodes).toEqual([])

    // 未筛选时按全库计数
    const unfiltered = await post<MemoryTreeResponse>(host, MEMORY_BROWSER_PATHS.tree, {})
    expect(unfiltered.json.data?.nodes.find((node) => node.title === '父条')?.childCount).toBe(1)
  })

  it('引擎异常回 500（不是 503），避免客户端误判“已禁用”', async () => {
    const { createMemoryListHandler } = await import('../src/memory-routes')
    const { RecallLedger } = await import('../src/recall-ledger')
    const handler = createMemoryListHandler({
      getMem: () => {
        throw new Error('engine boom')
      },
      getGeneration: () => 1,
      isEnabled: () => true,
      ledger: new RecallLedger(),
      write: {} as never,
      syncActivity: { isVerified: false } as never,
      status: async () => {
        throw new Error('unused')
      },
      log: () => {},
    })
    const response = await handler(
      new Request('http://127.0.0.1/api/memlite/browser/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    )
    expect(response.status).toBe(500)
    const body = (await response.json()) as { ok: boolean; error?: string; disabled?: boolean }
    expect(body.ok).toBe(false)
    expect(body.disabled).toBeUndefined()
    expect(body.error).not.toContain('boom')
  })
})
