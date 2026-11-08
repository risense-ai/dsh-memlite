/**
 * 记忆浏览投影（M8a/M8b 宿主半区）。
 *
 * 约束（proposal §14.4）：
 * - 只经 Memlite 主类读取：`mem.store` 是主类公开 getter，读到的是内存索引；
 *   插件**不**直接读 JSONL、不碰归档文件。
 * - 有界：列表/搜索/树都有条数与字符上限，详情正文单独限长；调用方给的上限一律 clamp。
 * - 白名单：列表/搜索/树不返回正文；`extra` 只投影 importance/kind；
 *   向量、凭据、路径、querylog 不出现。
 * - 纯函数 + 一次 O(n) 内存遍历：本地记忆库规模（千级）内可接受，且不阻塞事件循环之外的 IO。
 */
import type { Memlite, MemRecord } from '@rsrsai/memlite'
import {
  DEFAULT_PROJECTION_LIMITS,
  recordImportance,
  recordKind,
  type MemoryDetail,
  type MemoryImportance,
  type MemoryListRequest,
  type MemoryNeighbor,
  type MemorySearchItem,
  type MemorySearchRequest,
  type MemoryShowResponse,
  type MemorySummaryItem,
  type MemoryTreeRequest,
  type MemoryTreeNode,
  type ProjectionLimits,
} from './browser-contract'

/** 列表页大小上限（契约：1..50）。 */
export const MAX_LIST_LIMIT = 50
/** 搜索页大小上限（契约：1..20）。 */
export const MAX_SEARCH_LIMIT = 20
/** 树单层节点上限（契约：1..200）。 */
export const MAX_TREE_LIMIT = 200
/** show 的因果链节点上限（防一次返回全深树/大子树）。 */
export const MAX_CHAIN_NODES = 200
/** show 的链深度（`mem.chain` 的 depth）。 */
export const SHOW_CHAIN_DEPTH = 3

/** 项目筛选的「无项目」哨兵：memlite 的 projectCounts 用「（无）」表示空 project。 */
export const NO_PROJECT_LABEL = '（无）'

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** 单行化 + 长度上限（列表摘要/标题/邻居标题共用）。 */
export function clipText(value: string, cap: number): string {
  const oneLine = value.replace(/\s+/gu, ' ').trim()
  if (oneLine.length <= cap) return oneLine
  return `${[...oneLine].slice(0, cap).join('')}…`
}

function recordTitle(record: MemRecord, cap: number): string {
  const title = record.title !== '' ? record.title : record.content
  return clipText(title, cap)
}

function summaryOf(record: MemRecord, cap: number): string {
  return clipText(record.content, cap)
}

function cleanTags(tags: readonly string[] | undefined, cap: number): string[] {
  if (!Array.isArray(tags)) return []
  const out: string[] = []
  for (const tag of tags) {
    if (typeof tag !== 'string') continue
    const text = tag.trim()
    if (text !== '') out.push(text.slice(0, 80))
    if (out.length >= cap) break
  }
  return out
}

function projectFilter(requested: string | undefined): string | undefined {
  const value = (requested ?? '').trim()
  if (value === '') return undefined // 全部项目
  if (value === NO_PROJECT_LABEL) return '' // 只看无项目
  return value.slice(0, 100)
}

function importanceFilter(requested: unknown): MemoryImportance | undefined {
  return requested === 'important' || requested === 'trivial' ? requested : undefined
}

function tagFilter(requested: string | undefined): string | undefined {
  const value = (requested ?? '').trim()
  return value === '' ? undefined : value.slice(0, 80)
}

function matches(
  record: MemRecord,
  project: string | undefined,
  tag: string | undefined,
  importance: MemoryImportance | undefined,
): boolean {
  if (project !== undefined && record.project !== project) return false
  if (tag !== undefined && !record.tags.includes(tag)) return false
  if (importance !== undefined && recordImportance(record) !== importance) return false
  return true
}

/** 直接子条计数（一次遍历，避免逐节点调 store.children 的二次方开销）。 */
function childCounts(records: readonly MemRecord[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const record of records) {
    const parent = typeof record.extra?.['parent_id'] === 'string' ? (record.extra['parent_id'] as string) : ''
    if (parent === '') continue
    counts.set(parent, (counts.get(parent) ?? 0) + 1)
  }
  return counts
}

/** 记录排序：最近优先（ts 降序；同 ts 按 id 升序保证稳定）。 */
function byRecent(left: MemRecord, right: MemRecord): number {
  return right.ts - left.ts || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
}

/** 游标：`<ts>:<id>`（id 做 URL 编码，防非法字符）。 */
export function encodeCursor(record: MemRecord): string {
  return `${record.ts}:${encodeURIComponent(record.id)}`
}

interface DecodedCursor {
  ts: number
  id: string
}

/** 解析游标；不合法返回 undefined（路由层转 400）。 */
export function decodeCursor(raw: unknown): DecodedCursor | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 300) return undefined
  const index = raw.indexOf(':')
  if (index <= 0) return undefined
  const ts = Number(raw.slice(0, index))
  if (!Number.isSafeInteger(ts) || ts < 0) return undefined
  let id: string
  try {
    id = decodeURIComponent(raw.slice(index + 1))
  } catch {
    return undefined
  }
  if (id === '' || id.length > 200) return undefined
  return { ts, id }
}

function afterCursor(record: MemRecord, cursor: DecodedCursor): boolean {
  return record.ts < cursor.ts || (record.ts === cursor.ts && record.id > cursor.id)
}

export interface ListProjection {
  items: MemorySummaryItem[]
  nextCursor: string | null
  total: number
  projects: Array<[string, number]>
  tags: Array<[string, number]>
}

/** 「全部记忆」第一页/后续页：内存过滤 + 投影 + keyset 游标。 */
export function listMemories(
  mem: Memlite,
  request: MemoryListRequest,
  limits: ProjectionLimits = DEFAULT_PROJECTION_LIMITS,
): ListProjection {
  const limit = clampInt(request.limit, 20, 1, MAX_LIST_LIMIT)
  const project = projectFilter(request.project)
  const tag = tagFilter(request.tag)
  const importance = importanceFilter(request.importance)
  const cursor = request.cursor === undefined || request.cursor === null ? undefined : decodeCursor(request.cursor)
  if (request.cursor !== undefined && request.cursor !== null && request.cursor !== '' && cursor === undefined) {
    throw new TypeError('cursor 无效')
  }

  const records = mem.store.all()
  const filtered = records.filter((record) => matches(record, project, tag, importance))
  const counts = childCounts(records)
  const sorted = filtered.slice().sort(byRecent)
  const startAt = cursor === undefined ? 0 : sorted.findIndex((record) => afterCursor(record, cursor))
  const start = startAt < 0 ? sorted.length : startAt
  const page = sorted.slice(start, start + limit)
  const hasMore = start + limit < sorted.length

  return {
    items: page.map((record) => summaryItem(record, counts, limits)),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]!) : null,
    total: sorted.length,
    projects: topCounts(mem.store.projectCounts(), 50),
    tags: topCounts(mem.store.tagCounts(), 100),
  }
}

function summaryItem(
  record: MemRecord,
  counts: Map<string, number>,
  limits: ProjectionLimits = DEFAULT_PROJECTION_LIMITS,
): MemorySummaryItem {
  const childCount = counts.get(record.id) ?? 0
  return {
    id: record.id,
    title: recordTitle(record, limits.titleChars),
    summary: summaryOf(record, limits.summaryChars),
    tags: cleanTags(record.tags, limits.tags),
    project: record.project.slice(0, 100),
    ts: record.ts,
    importance: recordImportance(record),
    kind: recordKind(record),
    childCount,
    leaf: childCount === 0,
  }
}

function topCounts(source: Array<[string, number]>, cap: number): Array<[string, number]> {
  return source
    .slice(0, cap)
    .filter(([key, count]) => typeof key === 'string' && Number.isFinite(count))
    .map(([key, count]) => [key, count] as [string, number])
}

/**
 * 搜索：语义/词面由 memlite 自动选档，这里只做有界投影。
 *
 * 「（无）」项目是一个**后置过滤**：memlite 的 `project:''` 语义是「不过滤」，
 * 无法表达「只要没有项目的条目」，所以先按全量召回再按 `hit.project === ''` 过滤；
 * 为保证过滤后仍有足够结果，内部按 `limit × 4`（上限 100）过采样。
 */
export async function searchMemories(
  mem: Memlite,
  request: MemorySearchRequest,
  limits: ProjectionLimits = DEFAULT_PROJECTION_LIMITS,
): Promise<{ backend: string; fallback: string; ms: number; items: MemorySearchItem[] }> {
  const limit = clampInt(request.limit, 10, 1, MAX_SEARCH_LIMIT)
  const requested = (request.project ?? '').trim()
  const onlyNoProject = requested === NO_PROJECT_LABEL
  const project = onlyNoProject ? '' : (projectFilter(request.project) ?? '')
  const overSample = onlyNoProject ? Math.min(100, limit * 4) : limit
  const result = await mem.recall(request.query, { limit: overSample, project })
  const hits = onlyNoProject ? result.hits.filter((hit) => String(hit.project ?? '') === '') : result.hits
  return {
    backend: String(result.backend ?? 'bm25').slice(0, 40),
    fallback: String(result.fallback ?? '').slice(0, 40),
    ms: Number.isFinite(result.ms) ? result.ms : 0,
    items: hits.slice(0, limit).map((hit) => {
      const childCount = Array.isArray(hit.children) ? hit.children.length : 0
      return {
        id: hit.id,
        title: clipText(hit.title !== '' ? hit.title : hit.content, limits.titleChars),
        summary: clipText(hit.content, limits.summaryChars),
        tags: cleanTags(hit.tags, limits.tags),
        project: String(hit.project ?? '').slice(0, 100),
        ts: Number.isFinite(hit.ts) ? hit.ts : 0,
        importance: '',
        kind: '',
        childCount,
        leaf: childCount === 0,
        // 召回原始分数（BM25 可 >1；RRF 融合分通常 ≤1）；只做非负截断，UI 以三位小数展示。
        score: Number.isFinite(hit.score) ? Math.max(0, hit.score) : 0,
      }
    }),
  }
}

function neighbor(record: { id: string; title: string; content?: string }, cap = DEFAULT_PROJECTION_LIMITS.titleChars): MemoryNeighbor {
  return { id: record.id, title: clipText(record.title !== '' ? record.title : (record.content ?? ''), cap) }
}

/** 单条全文 + 因果邻居 + 有界完整链；不存在时 found=false（不抛错，供 UI 标记“原记忆已删除”）。 */
export function showMemory(mem: Memlite, id: string): Omit<MemoryShowResponse, 'engine'> {
  const shown = mem.show(id)
  if (shown === undefined) {
    return {
      found: false,
      ancestors: [],
      children: [],
      chain: {
        ancestors: [],
        entry: { id: '', title: '' },
        descendants: [],
      },
    }
  }
  const record = shown.record
  const children = shown.children.slice(0, MAX_CHAIN_NODES).map((child) => ({
    ...neighbor(child),
    summary: clipText(child.summary, DEFAULT_PROJECTION_LIMITS.summaryChars),
  }))
  let chain: Omit<MemoryShowResponse, 'engine'>['chain'] = {
    ancestors: [],
    entry: neighbor(record),
    descendants: [],
  }
  try {
    const view = mem.chain(record.id, SHOW_CHAIN_DEPTH)
    chain = {
      ancestors: view.ancestors.slice(-MAX_CHAIN_NODES).map((item) => neighbor(item)),
      entry: neighbor(view.entry),
      descendants: view.descendants
        .slice(0, MAX_CHAIN_NODES)
        .map(([depth, item]) => ({ ...neighbor(item), depth: Number.isFinite(depth) ? depth : 0 })),
    }
  } catch {
    // 断链/脏数据：链视图降级为空，详情仍可看
  }
  const detail: MemoryDetail = {
    id: record.id,
    title: recordTitle(record, DEFAULT_PROJECTION_LIMITS.titleChars),
    content: record.content,
    truncated: false,
    tags: cleanTags(record.tags, DEFAULT_PROJECTION_LIMITS.tags),
    project: record.project.slice(0, 100),
    ts: record.ts,
    importance: recordImportance(record),
    kind: recordKind(record),
    childCount: shown.children.length,
    leaf: shown.children.length === 0,
  }
  const cap = DEFAULT_PROJECTION_LIMITS.contentChars
  if (detail.content.length > cap) {
    detail.content = `${[...detail.content].slice(0, cap).join('')}…`
    detail.truncated = true
  }
  return {
    found: true,
    record: detail,
    ancestors: shown.ancestors.slice(-MAX_CHAIN_NODES).map((item) => neighbor(item)),
    children,
    chain,
  }
}

export interface TreeProjection {
  parentId: string
  nodes: MemoryTreeNode[]
  trimmed: boolean
}

/**
 * 因果树单层：`parentId` 缺省取根层；子条按 ts 升序（存入序，树渲染稳定）。
 * 项目筛选时，父条不在筛选集里的节点按根处理，保证不出现悬空节点。
 */
export function treeLayer(
  mem: Memlite,
  request: MemoryTreeRequest,
  limits: ProjectionLimits = DEFAULT_PROJECTION_LIMITS,
): TreeProjection {
  const limit = clampInt(request.limit, 100, 1, MAX_TREE_LIMIT)
  const project = projectFilter(request.project)
  const records = mem.store.all()
  const inScope = records.filter((record) => project === undefined || record.project === project)
  const scoped = new Set(inScope.map((record) => record.id))
  const counts = childCounts(records)
  const rawParent = (request.parentId ?? '').trim()

  let parentId = ''
  if (rawParent !== '') {
    const resolved = mem.store.resolve(rawParent)
    if (resolved === undefined) throw new TypeError('父节点不存在')
    parentId = resolved.id
  }

  const children = new Map<string, MemRecord[]>()
  const roots: MemRecord[] = []
  for (const record of inScope) {
    const parent = typeof record.extra?.['parent_id'] === 'string' ? (record.extra['parent_id'] as string) : ''
    if (parent === '' || !scoped.has(parent)) {
      roots.push(record)
      continue
    }
    const list = children.get(parent)
    if (list === undefined) children.set(parent, [record])
    else list.push(record)
  }

  const source = parentId === '' ? roots : (children.get(parentId) ?? [])
  const sorted = source.slice().sort((left, right) => left.ts - right.ts || (left.id < right.id ? -1 : 1))
  const nodes = sorted.slice(0, limit).map((record) => {
    // 项目筛选时只算子条在筛选集内的数量：否则点开会显示“子条已不存在（断链）”。
    // 未筛选时才回退到全库计数（覆盖 trivial 不进树等情形）。
    const scopedChildren = children.get(record.id)?.length ?? 0
    const childCount = project === undefined ? Math.max(scopedChildren, counts.get(record.id) ?? 0) : scopedChildren
    return {
      id: record.id,
      title: recordTitle(record, limits.titleChars),
      kind: recordKind(record),
      importance: recordImportance(record),
      ts: record.ts,
      childCount,
      leaf: childCount === 0,
    }
  })
  return { parentId, nodes, trimmed: sorted.length > limit }
}
