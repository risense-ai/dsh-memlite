/**
 * 记忆面板数据层：会话/列表/树/状态/详情的加载与浏览状态。
 *
 * 不持有编辑器与回执；编辑器/回执在 memory-panel-writes.ts。
 * 引擎或会话切换时通过 onEngineChange/onSessionChange 通知写入层清理草稿。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import type { MemoryImportance, MemorySessionRecall } from '../browser-contract'
import { MEMORY_API_LIMITS, isAbortError, type MemoryApi } from './memory-api'
import type { StatusViewState } from './memory-status-view'
import {
  emptyAllState,
  emptyTreeState,
  type AllViewState,
  type DetailViewState,
  type MemoryView,
  type SessionViewState,
  type TreeViewState,
} from './memory-view-types'
import {
  ALL_DEBOUNCE_MS,
  isDisabledError,
  toErrorInfo,
} from './memory-panel-helpers'

export interface MemoryPanelDataOptions {
  api: MemoryApi
  sessionId?: string
  tabVisible: boolean
  onSessionChange?: () => void
  onEngineChange?: () => void
}

export interface MemoryPanelData {
  view: MemoryView
  sessionState: SessionViewState
  allState: AllViewState
  treeState: TreeViewState
  statusState: StatusViewState
  detail: DetailViewState
  query: string
  project: string
  tag: string
  importance: MemoryImportance
  copied?: 'content' | 'id' | 'failed'
  feedbackBusy?: string
  setQuery(value: string): void
  setProject(value: string): void
  setTag(value: string): void
  setImportance(value: MemoryImportance): void
  setStatusState: Dispatch<SetStateAction<StatusViewState>>
  changeView(next: MemoryView): void
  refresh(): void
  closeDetail(): void
  select(id: string): void
  toggleNode(id: string): void
  loadChild(id: string): void
  requestList(mode: 'reset' | 'more'): void
  loadStatus(): void
  copy(kind: 'content' | 'id', text: string): void
  feedback(entry: MemorySessionRecall, memoryId: string, value: 'helpful' | 'irrelevant'): void
  bumpReload(): void
  isAlive(): boolean
}

export function useMemoryPanelData(options: MemoryPanelDataOptions): MemoryPanelData {
  const { api, sessionId, tabVisible } = options
  const noopRef = useRef<() => void>(() => {})
  const onSessionChange = options.onSessionChange ?? noopRef.current
  const onEngineChange = options.onEngineChange ?? noopRef.current

  const [view, setView] = useState<MemoryView>('session')
  const [sessionState, setSessionState] = useState<SessionViewState>(() =>
    sessionId === undefined || sessionId.trim() === ''
      ? { status: 'unavailable' }
      : { status: 'loading' },
  )
  const [allState, setAllState] = useState<AllViewState>(() => emptyAllState())
  const [treeState, setTreeState] = useState<TreeViewState>(() => emptyTreeState())
  const [statusState, setStatusState] = useState<StatusViewState>({ status: 'loading' })
  const [feedbackBusy, setFeedbackBusy] = useState<string>()
  const [detail, setDetail] = useState<DetailViewState>({ status: 'idle' })
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('')
  const [tag, setTag] = useState('')
  const [importance, setImportance] = useState<MemoryImportance>('')
  const [copied, setCopied] = useState<'content' | 'id' | 'failed'>()
  const [reloadToken, setReloadToken] = useState(0)

  const aliveRef = useRef(true)
  const primaryRef = useRef<AbortController | undefined>(undefined)
  const detailRef = useRef<AbortController | undefined>(undefined)
  const statusRef = useRef<AbortController | undefined>(undefined)
  const childrenRef = useRef<Map<string, AbortController>>(new Map())
  const engineRef = useRef<number | undefined>(undefined)
  const allRef = useRef<AllViewState>(allState)
  const treeRef = useRef<TreeViewState>(treeState)

  const abortPrimary = useCallback(() => {
    primaryRef.current?.abort()
    primaryRef.current = undefined
  }, [])
  const abortDetail = useCallback(() => {
    detailRef.current?.abort()
    detailRef.current = undefined
  }, [])
  const abortChildren = useCallback(() => {
    for (const controller of childrenRef.current.values()) controller.abort()
    childrenRef.current.clear()
  }, [])
  const abortStatus = useCallback(() => {
    statusRef.current?.abort()
    statusRef.current = undefined
  }, [])
  const abortAllData = useCallback(() => {
    abortPrimary()
    abortDetail()
    abortChildren()
    abortStatus()
  }, [abortPrimary, abortDetail, abortChildren, abortStatus])

  useEffect(() => {
    allRef.current = allState
  }, [allState])
  useEffect(() => {
    treeRef.current = treeState
  }, [treeState])

  // 卸载：中止全部在途请求，后续回调不再写状态。
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      abortAllData()
    }
  }, [abortAllData])

  // 换会话：中止旧请求、清空选中详情、重置引擎代次（避免把新会话误判为“引擎变化”）。
  useEffect(() => {
    abortAllData()
    setDetail({ status: 'idle' })
    setCopied(undefined)
    onSessionChange()
    setFeedbackBusy(undefined)
    setStatusState({ status: 'loading' })
    engineRef.current = undefined
  }, [sessionId, abortAllData, onSessionChange])

  const noteEngine = useCallback(
    (engine: number): boolean => {
      const previous = engineRef.current
      engineRef.current = engine
      if (previous === undefined || previous === engine) return false
      abortDetail()
      setDetail({ status: 'idle' })
      onEngineChange()
      setReloadToken((token) => token + 1)
      return true
    },
    [abortDetail, onEngineChange],
  )

  const loadStatus = useCallback(() => {
    if (!tabVisible) return
    abortStatus()
    const controller = new AbortController()
    statusRef.current = controller
    setStatusState((previous) => ({
      ...previous,
      status: previous.data === undefined ? 'loading' : previous.status,
      error: undefined,
    }))
    void api
      .status(sessionId !== undefined && sessionId.trim() !== '' ? { sessionId } : {}, controller.signal)
      .then((data) => {
        if (controller.signal.aborted || !aliveRef.current) return
        noteEngine(data.engine)
        setStatusState((previous) => ({ ...previous, status: 'ready', data, error: undefined }))
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error) || !aliveRef.current) return
        setStatusState((previous) =>
          isDisabledError(error)
            ? { ...previous, status: 'disabled' }
            : { ...previous, status: 'error', error: toErrorInfo(error) },
        )
      })
  }, [api, sessionId, tabVisible, abortStatus, noteEngine])

  const loadSession = useCallback(() => {
    if (!tabVisible) return
    abortPrimary()
    if (sessionId === undefined || sessionId.trim() === '') {
      setSessionState({ status: 'unavailable' })
      return
    }
    const controller = new AbortController()
    primaryRef.current = controller
    setSessionState({ status: 'loading' })
    void api
      .sessionRecalls({ sessionId, limit: MEMORY_API_LIMITS.sessionRecalls }, controller.signal)
      .then((data) => {
        if (controller.signal.aborted || !aliveRef.current) return
        noteEngine(data.engine)
        setSessionState({ status: 'ready', data })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error) || !aliveRef.current) return
        setSessionState(
          isDisabledError(error) ? { status: 'disabled' } : { status: 'error', error: toErrorInfo(error) },
        )
      })
  }, [api, sessionId, tabVisible, abortPrimary, noteEngine])

  const requestList = useCallback(
    (mode: 'reset' | 'more') => {
      if (!tabVisible) return
      if (mode === 'more') {
        const current = allRef.current
        if (current.status !== 'ready' || current.loadingMore || current.nextCursor === null) return
      }
      abortPrimary()
      const controller = new AbortController()
      primaryRef.current = controller
      const reset = mode === 'reset'
      const searching = query.trim() !== ''

      if (reset) {
        setAllState((previous) => ({ ...previous, status: 'loading', error: undefined, loadMoreError: undefined }))
      } else {
        setAllState((previous) => ({ ...previous, loadingMore: true, loadMoreError: undefined }))
      }

      const cursor = reset || allRef.current.nextCursor === null ? undefined : allRef.current.nextCursor
      const task: Promise<
        { kind: 'search'; data: Awaited<ReturnType<MemoryApi['search']>> } | { kind: 'list'; data: Awaited<ReturnType<MemoryApi['list']>> }
      > = searching
        ? api
            .search(
              {
                query: query.trim(),
                project: project === '' ? undefined : project,
                limit: MEMORY_API_LIMITS.search,
              },
              controller.signal,
            )
            .then((data) => ({ kind: 'search' as const, data }))
        : api
            .list(
              {
                project: project === '' ? undefined : project,
                tag: tag === '' ? undefined : tag,
                importance: importance === '' ? undefined : importance,
                cursor,
                limit: MEMORY_API_LIMITS.list,
              },
              controller.signal,
            )
            .then((data) => ({ kind: 'list' as const, data }))

      void task.then(
        (result) => {
          if (controller.signal.aborted || !aliveRef.current) return
          if (result.kind === 'search') {
            const data = result.data
            noteEngine(data.engine)
            setAllState((previous) => ({
              ...previous,
              status: 'ready',
              items: data.items,
              scored: true,
              engine: data.engine,
              nextCursor: null,
              total: data.items.length,
              loadingMore: false,
              error: undefined,
              loadMoreError: undefined,
            }))
            return
          }
          const data = result.data
          noteEngine(data.engine)
          setAllState((previous) => ({
            ...previous,
            status: 'ready',
            items: reset ? data.items : [...previous.items, ...data.items],
            scored: false,
            engine: data.engine,
            nextCursor: data.nextCursor,
            total: data.total,
            projects: data.projects,
            tags: data.tags,
            loadingMore: false,
            error: undefined,
            loadMoreError: undefined,
          }))
        },
        (error: unknown) => {
          if (controller.signal.aborted || isAbortError(error) || !aliveRef.current) return
          if (mode === 'more') {
            setAllState((previous) => ({
              ...previous,
              loadingMore: false,
              loadMoreError: toErrorInfo(error),
            }))
            return
          }
          setAllState((previous) =>
            isDisabledError(error)
              ? { ...previous, status: 'disabled', loadingMore: false }
              : { ...previous, status: 'error', error: toErrorInfo(error), loadingMore: false },
          )
        },
      )
    },
    [api, query, project, tag, importance, tabVisible, abortPrimary, noteEngine],
  )

  const loadTreeRoot = useCallback(() => {
    if (!tabVisible) return
    abortPrimary()
    abortChildren()
    const controller = new AbortController()
    primaryRef.current = controller
    setTreeState((previous) => ({ ...previous, status: 'loading', error: undefined }))
    void api
      .tree({}, controller.signal)
      .then((data) => {
        if (controller.signal.aborted || !aliveRef.current) return
        noteEngine(data.engine)
        setTreeState({
          status: 'ready',
          engine: data.engine,
          nodes: data.nodes,
          trimmed: data.trimmed,
          expanded: {},
          children: {},
        })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error) || !aliveRef.current) return
        setTreeState((previous) =>
          isDisabledError(error)
            ? { ...previous, status: 'disabled' }
            : { ...previous, status: 'error', error: toErrorInfo(error) },
        )
      })
  }, [api, tabVisible, abortPrimary, abortChildren, noteEngine])

  const loadChild = useCallback(
    (parentId: string) => {
      if (!tabVisible) return
      const existing = childrenRef.current.get(parentId)
      if (existing !== undefined) return // 同一层已在加载
      const controller = new AbortController()
      childrenRef.current.set(parentId, controller)
      setTreeState((previous) => ({
        ...previous,
        children: {
          ...previous.children,
          [parentId]: { status: 'loading', nodes: [], trimmed: false },
        },
      }))
      void api
        .tree({ parentId, limit: MEMORY_API_LIMITS.tree }, controller.signal)
        .then((data) => {
          if (controller.signal.aborted || !aliveRef.current) return
          noteEngine(data.engine)
          setTreeState((previous) => ({
            ...previous,
            children: {
              ...previous.children,
              [parentId]: { status: 'ready', nodes: data.nodes, trimmed: data.trimmed },
            },
          }))
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || isAbortError(error) || !aliveRef.current) return
          setTreeState((previous) => ({
            ...previous,
            children: {
              ...previous.children,
              [parentId]: { status: 'error', nodes: [], trimmed: false, error: toErrorInfo(error) },
            },
          }))
        })
        .finally(() => {
          if (childrenRef.current.get(parentId) === controller) {
            childrenRef.current.delete(parentId)
          }
        })
    },
    [api, tabVisible, noteEngine],
  )

  const select = useCallback(
    (id: string) => {
      abortDetail()
      const controller = new AbortController()
      detailRef.current = controller
      setCopied(undefined)
      setDetail({ status: 'loading', id })
      void api
        .show({ id }, controller.signal)
        .then((data) => {
          if (controller.signal.aborted || !aliveRef.current) return
          noteEngine(data.engine)
          setDetail({ status: 'ready', id, data })
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || isAbortError(error) || !aliveRef.current) return
          setDetail(
            isDisabledError(error)
              ? { status: 'disabled', id }
              : { status: 'error', id, error: toErrorInfo(error) },
          )
        })
    },
    [api, abortDetail, noteEngine],
  )

  const toggleNode = useCallback(
    (id: string) => {
      const tree = treeRef.current
      if (tree.expanded[id] === true) {
        setTreeState((previous) => {
          const expanded = { ...previous.expanded }
          delete expanded[id]
          return { ...previous, expanded }
        })
        return
      }
      setTreeState((previous) => ({ ...previous, expanded: { ...previous.expanded, [id]: true } }))
      const cached = tree.children[id]
      if (cached === undefined || cached.status === 'error') loadChild(id)
    },
    [loadChild],
  )

  const copy = useCallback((kind: 'content' | 'id', text: string) => {
    const clipboard =
      typeof navigator === 'undefined' ? undefined : (navigator as { clipboard?: unknown }).clipboard
    const writeText =
      typeof clipboard === 'object' && clipboard !== null
        ? (clipboard as { writeText?: unknown }).writeText
        : undefined
    if (typeof writeText !== 'function') {
      setCopied('failed')
      return
    }
    try {
      void (writeText as (value: string) => Promise<void>).call(clipboard, text).then(
        () => setCopied(kind),
        () => setCopied('failed'),
      )
    } catch {
      setCopied('failed')
    }
  }, [])

  const feedback = useCallback(
    (entry: MemorySessionRecall, memoryId: string, value: 'helpful' | 'irrelevant') => {
      if (sessionId === undefined || sessionId.trim() === '') return
      const busyKey = `feedback:${entry.turn}:${entry.messageId}:${memoryId}`
      setFeedbackBusy(busyKey)
      void api
        .feedback({
          sessionId,
          turn: entry.turn,
          messageId: entry.messageId,
          memoryId,
          feedback: value,
        })
        .then((result) => {
          if (!aliveRef.current) return
          setSessionState((previous) => {
            if (previous.data === undefined) return previous
            return {
              ...previous,
              data: {
                ...previous.data,
                entries: previous.data.entries.map((item) =>
                  item.turn === entry.turn && item.messageId === entry.messageId
                    ? { ...item, feedback: { ...(item.feedback ?? {}), [memoryId]: result.feedback } }
                    : item,
                ),
              },
            }
          })
        })
        .catch(() => {
          // 反馈失败不阻塞浏览；用户可重试。
        })
        .finally(() => {
          if (aliveRef.current) setFeedbackBusy(undefined)
        })
    },
    [api, sessionId],
  )

  // 视图变化/刷新/换会话时重新加载对应数据（abort 在各自 load 里完成）。
  useEffect(() => {
    if (view !== 'session') return
    loadSession()
  }, [view, loadSession, reloadToken])

  useEffect(() => {
    if (view !== 'all' || !tabVisible) return
    abortPrimary()
    // 搜索/筛选做轻量防抖；定时器清理即取消本次待发请求。
    const timer = setTimeout(() => {
      requestList('reset')
    }, ALL_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [view, tabVisible, reloadToken, requestList, abortPrimary])

  useEffect(() => {
    if (view !== 'tree') return
    loadTreeRoot()
  }, [view, loadTreeRoot, reloadToken])

  useEffect(() => {
    if (view !== 'status') return
    loadStatus()
  }, [view, loadStatus, reloadToken])

  // 顶栏状态徽章：挂载即取一次；会话/可见性变化时 refresh 会随 loadStatus 身份变化重跑。
  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  const changeView = (next: MemoryView): void => {
    if (next === view) return
    abortAllData()
    setDetail({ status: 'idle' })
    setCopied(undefined)
    setView(next)
  }

  const refresh = (): void => {
    abortAllData()
    setDetail({ status: 'idle' })
    setCopied(undefined)
    setReloadToken((token) => token + 1)
  }

  const closeDetail = useCallback(() => {
    abortDetail()
    setDetail({ status: 'idle' })
    setCopied(undefined)
  }, [abortDetail])

  const bumpReload = useCallback(() => {
    setReloadToken((token) => token + 1)
  }, [])

  const isAlive = useCallback(() => aliveRef.current, [])

  return {
    view,
    sessionState,
    allState,
    treeState,
    statusState,
    detail,
    query,
    project,
    tag,
    importance,
    ...(copied === undefined ? {} : { copied }),
    ...(feedbackBusy === undefined ? {} : { feedbackBusy }),
    setQuery,
    setProject,
    setTag,
    setImportance,
    setStatusState,
    changeView,
    refresh,
    closeDetail,
    select,
    toggleNode,
    loadChild,
    requestList,
    loadStatus,
    copy,
    feedback,
    bumpReload,
    isAlive,
  }
}
