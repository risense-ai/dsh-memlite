/**
 * 记忆浏览器视图状态、动作与共享类型。
 * 纯类型 + 纯函数；不依赖 React 运行时。
 */
import type {
  MemoryImportance,
  MemorySessionRecall,
  MemorySessionRecallsResponse,
  MemoryShowResponse,
  MemorySummaryItem,
  MemoryTreeNode,
  MemoryWriteReceipt,
} from '../browser-contract'
import type { EditorActions, EditorState } from './memory-editor'
import type { StatusViewActions, StatusViewState } from './memory-status-view'
import type { MemoryApi } from './memory-api'

export type MemoryView = 'session' | 'all' | 'tree' | 'status'
export type Translate = (key: string, params?: Record<string, unknown>) => string

export interface MemoryErrorInfo {
  code: 'http' | 'network' | 'shape' | 'unknown'
  status?: number
}

export interface SessionViewState {
  status: 'loading' | 'ready' | 'error' | 'disabled' | 'unavailable'
  data?: MemorySessionRecallsResponse
  error?: MemoryErrorInfo
}

export interface DetailViewState {
  status: 'idle' | 'loading' | 'ready' | 'error' | 'disabled'
  /** 选中的 id（重试/删除提示用）。 */
  id?: string
  data?: MemoryShowResponse
  error?: MemoryErrorInfo
}

export interface AllViewState {
  status: 'loading' | 'ready' | 'error' | 'disabled'
  items: Array<MemorySummaryItem & { score?: number }>
  /** 当前数据来自 search 路由（带 score）。 */
  scored: boolean
  engine: number
  nextCursor: string | null
  total: number
  projects: Array<[string, number]>
  tags: Array<[string, number]>
  loadingMore: boolean
  error?: MemoryErrorInfo
  loadMoreError?: MemoryErrorInfo
}

export interface TreeChildrenState {
  status: 'loading' | 'ready' | 'error'
  nodes: MemoryTreeNode[]
  trimmed: boolean
  error?: MemoryErrorInfo
}

export interface TreeViewState {
  status: 'loading' | 'ready' | 'error' | 'disabled'
  engine: number
  nodes: MemoryTreeNode[]
  trimmed: boolean
  error?: MemoryErrorInfo
  expanded: Record<string, boolean>
  children: Record<string, TreeChildrenState>
}

export interface MemoryPanelState {
  view: MemoryView
  session: SessionViewState
  all: AllViewState
  tree: TreeViewState
  status: StatusViewState
  detail: DetailViewState
  editor: EditorState
  receipt?: MemoryWriteReceipt
  feedbackBusy?: string
  query: string
  project: string
  tag: string
  importance: MemoryImportance
  copied?: 'content' | 'id' | 'failed'
}

export interface MemoryPanelActions {
  setView(view: MemoryView): void
  refresh(): void
  setQuery(value: string): void
  setProject(value: string): void
  setTag(value: string): void
  setImportance(value: MemoryImportance): void
  loadMore(): void
  select(id: string): void
  toggleNode(id: string): void
  loadChild(id: string): void
  copy(kind: 'content' | 'id', text: string): void
  closeDetail(): void
  feedback(entry: MemorySessionRecall, memoryId: string, value: 'helpful' | 'irrelevant'): void
  openEditor(mode: EditorState['mode'], detail?: MemoryShowResponse['record']): void
  searchAround(query: string): void
  status: StatusViewActions
  editor: EditorActions
  dismissReceipt(): void
}

/** 空列表状态（也供测试构造初始状态）。 */
export function emptyAllState(overrides: Partial<AllViewState> = {}): AllViewState {
  return {
    status: 'loading',
    items: [],
    scored: false,
    engine: 0,
    nextCursor: null,
    total: 0,
    projects: [],
    tags: [],
    loadingMore: false,
    ...overrides,
  }
}

/** 空树状态。 */
export function emptyTreeState(overrides: Partial<TreeViewState> = {}): TreeViewState {
  return {
    status: 'loading',
    engine: 0,
    nodes: [],
    trimmed: false,
    expanded: {},
    children: {},
    ...overrides,
  }
}

/** 面板组件 props（slot 注入 + 测试注入）。 */
export interface MemoryPanelProps {
  t: (key: string, params?: Record<string, unknown>) => string
  /** 当前会话 id（slot inject 注入；缺省时“本次对话”显示不可用）。 */
  sessionId?: string
  /** slot 框架注入的 hooks（防御式读取，不依赖其内部形状）。 */
  useTabInfo?: () => unknown
  /** 测试注入；缺省用 document-relative fetch。 */
  api?: MemoryApi
}
