/**
 * 因果树视图：逐层展开、断链/环提示、定位选中节点。
 */
import type { ReactNode } from 'react'
import type { MemoryTreeNode } from '../browser-contract'
import type {
  MemoryPanelActions,
  Translate,
  TreeChildrenState,
  TreeViewState,
} from './memory-view-types'
import {
  DisabledNotice,
  ErrorNotice,
  ImportanceBadge,
  LoadingNotice,
  Notice,
} from './memory-widgets'
import {
  COLOR_ACCENT,
  badgeRowStyle,
  badgeStyle,
  columnStyle,
  errorTextStyle,
  hintStyle,
  linkButtonStyle,
  rowBetweenStyle,
  treeItemStyle,
  treeListStyle,
  treeMetaStyle,
  treeNodeButtonStyle,
  treeNodeTitleStyle,
  treeRowStyle,
  treeTogglePlaceholderStyle,
  treeToggleStyle,
} from './memory-styles'

function TreeNodeRow(props: {
  t: Translate
  node: MemoryTreeNode
  ancestors: string[]
  depth: number
  state: TreeViewState
  selectedId?: string
  actions: MemoryPanelActions
}): ReactNode {
  const { t, node, ancestors, depth, state, selectedId, actions } = props
  const cycle = ancestors.includes(node.id)
  const expanded = state.expanded[node.id] === true
  const canExpand = !cycle && !node.leaf && node.childCount > 0
  const children = state.children[node.id]

  return (
    <li style={treeItemStyle}>
      <div id={`tree-node-${node.id}`} style={{ ...treeRowStyle, paddingLeft: depth * 12 }}>
        {canExpand ? (
          <button
            type="button"
            aria-label={expanded ? t('tree.collapse') : t('tree.expand')}
            aria-expanded={expanded}
            style={treeToggleStyle}
            onClick={() => actions.toggleNode(node.id)}
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span style={treeTogglePlaceholderStyle}>{cycle ? '⟲' : '·'}</span>
        )}
        <button
          type="button"
          aria-current={selectedId === node.id ? 'true' : undefined}
          style={
            selectedId === node.id
              ? { ...treeNodeButtonStyle, color: COLOR_ACCENT, fontWeight: 600 }
              : treeNodeButtonStyle
          }
          title={node.title !== '' ? node.title : node.id}
          onClick={() => actions.select(node.id)}
        >
          <span style={treeNodeTitleStyle}>{node.title !== '' ? node.title : t('list.unnamed')}</span>
        </button>
        <span style={treeMetaStyle}>
          <ImportanceBadge t={t} importance={node.importance} />
          {node.childCount > 0 ? (
            <span style={badgeStyle}>{t('tree.children', { count: node.childCount })}</span>
          ) : (
            <span style={badgeStyle}>{t('tree.leaf')}</span>
          )}
        </span>
      </div>

      {cycle ? <p style={{ ...hintStyle, paddingLeft: depth * 12 + 20 }}>{t('tree.cycle')}</p> : null}

      {expanded && !cycle && children !== undefined ? (
        <TreeChildren
          t={t}
          node={node}
          childrenState={children}
          ancestors={[...ancestors, node.id]}
          depth={depth + 1}
          state={state}
          selectedId={selectedId}
          actions={actions}
        />
      ) : null}
    </li>
  )
}

function TreeChildren(props: {
  t: Translate
  node: MemoryTreeNode
  childrenState: TreeChildrenState
  ancestors: string[]
  depth: number
  state: TreeViewState
  selectedId?: string
  actions: MemoryPanelActions
}): ReactNode {
  const { t, node, childrenState, ancestors, depth, state, selectedId, actions } = props
  if (childrenState.status === 'loading') {
    return <p style={{ ...hintStyle, paddingLeft: depth * 12 + 20 }}>{t('tree.loadingChildren')}</p>
  }
  if (childrenState.status === 'error') {
    return (
      <div style={{ paddingLeft: depth * 12 + 20, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <p style={errorTextStyle}>{t('tree.childError')}</p>
        <button type="button" style={linkButtonStyle} onClick={() => actions.loadChild(node.id)}>
          {t('retry')}
        </button>
      </div>
    )
  }
  if (childrenState.nodes.length === 0) {
    return <p style={{ ...hintStyle, paddingLeft: depth * 12 + 20 }}>{t('tree.childEmpty')}</p>
  }
  return (
    <>
      {childrenState.trimmed ? (
        <p style={{ ...hintStyle, paddingLeft: depth * 12 + 20 }}>
          {t('tree.trimmed', { count: childrenState.nodes.length })}
        </p>
      ) : null}
      <ul style={treeListStyle}>
        {childrenState.nodes.map((child) => (
          <TreeNodeRow
            key={child.id}
            t={t}
            node={child}
            ancestors={ancestors}
            depth={depth}
            state={state}
            selectedId={selectedId}
            actions={actions}
          />
        ))}
      </ul>
    </>
  )
}

export function TreeView(props: {
  t: Translate
  state: TreeViewState
  selectedId?: string
  actions: MemoryPanelActions
}): ReactNode {
  const { t, state, selectedId, actions } = props
  if (state.status === 'disabled') return <DisabledNotice t={t} />
  if (state.status === 'loading') return <LoadingNotice t={t} />
  if (state.status === 'error') {
    return <ErrorNotice t={t} error={state.error} onRetry={actions.refresh} />
  }
  if (state.nodes.length === 0) {
    return <Notice title={t('tree.empty')} description={t('tree.emptyHint')} />
  }
  return (
    <div style={columnStyle}>
      <div style={rowBetweenStyle}>
        <span style={hintStyle}>{t('tree.rootCount', { count: state.nodes.length })}</span>
        <div style={badgeRowStyle}>
          {selectedId !== undefined ? (
            <button
              type="button"
              style={linkButtonStyle}
              onClick={() => {
                if (typeof document === 'undefined') return
                document.getElementById(`tree-node-${selectedId}`)?.scrollIntoView({ block: 'center' })
              }}
            >
              {t('tree.locate')}
            </button>
          ) : null}
          {state.trimmed ? (
            <span style={hintStyle}>{t('tree.trimmed', { count: state.nodes.length })}</span>
          ) : null}
        </div>
      </div>
      <ul style={treeListStyle}>
        {state.nodes.map((node) => (
          <TreeNodeRow
            key={node.id}
            t={t}
            node={node}
            ancestors={[]}
            depth={0}
            state={state}
            selectedId={selectedId}
            actions={actions}
          />
        ))}
      </ul>
    </div>
  )
}
