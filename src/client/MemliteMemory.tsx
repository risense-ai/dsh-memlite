/**
 * 聊天记忆浏览器入口（0.5.0 拆分后）。
 *
 * - 状态机在 memory-panel-controller.ts；
 * - 纯展示在 memory-panel-view.tsx 与 session/library/detail/tree 视图；
 * - 本文件只做 API 选择、控制器调用与兼容导出。
 */
import type { ReactNode } from 'react'
import { MemoryPanelView } from './memory-panel-view'
import { useMemoryPanelController } from './memory-panel-controller'
import type { MemoryPanelProps } from './memory-view-types'

/** 聊天记忆浏览器面板。 */
export function MemliteMemoryPanel(props: MemoryPanelProps): ReactNode {
  const { state, actions } = useMemoryPanelController(props)
  return <MemoryPanelView t={props.t} state={state} actions={actions} />
}

/* 兼容导出：测试与 client/index.tsx 仍从这些名字。 */
export { MemoryPanelView }
export { emptyAllState, emptyTreeState } from './memory-view-types'
export { formatScore, formatTimestamp } from './memory-widgets'
export type {
  AllViewState,
  DetailViewState,
  MemoryErrorInfo,
  MemoryPanelActions,
  MemoryPanelProps,
  MemoryPanelState,
  MemoryView,
  SessionViewState,
  TreeChildrenState,
  TreeViewState,
  Translate,
} from './memory-view-types'
