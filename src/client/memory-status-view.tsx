/**
 * 状态视图（M11）：库/检索/同步/Obsidian/近期回执，只显示可行动信息。
 * 不展示完整路径、remote URL、凭据或正文。
 */
import type { ReactNode } from 'react'
import type {
  MemoryStatusResponse,
  MemoryWriteKind,
  MemoryWriteReceipt,
  MemoryWriteStatus,
} from '../browser-contract'
import {
  COLOR_ERROR,
  COLOR_SECONDARY,
  badgeRowStyle,
  badgeStyle,
  cardStyle,
  columnStyle,
  errorBadgeStyle,
  errorTextStyle,
  hintStyle,
  itemTitleStyle,
  listButtonStyle,
  plainButtonStyle,
  primaryButtonStyle,
  rowBetweenStyle,
  sectionTitleStyle,
  warningBadgeStyle,
  type Translate,
} from './memory-ui'

export interface StatusErrorInfo {
  code: 'http' | 'network' | 'shape' | 'unknown'
  status?: number
}

export interface StatusViewState {
  status: 'loading' | 'ready' | 'error' | 'disabled'
  data?: MemoryStatusResponse
  error?: StatusErrorInfo
  busy?: 'sync' | 'reembed'
  result?: { ok: boolean; text: string }
  copied?: 'ok' | 'failed'
}

export interface StatusViewActions {
  refresh(): void
  sync(): void
  reembed(): void
  copyDiagnostics(): void
  openReceipt(id: string): void
}

const WRITE_KIND_KEY: Record<MemoryWriteKind, string> = {
  remember: 'editor.create',
  update: 'editor.edit',
  attach: 'editor.attach',
  forget: 'editor.forget',
}

const WRITE_STATUS_KEY: Record<MemoryWriteStatus, string> = {
  saved: 'receipt.saved',
  'saved-degraded': 'receipt.degraded',
  skipped: 'receipt.skipped',
  partial: 'receipt.degraded',
  rejected: 'receipt.rejected',
  conflict: 'receipt.conflict',
  failed: 'receipt.failed',
  unconfirmed: 'receipt.unconfirmed',
}

function receiptLabel(receipt: MemoryWriteReceipt): string {
  if (receipt.status === 'saved' || receipt.status === 'saved-degraded') {
    if (receipt.status === 'saved-degraded') return 'receipt.degraded'
    switch (receipt.kind) {
      case 'update':
        return 'receipt.updated'
      case 'attach':
        return 'receipt.attached'
      case 'forget':
        return 'receipt.forgotten'
      default:
        return 'receipt.saved'
    }
  }
  return WRITE_STATUS_KEY[receipt.status]
}

function statusColor(status: MemoryWriteStatus): string {
  if (status === 'saved' || status === 'saved-degraded') return COLOR_SECONDARY
  if (status === 'conflict') return '#9a6700'
  return COLOR_ERROR
}

function ErrorNotice(props: { t: Translate; error?: StatusErrorInfo; onRetry: () => void }): ReactNode {
  const { t, error, onRetry } = props
  const description =
    error?.code === 'network'
      ? t('state.errorNetwork')
      : error?.code === 'shape'
        ? t('state.errorMalformed')
        : error?.code === 'http'
          ? t('state.errorHttp', { status: error.status ?? '?' })
          : t('state.errorGeneric')
  return (
    <div style={cardStyle}>
      <p style={{ ...sectionTitleStyle, color: COLOR_ERROR }}>{t('state.errorTitle')}</p>
      <p style={errorTextStyle}>{description}</p>
      <div>
        <button type="button" style={plainButtonStyle} onClick={onRetry}>
          {t('retry')}
        </button>
      </div>
    </div>
  )
}

function LibraryCard(props: { t: Translate; data: MemoryStatusResponse }): ReactNode {
  const { t, data } = props
  const scopeKey =
    data.library.dataScope === 'project'
      ? 'status.scopeProject'
      : data.library.dataScope === 'user'
        ? 'status.scopeUser'
        : 'status.scopeCustom'
  return (
    <div style={cardStyle}>
      <div style={rowBetweenStyle}>
        <p style={sectionTitleStyle}>{t('status.library')}</p>
        <span style={data.library.badLines > 0 ? warningBadgeStyle : badgeStyle}>
          {data.library.badLines > 0 ? t('status.badLines', { count: data.library.badLines }) : t('header.statusAvailable')}
        </span>
      </div>
      <div style={badgeRowStyle}>
        <span style={badgeStyle}>{t('status.records', { count: data.library.records })}</span>
        <span style={badgeStyle}>{t('status.vectors', { count: data.library.vectors })}</span>
      </div>
      <p style={hintStyle}>
        {t('status.dataScope')}: {t(scopeKey)}
      </p>
    </div>
  )
}

function SearchCard(props: { t: Translate; data: MemoryStatusResponse }): ReactNode {
  const { t, data } = props
  return (
    <div style={cardStyle}>
      <p style={sectionTitleStyle}>{t('status.search')}</p>
      <div style={badgeRowStyle}>
        <span style={badgeStyle}>
          {data.search.backend === 'bm25' ? t('status.backendBm25') : t('status.backendSemantic')}
        </span>
        <span style={badgeStyle}>
          {t('status.embedding', {
            provider:
              data.search.embeddingProvider === 'none'
                ? t('status.embeddingNone')
                : data.search.embeddingProvider,
          })}
        </span>
      </div>
    </div>
  )
}

function SyncCard(props: {
  t: Translate
  data: MemoryStatusResponse
  busy?: 'sync' | 'reembed'
  result?: { ok: boolean; text: string }
  actions: StatusViewActions
}): ReactNode {
  const { t, data, busy, result, actions } = props
  const sync = data.sync
  const stateText = !sync.available
    ? t('status.syncUnavailable')
    : !sync.hasRemote
      ? t('status.syncNoRemote')
      : sync.dirty
        ? t('status.syncDirty')
        : sync.verified
          ? t('status.syncClean')
          : t('status.syncUnverified')
  return (
    <div style={cardStyle}>
      <div style={rowBetweenStyle}>
        <p style={sectionTitleStyle}>{t('status.sync')}</p>
        <span style={sync.available && sync.hasRemote && sync.dirty ? warningBadgeStyle : badgeStyle}>{stateText}</span>
      </div>
      {sync.localSha !== '' ? <p style={hintStyle}>{t('status.localSha', { sha: sync.localSha })}</p> : null}
      <div style={badgeRowStyle}>
        <button
          type="button"
          style={busy === 'sync' ? plainButtonStyle : primaryButtonStyle}
          disabled={busy !== undefined || !sync.available || !sync.hasRemote}
          onClick={actions.sync}
        >
          {busy === 'sync' ? t('status.syncing') : t('status.syncNow')}
        </button>
        <button
          type="button"
          style={plainButtonStyle}
          disabled={busy !== undefined || data.search.embeddingProvider === 'none' || data.search.embeddingProvider === 'host'}
          onClick={actions.reembed}
        >
          {busy === 'reembed' ? t('status.reembedding') : t('status.reembed')}
        </button>
      </div>
      {result !== undefined ? (
        <p style={result.ok ? hintStyle : errorTextStyle}>{result.text}</p>
      ) : null}
    </div>
  )
}

function ObsidianCard(props: { t: Translate; data: MemoryStatusResponse }): ReactNode {
  const { t, data } = props
  const obsidian = data.obsidian
  const operation = obsidian.lastOperation ?? 'status'
  const text =
    obsidian.state === 'unchecked'
      ? t('status.obsidianUnchecked')
      : obsidian.state === 'busy'
        ? t('status.obsidianBusy', { operation })
        : obsidian.state === 'ok'
          ? t('status.obsidianOk', { operation })
          : t('status.obsidianError', { operation })
  return (
    <div style={cardStyle}>
      <div style={rowBetweenStyle}>
        <p style={sectionTitleStyle}>{t('status.obsidian')}</p>
        <span style={obsidian.state === 'error' ? errorBadgeStyle : badgeStyle}>{text}</span>
      </div>
      <p style={hintStyle}>{t('header.settingsHint')}</p>
    </div>
  )
}

function ReceiptCard(props: {
  t: Translate
  receipts: MemoryWriteReceipt[]
  actions: StatusViewActions
}): ReactNode {
  const { t, receipts, actions } = props
  return (
    <div style={cardStyle}>
      <p style={sectionTitleStyle}>{t('status.receipts')}</p>
      {receipts.length === 0 ? <p style={hintStyle}>{t('status.noReceipts')}</p> : null}
      {receipts.map((receipt) => (
        <button
          key={receipt.operationId}
          type="button"
          style={listButtonStyle}
          onClick={() => {
            if (receipt.id !== '') actions.openReceipt(receipt.id)
          }}
        >
          <span style={itemTitleStyle}>{receipt.title !== '' ? receipt.title : receipt.id}</span>
          <span style={badgeRowStyle}>
            <span style={badgeStyle}>{t(WRITE_KIND_KEY[receipt.kind])}</span>
            <span style={{ ...badgeStyle, color: statusColor(receipt.status) }}>
              {t(receiptLabel(receipt))}
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}

export function MemoryStatusView(props: {
  t: Translate
  state: StatusViewState
  actions: StatusViewActions
}): ReactNode {
  const { t, state, actions } = props
  if (state.status === 'loading') return <p style={hintStyle}>{t('state.loading')}</p>
  if (state.status === 'disabled') return <p style={hintStyle}>{t('state.disabledDescription')}</p>
  if (state.status === 'error') return <ErrorNotice t={t} error={state.error} onRetry={actions.refresh} />
  const data = state.data
  if (data === undefined) return <p style={hintStyle}>{t('state.errorGeneric')}</p>
  return (
    <div style={columnStyle}>
      <div style={rowBetweenStyle}>
        <p style={sectionTitleStyle}>{t('status.title')}</p>
        <div style={badgeRowStyle}>
          <button type="button" style={plainButtonStyle} onClick={actions.refresh}>
            {t('status.refresh')}
          </button>
          <button type="button" style={plainButtonStyle} onClick={actions.copyDiagnostics}>
            {t('status.copyDiagnostics')}
          </button>
        </div>
      </div>
      {state.copied !== undefined ? (
        <p style={state.copied === 'ok' ? hintStyle : errorTextStyle}>
          {state.copied === 'ok' ? t('status.copied') : t('status.copyFailed')}
        </p>
      ) : null}
      <LibraryCard t={t} data={data} />
      <SearchCard t={t} data={data} />
      <SyncCard t={t} data={data} busy={state.busy} result={state.result} actions={actions} />
      <ObsidianCard t={t} data={data} />
      <ReceiptCard t={t} receipts={data.receipts} actions={actions} />
    </div>
  )
}
