/**
 * 本地 UI 预览（不属于 npm 产物）：用内存 fixture 驱动真实面板组件。
 * 运行：node scripts/build-preview.mjs && python3 -m http.server 8123 -d preview
 */
import { createRoot } from 'react-dom/client'
import { MemliteMemoryPanel } from '../src/client/MemliteMemory'
import { memoryLocales } from '../src/client/memory-locales'
import type {
  MemoryApi,
  MemoryListRequest,
  MemorySearchRequest,
  MemoryShowRequest,
  MemoryTreeRequest,
  MemorySessionRecallsRequest,
  MemoryRememberRequest,
  MemoryUpdateRequest,
  MemoryAttachRequest,
  MemoryForgetRequest,
  MemoryRecallFeedbackRequest,
} from '../src/client/memory-api'
import type {
  MemoryDetail,
  MemoryImportance,
  MemorySessionRecall,
  MemoryShowResponse,
  MemoryStatusResponse,
  MemorySummaryItem,
  MemoryTreeResponse,
  MemoryWriteReceipt,
} from '../src/browser-contract'

interface FixtureMemory {
  id: string
  title: string
  content: string
  tags: string[]
  project: string
  ts: number
  importance: MemoryImportance
  kind: string
  revision: number
  parentId: string
}

const memories: FixtureMemory[] = [
  {
    id: 'aaaaaaaa1111',
    title: 'nginx 504 根因与处置',
    content: '生产环境 nginx 反向代理 504 超时，根因是上游连接池过小（默认 32），已扩到 256 并加 P95 延迟监控。',
    tags: ['nginx', 'incident'],
    project: 'risense',
    ts: 1_794_000_000,
    importance: 'important',
    kind: 'Context',
    revision: 0,
    parentId: '',
  },
  {
    id: 'bbbbbbbb2222',
    title: '504 现象与时间分布',
    content: '告警集中在每天 10:00–11:00，P95 从 800ms 升到 4.2s；上游日志显示 connection pool exhausted。',
    tags: ['nginx'],
    project: 'risense',
    ts: 1_794_000_100,
    importance: 'trivial',
    kind: 'Context',
    revision: 0,
    parentId: 'aaaaaaaa1111',
  },
  {
    id: 'cccccccc3333',
    title: '504 处置步骤',
    content: '1. 扩容连接池；2. 增加超时重试；3. 观察 P95 与 5xx 比例；4. 回写复盘到因果树。',
    tags: ['nginx', 'runbook'],
    project: 'risense',
    ts: 1_794_000_200,
    importance: 'important',
    kind: 'Task',
    revision: 0,
    parentId: 'aaaaaaaa1111',
  },
  {
    id: 'dddddddd4444',
    title: '本周发布约定',
    content: '周四 18:00 后不发版；紧急修复需两人复核并留回滚脚本。',
    tags: ['process'],
    project: '',
    ts: 1_793_900_000,
    importance: 'important',
    kind: 'Context',
    revision: 0,
    parentId: '',
  },
]

const feedback: Record<string, 'helpful' | 'irrelevant'> = {}

const recalls: MemorySessionRecall[] = [
  {
    agentId: 'preview-agent',
    turn: 3,
    messageId: 'message-3',
    timestamp: 1_794_000_500,
    backend: 'bm25',
    fallback: '',
    status: 'ok',
    threshold: 0.3,
    budgetChars: 1500,
    usedChars: 240,
    limit: 5,
    elapsedMs: 4,
    injectedText:
      '【memlite · 自动召回】以下为标题级记忆；需要正文用 memlite_show <id> 读取：\n- [5.47] nginx 504 根因与处置（aaaaaaaa）\n- [2.31] 504 处置步骤（cccccccc）',
    hits: [
      { id: 'aaaaaaaa1111', score: 5.47, title: 'nginx 504 根因与处置', injected: true, exists: true },
      { id: 'cccccccc3333', score: 2.31, title: '504 处置步骤', injected: true, exists: true },
      { id: 'bbbbbbbb2222', score: 0.18, title: '504 现象与时间分布', injected: false, exclusion: 'threshold', exists: true },
      { id: 'dddddddd4444', score: 1.2, title: '本周发布约定', injected: false, exclusion: 'budget', exists: true },
    ],
    feedback: { ...feedback },
  },
]

function summary(memory: FixtureMemory): MemorySummaryItem {
  const childCount = memories.filter((item) => item.parentId === memory.id).length
  return {
    id: memory.id,
    title: memory.title,
    summary: memory.content.slice(0, 120),
    tags: memory.tags,
    project: memory.project,
    ts: memory.ts,
    importance: memory.importance,
    kind: memory.kind,
    revision: memory.revision,
    childCount,
    leaf: childCount === 0,
  }
}

function detail(memory: FixtureMemory): MemoryDetail {
  return {
    ...summary(memory),
    content: memory.content,
    truncated: false,
    parentId: memory.parentId,
  }
}

function receipt(
  operationId: string,
  kind: MemoryWriteReceipt['kind'],
  status: MemoryWriteReceipt['status'],
  memory: FixtureMemory | undefined,
  extra: Partial<MemoryWriteReceipt> = {},
): MemoryWriteReceipt {
  return {
    operationId,
    kind,
    status,
    id: memory?.id ?? '',
    title: memory?.title ?? '',
    verified: status === 'saved',
    embedded: kind === 'forget' || kind === 'attach' ? 'not-applicable' : 'disabled',
    timestamp: Math.floor(Date.now() / 1000),
    ...(memory !== undefined ? { revision: memory.revision } : {}),
    ...extra,
  }
}

function find(id: string): FixtureMemory | undefined {
  return memories.find((memory) => memory.id === id)
}

const api: MemoryApi = {
  async list(req: MemoryListRequest) {
    const filtered = memories
      .filter((memory) => (req.project ? memory.project === req.project : true))
      .sort((left, right) => right.ts - left.ts)
    return {
      engine: 1,
      items: filtered.slice(0, req.limit ?? 20).map(summary),
      nextCursor: null,
      total: filtered.length,
      projects: [['risense', 3], ['（无）', 1]],
      tags: [['nginx', 3], ['incident', 1]],
    }
  },
  async search(req: MemorySearchRequest) {
    const query = req.query.trim()
    const items = memories
      .filter((memory) => query === '' || `${memory.title}\n${memory.content}`.includes(query))
      .slice(0, req.limit ?? 10)
      .map((memory, index) => ({ ...summary(memory), score: Math.max(0.1, 3 - index * 0.5) }))
    return { engine: 1, backend: 'bm25', fallback: '', ms: 4, items }
  },
  async show(req: MemoryShowRequest): Promise<MemoryShowResponse> {
    const memory = find(req.id)
    if (memory === undefined) {
      return {
        engine: 1,
        found: false,
        ancestors: [],
        children: [],
        chain: { ancestors: [], entry: { id: '', title: '' }, descendants: [] },
      }
    }
    const parent = memory.parentId !== '' ? find(memory.parentId) : undefined
    const children = memories.filter((item) => item.parentId === memory.id)
    return {
      engine: 1,
      found: true,
      record: detail(memory),
      ancestors: parent !== undefined ? [{ id: parent.id, title: parent.title }] : [],
      children: children.map((child) => ({ id: child.id, title: child.title, summary: child.content.slice(0, 80) })),
      chain: {
        ancestors: parent !== undefined ? [{ id: parent.id, title: parent.title }] : [],
        entry: { id: memory.id, title: memory.title },
        descendants: children.map((child) => ({ id: child.id, title: child.title, depth: 1 })),
      },
    }
  },
  async tree(req: MemoryTreeRequest): Promise<MemoryTreeResponse> {
    const parentId = req.parentId ?? ''
    const nodes = memories
      .filter((memory) => memory.parentId === parentId)
      .map((memory) => {
        const item = summary(memory)
        return {
          id: item.id,
          title: item.title,
          kind: item.kind,
          importance: item.importance,
          ts: item.ts,
          childCount: item.childCount,
          leaf: item.leaf,
        }
      })
    return { engine: 1, parentId, nodes, trimmed: false }
  },
  async sessionRecalls(req: MemorySessionRecallsRequest) {
    void req
    return {
      engine: 1,
      scope: 'session',
      entries: recalls.map((entry) => ({ ...entry, feedback: { ...feedback } })),
      trimmed: false,
    }
  },
  async status(): Promise<MemoryStatusResponse> {
    return {
      engine: 1,
      library: { enabled: true, records: memories.length, badLines: 0, vectors: 0, dataScope: 'project', files: 1 },
      search: { backend: 'bm25', embeddingProvider: 'none', embeddingConfigured: false, fallbacks: 0 },
      sync: { available: true, hasRemote: true, dirty: true, verified: true, localSha: 'abc123def456' },
      obsidian: { state: 'unchecked' },
      receipts: [],
    }
  },
  async remember(req: MemoryRememberRequest) {
    const memory: FixtureMemory = {
      id: `new${String(Date.now()).slice(-8)}`,
      title: req.title,
      content: req.content,
      tags: req.tags ?? [],
      project: req.project ?? '',
      ts: Math.floor(Date.now() / 1000),
      importance: req.importance ?? 'important',
      kind: 'Context',
      revision: 0,
      parentId: req.parentId ?? '',
    }
    memories.push(memory)
    return receipt(req.operationId, 'remember', 'saved', memory)
  },
  async update(req: MemoryUpdateRequest) {
    const memory = find(req.id)
    if (memory === undefined) return receipt(req.operationId, 'update', 'rejected', undefined, { code: 'NOT_FOUND' })
    if (memory.revision !== req.expectedRevision) {
      return receipt(req.operationId, 'update', 'conflict', memory, {
        code: 'STALE_VERSION',
        current: detail(memory),
      })
    }
    memory.title = req.title ?? memory.title
    memory.content = req.content ?? memory.content
    memory.tags = req.tags ?? memory.tags
    memory.importance = req.importance ?? memory.importance
    memory.revision += 1
    return receipt(req.operationId, 'update', 'saved', memory)
  },
  async attach(req: MemoryAttachRequest) {
    const memory = find(req.id)
    if (memory === undefined) return receipt(req.operationId, 'attach', 'rejected', undefined, { code: 'NOT_FOUND' })
    if (memory.revision !== req.expectedRevision) {
      return receipt(req.operationId, 'attach', 'conflict', memory, { code: 'STALE_VERSION', current: detail(memory) })
    }
    memory.parentId = req.parentId
    memory.revision += 1
    return receipt(req.operationId, 'attach', 'saved', memory)
  },
  async forget(req: MemoryForgetRequest) {
    const index = memories.findIndex((memory) => memory.id === req.id)
    if (index < 0) return receipt(req.operationId, 'forget', 'rejected', undefined, { code: 'NOT_FOUND' })
    const memory = memories[index]!
    if (memory.revision !== req.expectedRevision || (memory.title || memory.id) !== req.confirmTitle) {
      return receipt(req.operationId, 'forget', 'rejected', memory, { code: 'CONFIRM_MISMATCH', current: detail(memory) })
    }
    memories.splice(index, 1)
    return receipt(req.operationId, 'forget', 'saved', memory)
  },
  async feedback(req: MemoryRecallFeedbackRequest) {
    feedback[req.memoryId] = req.feedback
    for (const entry of recalls) entry.feedback = { ...feedback }
    return { updated: true, feedback: req.feedback }
  },
  async sync() {
    return { committed: true, localSha: 'abc123def456', remoteSha: 'abc123def456', verified: true }
  },
  async reembed() {
    return { total: memories.length, embedded: memories.length, failed: 0 }
  },
}

const zh = memoryLocales.zh as Record<string, string>
const t = (key: string, params?: Record<string, unknown>): string => {
  const template = zh[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? `{${name}}`))
}

const root = document.getElementById('root')
if (root !== null) {
  createRoot(root).render(<MemliteMemoryPanel t={t} sessionId="preview-session" api={api} />)
}
