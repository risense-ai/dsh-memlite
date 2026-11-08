/**
 * 记忆浏览器控制器：组合数据层与写入层，产出 MemoryPanelView 所需的 state/actions。
 *
 * - 数据/加载在 memory-panel-data.ts；
 * - 编辑器/回执/同步动作在 memory-panel-writes.ts；
 * - 本文件只做 API 选择、跨层复位与 action 装配。
 */
import { useCallback, useMemo, useRef } from 'react'
import { createMemoryApi, type MemoryApi } from './memory-api'
import { readTabVisible, useNoTabInfo } from './memory-panel-helpers'
import { useMemoryPanelData } from './memory-panel-data'
import { useMemoryPanelWrites } from './memory-panel-writes'
import type {
  MemoryPanelActions,
  MemoryPanelProps,
  MemoryPanelState,
} from './memory-view-types'

export function useMemoryPanelController(props: MemoryPanelProps): {
  state: MemoryPanelState
  actions: MemoryPanelActions
} {
  const { sessionId, t } = props

  // 防御式调用宿主注入的 hooks（位置固定，不依赖其内部形状）。
  const useInfo = props.useTabInfo ?? useNoTabInfo
  const tabInfo = useInfo()
  const tabVisible = readTabVisible(tabInfo)

  const providedApi = props.api
  const fallbackApi = useMemo(
    () => (providedApi === undefined ? createMemoryApi() : undefined),
    [providedApi],
  )
  const api: MemoryApi = providedApi ?? (fallbackApi as MemoryApi)

  // 写入层复位回调：会话/引擎切换时丢弃草稿与最近回执。
  const writesResetRef = useRef<() => void>(() => {})
  const onSessionChange = useCallback(() => writesResetRef.current(), [])
  const onEngineChange = useCallback(() => writesResetRef.current(), [])

  const data = useMemoryPanelData({
    api,
    sessionId,
    tabVisible,
    onSessionChange,
    onEngineChange,
  })

  const writes = useMemoryPanelWrites({
    api,
    sessionId,
    t,
    detail: data.detail,
    statusState: data.statusState,
    setStatusState: data.setStatusState,
    select: data.select,
    closeDetail: data.closeDetail,
    bumpReload: data.bumpReload,
    loadStatus: data.loadStatus,
    changeView: data.changeView,
    copy: data.copy,
    isAlive: data.isAlive,
  })
  writesResetRef.current = writes.resetWrites

  const actions: MemoryPanelActions = {
    setView: (next) => {
      writes.abortEditor()
      data.changeView(next)
    },
    refresh: () => {
      writes.abortEditor()
      data.refresh()
    },
    setQuery: data.setQuery,
    setProject: data.setProject,
    setTag: data.setTag,
    setImportance: data.setImportance,
    loadMore: () => data.requestList('more'),
    select: data.select,
    toggleNode: data.toggleNode,
    loadChild: data.loadChild,
    copy: data.copy,
    closeDetail: data.closeDetail,
    feedback: data.feedback,
    openEditor: writes.openEditor,
    searchAround: (query) => {
      data.setQuery(query)
      data.changeView('all')
    },
    status: writes.statusActions,
    editor: writes.editorActions,
    dismissReceipt: writes.dismissReceipt,
  }

  const state: MemoryPanelState = {
    view: data.view,
    session: data.sessionState,
    all: data.allState,
    tree: data.treeState,
    status: data.statusState,
    detail: data.detail,
    editor: writes.editor,
    ...(writes.receipt === undefined ? {} : { receipt: writes.receipt }),
    ...(data.feedbackBusy === undefined ? {} : { feedbackBusy: data.feedbackBusy }),
    query: data.query,
    project: data.project,
    tag: data.tag,
    importance: data.importance,
    ...(data.copied === undefined ? {} : { copied: data.copied }),
  }

  return { state, actions }
}
