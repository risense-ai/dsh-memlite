/**
 * 聊天记忆浏览器（M8 浏览器半区）测试。
 *
 * 只依赖 vitest + react-dom/server：
 * - memory-api：假 fetchImpl 下的成功解析、错误外壳、disabled、形状拒绝、字符串截断、abort 透出。
 * - 面板：`MemoryPanelView` 纯展示层 SSR（加载/空/错误/列表/详情/树/本次对话徽章），
 *   `MemliteMemoryPanel` 默认渲染（loading / sessionId 缺失）与 SSR 安全性。
 * - locale：注册用键、zh/en 对齐。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MEMORY_BROWSER_PATHS } from '../src/browser-contract'
import type {
  MemoryImportance,
  MemorySessionRecall,
  MemoryShowResponse,
  MemorySummaryItem,
} from '../src/browser-contract'
import {
  MemoryApiError,
  createMemoryApi,
  isAbortError,
  parseListResponse,
  parseSearchResponse,
  parseSessionRecallsResponse,
  parseShowResponse,
  parseTreeResponse,
  type MemoryApi,
} from '../src/client/memory-api'
import {
  MemoryPanelView,
  MemliteMemoryPanel,
  emptyAllState,
  emptyTreeState,
  formatScore,
  formatTimestamp,
  type MemoryPanelActions,
  type MemoryPanelState,
  type Translate,
} from '../src/client/MemliteMemory'
import { MEMORY_LOCALE_NS, memoryLocales } from '../src/client/memory-locales'

/* -------------------------------------------------------------------------- */
/* 固定夹具                                                                    */
/* -------------------------------------------------------------------------- */

const t: Translate = (key) => key
/** 保留插值参数的变体（断言 params 比如 turn/score 时使用）。 */
const tParams: Translate = (key, params) =>
  params === undefined ? key : `${key} ${JSON.stringify(params)}`

const SUMMARY: MemorySummaryItem = {
  id: 'mem-1',
  title: '记忆一',
  summary: '第一行摘要\n第二行摘要',
  tags: ['tag-a', 'tag-b'],
  project: 'proj',
  ts: 1_700_000_000,
  importance: 'important',
  kind: 'fact',
  childCount: 2,
  leaf: false,
}

const SUMMARY_2: MemorySummaryItem = {
  ...SUMMARY,
  id: 'mem-2',
  title: '记忆二',
  importance: 'trivial',
  childCount: 0,
  leaf: true,
}

const LIST_DATA = {
  engine: 3,
  items: [SUMMARY, SUMMARY_2],
  nextCursor: 'cursor-2',
  total: 42,
  projects: [['proj', 2], ['other', 1]] as Array<[string, number]>,
  tags: [['tag-a', 2]] as Array<[string, number]>,
}

const SEARCH_DATA = {
  engine: 3,
  backend: 'bm25',
  fallback: '',
  ms: 4,
  items: [{ ...SUMMARY, score: 0.87 }],
}

const SHOW_DATA: MemoryShowResponse = {
  engine: 3,
  found: true,
  record: {
    ...SUMMARY,
    content: '第一行正文\n第二行正文',
    truncated: false,
  },
  ancestors: [{ id: 'anc-1', title: '祖先记忆' }],
  children: [{ id: 'child-1', title: '子条记忆', summary: '子条摘要' }],
  chain: {
    ancestors: [{ id: 'anc-1', title: '祖先记忆' }],
    entry: { id: 'mem-1', title: '记忆一' },
    descendants: [{ id: 'child-1', title: '子条记忆', depth: 1 }],
  },
}

const TREE_DATA = {
  engine: 3,
  parentId: '',
  nodes: [
    { id: 'root-1', title: '根记忆', kind: 'fact', importance: 'important', ts: 1, childCount: 2, leaf: false },
    { id: 'root-2', title: '根叶', kind: 'fact', importance: '', ts: 2, childCount: 0, leaf: true },
  ],
  trimmed: true,
}

const RECALLS_DATA = {
  engine: 3,
  scope: 'session' as const,
  entries: [
    {
      agentId: 'agent-1',
      turn: 3,
      messageId: 'msg-3',
      timestamp: 1_700_000_300,
      backend: 'bm25',
      fallback: '',
      status: 'ok' as const,
      hits: [
        { id: 'mem-1', score: 0.91234, title: '记忆一', injected: true, exists: true },
        { id: 'mem-2', score: 0.4, title: '记忆二', injected: false, exclusion: 'threshold' as const, exists: true },
        { id: 'mem-3', score: 0.3, title: '记忆三', injected: false, exclusion: 'budget' as const, exists: false },
        { id: 'mem-4', score: 0.2, title: '记忆四', injected: false, exists: true },
      ],
    },
    {
      agentId: 'agent-1',
      turn: 3,
      messageId: 'msg-3b',
      timestamp: 1_700_000_301,
      backend: 'bm25',
      fallback: 'embedding',
      status: 'empty' as const,
      hits: [],
    },
    {
      agentId: 'agent-1',
      turn: 2,
      messageId: 'msg-2',
      timestamp: 1_700_000_200,
      backend: 'bm25',
      fallback: '',
      status: 'skipped' as const,
      skipReason: 'short' as const,
      hits: [],
    },
    {
      agentId: 'agent-1',
      turn: 1,
      messageId: 'msg-1',
      timestamp: 1_700_000_100,
      backend: 'bm25',
      fallback: '',
      status: 'error' as const,
      hits: [],
    },
  ],
  trimmed: true,
}

/* -------------------------------------------------------------------------- */
/* 假 fetch                                                                    */
/* -------------------------------------------------------------------------- */

interface FetchCall {
  input: Parameters<typeof fetch>[0]
  init: Parameters<typeof fetch>[1]
}

function responseOf(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response
}

function fakeFetch(payload: unknown, status = 200): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ input, init })
    return responseOf(payload, status)
  }) as typeof fetch
  return { impl, calls }
}

function badJsonFetch(): typeof fetch {
  const impl = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('not json')
      },
    }) as unknown as Response) as typeof fetch
  return impl
}

/* -------------------------------------------------------------------------- */
/* memory-api                                                                  */
/* -------------------------------------------------------------------------- */

describe('memory-api 请求与解析', () => {
  it('list 成功：document-relative POST + JSON + credentials，返回校验后的数据', async () => {
    const { impl, calls } = fakeFetch({ ok: true, data: LIST_DATA })
    const api = createMemoryApi(impl)
    const result = await api.list({ project: 'proj', limit: 20 })

    expect(result.engine).toBe(3)
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({ id: 'mem-1', title: '记忆一', importance: 'important' })
    expect(result.nextCursor).toBe('cursor-2')
    expect(result.total).toBe(42)
    expect(result.projects).toEqual([['proj', 2], ['other', 1]])

    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toBe(MEMORY_BROWSER_PATHS.list)
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
    })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ project: 'proj', limit: 20 })
  })

  it('五条路由各自命中正确的 document-relative 路径', async () => {
    const payloads: Record<string, unknown> = {
      [MEMORY_BROWSER_PATHS.list]: { ok: true, data: LIST_DATA },
      [MEMORY_BROWSER_PATHS.search]: { ok: true, data: SEARCH_DATA },
      [MEMORY_BROWSER_PATHS.show]: { ok: true, data: SHOW_DATA },
      [MEMORY_BROWSER_PATHS.tree]: { ok: true, data: TREE_DATA },
      [MEMORY_BROWSER_PATHS.sessionRecalls]: { ok: true, data: RECALLS_DATA },
    }
    const calls: FetchCall[] = []
    const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push({ input, init })
      return responseOf(payloads[String(input)])
    }) as typeof fetch
    const api = createMemoryApi(impl)

    await api.list({})
    await api.search({ query: 'x' })
    await api.show({ id: 'mem-1' })
    await api.tree({})
    await api.sessionRecalls({ sessionId: 'sess-1' })

    expect(calls.map((call) => call.input)).toEqual([
      MEMORY_BROWSER_PATHS.list,
      MEMORY_BROWSER_PATHS.search,
      MEMORY_BROWSER_PATHS.show,
      MEMORY_BROWSER_PATHS.tree,
      MEMORY_BROWSER_PATHS.sessionRecalls,
    ])
    expect(calls.every((call) => call.init?.method === 'POST')).toBe(true)
  })

  it('ok:false → MemoryApiError（含状态码与 code=http）', async () => {
    const { impl } = fakeFetch({ ok: false, error: 'boom' }, 500)
    const api = createMemoryApi(impl)
    await expect(api.list({})).rejects.toBeInstanceOf(MemoryApiError)
    await expect(api.list({})).rejects.toMatchObject({
      name: 'MemoryApiError',
      code: 'http',
      status: 500,
      disabled: false,
      message: 'boom',
    })
  })

  it('disabled:true / HTTP 503 → code=disabled 且 disabled=true', async () => {
    const { impl } = fakeFetch({ ok: false, error: 'memlite 已禁用', disabled: true }, 503)
    const api = createMemoryApi(impl)
    const error = await api.sessionRecalls({ sessionId: 's' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MemoryApiError)
    expect(error).toMatchObject({ code: 'disabled', disabled: true, status: 503 })
  })

  it('网络错误 → MemoryApiError（code=network，不泄露堆栈）', async () => {
    const impl = (async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    const api = createMemoryApi(impl)
    const error = await api.tree({}).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MemoryApiError)
    expect(error).toMatchObject({ code: 'network' })
    expect((error as MemoryApiError).message).toContain('Failed to fetch')
  })

  it('非 JSON 响应 → 可读错误（HTTP 200 → code=shape）', async () => {
    const api = createMemoryApi(badJsonFetch())
    await expect(api.list({})).rejects.toMatchObject({ code: 'shape', status: 200 })
  })

  it('abort 原样透出（不被包装成 MemoryApiError）', async () => {
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const impl = (async () => {
      throw aborted
    }) as typeof fetch
    const controller = new AbortController()
    controller.abort()
    const api = createMemoryApi(impl)
    const error = await api.list({}, controller.signal).catch((caught: unknown) => caught)
    expect(error).toBe(aborted)
    expect(isAbortError(error)).toBe(true)
    expect(isAbortError(new MemoryApiError('x', { code: 'shape' }))).toBe(false)
  })

  it('把 signal 传进 fetch init', async () => {
    const { impl, calls } = fakeFetch({ ok: true, data: LIST_DATA })
    const controller = new AbortController()
    await createMemoryApi(impl).list({}, controller.signal)
    expect(calls[0]?.init?.signal).toBe(controller.signal)
  })
})

describe('memory-api 形状校验', () => {
  it('items 非数组 → 拒绝', async () => {
    const { impl } = fakeFetch({ ok: true, data: { ...LIST_DATA, items: 'nope' } })
    await expect(createMemoryApi(impl).list({})).rejects.toMatchObject({ code: 'shape' })
  })

  it('items 超过上限 → 拒绝（不静默截断数组）', async () => {
    const items = Array.from({ length: 201 }, (_, index) => ({ ...SUMMARY, id: `mem-${index}` }))
    const { impl } = fakeFetch({ ok: true, data: { ...LIST_DATA, items } })
    await expect(createMemoryApi(impl).list({})).rejects.toMatchObject({ code: 'shape' })
  })

  it('字段类型错误 → 拒绝（total 非数字）', async () => {
    const { impl } = fakeFetch({ ok: true, data: { ...LIST_DATA, total: '42' } })
    await expect(createMemoryApi(impl).list({})).rejects.toMatchObject({ code: 'shape' })
  })

  it('show：record 字段类型错误 / chain 缺失 → 拒绝', async () => {
    const badRecord = { ...SHOW_DATA, record: { ...SHOW_DATA.record, content: 42 } }
    await expect(
      createMemoryApi(fakeFetch({ ok: true, data: badRecord }).impl).show({ id: 'mem-1' }),
    ).rejects.toMatchObject({ code: 'shape' })

    const noChain = { ...SHOW_DATA, chain: undefined }
    await expect(
      createMemoryApi(fakeFetch({ ok: true, data: noChain }).impl).show({ id: 'mem-1' }),
    ).rejects.toMatchObject({ code: 'shape' })
  })

  it('tree：nodes 非数组 / parentId 非字符串 → 拒绝', async () => {
    await expect(
      createMemoryApi(fakeFetch({ ok: true, data: { ...TREE_DATA, nodes: {} } }).impl).tree({}),
    ).rejects.toMatchObject({ code: 'shape' })
    await expect(
      createMemoryApi(fakeFetch({ ok: true, data: { ...TREE_DATA, parentId: 3 } }).impl).tree({}),
    ).rejects.toMatchObject({ code: 'shape' })
  })

  it('session-recalls：status/skipReason/exclusion 枚举校验', async () => {
    const badStatus = {
      ...RECALLS_DATA,
      entries: [{ ...RECALLS_DATA.entries[0], status: 'weird' }],
    }
    await expect(
      createMemoryApi(
        fakeFetch({ ok: true, data: badStatus }).impl,
      ).sessionRecalls({ sessionId: 's' }),
    ).rejects.toMatchObject({ code: 'shape' })

    const badReason = {
      ...RECALLS_DATA,
      entries: [{ ...RECALLS_DATA.entries[2], skipReason: 'other' }],
    }
    await expect(
      createMemoryApi(
        fakeFetch({ ok: true, data: badReason }).impl,
      ).sessionRecalls({ sessionId: 's' }),
    ).rejects.toMatchObject({ code: 'shape' })

    const badExclusion = {
      ...RECALLS_DATA,
      entries: [
        {
          ...RECALLS_DATA.entries[0],
          hits: [{ id: 'hit-1', score: 0.5, title: 'x', injected: false, exclusion: 'other' }],
        },
      ],
    }
    await expect(
      createMemoryApi(
        fakeFetch({ ok: true, data: badExclusion }).impl,
      ).sessionRecalls({ sessionId: 's' }),
    ).rejects.toMatchObject({ code: 'shape' })
  })

  it('字符串长度截断（标题/摘要/正文），score 只截负数（保留 BM25 原始分）', async () => {
    const long = 'x'.repeat(500)
    const { impl } = fakeFetch({
      ok: true,
      data: {
        ...LIST_DATA,
        items: [{ ...SUMMARY, title: long, summary: long }],
      },
    })
    const result = await createMemoryApi(impl).list({})
    expect(result.items[0]?.title.length).toBe(200)
    expect(result.items[0]?.summary.length).toBe(160)

    const show = await createMemoryApi(
      fakeFetch({
        ok: true,
        data: {
          ...SHOW_DATA,
          record: { ...SHOW_DATA.record, content: 'y'.repeat(30_000) },
        },
      }).impl,
    ).show({ id: 'mem-1' })
    expect(show.record?.content.length).toBe(20_000)

    const search = await createMemoryApi(
      fakeFetch({
        ok: true,
        data: { ...SEARCH_DATA, items: [{ ...SUMMARY, score: 1.7 }] },
      }).impl,
    ).search({ query: 'x' })
    // BM25 原始分可 >1：保留原值，不做上限截断
    expect(search.items[0]?.score).toBe(1.7)
  })

  it('found=false 且 record 缺省、chain 降级为 {id:"",title:""} 时可解析', () => {
    const parsed = parseShowResponse({
      engine: 1,
      found: false,
      ancestors: [],
      children: [],
      chain: { ancestors: [], entry: { id: '', title: '' }, descendants: [] },
    })
    expect(parsed.found).toBe(false)
    expect(parsed.record).toBeUndefined()
    expect(parsed.chain.entry).toEqual({ id: '', title: '' })
  })

  it('导出的 parser 可被直接调用并拒绝非法输入', () => {
    expect(() => parseListResponse(null)).toThrow(MemoryApiError)
    expect(() => parseListResponse({ ...LIST_DATA, projects: [['p']] })).toThrow(MemoryApiError)
    expect(() => parseSearchResponse({ ...SEARCH_DATA, ms: Number.NaN })).toThrow(MemoryApiError)
    expect(() => parseTreeResponse({ ...TREE_DATA, trimmed: 'yes' })).toThrow(MemoryApiError)
    expect(() =>
      parseSessionRecallsResponse({ ...RECALLS_DATA, scope: 'global' }),
    ).toThrow(MemoryApiError)
    expect(parseListResponse(LIST_DATA).items[1]?.id).toBe('mem-2')
  })

  it('响应外壳缺少 data → 拒绝', async () => {
    const { impl } = fakeFetch({ ok: true })
    await expect(createMemoryApi(impl).list({})).rejects.toMatchObject({ code: 'shape' })
  })
})

/* -------------------------------------------------------------------------- */
/* locale                                                                      */
/* -------------------------------------------------------------------------- */

describe('memory-locales', () => {
  it('命名空间与注册用键齐全', () => {
    expect(MEMORY_LOCALE_NS).toBe('memliteMemory')
    const registrationKeys = ['tab.title', 'guide.title', 'guide.description'] as const
    for (const key of registrationKeys) {
      expect(Object.keys(memoryLocales.zh)).toContain(key)
      expect(Object.keys(memoryLocales.en)).toContain(key)
      expect(memoryLocales.zh[key]).not.toBe('')
      expect(memoryLocales.en[key]).not.toBe('')
    }
  })

  it('zh/en 键集合一致且没有空串', () => {
    expect(Object.keys(memoryLocales.en).sort()).toEqual(Object.keys(memoryLocales.zh).sort())
    for (const value of [...Object.values(memoryLocales.zh), ...Object.values(memoryLocales.en)]) {
      expect(typeof value).toBe('string')
      expect(value.trim()).not.toBe('')
    }
  })
})

/* -------------------------------------------------------------------------- */
/* 纯展示层 SSR                                                                */
/* -------------------------------------------------------------------------- */

function noopActions(overrides: Partial<MemoryPanelActions> = {}): MemoryPanelActions {
  return {
    setView: () => {},
    refresh: () => {},
    setQuery: () => {},
    setProject: () => {},
    setTag: () => {},
    setImportance: () => {},
    loadMore: () => {},
    select: () => {},
    toggleNode: () => {},
    loadChild: () => {},
    copy: () => {},
    closeDetail: () => {},
    ...overrides,
  }
}

function panelState(overrides: Partial<MemoryPanelState> = {}): MemoryPanelState {
  return {
    view: 'session',
    session: { status: 'loading' },
    all: emptyAllState(),
    tree: emptyTreeState(),
    detail: { status: 'idle' },
    query: '',
    project: '',
    tag: '',
    importance: '',
    ...overrides,
  }
}

function renderView(
  state: MemoryPanelState,
  actions: MemoryPanelActions = noopActions(),
  translate: Translate = t,
): string {
  return renderToStaticMarkup(createElement(MemoryPanelView, { t: translate, state, actions }))
}

function readyRecall(entries: MemorySessionRecall[]): MemoryPanelState {
  return panelState({ session: { status: 'ready', data: { engine: 3, scope: 'session', entries, trimmed: false } } })
}

describe('MemoryPanelView SSR：本次对话', () => {
  it('注入状态徽章对照：已注入/低于阈值/预算截断/候选未注入/已删除', () => {
    const html = renderView(readyRecall(RECALLS_DATA.entries as unknown as MemorySessionRecall[]))
    expect(html).toContain('session.injected')
    expect(html).toContain('session.threshold')
    expect(html).toContain('session.budget')
    expect(html).toContain('session.candidate')
    expect(html).toContain('session.deleted')
    expect(html).toContain('session.score')
    expect(html).toContain('session.backend')
    expect(html).toContain('session.fallback')
    expect(html).toContain('session.recallError')
    expect(html).toContain('session.skip.short')
    expect(html).toContain('session.turn')
    expect(html).toContain('session.scopeSession')
  })

  it('按 turn 倒序分组（第 3 回合在第 2 回合之前）', () => {
    const state = readyRecall(RECALLS_DATA.entries as unknown as MemorySessionRecall[])
    const html = renderView(state, noopActions(), tParams)
    const turn3 = html.indexOf('&quot;turn&quot;:3')
    const turn2 = html.indexOf('&quot;turn&quot;:2')
    expect(turn3).toBeGreaterThanOrEqual(0)
    expect(turn2).toBeGreaterThan(turn3)
  })

  it('空态与 sessionId 缺失的不可用态', () => {
    expect(renderView(panelState({ session: { status: 'ready', data: { engine: 1, scope: 'session', entries: [], trimmed: false } } }))).toContain(
      'session.empty',
    )
    expect(renderView(panelState({ session: { status: 'unavailable' } }))).toContain(
      'session.unavailableTitle',
    )
    expect(renderView(panelState({ session: { status: 'disabled' } }))).toContain(
      'state.disabledTitle',
    )
  })
})

describe('MemoryPanelView SSR：全部记忆', () => {
  it('列表项、筛选选项与「加载更多」', () => {
    const html = renderView(
      panelState({
        view: 'all',
        all: emptyAllState({
          status: 'ready',
          items: [SUMMARY, SUMMARY_2],
          nextCursor: 'cursor-2',
          total: 42,
          projects: [['proj', 2]],
          tags: [['tag-a', 2]],
        }),
      }),
    )
    expect(html).toContain('记忆一')
    expect(html).toContain('第一行摘要')
    expect(html).toContain('list.total')
    expect(html).toContain('list.projectAll')
    expect(html).toContain('list.tagAll')
    expect(html).toContain('list.importanceAll')
    expect(html).toContain('list.loadMore')
    expect(html).toContain('proj')
    expect(html).toContain('tag-a')
    expect(html).toContain('list.importanceImportant')
  })

  it('没有下一游标时不渲染「加载更多」；搜索结果带相关度', () => {
    const html = renderView(
      panelState({
        view: 'all',
        all: emptyAllState({
          status: 'ready',
          items: [{ ...SUMMARY, score: 0.87 }],
          scored: true,
          nextCursor: null,
        }),
      }),
      noopActions(),
      tParams,
    )
    expect(html).not.toContain('list.loadMore')
    expect(html).toContain('list.score')
    expect(html).toContain('0.870')
  })

  it('空库 / 无命中 / 错误 / 禁用状态', () => {
    const empty = renderView(panelState({ view: 'all', all: emptyAllState({ status: 'ready' }) }))
    expect(empty).toContain('list.empty')

    const noHits = renderView(
      panelState({ view: 'all', all: emptyAllState({ status: 'ready' }), query: '没有' }),
    )
    expect(noHits).toContain('list.noHits')

    const error = renderView(
      panelState({ view: 'all', all: emptyAllState({ status: 'error', error: { code: 'http', status: 500 } }) }),
    )
    expect(error).toContain('state.errorTitle')
    expect(error).toContain('state.errorHttp')
    expect(error).toContain('retry')

    const disabled = renderView(panelState({ view: 'all', all: emptyAllState({ status: 'disabled' }) }))
    expect(disabled).toContain('state.disabledTitle')
  })

  it('加载更多失败显示可重试提示', () => {
    const html = renderView(
      panelState({
        view: 'all',
        all: emptyAllState({
          status: 'ready',
          items: [SUMMARY],
          nextCursor: 'cursor-2',
          loadMoreError: { code: 'network' },
        }),
      }),
    )
    expect(html).toContain('list.loadMoreError')
  })
})

function detailState(overrides: Partial<MemoryPanelState['detail']> = {}): MemoryPanelState['detail'] {
  return { status: 'ready', id: 'mem-1', data: SHOW_DATA, ...overrides }
}

describe('MemoryPanelView SSR：详情', () => {
  it('全文（pre-wrap 纯文本）、元数据、因果邻居与复制按钮', () => {
    const html = renderView(panelState({ detail: detailState() }))
    expect(html).toContain('第一行正文')
    expect(html).toContain('pre-wrap')
    expect(html).toContain('anywhere')
    expect(html).toContain('detail.metaProject')
    expect(html).toContain('detail.metaId')
    expect(html).toContain('detail.ancestors')
    expect(html).toContain('detail.children')
    expect(html).toContain('detail.chain')
    expect(html).toContain('detail.copyContent')
    expect(html).toContain('detail.copyId')
    expect(html).toContain('祖先记忆')
    expect(html).toContain('子条记忆')
  })

  it('正文按文本转义，不注入 HTML', () => {
    const html = renderView(
      panelState({
        detail: detailState({
          data: {
            ...SHOW_DATA,
            record: { ...SHOW_DATA.record!, content: '<img src=x onerror=alert(1)>' },
          },
        }),
      }),
    )
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('found=false → 原记忆已删除；loading/error/disabled 状态', () => {
    const deleted = renderView(
      panelState({
        detail: { status: 'ready', id: 'mem-1', data: { ...SHOW_DATA, found: false, record: undefined } },
      }),
    )
    expect(deleted).toContain('detail.deletedTitle')

    expect(renderView(panelState({ detail: { status: 'loading', id: 'mem-1' } }))).toContain(
      'detail.loading',
    )
    expect(
      renderView(panelState({ detail: { status: 'error', id: 'mem-1', error: { code: 'network' } } })),
    ).toContain('retry')
    expect(renderView(panelState({ detail: { status: 'disabled', id: 'mem-1' } }))).toContain(
      'state.disabledTitle',
    )
  })

  it('复制结果提示', () => {
    expect(renderView(panelState({ detail: detailState(), copied: 'content' }))).toContain(
      'detail.copied',
    )
    expect(renderView(panelState({ detail: detailState(), copied: 'failed' }))).toContain(
      'detail.copyFailed',
    )
  })

  it('列表与树中选中的记忆带 aria-current 高亮', () => {
    const listHtml = renderView(
      panelState({
        view: 'all',
        all: emptyAllState({ status: 'ready', items: [SUMMARY] }),
        detail: detailState(),
      }),
    )
    expect(listHtml).toContain('aria-current="true"')

    const node = {
      id: 'mem-1',
      title: '记忆一',
      kind: 'fact',
      importance: 'important' as MemoryImportance,
      ts: 1,
      childCount: 0,
      leaf: true,
    }
    const treeHtml = renderView(
      panelState({
        view: 'tree',
        tree: emptyTreeState({ status: 'ready', nodes: [node] }),
        detail: detailState(),
      }),
    )
    expect(treeHtml).toContain('aria-current="true"')
  })
})

describe('MemoryPanelView SSR：因果树', () => {
  const treeNode = {
    id: 'root-1',
    title: '根记忆',
    kind: 'fact',
    importance: 'important' as MemoryImportance,
    ts: 1,
    childCount: 1,
    leaf: false,
  }

  it('根节点、子条数、叶标记与缩进子层', () => {
    const html = renderView(
      panelState({
        view: 'tree',
        tree: emptyTreeState({
          status: 'ready',
          nodes: [treeNode, { ...treeNode, id: 'root-2', title: '根叶', childCount: 0, leaf: true }],
          expanded: { 'root-1': true },
          children: {
            'root-1': {
              status: 'ready',
              nodes: [{ ...treeNode, id: 'child-1', title: '子节点', childCount: 0, leaf: true }],
              trimmed: true,
            },
          },
          trimmed: true,
        }),
      }),
    )
    expect(html).toContain('根记忆')
    expect(html).toContain('子节点')
    expect(html).toContain('tree.rootCount')
    expect(html).toContain('tree.children')
    expect(html).toContain('tree.leaf')
    expect(html).toContain('tree.trimmed')
    expect(html).toContain('tree.collapse')
  })

  it('环检测：子节点 id 与祖先相同时截断并提示', () => {
    const html = renderView(
      panelState({
        view: 'tree',
        tree: emptyTreeState({
          status: 'ready',
          nodes: [treeNode],
          expanded: { 'root-1': true },
          children: {
            'root-1': {
              status: 'ready',
              nodes: [{ ...treeNode, id: 'root-1', title: '自身' }],
              trimmed: false,
            },
          },
        }),
      }),
    )
    expect(html).toContain('tree.cycle')
  })

  it('空树、子层加载中、子层失败与断链提示', () => {
    expect(renderView(panelState({ view: 'tree', tree: emptyTreeState({ status: 'ready' }) }))).toContain(
      'tree.empty',
    )

    const loadingChild = renderView(
      panelState({
        view: 'tree',
        tree: emptyTreeState({
          status: 'ready',
          nodes: [treeNode],
          expanded: { 'root-1': true },
          children: { 'root-1': { status: 'loading', nodes: [], trimmed: false } },
        }),
      }),
    )
    expect(loadingChild).toContain('tree.loadingChildren')

    const failedChild = renderView(
      panelState({
        view: 'tree',
        tree: emptyTreeState({
          status: 'ready',
          nodes: [treeNode],
          expanded: { 'root-1': true },
          children: {
            'root-1': { status: 'error', nodes: [], trimmed: false, error: { code: 'network' } },
          },
        }),
      }),
    )
    expect(failedChild).toContain('tree.childError')
    expect(failedChild).toContain('retry')

    const brokenLink = renderView(
      panelState({
        view: 'tree',
        tree: emptyTreeState({
          status: 'ready',
          nodes: [treeNode],
          expanded: { 'root-1': true },
          children: { 'root-1': { status: 'ready', nodes: [], trimmed: false } },
        }),
      }),
    )
    expect(brokenLink).toContain('tree.childEmpty')
  })

  it('树根层读取失败可重试', () => {
    const html = renderView(
      panelState({ view: 'tree', tree: emptyTreeState({ status: 'error', error: { code: 'network' } }) }),
    )
    expect(html).toContain('state.errorTitle')
    expect(html).toContain('retry')
  })
})

describe('formatTimestamp / formatScore', () => {
  it('默认本地时区（与聊天时间一致）；显式 utc 时确定', () => {
    // 面板按本地时区渲染；跨时区断言用 'utc' 保证确定
    expect(formatTimestamp(0, 'utc')).toBe('1970-01-01 00:00')
    expect(formatTimestamp(0)).toMatch(/^1970-01-0[12] \d{2}:\d{2}$/)
    expect(formatTimestamp(Number.NaN)).toBe('—')
  })

  it('分数固定三位小数', () => {
    expect(formatScore(0.5)).toBe('0.500')
    expect(formatScore(1)).toBe('1.000')
    expect(formatScore(Number.NaN)).toBe('—')
  })
})

/* -------------------------------------------------------------------------- */
/* 面板组件 SSR（默认状态 / 无 sessionId / SSR 安全）                           */
/* -------------------------------------------------------------------------- */

function pendingApi(): MemoryApi {
  const pending = <T,>(): Promise<T> => new Promise<T>(() => {})
  return {
    list: () => pending(),
    search: () => pending(),
    show: () => pending(),
    tree: () => pending(),
    sessionRecalls: () => pending(),
  }
}

describe('MemliteMemoryPanel SSR', () => {
  it('有 sessionId：首屏 loading + 三视图切换 + 只读标签', () => {
    const html = renderToStaticMarkup(
      createElement(MemliteMemoryPanel, { t, sessionId: 'sess-1', api: pendingApi() }),
    )
    expect(html).toContain('state.loading')
    expect(html).toContain('view.session')
    expect(html).toContain('view.all')
    expect(html).toContain('view.tree')
    expect(html).toContain('readOnly')
    expect(html).toContain('refresh')
  })

  it('缺 sessionId：明示不可用，不伪造会话', () => {
    const html = renderToStaticMarkup(createElement(MemliteMemoryPanel, { t, api: pendingApi() }))
    expect(html).toContain('session.unavailableTitle')
    expect(html).toContain('session.unavailableDescription')
  })

  it('SSR 安全：没有 window/navigator 也能渲染（含防御式 useTabInfo）', () => {
    const html = renderToStaticMarkup(
      createElement(MemliteMemoryPanel, {
        t,
        sessionId: 'sess-1',
        api: pendingApi(),
        useTabInfo: () => ({ tab: { visible: true } }),
      }),
    )
    expect(html).toContain('view.session')

    let threw = false
    try {
      renderToStaticMarkup(
        createElement(MemliteMemoryPanel, {
          t,
          sessionId: 'sess-1',
          api: pendingApi(),
          // 形状未知的 hook 返回值也不应导致崩溃
          useTabInfo: () => 42,
        }),
      )
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })

  it('实现里不使用 dangerouslySetInnerHTML（正文只能按文本渲染）', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src', 'client', 'MemliteMemory.tsx'),
      'utf8',
    )
    // 注释里允许出现该词，但实现中不允许真正使用它。
    expect(source).not.toMatch(/dangerouslySetInnerHTML\s*[:=]/)
  })
})
