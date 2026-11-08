/**
 * 聊天记忆浏览器（M8 浏览器半区，只读）。
 *
 * 右侧栏 Memory 页签的内容体：三个视图（本次对话 / 全部记忆 / 因果树），
 * 列表 + 详情 + 逐层因果树，全部只读。宿主的 `sidebar.right.pane.tab` slot 注入
 * `t` / `sessionId` / `useTabInfo`，测试可注入 `api`。
 *
 * 设计要点：
 * - **SSR 安全**：渲染期不触碰 window/navigator/document；`MemoryPanelView` 是纯展示层，
 *   首屏在数据未到位时显示 loading，因此 `renderToStaticMarkup` 可确定性地快照各种状态。
 * - **请求生命周期**：切视图 / 换会话 / 刷新 / 卸载统一 abort 旧请求；abort 静默。
 * - **安全渲染**：正文只进 `<pre>{content}</pre>`（转义文本），禁止 dangerouslySetInnerHTML。
 * - **主题**：只用 `var(--dsw-*)` 变量 + `font: inherit`，不引入样式表。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import type {
  MemoryImportance,
  MemoryRecallStatus,
  MemorySessionRecall,
  MemorySessionRecallsResponse,
  MemoryShowResponse,
  MemorySkipReason,
  MemorySummaryItem,
  MemoryTreeNode,
  MemoryTreeResponse,
} from '../browser-contract'
import {
  MEMORY_API_LIMITS,
  MemoryApiError,
  createMemoryApi,
  isAbortError,
  type MemoryApi,
} from './memory-api'
import { MemoryEditor, emptyEditorState, type EditorActions, type EditorState } from './memory-editor'
import { MemoryStatusView, type StatusViewActions, type StatusViewState } from './memory-status-view'
import { ReceiptBanner } from './memory-receipt'
import { newOperationId } from './memory-ui'
import type { MemoryStatusResponse, MemoryWriteReceipt } from '../browser-contract'

/* -------------------------------------------------------------------------- */
/* 主题色（与 MemliteSettings.tsx 一致，仅用 DSH 主题变量）                     */
/* -------------------------------------------------------------------------- */

const COLOR_LABEL = 'var(--dsw-alias-label-primary, #2b2a27)'
const COLOR_SECONDARY = 'var(--dsw-alias-label-secondary, #6b675f)'
const COLOR_TERTIARY = 'var(--dsw-alias-label-tertiary, #8a857a)'
const COLOR_ERROR = 'var(--dsw-alias-state-error-primary, #b3261e)'
const COLOR_BORDER = 'var(--dsw-alias-border-l3, #e5e0d6)'
const COLOR_INPUT_BG = 'var(--dsw-alias-bg-layer-2, #ffffff)'
const COLOR_CARD_BG = 'var(--dsw-alias-settings-card-fill, #ffffff)'
const COLOR_SOFT_BG = 'var(--dsw-alias-bg-module-platform, #f7f5f0)'
const COLOR_ACCENT = 'var(--dsw-alias-state-business-primary, #3e6b4f)'
const COLOR_ACCENT_FG = 'var(--dsw-alias-label-primary-foreground, #ffffff)'

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  minWidth: 0,
  maxWidth: '100%',
  boxSizing: 'border-box',
  padding: '10px 12px 16px',
  color: COLOR_LABEL,
  font: 'inherit',
  fontSize: 13,
  lineHeight: '20px',
  overflowWrap: 'anywhere',
}
const headerStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
  paddingBottom: 8,
  borderBottom: `.5px solid ${COLOR_BORDER}`,
}
const viewTabsStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4, minWidth: 0 }
const tabStyle: CSSProperties = {
  padding: '4px 10px',
  border: `.5px solid ${COLOR_BORDER}`,
  borderRadius: 999,
  background: 'transparent',
  color: COLOR_SECONDARY,
  font: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
  cursor: 'pointer',
}
const tabActiveStyle: CSSProperties = {
  ...tabStyle,
  border: '.5px solid transparent',
  background: COLOR_ACCENT,
  color: COLOR_ACCENT_FG,
}
const headerMetaStyle: CSSProperties = {
  marginLeft: 'auto',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
}
const linkButtonStyle: CSSProperties = {
  padding: 0,
  border: 0,
  background: 'transparent',
  color: COLOR_SECONDARY,
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
  textDecoration: 'underline',
  overflowWrap: 'anywhere',
}
const plainButtonStyle: CSSProperties = {
  height: 28,
  padding: '0 12px',
  border: `.5px solid ${COLOR_BORDER}`,
  borderRadius: 8,
  background: 'transparent',
  color: COLOR_LABEL,
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
  maxWidth: '100%',
}
const disabledButtonStyle: CSSProperties = { ...plainButtonStyle, opacity: 0.5, cursor: 'default' }
const inputStyle: CSSProperties = {
  flex: '1 1 120px',
  minWidth: 0,
  boxSizing: 'border-box',
  height: 30,
  padding: '0 10px',
  border: `.5px solid ${COLOR_BORDER}`,
  borderRadius: 8,
  background: COLOR_INPUT_BG,
  color: COLOR_LABEL,
  font: 'inherit',
  fontSize: 12,
  outline: 'none',
}
const selectStyle: CSSProperties = {
  ...inputStyle,
  flex: '1 1 80px',
  appearance: 'auto',
  cursor: 'pointer',
}
const filterRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
}
const filterLabelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  flex: '1 1 140px',
  minWidth: 0,
  color: COLOR_TERTIARY,
  fontSize: 12,
}
const hintStyle: CSSProperties = {
  margin: 0,
  color: COLOR_TERTIARY,
  fontSize: 12,
  lineHeight: '18px',
  overflowWrap: 'anywhere',
}
const errorTextStyle: CSSProperties = { ...hintStyle, color: COLOR_ERROR }
const columnStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }
const rowBetweenStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 6,
  minWidth: 0,
}
const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  minWidth: 0,
  padding: '10px 12px',
  border: `.5px solid ${COLOR_BORDER}`,
  borderRadius: 10,
  background: COLOR_CARD_BG,
}
const sectionTitleStyle: CSSProperties = {
  margin: 0,
  color: COLOR_SECONDARY,
  fontSize: 12,
  fontWeight: 600,
  lineHeight: '18px',
}
const badgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  maxWidth: '100%',
  padding: '0 6px',
  border: `.5px solid ${COLOR_BORDER}`,
  borderRadius: 999,
  color: COLOR_SECONDARY,
  fontSize: 11,
  lineHeight: '16px',
  overflowWrap: 'anywhere',
}
const injectedBadgeStyle: CSSProperties = {
  ...badgeStyle,
  border: `.5px solid ${COLOR_ACCENT}`,
  color: COLOR_ACCENT,
}
const errorBadgeStyle: CSSProperties = {
  ...badgeStyle,
  border: `.5px solid ${COLOR_ERROR}`,
  color: COLOR_ERROR,
}
const badgeRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 4,
  minWidth: 0,
}
const wideRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-start',
  gap: 10,
  minWidth: 0,
}
const listColumnStyle: CSSProperties = { flex: '1 1 280px', minWidth: 0, maxWidth: '100%' }
const detailColumnStyle: CSSProperties = { flex: '2 1 360px', minWidth: 0, maxWidth: '100%' }
const noticeStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  minWidth: 0,
  padding: '12px 14px',
  border: `.5px solid ${COLOR_BORDER}`,
  borderRadius: 10,
  background: COLOR_SOFT_BG,
}
const noticeTitleStyle: CSSProperties = {
  margin: 0,
  color: COLOR_LABEL,
  fontSize: 13,
  fontWeight: 600,
  lineHeight: '20px',
  overflowWrap: 'anywhere',
}
const listButtonStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  width: '100%',
  minWidth: 0,
  maxWidth: '100%',
  boxSizing: 'border-box',
  padding: '9px 10px',
  border: `.5px solid ${COLOR_BORDER}`,
  borderRadius: 10,
  background: 'transparent',
  color: COLOR_LABEL,
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  overflowWrap: 'anywhere',
}
const itemTitleStyle: CSSProperties = {
  margin: 0,
  color: COLOR_LABEL,
  fontSize: 13,
  fontWeight: 600,
  lineHeight: '19px',
  overflowWrap: 'anywhere',
}
const itemSummaryStyle: CSSProperties = {
  margin: 0,
  color: COLOR_SECONDARY,
  fontSize: 12,
  lineHeight: '18px',
  overflow: 'hidden',
  overflowWrap: 'anywhere',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
}
const detailCardStyle: CSSProperties = {
  ...cardStyle,
  background: COLOR_CARD_BG,
}
const contentStyle: CSSProperties = {
  margin: 0,
  maxWidth: '100%',
  maxHeight: 360,
  overflow: 'auto',
  padding: '10px 12px',
  border: `.5px solid ${COLOR_BORDER}`,
  borderRadius: 8,
  background: COLOR_SOFT_BG,
  color: COLOR_LABEL,
  font: 'inherit',
  fontSize: 13,
  lineHeight: '20px',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
}
const metaRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  minWidth: 0,
  fontSize: 12,
  lineHeight: '18px',
}
const metaLabelStyle: CSSProperties = { color: COLOR_TERTIARY, flex: 'none' }
const metaValueStyle: CSSProperties = { color: COLOR_SECONDARY, minWidth: 0, overflowWrap: 'anywhere' }
const treeListStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
}
const treeItemStyle: CSSProperties = { minWidth: 0 }
const treeRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  minWidth: 0,
  maxWidth: '100%',
  padding: '2px 0',
}
const treeToggleStyle: CSSProperties = {
  flex: 'none',
  width: 20,
  height: 20,
  padding: 0,
  border: 0,
  borderRadius: 4,
  background: 'transparent',
  color: COLOR_SECONDARY,
  font: 'inherit',
  fontSize: 11,
  cursor: 'pointer',
}
const treeTogglePlaceholderStyle: CSSProperties = {
  ...treeToggleStyle,
  color: COLOR_TERTIARY,
  cursor: 'default',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
}
const treeNodeButtonStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  padding: '2px 4px',
  border: 0,
  borderRadius: 4,
  background: 'transparent',
  color: COLOR_LABEL,
  font: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
  textAlign: 'left',
  cursor: 'pointer',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const treeNodeTitleStyle: CSSProperties = {
  display: 'inline-block',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  verticalAlign: 'bottom',
}
const treeMetaStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  flex: 'none',
  minWidth: 0,
  maxWidth: '50%',
  color: COLOR_TERTIARY,
  fontSize: 11,
}
const chainRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 4,
  minWidth: 0,
}
const chainLinkStyle: CSSProperties = {
  ...linkButtonStyle,
  color: COLOR_SECONDARY,
  textDecoration: 'none',
  border: `.5px solid ${COLOR_BORDER}`,
  borderRadius: 999,
  padding: '0 8px',
  fontSize: 11,
  lineHeight: '18px',
  maxWidth: '100%',
}
const neighborButtonStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  width: '100%',
  minWidth: 0,
  maxWidth: '100%',
  padding: '6px 8px',
  border: `.5px solid ${COLOR_BORDER}`,
  borderRadius: 8,
  background: 'transparent',
  color: COLOR_LABEL,
  font: 'inherit',
  fontSize: 12,
  textAlign: 'left',
  cursor: 'pointer',
  overflowWrap: 'anywhere',
}

/* -------------------------------------------------------------------------- */
/* 纯展示层：状态类型 + 渲染入口（SSR 测试直接使用）                            */
/* -------------------------------------------------------------------------- */

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

/** 纯展示层入口：不调用任何 hook，SSR 下可安全渲染。 */
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

/* -------------------------------------------------------------------------- */
/* 公共小部件                                                                  */
/* -------------------------------------------------------------------------- */

function Notice(props: {
  title: string
  description?: string
  tone?: 'muted' | 'error'
  action?: ReactNode
}): ReactNode {
  return (
    <div style={noticeStyle}>
      <p style={{ ...noticeTitleStyle, color: props.tone === 'error' ? COLOR_ERROR : COLOR_LABEL }}>
        {props.title}
      </p>
      {props.description !== undefined ? <p style={hintStyle}>{props.description}</p> : null}
      {props.action}
    </div>
  )
}

function describeApiError(t: Translate, error: MemoryErrorInfo | undefined): string {
  if (error === undefined) return t('state.errorGeneric')
  switch (error.code) {
    case 'network':
      return t('state.errorNetwork')
    case 'shape':
      return t('state.errorMalformed')
    case 'http':
      return t('state.errorHttp', { status: error.status ?? '?' })
    default:
      return t('state.errorGeneric')
  }
}

function ErrorNotice(props: {
  t: Translate
  error: MemoryErrorInfo | undefined
  onRetry: () => void
}): ReactNode {
  const { t, error, onRetry } = props
  return (
    <div style={noticeStyle}>
      <p style={{ ...noticeTitleStyle, color: COLOR_ERROR }}>{t('state.errorTitle')}</p>
      <p style={errorTextStyle}>{describeApiError(t, error)}</p>
      <div>
        <button type="button" style={plainButtonStyle} onClick={onRetry}>
          {t('retry')}
        </button>
      </div>
    </div>
  )
}

function DisabledNotice(props: { t: Translate }): ReactNode {
  return <Notice title={props.t('state.disabledTitle')} description={props.t('state.disabledDescription')} />
}

function LoadingNotice(props: { t: Translate }): ReactNode {
  return <p style={hintStyle}>{props.t('state.loading')}</p>
}

function ImportanceBadge(props: { t: Translate; importance: MemoryImportance }): ReactNode {
  const { t, importance } = props
  if (importance === '') return null
  return (
    <span style={badgeStyle}>
      {importance === 'important' ? t('list.importanceImportant') : t('list.importanceTrivial')}
    </span>
  )
}

/**
 * 格式化为 `YYYY-MM-DD HH:mm`（秒级时间戳，与 `MemRecord.ts` 同口径）。
 *
 * 默认按**浏览器本地时区**渲染——面板旁边就是聊天消息的本地时间，用 UTC 会差 8 小时误导用户；
 * 传 `'utc'` 可得到确定值（测试/快照用）。无效时间戳返回 `—`。
 */
export function formatTimestamp(ts: number, zone: 'local' | 'utc' = 'local'): string {
  if (!Number.isFinite(ts)) return '—'
  const date = new Date(ts * 1000)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number): string => String(value).padStart(2, '0')
  const year = zone === 'utc' ? date.getUTCFullYear() : date.getFullYear()
  const month = zone === 'utc' ? date.getUTCMonth() : date.getMonth()
  const day = zone === 'utc' ? date.getUTCDate() : date.getDate()
  const hours = zone === 'utc' ? date.getUTCHours() : date.getHours()
  const minutes = zone === 'utc' ? date.getUTCMinutes() : date.getMinutes()
  return `${year}-${pad(month + 1)}-${pad(day)} ${pad(hours)}:${pad(minutes)}`
}

/** 召回分数展示（固定三位小数，确定性）。 */
export function formatScore(score: number): string {
  return Number.isFinite(score) ? score.toFixed(3) : '—'
}

/* -------------------------------------------------------------------------- */
/* 本次对话视图                                                                */
/* -------------------------------------------------------------------------- */

interface RecallGroup {
  turn: number
  entries: MemorySessionRecall[]
}

/** 按 turn 倒序分组（同 turn 内按时间倒序）。 */
function groupRecalls(entries: readonly MemorySessionRecall[]): RecallGroup[] {
  const sorted = [...entries].sort((a, b) => b.turn - a.turn || b.timestamp - a.timestamp)
  const groups: RecallGroup[] = []
  for (const entry of sorted) {
    const last = groups[groups.length - 1]
    if (last !== undefined && last.turn === entry.turn) last.entries.push(entry)
    else groups.push({ turn: entry.turn, entries: [entry] })
  }
  return groups
}

const RECALL_STATUS_TONE: Record<MemoryRecallStatus, 'muted' | 'injected' | 'error'> = {
  ok: 'injected',
  empty: 'muted',
  skipped: 'muted',
  error: 'error',
}

function SkipReasonBadge(props: { t: Translate; reason: MemorySkipReason }): ReactNode {
  const { t, reason } = props
  return <span style={badgeStyle}>{t(`session.skip.${reason}`)}</span>
}

function SessionHitBadge(props: { t: Translate; hit: MemorySessionRecallsResponse['entries'][number]['hits'][number] }): ReactNode {
  const { t, hit } = props
  if (hit.injected) return <span style={injectedBadgeStyle}>{t('session.injected')}</span>
  if (hit.exclusion === 'threshold') return <span style={badgeStyle}>{t('session.threshold')}</span>
  if (hit.exclusion === 'budget') return <span style={badgeStyle}>{t('session.budget')}</span>
  // 候选命中且没有任何注入原因：明确标注“未注入”，不得显示为已使用。
  return <span style={badgeStyle}>{t('session.candidate')}</span>
}

function SessionView(props: {
  t: Translate
  state: SessionViewState
  feedbackBusy?: string
  actions: MemoryPanelActions
}): ReactNode {
  const { t, state, actions, feedbackBusy } = props
  if (state.status === 'unavailable') {
    return (
      <Notice
        title={t('session.unavailableTitle')}
        description={t('session.unavailableDescription')}
      />
    )
  }
  if (state.status === 'loading') return <LoadingNotice t={t} />
  if (state.status === 'disabled') return <DisabledNotice t={t} />
  if (state.status === 'error') {
    return <ErrorNotice t={t} error={state.error} onRetry={actions.refresh} />
  }

  const data = state.data
  if (data === undefined) return <Notice title={t('state.errorGeneric')} />
  if (data.entries.length === 0) {
    return <Notice title={t('session.empty')} description={t('session.emptyHint')} />
  }

  const groups = groupRecalls(data.entries)
  return (
    <div style={columnStyle}>
      <div style={rowBetweenStyle}>
        <span style={hintStyle}>
          {data.scope === 'agent' ? t('session.scopeAgent') : t('session.scopeSession')} ·{' '}
          {t('session.count', { count: data.entries.length })}
        </span>
        <span style={hintStyle}>
          {formatTimestamp(
            data.entries.reduce((latest, entry) => Math.max(latest, entry.timestamp), 0),
          )}
        </span>
      </div>
      {data.trimmed ? <p style={hintStyle}>{t('session.trimmed', { count: data.entries.length })}</p> : null}
      {groups.map((group) => (
        <div key={`turn-${group.turn}`} style={columnStyle}>
          <p style={sectionTitleStyle}>{t('session.turn', { turn: group.turn })}</p>
          {group.entries.map((entry, entryIndex) => (
            <div key={`${entry.messageId}-${entry.turn}-${entryIndex}`} style={cardStyle}>
              <div style={badgeRowStyle}>
                <span style={RECALL_STATUS_TONE[entry.status] === 'error' ? errorBadgeStyle : badgeStyle}>
                  {t(`session.status.${entry.status}`)}
                </span>
                {entry.skipReason !== undefined ? (
                  <SkipReasonBadge t={t} reason={entry.skipReason} />
                ) : null}
                {entry.backend !== '' ? (
                  <span style={badgeStyle}>{t('session.backend', { backend: entry.backend })}</span>
                ) : null}
                {entry.fallback !== '' ? (
                  <span style={badgeStyle}>{t('session.fallback', { fallback: entry.fallback })}</span>
                ) : null}
                <span style={hintStyle}>{formatTimestamp(entry.timestamp)}</span>
              </div>
              <p style={hintStyle}>
                {t('session.injectedSummary', {
                  injected: entry.hits.filter((hit) => hit.injected).length,
                  candidates: entry.hits.length,
                  backend: entry.backend !== '' ? entry.backend : '—',
                  ms: entry.elapsedMs ?? 0,
                })}
              </p>
              {entry.status === 'error' ? <p style={errorTextStyle}>{t('session.recallError')}</p> : null}
              {entry.status !== 'error' && entry.hits.length === 0 ? (
                <p style={hintStyle}>{t('session.noHits')}</p>
              ) : null}
              {entry.injectedText !== undefined && entry.injectedText !== '' ? (
                <details>
                  <summary style={linkButtonStyle}>{t('session.injectedText')}</summary>
                  <pre style={contentStyle}>{entry.injectedText}</pre>
                </details>
              ) : entry.hits.length > 0 ? (
                <p style={hintStyle}>{t('session.noInjectedText')}</p>
              ) : null}
              {entry.hits.map((hit, hitIndex) => {
                const feedback = entry.feedback?.[hit.id]
                const busyKey = `feedback:${entry.turn}:${entry.messageId}:${hit.id}`
                const why = hit.injected
                  ? t('session.whyInjected', {
                      threshold: entry.threshold ?? 0,
                      used: entry.usedChars ?? 0,
                      budget: entry.budgetChars ?? 0,
                    })
                  : hit.exclusion === 'threshold'
                    ? t('session.whyThreshold', {
                        score: formatScore(hit.score),
                        threshold: entry.threshold ?? 0,
                      })
                    : hit.exclusion === 'budget'
                      ? t('session.whyBudget', {
                          used: entry.usedChars ?? 0,
                          budget: entry.budgetChars ?? 0,
                        })
                      : t('session.whyCandidate')
                return (
                  <div key={`${hit.id}-${hitIndex}`} style={columnStyle}>
                    <button type="button" style={listButtonStyle} onClick={() => actions.select(hit.id)}>
                      <span style={itemTitleStyle}>{hit.title !== '' ? hit.title : hit.id}</span>
                      <span style={badgeRowStyle}>
                        <SessionHitBadge t={t} hit={hit} />
                        <span style={badgeStyle}>{t('session.score', { score: formatScore(hit.score) })}</span>
                        {hit.exists ? null : <span style={errorBadgeStyle}>{t('session.deleted')}</span>}
                      </span>
                      <span style={hintStyle}>{why}</span>
                    </button>
                    <div style={badgeRowStyle}>
                      <button
                        type="button"
                        style={feedback === 'helpful' ? tabActiveStyle : plainButtonStyle}
                        disabled={feedbackBusy !== undefined}
                        onClick={() => actions.feedback(entry, hit.id, 'helpful')}
                      >
                        {t('session.helpful')}
                      </button>
                      <button
                        type="button"
                        style={feedback === 'irrelevant' ? tabActiveStyle : plainButtonStyle}
                        disabled={feedbackBusy !== undefined}
                        onClick={() => actions.feedback(entry, hit.id, 'irrelevant')}
                      >
                        {t('session.irrelevant')}
                      </button>
                      {feedbackBusy === busyKey ? <span style={hintStyle}>{t('state.loading')}</span> : null}
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* 全部记忆视图                                                                */
/* -------------------------------------------------------------------------- */

function AllMemoriesView(props: {
  t: Translate
  state: AllViewState
  query: string
  project: string
  tag: string
  importance: MemoryImportance
  /** 详情里选中的记忆 id：列表中高亮，保持列表与详情选中态一致。 */
  selectedId?: string
  actions: MemoryPanelActions
}): ReactNode {
  const { t, state, actions, query, project, tag, importance, selectedId } = props
  const searching = query.trim() !== ''
  const filtering = project !== '' || tag !== '' || importance !== ''

  const controls = (
    <div style={columnStyle}>
      <div style={filterRowStyle}>
        <input
          type="search"
          aria-label={t('list.searchPlaceholder')}
          placeholder={t('list.searchPlaceholder')}
          style={inputStyle}
          value={query}
          onChange={(event) => actions.setQuery(event.target.value)}
        />
      </div>
      <div style={filterRowStyle}>
        <label style={filterLabelStyle}>
          <span>{t('list.filterProject')}</span>
          <select
            aria-label={t('list.filterProject')}
            style={selectStyle}
            value={project}
            onChange={(event) => actions.setProject(event.target.value)}
          >
            <option value="">{t('list.projectAll')}</option>
            {state.projects.map(([name, count]) => (
              <option key={name} value={name}>
                {name} ({count})
              </option>
            ))}
          </select>
        </label>
        <label style={filterLabelStyle}>
          <span>{t('list.filterTag')}</span>
          <select
            aria-label={t('list.filterTag')}
            style={selectStyle}
            value={tag}
            disabled={searching}
            onChange={(event) => actions.setTag(event.target.value)}
          >
            <option value="">{t('list.tagAll')}</option>
            {state.tags.map(([name, count]) => (
              <option key={name} value={name}>
                {name} ({count})
              </option>
            ))}
          </select>
        </label>
        <label style={filterLabelStyle}>
          <span>{t('list.filterImportance')}</span>
          <select
            aria-label={t('list.filterImportance')}
            style={selectStyle}
            value={importance}
            disabled={searching}
            onChange={(event) => actions.setImportance(event.target.value as MemoryImportance)}
          >
            <option value="">{t('list.importanceAll')}</option>
            <option value="important">{t('list.importanceImportant')}</option>
            <option value="trivial">{t('list.importanceTrivial')}</option>
          </select>
        </label>
      </div>
    </div>
  )

  if (state.status === 'disabled') {
    return (
      <div style={columnStyle}>
        {controls}
        <DisabledNotice t={t} />
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div style={columnStyle}>
        {controls}
        <ErrorNotice t={t} error={state.error} onRetry={actions.refresh} />
      </div>
    )
  }

  const loading = state.status === 'loading'
  return (
    <div style={columnStyle}>
      {controls}
      <div style={rowBetweenStyle}>
        <span style={hintStyle}>
          {searching
            ? t('list.searchTotal', { count: state.items.length })
            : t('list.total', { total: state.total })}
        </span>
        {searching ? <span style={hintStyle}>{t('list.searchMode')}</span> : null}
      </div>

      {loading ? <LoadingNotice t={t} /> : null}

      {!loading && state.items.length === 0 ? (
        searching || filtering ? (
          <Notice title={t('list.noHits')} description={t('list.noHitsHint')} />
        ) : (
          <Notice title={t('list.empty')} description={t('list.emptyHint')} />
        )
      ) : null}

      {state.items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-current={selectedId === item.id ? 'true' : undefined}
          style={
            selectedId === item.id ? { ...listButtonStyle, border: `.5px solid ${COLOR_ACCENT}` } : listButtonStyle
          }
          onClick={() => actions.select(item.id)}
        >
          <span style={itemTitleStyle}>{item.title !== '' ? item.title : t('list.unnamed')}</span>
          {item.summary !== '' ? <span style={itemSummaryStyle}>{item.summary}</span> : null}
          <span style={badgeRowStyle}>
            <ImportanceBadge t={t} importance={item.importance} />
            {item.project !== '' ? <span style={badgeStyle}>{item.project}</span> : null}
            {item.childCount > 0 ? (
              <span style={badgeStyle}>{t('tree.children', { count: item.childCount })}</span>
            ) : (
              <span style={badgeStyle}>{t('detail.leaf')}</span>
            )}
            {state.scored && item.score !== undefined ? (
              <span style={badgeStyle}>{t('list.score', { score: formatScore(item.score) })}</span>
            ) : null}
          </span>
        </button>
      ))}

      {state.loadMoreError !== undefined ? (
        <p style={errorTextStyle}>{t('list.loadMoreError')}</p>
      ) : null}
      {!loading && state.nextCursor !== null ? (
        <div>
          <button
            type="button"
            style={state.loadingMore ? disabledButtonStyle : plainButtonStyle}
            disabled={state.loadingMore}
            onClick={actions.loadMore}
          >
            {state.loadingMore ? t('list.loadingMore') : t('list.loadMore')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* 详情视图（列表 / 本次对话 / 因果树共用）                                     */
/* -------------------------------------------------------------------------- */

function DetailView(props: {
  t: Translate
  state: DetailViewState
  copied?: 'content' | 'id' | 'failed'
  actions: MemoryPanelActions
}): ReactNode {
  const { t, state, actions, copied } = props

  const header = (
    <div style={rowBetweenStyle}>
      <p style={sectionTitleStyle}>{t('detail.title')}</p>
      <button type="button" style={linkButtonStyle} onClick={actions.closeDetail}>
        {t('detail.close')}
      </button>
    </div>
  )

  if (state.status === 'loading') {
    return (
      <div style={detailCardStyle}>
        {header}
        <p style={hintStyle}>{t('detail.loading')}</p>
      </div>
    )
  }
  if (state.status === 'disabled') {
    return (
      <div style={detailCardStyle}>
        {header}
        <DisabledNotice t={t} />
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <div style={detailCardStyle}>
        {header}
        <ErrorNotice
          t={t}
          error={state.error}
          onRetry={() => {
            if (state.id !== undefined) actions.select(state.id)
          }}
        />
      </div>
    )
  }

  const data = state.data
  if (data === undefined || !data.found || data.record === undefined) {
    return (
      <div style={detailCardStyle}>
        {header}
        <Notice title={t('detail.deletedTitle')} description={t('detail.deletedDescription')} />
      </div>
    )
  }

  const record = data.record
  const copyState =
    copied === 'failed' ? (
      <span style={errorTextStyle}>{t('detail.copyFailed')}</span>
    ) : copied !== undefined ? (
      <span style={hintStyle}>{t('detail.copied')}</span>
    ) : null

  return (
    <div style={detailCardStyle}>
      {header}
      <span style={itemTitleStyle}>{record.title !== '' ? record.title : t('list.unnamed')}</span>

      <div style={columnStyle}>
        <div style={metaRowStyle}>
          <span style={metaLabelStyle}>{t('detail.metaProject')}</span>
          <span style={metaValueStyle}>{record.project !== '' ? record.project : '—'}</span>
        </div>
        <div style={metaRowStyle}>
          <span style={metaLabelStyle}>{t('detail.metaImportance')}</span>
          <span style={metaValueStyle}>
            {record.importance === 'important'
              ? t('list.importanceImportant')
              : record.importance === 'trivial'
                ? t('list.importanceTrivial')
                : t('list.importanceUnmarked')}
          </span>
        </div>
        <div style={metaRowStyle}>
          <span style={metaLabelStyle}>{t('detail.metaKind')}</span>
          <span style={metaValueStyle}>{record.kind !== '' ? record.kind : '—'}</span>
        </div>
        <div style={metaRowStyle}>
          <span style={metaLabelStyle}>{t('detail.metaTags')}</span>
          <span style={metaValueStyle}>{record.tags.length > 0 ? record.tags.join(' · ') : '—'}</span>
        </div>
        <div style={metaRowStyle}>
          <span style={metaLabelStyle}>{t('detail.metaCreated')}</span>
          <span style={metaValueStyle}>{formatTimestamp(record.ts)}</span>
        </div>
        <div style={metaRowStyle}>
          <span style={metaLabelStyle}>{t('detail.parent')}</span>
          <span style={metaValueStyle}>
            {record.parentId !== '' ? record.parentId : t('detail.noParent')}
          </span>
        </div>
        <div style={metaRowStyle}>
          <span style={metaLabelStyle}>{t('detail.metaId')}</span>
          <span
            style={{
              ...metaValueStyle,
              fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
            }}
          >
            {record.id}
          </span>
        </div>
        <div style={metaRowStyle}>
          <span style={metaLabelStyle}>{t('detail.metaChildren')}</span>
          <span style={metaValueStyle}>{record.leaf ? t('detail.leaf') : String(record.childCount)}</span>
        </div>
      </div>

      <pre style={contentStyle}>{record.content}</pre>
      {record.truncated ? <p style={hintStyle}>{t('detail.contentTruncated')}</p> : null}

      <div style={badgeRowStyle}>
        <button type="button" style={plainButtonStyle} onClick={() => actions.openEditor('edit', record)}>
          {t('detail.edit')}
        </button>
        <button type="button" style={plainButtonStyle} onClick={() => actions.openEditor('reply', record)}>
          {t('detail.reply')}
        </button>
        <button type="button" style={plainButtonStyle} onClick={() => actions.openEditor('attach', record)}>
          {t('detail.attach')}
        </button>
        <button type="button" style={plainButtonStyle} onClick={() => actions.searchAround(record.title)}>
          {t('detail.around')}
        </button>
        <button type="button" style={plainButtonStyle} onClick={() => actions.copy('content', record.content)}>
          {t('detail.copyAction')}
        </button>
        <button type="button" style={plainButtonStyle} onClick={() => actions.copy('id', record.id)}>
          {t('detail.copyIdAction')}
        </button>
        <button
          type="button"
          style={{ ...plainButtonStyle, color: COLOR_ERROR, border: `.5px solid ${COLOR_ERROR}` }}
          onClick={() => actions.openEditor('forget', record)}
        >
          {t('detail.forget')}
        </button>
        {copyState}
      </div>

      {data.ancestors.length > 0 ? (
        <div style={columnStyle}>
          <p style={sectionTitleStyle}>{t('detail.ancestors')}</p>
          {data.ancestors.map((neighbor) => (
            <button
              key={neighbor.id}
              type="button"
              style={neighborButtonStyle}
              onClick={() => actions.select(neighbor.id)}
            >
              <span style={itemTitleStyle}>{neighbor.title !== '' ? neighbor.title : neighbor.id}</span>
            </button>
          ))}
        </div>
      ) : null}

      {data.children.length > 0 ? (
        <div style={columnStyle}>
          <p style={sectionTitleStyle}>{t('detail.children')}</p>
          {data.children.map((neighbor) => (
            <button
              key={neighbor.id}
              type="button"
              style={neighborButtonStyle}
              onClick={() => actions.select(neighbor.id)}
            >
              <span style={itemTitleStyle}>{neighbor.title !== '' ? neighbor.title : neighbor.id}</span>
              {neighbor.summary !== '' ? <span style={itemSummaryStyle}>{neighbor.summary}</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      {data.chain.ancestors.length > 0 || data.chain.descendants.length > 0 ? (
        <div style={columnStyle}>
          <p style={sectionTitleStyle}>{t('detail.chain')}</p>
          <div style={chainRowStyle}>
            {data.chain.ancestors.map((neighbor) => (
              <button
                key={`ancestor-${neighbor.id}`}
                type="button"
                style={chainLinkStyle}
                onClick={() => actions.select(neighbor.id)}
              >
                {neighbor.title !== '' ? neighbor.title : neighbor.id}
              </button>
            ))}
            {data.chain.entry.id !== '' ? (
              <span style={badgeStyle}>
                {data.chain.entry.title !== '' ? data.chain.entry.title : data.chain.entry.id}
              </span>
            ) : null}
            {data.chain.descendants.map((neighbor) => (
              <button
                key={`descendant-${neighbor.id}-${neighbor.depth}`}
                type="button"
                style={chainLinkStyle}
                onClick={() => actions.select(neighbor.id)}
              >
                {neighbor.title !== '' ? neighbor.title : neighbor.id} · {neighbor.depth}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* 因果树视图                                                                  */
/* -------------------------------------------------------------------------- */

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

function TreeView(props: {
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

/* -------------------------------------------------------------------------- */
/* 面板组件（状态机 + 请求生命周期）                                            */
/* -------------------------------------------------------------------------- */

export interface MemoryPanelProps {
  t: (key: string, params?: Record<string, unknown>) => string
  /** 当前会话 id（slot inject 注入；缺省时“本次对话”显示不可用）。 */
  sessionId?: string
  /** slot 框架注入的 hooks（防御式读取，不依赖其内部形状）。 */
  useTabInfo?: () => unknown
  /** 测试注入；缺省用 document-relative fetch。 */
  api?: MemoryApi
}

/** 防御式读取 slot 框架的 tabInfo：拿不到 `tab.visible` 就按可见处理。 */
function readTabVisible(info: unknown): boolean {
  if (typeof info !== 'object' || info === null) return true
  const tab = (info as { tab?: unknown }).tab
  if (typeof tab !== 'object' || tab === null) return true
  const visible = (tab as { visible?: unknown }).visible
  return typeof visible === 'boolean' ? visible : true
}

/** SSR / 未注入 useTabInfo 时的占位 hook。 */
function useNoTabInfo(): unknown {
  return undefined
}

function toErrorInfo(error: unknown): MemoryErrorInfo {
  if (error instanceof MemoryApiError) {
    return {
      code: error.code === 'disabled' ? 'http' : error.code,
      ...(error.status === undefined ? {} : { status: error.status }),
    }
  }
  return { code: 'unknown' }
}

function isDisabledError(error: unknown): boolean {
  return error instanceof MemoryApiError && error.disabled
}

const ALL_DEBOUNCE_MS = 200

/** 聊天记忆浏览器面板。 */
export function MemliteMemoryPanel(props: MemoryPanelProps): ReactNode {
  const { t, sessionId } = props

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

  const [view, setView] = useState<MemoryView>('session')
  const [sessionState, setSessionState] = useState<SessionViewState>(() =>
    sessionId === undefined || sessionId.trim() === ''
      ? { status: 'unavailable' }
      : { status: 'loading' },
  )
  const [allState, setAllState] = useState<AllViewState>(() => emptyAllState())
  const [treeState, setTreeState] = useState<TreeViewState>(() => emptyTreeState())
  const [statusState, setStatusState] = useState<StatusViewState>({ status: 'loading' })
  const [editor, setEditor] = useState<EditorState>(() => emptyEditorState())
  const [receipt, setReceipt] = useState<MemoryWriteReceipt>()
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
  const editorSearchRef = useRef<AbortController | undefined>(undefined)
  const saveRef = useRef<AbortController | undefined>(undefined)
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
  const abortEditor = useCallback(() => {
    editorSearchRef.current?.abort()
    editorSearchRef.current = undefined
    saveRef.current?.abort()
    saveRef.current = undefined
  }, [])
  const abortAll = useCallback(() => {
    abortPrimary()
    abortDetail()
    abortChildren()
    abortStatus()
    abortEditor()
  }, [abortPrimary, abortDetail, abortChildren, abortStatus, abortEditor])

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
      abortAll()
    }
  }, [abortAll])

  // 换会话：中止旧请求、清空选中详情、重置引擎代次（避免把新会话误判为“引擎变化”）。
  useEffect(() => {
    abortAll()
    setDetail({ status: 'idle' })
    setCopied(undefined)
    setReceipt(undefined)
    setEditor(emptyEditorState())
    setFeedbackBusy(undefined)
    setStatusState({ status: 'loading' })
    engineRef.current = undefined
  }, [sessionId, abortAll])

  /**
   * 引擎代次变化：清空失效详情并触发当前视图重载（契约 §六）。
   * 返回是否发生了变化。
   */
  const noteEngine = useCallback(
    (engine: number): boolean => {
      const previous = engineRef.current
      engineRef.current = engine
      if (previous === undefined || previous === engine) return false
      abortDetail()
      abortEditor()
      setDetail({ status: 'idle' })
      setEditor(emptyEditorState())
      setReceipt(undefined)
      setReloadToken((token) => token + 1)
      return true
    },
    [abortDetail, abortEditor],
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

  const openEditor = useCallback(
    (mode: EditorState['mode'], record?: MemoryShowResponse['record']) => {
      const current = record ?? (detail.status === 'ready' ? detail.data?.record : undefined)
      if (mode !== 'create' && current === undefined) return
      abortEditor()
      if (mode === 'create') {
        setEditor(emptyEditorState({ mode: 'create', status: 'open', importance: 'important' }))
        return
      }
      const base = current!
      if (mode === 'edit') {
        setEditor(
          emptyEditorState({
            mode: 'edit',
            status: 'open',
            id: base.id,
            expectedRevision: base.revision,
            title: base.title,
            content: base.content,
            tags: base.tags.join(', '),
            project: base.project,
            importance: base.importance,
            baseTitle: base.title,
          }),
        )
        return
      }
      if (mode === 'reply') {
        setEditor(
          emptyEditorState({
            mode: 'reply',
            status: 'open',
            id: base.id,
            parentId: base.id,
            parentTitle: base.title,
            project: base.project,
            importance: 'important',
            baseTitle: base.title,
          }),
        )
        return
      }
      if (mode === 'attach') {
        setEditor(
          emptyEditorState({
            mode: 'attach',
            status: 'open',
            id: base.id,
            expectedRevision: base.revision,
            parentId: base.parentId,
            baseTitle: base.title,
          }),
        )
        return
      }
      setEditor(
        emptyEditorState({
          mode: 'forget',
          status: 'open',
          id: base.id,
          expectedRevision: base.revision,
          baseTitle: base.title !== '' ? base.title : base.id,
        }),
      )
    },
    [abortEditor, detail],
  )

  const searchParent = useCallback(() => {
    const query = editor.parentQuery.trim()
    if (query === '') {
      setEditor((previous) => ({ ...previous, parentResults: [] }))
      return
    }
    editorSearchRef.current?.abort()
    const controller = new AbortController()
    editorSearchRef.current = controller
    setEditor((previous) => ({ ...previous, parentSearching: true }))
    void api
      .search({ query, limit: 5 }, controller.signal)
      .then((data) => {
        if (controller.signal.aborted || !aliveRef.current) return
        const currentId = editor.id
        setEditor((previous) => ({
          ...previous,
          parentSearching: false,
          parentResults: data.items
            .filter((item) => item.id !== currentId)
            .map((item) => ({ id: item.id, title: item.title, revision: item.revision })),
        }))
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error) || !aliveRef.current) return
        setEditor((previous) => ({ ...previous, parentSearching: false, parentResults: [] }))
      })
  }, [api, editor.parentQuery, editor.id])

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

  const runSync = useCallback(() => {
    setStatusState((previous) => ({ ...previous, busy: 'sync', result: undefined }))
    void api
      .sync({ operationId: newOperationId() })
      .then((result) => {
        if (!aliveRef.current) return
        setStatusState((previous) => ({
          ...previous,
          busy: undefined,
          result: {
            ok: result.verified,
            text: t('status.syncResult', {
              committed: String(result.committed),
              local: result.localSha,
              remote: result.remoteSha,
              verified: String(result.verified),
            }),
          },
        }))
        loadStatus()
      })
      .catch((error: unknown) => {
        if (!aliveRef.current) return
        setStatusState((previous) => ({
          ...previous,
          busy: undefined,
          result: {
            ok: false,
            text: error instanceof Error ? error.message : t('state.errorGeneric'),
          },
        }))
      })
  }, [api, loadStatus, t])

  const runReembed = useCallback(() => {
    setStatusState((previous) => ({ ...previous, busy: 'reembed', result: undefined }))
    void api
      .reembed({ operationId: newOperationId() })
      .then((result) => {
        if (!aliveRef.current) return
        setStatusState((previous) => ({
          ...previous,
          busy: undefined,
          result: {
            ok: result.failed === 0,
            text: t('status.reembedResult', {
              embedded: result.embedded,
              total: result.total,
              failed: result.failed,
            }),
          },
        }))
        loadStatus()
      })
      .catch((error: unknown) => {
        if (!aliveRef.current) return
        setStatusState((previous) => ({
          ...previous,
          busy: undefined,
          result: {
            ok: false,
            text: error instanceof Error ? error.message : t('state.errorGeneric'),
          },
        }))
      })
  }, [api, loadStatus, t])

  const copyDiagnostics = useCallback(() => {
    const data = statusState.data
    if (data === undefined) return
    const text = [
      `memlite status engine=${data.engine}`,
      `records=${data.library.records} badLines=${data.library.badLines} vectors=${data.library.vectors}`,
      `backend=${data.search.backend} embedding=${data.search.embeddingProvider}`,
      `sync.available=${data.sync.available} hasRemote=${data.sync.hasRemote} dirty=${data.sync.dirty} local=${data.sync.localSha}`,
      `obsidian=${data.obsidian.state}`,
      `receipts=${data.receipts.length}`,
    ].join('\n')
    const clipboard =
      typeof navigator === 'undefined' ? undefined : (navigator as { clipboard?: unknown }).clipboard
    const writeText =
      typeof clipboard === 'object' && clipboard !== null
        ? (clipboard as { writeText?: unknown }).writeText
        : undefined
    if (typeof writeText !== 'function') {
      setStatusState((previous) => ({ ...previous, copied: 'failed' }))
      return
    }
    try {
      void (writeText as (value: string) => Promise<void>).call(clipboard, text).then(
        () => setStatusState((previous) => ({ ...previous, copied: 'ok' })),
        () => setStatusState((previous) => ({ ...previous, copied: 'failed' })),
      )
    } catch {
      setStatusState((previous) => ({ ...previous, copied: 'failed' }))
    }
  }, [statusState.data])

  const saveEditor = useCallback(() => {
    const current = editor
    if (current.status === 'saving') return
    const mode = current.mode
    const requireBody = mode === 'create' || mode === 'edit' || mode === 'reply'
    if (requireBody && current.title.trim() === '') {
      setEditor((previous) => ({ ...previous, error: t('editor.invalidTitle') }))
      return
    }
    if (requireBody && current.content.trim() === '') {
      setEditor((previous) => ({ ...previous, error: t('editor.invalidContent') }))
      return
    }
    if (mode !== 'create' && current.expectedRevision === undefined) return
    const operationId = newOperationId()
    setEditor((previous) => ({ ...previous, status: 'saving', error: undefined, conflict: undefined }))
    const tags = current.tags
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '')
    const scope =
      sessionId !== undefined && sessionId.trim() !== '' ? { sessionId } : {}
    let task: Promise<MemoryWriteReceipt>
    if (mode === 'create') {
      task = api.remember({
        operationId,
        title: current.title.trim(),
        content: current.content,
        tags,
        project: current.project.trim(),
        importance: current.importance === '' ? 'important' : current.importance,
        ...(current.parentId !== '' ? { parentId: current.parentId } : {}),
        ...scope,
      })
    } else if (mode === 'edit') {
      task = api.update({
        operationId,
        id: current.id!,
        expectedRevision: current.expectedRevision!,
        title: current.title,
        content: current.content,
        tags,
        importance: current.importance,
        ...scope,
      })
    } else if (mode === 'reply') {
      task = api.remember({
        operationId,
        title: current.title.trim(),
        content: current.content,
        tags,
        project: current.project.trim(),
        importance: current.importance === '' ? 'important' : current.importance,
        parentId: current.parentId,
        ...scope,
      })
    } else if (mode === 'attach') {
      task = api.attach({
        operationId,
        id: current.id!,
        expectedRevision: current.expectedRevision!,
        parentId: current.parentId,
        ...scope,
      })
    } else {
      task = api.forget({
        operationId,
        id: current.id!,
        expectedRevision: current.expectedRevision!,
        confirmTitle: current.confirmTitle.trim(),
        ...scope,
      })
    }
    void task.then(
      (result) => {
        if (!aliveRef.current) return
        setReceipt(result)
        if (result.status === 'saved' || result.status === 'saved-degraded') {
          setEditor((previous) => ({ ...previous, status: 'closed' }))
          setReloadToken((token) => token + 1)
          if (mode === 'forget') {
            setDetail({ status: 'idle' })
          } else if (result.id !== '') {
            select(result.id)
          }
          loadStatus()
          return
        }
        setEditor((previous) => ({
          ...previous,
          status: 'open',
          ...(result.status === 'conflict'
            ? { conflict: result }
            : { error: result.message ?? t('state.errorGeneric') }),
        }))
      },
      (error: unknown) => {
        if (!aliveRef.current || isAbortError(error)) return
        const kind =
          mode === 'attach'
            ? 'attach'
            : mode === 'forget'
              ? 'forget'
              : mode === 'create' || mode === 'reply'
                ? 'remember'
                : 'update'
        if (error instanceof MemoryApiError && error.receipt !== undefined) {
          const failedReceipt = error.receipt
          setReceipt(failedReceipt)
          setEditor((previous) => ({
            ...previous,
            status: 'open',
            ...(failedReceipt.status === 'conflict'
              ? { conflict: failedReceipt }
              : { error: failedReceipt.message ?? error.message }),
          }))
          return
        }
        if (error instanceof MemoryApiError && error.code !== 'network') {
          const failedReceipt: MemoryWriteReceipt = {
            operationId,
            kind,
            status: 'failed',
            id: current.id ?? '',
            title: current.title,
            verified: false,
            embedded: 'not-applicable',
            code: error.businessCode ?? error.code,
            message: error.disabled ? t('state.disabledDescription') : error.message,
            timestamp: Math.floor(Date.now() / 1000),
          }
          setReceipt(failedReceipt)
          setEditor((previous) => ({
            ...previous,
            status: 'open',
            error: failedReceipt.message ?? t('state.errorGeneric'),
          }))
          return
        }
        const unconfirmed: MemoryWriteReceipt = {
          operationId,
          kind,
          status: 'unconfirmed',
          id: current.id ?? '',
          title: current.title,
          verified: false,
          embedded: 'not-applicable',
          code: 'UNCONFIRMED',
          message: t('receipt.unconfirmedHint'),
          timestamp: Math.floor(Date.now() / 1000),
        }
        setReceipt(unconfirmed)
        setEditor((previous) => ({ ...previous, status: 'open', error: t('receipt.unconfirmedHint') }))
      },
    )
  }, [api, editor, loadStatus, select, sessionId, t])

  const editorActions: EditorActions = {
    setTitle: (value) => setEditor((previous) => ({ ...previous, title: value })),
    setContent: (value) => setEditor((previous) => ({ ...previous, content: value })),
    setTags: (value) => setEditor((previous) => ({ ...previous, tags: value })),
    setProject: (value) => setEditor((previous) => ({ ...previous, project: value })),
    setImportance: (value) => setEditor((previous) => ({ ...previous, importance: value })),
    setParentQuery: (value) => setEditor((previous) => ({ ...previous, parentQuery: value })),
    setParent: (id, title) =>
      setEditor((previous) => ({ ...previous, parentId: id, parentTitle: title, parentResults: [] })),
    clearParent: () => setEditor((previous) => ({ ...previous, parentId: '', parentTitle: '' })),
    searchParent,
    setConfirmTitle: (value) => setEditor((previous) => ({ ...previous, confirmTitle: value })),
    save: saveEditor,
    cancel: () => {
      abortEditor()
      setEditor((previous) => ({ ...previous, status: 'closed' }))
    },
    reloadConflict: () => {
      const conflict = editor.conflict
      setEditor((previous) => ({ ...previous, status: 'closed', conflict: undefined, error: undefined }))
      if (conflict !== undefined && conflict.id !== '') select(conflict.id)
    },
    copyDraft: () => {
      const draft = [editor.title, editor.content].filter((part) => part !== '').join('\n\n')
      copy('content', draft)
    },
  }

  const statusActions: StatusViewActions = {
    refresh: loadStatus,
    sync: runSync,
    reembed: runReembed,
    copyDiagnostics,
    openReceipt: (id) => {
      setView('all')
      setDetail({ status: 'idle' })
      select(id)
    },
  }

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
    abortAll()
    setDetail({ status: 'idle' })
    setCopied(undefined)
    setView(next)
  }

  const refresh = (): void => {
    abortAll()
    setDetail({ status: 'idle' })
    setCopied(undefined)
    setReloadToken((token) => token + 1)
  }

  const actions: MemoryPanelActions = {
    setView: changeView,
    refresh,
    setQuery,
    setProject,
    setTag,
    setImportance,
    loadMore: () => requestList('more'),
    select,
    toggleNode,
    loadChild,
    copy,
    closeDetail: () => {
      abortDetail()
      setDetail({ status: 'idle' })
      setCopied(undefined)
    },
    feedback,
    openEditor,
    searchAround: (query) => {
      setQuery(query)
      setView('all')
      setDetail({ status: 'idle' })
    },
    status: statusActions,
    editor: editorActions,
    dismissReceipt: () => setReceipt(undefined),
  }

  const state: MemoryPanelState = {
    view,
    session: sessionState,
    all: allState,
    tree: treeState,
    status: statusState,
    detail,
    editor,
    ...(receipt === undefined ? {} : { receipt }),
    ...(feedbackBusy === undefined ? {} : { feedbackBusy }),
    query,
    project,
    tag,
    importance,
    ...(copied === undefined ? {} : { copied }),
  }

  return <MemoryPanelView t={t} state={state} actions={actions} />
}
