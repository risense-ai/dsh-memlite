/**
 * 记忆浏览器公共小部件：提示、错误、徽章、时间/分数格式化。
 */
import type { ReactNode } from 'react'
import type { MemoryImportance } from '../browser-contract'
import type { MemoryErrorInfo, Translate } from './memory-view-types'
import {
  COLOR_ERROR,
  COLOR_LABEL,
  badgeStyle,
  errorTextStyle,
  hintStyle,
  noticeStyle,
  noticeTitleStyle,
  plainButtonStyle,
} from './memory-styles'

export function Notice(props: {
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

export function ErrorNotice(props: {
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

export function DisabledNotice(props: { t: Translate }): ReactNode {
  return <Notice title={props.t('state.disabledTitle')} description={props.t('state.disabledDescription')} />
}

export function LoadingNotice(props: { t: Translate }): ReactNode {
  return <p style={hintStyle}>{props.t('state.loading')}</p>
}

export function ImportanceBadge(props: { t: Translate; importance: MemoryImportance }): ReactNode {
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
