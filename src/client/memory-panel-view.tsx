/**
 * 记忆面板纯展示层：顶栏、四视图切换、统一回执与编辑器。
 * 不调用 hook，SSR 可直接快照。
 */
import type { ReactNode } from 'react'
import type { MemoryPanelActions, MemoryPanelState, Translate } from './memory-view-types'
import { MemoryEditor } from './memory-editor'
import { MemoryStatusView } from './memory-status-view'
import { ReceiptBanner } from './memory-receipt'
import { SessionView } from './memory-session-view'
import { AllMemoriesView } from './memory-library-view'
import { DetailView } from './memory-detail-view'
import { TreeView } from './memory-tree-view'
import {
  detailColumnStyle,
  disabledButtonStyle,
  headerMetaStyle,
  headerStyle,
  linkButtonStyle,
  listColumnStyle,
  panelStyle,
  plainButtonStyle,
  tabActiveStyle,
  tabStyle,
  viewTabsStyle,
  wideRowStyle,
} from './memory-styles'

export function MemoryPanelView(props: {
  t: Translate
  state: MemoryPanelState
  actions: MemoryPanelActions
}): ReactNode {
  const { t, state, actions } = props
  const statusData = state.status.data
  const disabled = statusData !== undefined && !statusData.library.enabled
  const statusText =
    statusData === undefined
      ? ''
      : !statusData.library.enabled
        ? t('header.statusDisabled')
        : statusData.library.badLines > 0
          ? t('header.statusWarning')
          : statusData.search.backend === 'bm25'
            ? t('header.statusBm25')
            : t('header.statusSemantic')
  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <div style={viewTabsStyle}>
          {(['session', 'all', 'tree', 'status'] as const).map((view) => (
            <button
              key={view}
              type="button"
              style={state.view === view ? tabActiveStyle : tabStyle}
              aria-pressed={state.view === view}
              onClick={() => actions.setView(view)}
            >
              {t(`view.${view}`)}
            </button>
          ))}
        </div>
        <div style={headerMetaStyle}>
          {statusText !== '' ? (
            <button type="button" style={linkButtonStyle} onClick={() => actions.setView('status')}>
              {statusText}
            </button>
          ) : null}
          <button
            type="button"
            style={disabled ? disabledButtonStyle : plainButtonStyle}
            disabled={disabled}
            onClick={() => actions.openEditor('create')}
          >
            {t('header.store')}
          </button>
          <button type="button" style={linkButtonStyle} onClick={actions.refresh}>
            {t('refresh')}
          </button>
        </div>
      </div>

      {state.receipt !== undefined ? (
        <ReceiptBanner
          t={t}
          receipt={state.receipt}
          onView={
            state.receipt.id !== ''
              ? () => {
                  actions.setView('all')
                  actions.select(state.receipt!.id)
                }
              : undefined
          }
          onContinue={
            state.receipt.status === 'conflict' || state.receipt.status === 'rejected'
              ? () => actions.openEditor('create')
              : undefined
          }
          onDismiss={actions.dismissReceipt}
        />
      ) : null}

      {state.view === 'session' ? (
        <SessionView t={t} state={state.session} feedbackBusy={state.feedbackBusy} actions={actions} />
      ) : null}
      {state.view === 'all' ? (
        <div style={wideRowStyle}>
          <div style={listColumnStyle}>
            <AllMemoriesView
              t={t}
              state={state.all}
              query={state.query}
              project={state.project}
              tag={state.tag}
              importance={state.importance}
              selectedId={state.detail.id}
              actions={actions}
            />
          </div>
          {state.detail.status !== 'idle' ? (
            <div style={detailColumnStyle}>
              <DetailView t={t} state={state.detail} copied={state.copied} actions={actions} />
            </div>
          ) : null}
        </div>
      ) : null}
      {state.view === 'tree' ? (
        <TreeView
          t={t}
          state={state.tree}
          selectedId={state.detail.id}
          actions={actions}
        />
      ) : null}
      {state.view === 'status' ? (
        <MemoryStatusView t={t} state={state.status} actions={actions.status} />
      ) : null}

      {state.view !== 'all' && state.detail.status !== 'idle' ? (
        <DetailView t={t} state={state.detail} copied={state.copied} actions={actions} />
      ) : null}

      <MemoryEditor t={t} state={state.editor} actions={actions.editor} />
    </div>
  )
}
