/**
 * 记忆浏览器视图样式（只使用 DSH 主题变量，无独立样式表）。
 * 从 MemliteMemory.tsx 拆出，供各视图按需引用。
 */
import type { CSSProperties } from 'react'

export const COLOR_LABEL = 'var(--dsw-alias-label-primary, #2b2a27)'
export const COLOR_SECONDARY = 'var(--dsw-alias-label-secondary, #6b675f)'
export const COLOR_TERTIARY = 'var(--dsw-alias-label-tertiary, #8a857a)'
export const COLOR_ERROR = 'var(--dsw-alias-state-error-primary, #b3261e)'
export const COLOR_BORDER = 'var(--dsw-alias-border-l3, #e5e0d6)'
export const COLOR_INPUT_BG = 'var(--dsw-alias-bg-layer-2, #ffffff)'
export const COLOR_CARD_BG = 'var(--dsw-alias-settings-card-fill, #ffffff)'
export const COLOR_SOFT_BG = 'var(--dsw-alias-bg-module-platform, #f7f5f0)'
export const COLOR_ACCENT = 'var(--dsw-alias-state-business-primary, #3e6b4f)'
export const COLOR_ACCENT_FG = 'var(--dsw-alias-label-primary-foreground, #ffffff)'

export const panelStyle: CSSProperties = {
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
export const headerStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
  paddingBottom: 8,
  borderBottom: `.5px solid ${COLOR_BORDER}`,
}
export const viewTabsStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4, minWidth: 0 }
export const tabStyle: CSSProperties = {
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
export const tabActiveStyle: CSSProperties = {
  ...tabStyle,
  border: '.5px solid transparent',
  background: COLOR_ACCENT,
  color: COLOR_ACCENT_FG,
}
export const headerMetaStyle: CSSProperties = {
  marginLeft: 'auto',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
}
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
export const disabledButtonStyle: CSSProperties = { ...plainButtonStyle, opacity: 0.5, cursor: 'default' }
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
export const selectStyle: CSSProperties = {
  ...inputStyle,
  flex: '1 1 80px',
  appearance: 'auto',
  cursor: 'pointer',
}
export const filterRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
}
export const filterLabelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  flex: '1 1 140px',
  minWidth: 0,
  color: COLOR_TERTIARY,
  fontSize: 12,
}
export const hintStyle: CSSProperties = {
  margin: 0,
  color: COLOR_TERTIARY,
  fontSize: 12,
  lineHeight: '18px',
  overflowWrap: 'anywhere',
}
export const errorTextStyle: CSSProperties = { ...hintStyle, color: COLOR_ERROR }
export const columnStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }
export const rowBetweenStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
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
export const sectionTitleStyle: CSSProperties = {
  margin: 0,
  color: COLOR_SECONDARY,
  fontSize: 12,
  fontWeight: 600,
  lineHeight: '18px',
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
export const injectedBadgeStyle: CSSProperties = {
  ...badgeStyle,
  border: `.5px solid ${COLOR_ACCENT}`,
  color: COLOR_ACCENT,
}
export const errorBadgeStyle: CSSProperties = {
  ...badgeStyle,
  border: `.5px solid ${COLOR_ERROR}`,
  color: COLOR_ERROR,
}
export const badgeRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 4,
  minWidth: 0,
}
export const wideRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-start',
  gap: 10,
  minWidth: 0,
}
export const listColumnStyle: CSSProperties = { flex: '1 1 280px', minWidth: 0, maxWidth: '100%' }
export const detailColumnStyle: CSSProperties = { flex: '2 1 360px', minWidth: 0, maxWidth: '100%' }
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
export const detailCardStyle: CSSProperties = {
  ...cardStyle,
  background: COLOR_CARD_BG,
}
export const contentStyle: CSSProperties = {
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
export const metaRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  minWidth: 0,
  fontSize: 12,
  lineHeight: '18px',
}
export const metaLabelStyle: CSSProperties = { color: COLOR_TERTIARY, flex: 'none' }
export const metaValueStyle: CSSProperties = { color: COLOR_SECONDARY, minWidth: 0, overflowWrap: 'anywhere' }
export const treeListStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
}
export const treeItemStyle: CSSProperties = { minWidth: 0 }
export const treeRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  minWidth: 0,
  maxWidth: '100%',
  padding: '2px 0',
}
export const treeToggleStyle: CSSProperties = {
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
export const treeTogglePlaceholderStyle: CSSProperties = {
  ...treeToggleStyle,
  color: COLOR_TERTIARY,
  cursor: 'default',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
}
export const treeNodeButtonStyle: CSSProperties = {
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
export const treeNodeTitleStyle: CSSProperties = {
  display: 'inline-block',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  verticalAlign: 'bottom',
}
export const treeMetaStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  flex: 'none',
  minWidth: 0,
  maxWidth: '50%',
  color: COLOR_TERTIARY,
  fontSize: 11,
}
export const chainRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 4,
  minWidth: 0,
}
export const chainLinkStyle: CSSProperties = {
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
export const neighborButtonStyle: CSSProperties = {
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
