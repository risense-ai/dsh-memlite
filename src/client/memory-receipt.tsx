/**
 * 统一写入回执条：就地展示写操作结果，冲突/失败保留草稿入口。
 */
import type { ReactNode } from 'react'
import type { MemoryWriteReceipt } from '../browser-contract'
import {
  COLOR_ERROR,
  COLOR_LABEL,
  COLOR_SECONDARY,
  COLOR_WARNING,
  badgeRowStyle,
  badgeStyle,
  cardStyle,
  errorBadgeStyle,
  hintStyle,
  linkButtonStyle,
  plainButtonStyle,
  primaryButtonStyle,
  warningBadgeStyle,
  type Translate,
} from './memory-ui'

const STATUS_KEY: Record<MemoryWriteReceipt['status'], string> = {
  saved: 'receipt.saved',
  'saved-degraded': 'receipt.degraded',
  skipped: 'receipt.skipped',
  partial: 'receipt.degraded',
  rejected: 'receipt.rejected',
  conflict: 'receipt.conflict',
  failed: 'receipt.failed',
  unconfirmed: 'receipt.unconfirmed',
}

function isSuccess(receipt: MemoryWriteReceipt): boolean {
  return receipt.status === 'saved' || receipt.status === 'saved-degraded'
}

function successKey(receipt: MemoryWriteReceipt): string {
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

function statusColor(receipt: MemoryWriteReceipt): string {
  if (isSuccess(receipt)) return COLOR_LABEL
  if (receipt.status === 'conflict') return COLOR_WARNING
  return COLOR_ERROR
}

export function ReceiptBanner(props: {
  t: Translate
  receipt: MemoryWriteReceipt
  onView?: () => void
  onContinue?: () => void
  onDismiss: () => void
}): ReactNode {
  const { t, receipt, onView, onContinue, onDismiss } = props
  const success = isSuccess(receipt)
  const canView = onView !== undefined && receipt.id !== '' && receipt.kind !== 'forget'
  return (
    <div style={success ? cardStyle : { ...cardStyle, border: `.5px solid ${statusColor(receipt)}` }}>
      <div style={badgeRowStyle}>
        <span
          style={
            success
              ? { ...badgeStyle, color: COLOR_LABEL }
              : receipt.status === 'conflict'
                ? warningBadgeStyle
                : errorBadgeStyle
          }
        >
          {isSuccess(receipt) ? t(successKey(receipt)) : t(STATUS_KEY[receipt.status])}
        </span>
        {receipt.embedded !== 'not-applicable' ? (
          <span style={badgeStyle}>
            {t(
              receipt.embedded === 'updated'
                ? 'receipt.embeddedUpdated'
                : receipt.embedded === 'disabled'
                  ? 'receipt.embeddedDisabled'
                  : receipt.embedded === 'failed'
                    ? 'receipt.embeddedFailed'
                    : 'receipt.embeddedPending',
            )}
          </span>
        ) : null}
      </div>
      <p style={{ ...hintStyle, color: statusColor(receipt) }}>
        {receipt.title !== '' ? receipt.title : receipt.id}
      </p>
      {receipt.message !== undefined ? (
        <p style={{ ...hintStyle, color: COLOR_SECONDARY }}>{receipt.message}</p>
      ) : null}
      {receipt.status === 'unconfirmed' ? <p style={hintStyle}>{t('receipt.unconfirmedHint')}</p> : null}
      <div style={badgeRowStyle}>
        {canView ? (
          <button type="button" style={plainButtonStyle} onClick={onView}>
            {t('receipt.view')}
          </button>
        ) : null}
        {!success && onContinue !== undefined ? (
          <button type="button" style={primaryButtonStyle} onClick={onContinue}>
            {t('receipt.continue')}
          </button>
        ) : null}
        <button type="button" style={linkButtonStyle} onClick={onDismiss}>
          {t('receipt.close')}
        </button>
      </div>
    </div>
  )
}
