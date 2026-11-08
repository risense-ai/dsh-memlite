/**
 * 记忆面板共享样式与格式化（只用 DSH 主题变量，不引入样式表/UI 框架）。
 */
import type { CSSProperties } from 'react'

export type Translate = (key: string, params?: Record<string, unknown>) => string

export const COLOR_LABEL = 'var(--dsw-alias-label-primary, #2b2a27)'
export const COLOR_SECONDARY = 'var(--dsw-alias-label-secondary, #6b675f)'
export const COLOR_TERTIARY = 'var(--dsw-alias-label-tertiary, #8a857a)'
export const COLOR_ERROR = 'var(--dsw-alias-state-error-primary, #b3261e)'
export const COLOR_WARNING = 'var(--dsw-alias-state-warning-primary, #9a6700)'
export const COLOR_BORDER = 'var(--dsw-alias-border-l3, #e5e0d6)'
export const COLOR_INPUT_BG = 'var(--dsw-alias-bg-layer-2, #ffffff)'
export const COLOR_CARD_BG = 'var(--dsw-alias-settings-card-fill, #ffffff)'
export const COLOR_SOFT_BG = 'var(--dsw-alias-bg-module-platform, #f7f5f0)'
export const COLOR_ACCENT = 'var(--dsw-alias-state-business-primary, #3e6b4f)'
export const COLOR_ACCENT_FG = 'var(--dsw-alias-label-primary-foreground, #ffffff)'

export const columnStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }
export const rowBetweenStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 6,
  minWidth: 0,
}
export const rowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
}
export const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  minWidth: 0,
  padding: '10px 12px',
  border: `.5px solid ${COLOR_BORDER}`,
  borderRadius: 10,
  background: COLOR_CARD_BG,
}
export const noticeStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  minWidth: 0,
  padding: '12px 14px',
  border: `.5px solid ${COLOR_BORDER}`,
  borderRadius: 10,
  background: COLOR_SOFT_BG,
}
export const noticeTitleStyle: CSSProperties = {
  margin: 0,
  color: COLOR_LABEL,
  fontSize: 13,
  fontWeight: 600,
  lineHeight: '20px',
  overflowWrap: 'anywhere',
}
export const hintStyle: CSSProperties = {
  margin: 0,
  color: COLOR_TERTIARY,
  fontSize: 12,
  lineHeight: '18px',
  overflowWrap: 'anywhere',
}
export const errorTextStyle: CSSProperties = { ...hintStyle, color: COLOR_ERROR }
export const sectionTitleStyle: CSSProperties = {
  margin: 0,
  color: COLOR_SECONDARY,
  fontSize: 12,
  fontWeight: 600,
  lineHeight: '18px',
}
export const inputStyle: CSSProperties = {
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
export const textareaStyle: CSSProperties = {
  ...inputStyle,
  flex: '1 1 auto',
  height: 'auto',
  minHeight: 120,
  padding: '8px 10px',
  resize: 'vertical',
  lineHeight: '19px',
}
export const selectStyle: CSSProperties = {
  ...inputStyle,
  flex: '1 1 90px',
  appearance: 'auto',
  cursor: 'pointer',
}
export const plainButtonStyle: CSSProperties = {
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
export const primaryButtonStyle: CSSProperties = {
  ...plainButtonStyle,
  border: '.5px solid transparent',
  background: COLOR_ACCENT,
  color: COLOR_ACCENT_FG,
}
export const disabledButtonStyle: CSSProperties = { ...plainButtonStyle, opacity: 0.5, cursor: 'default' }
export const linkButtonStyle: CSSProperties = {
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
export const badgeStyle: CSSProperties = {
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
export const accentBadgeStyle: CSSProperties = {
  ...badgeStyle,
  border: `.5px solid ${COLOR_ACCENT}`,
  color: COLOR_ACCENT,
}
export const errorBadgeStyle: CSSProperties = {
  ...badgeStyle,
  border: `.5px solid ${COLOR_ERROR}`,
  color: COLOR_ERROR,
}
export const warningBadgeStyle: CSSProperties = {
  ...badgeStyle,
  border: `.5px solid ${COLOR_WARNING}`,
  color: COLOR_WARNING,
}
export const badgeRowStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, minWidth: 0 }
export const itemTitleStyle: CSSProperties = {
  margin: 0,
  color: COLOR_LABEL,
  fontSize: 13,
  fontWeight: 600,
  lineHeight: '19px',
  overflowWrap: 'anywhere',
}
export const itemSummaryStyle: CSSProperties = {
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
export const listButtonStyle: CSSProperties = {
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

export function formatScore(score: number): string {
  return Number.isFinite(score) ? score.toFixed(3) : '—'
}

export function newOperationId(): string {
  const cryptoObj = typeof globalThis === 'object' ? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto : undefined
  if (typeof cryptoObj?.randomUUID === 'function') return cryptoObj.randomUUID()
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
