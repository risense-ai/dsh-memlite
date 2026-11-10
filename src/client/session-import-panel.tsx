/**
 * DSH 会话历史导入面板（浏览器半区）。
 *
 * 配置页里的一个分组：把宿主 DSH 落盘的会话历史（`~/.dsh/sessions`）按需导入记忆库。
 * 视觉与交互刻意与「Obsidian 桥」分组同构：三个按钮走插件自带的精确路由，
 * 结果以等宽 pre-wrap 文本块展示，最近使用的路径与本操作的勾选项记在 localStorage。
 *
 * 重要边界：本文件**不得** import 任何 `src/session-import/` 下的运行时模块
 * （那一层会拉 Node 的 zstd 解压模块，浏览器 bundle 里不可用），路由字符串直接写在这里的字面量里。
 * 契约：`docs/session-import-contract.md` 第九、十一节。
 */
import { useState, type CSSProperties, type ReactNode } from 'react'

export interface SessionImportPanelProps {
  readonly t: (key: string, params?: Record<string, unknown>) => string
}

/** 本分组的 DOM 标记（供样式与测试定位；不影响宿主）。 */
export const SESSION_IMPORT_PANEL_MARKER = 'memlite-session-import'

/** 路由（document-relative，与 Obsidian 桥同一约定：由宿主 connection 服务挂载）。 */
const SESSION_LIST_API = 'api/memlite/session/list'
const SESSION_IMPORT_API = 'api/memlite/session/import'

/** localStorage 前缀（与配置页其它分组互不干扰）。 */
const STORAGE_PREFIX = 'memlite.sessionImport.'

const COLOR_LABEL = 'var(--dsw-alias-label-primary, #2b2a27)'
const COLOR_SECONDARY = 'var(--dsw-alias-label-secondary, #6b675f)'
const COLOR_TERTIARY = 'var(--dsw-alias-label-tertiary, #8a857a)'
const COLOR_ERROR = 'var(--dsw-alias-state-error-primary, #b3261e)'
const COLOR_BORDER = 'var(--dsw-alias-border-l3, #e5e0d6)'
const COLOR_INPUT_BG = 'var(--dsw-alias-bg-layer-2, #ffffff)'
const COLOR_CARD_BG = 'var(--dsw-alias-settings-card-fill, #ffffff)'

const groupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: '16px 18px',
  border: `.5px solid ${COLOR_BORDER}`,
  borderRadius: 12,
  background: COLOR_CARD_BG,
}
const groupTitleStyle: CSSProperties = { margin: 0, fontSize: 14, fontWeight: 600, lineHeight: '22px' }
const hintStyle: CSSProperties = { margin: 0, color: COLOR_TERTIARY, fontSize: 12, lineHeight: '18px' }
const labelStyle: CSSProperties = { fontSize: 13, fontWeight: 500, lineHeight: '20px', color: COLOR_LABEL }
const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  height: 32,
  padding: '0 10px',
  border: `.5px solid ${COLOR_BORDER}`,
  borderRadius: 8,
  background: COLOR_INPUT_BG,
  color: COLOR_LABEL,
  font: 'inherit',
  fontSize: 13,
  outline: 'none',
}
const checkboxRowStyle: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8 }
const checkboxStyle: CSSProperties = { margin: '3px 0 0', width: 16, height: 16, flex: 'none' }
const checkboxLabelStyle: CSSProperties = { fontSize: 12, lineHeight: '18px', color: COLOR_LABEL }
const checkboxHintStyle: CSSProperties = { ...hintStyle, paddingLeft: 24 }
const checkboxGridStyle: CSSProperties = { display: 'flex', gap: 20, flexWrap: 'wrap' }
const buttonRowStyle: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap' }
const actionButtonStyle: CSSProperties = {
  height: 30,
  padding: '0 12px',
  border: `.5px solid ${COLOR_BORDER}`,
  borderRadius: 8,
  background: 'transparent',
  color: COLOR_LABEL,
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
}
const actionDisabledStyle: CSSProperties = { ...actionButtonStyle, opacity: 0.5, cursor: 'default' }
const resultStyle: CSSProperties = {
  margin: 0,
  padding: '10px 12px',
  border: `.5px solid ${COLOR_BORDER}`,
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-module-platform, #f7f5f0)',
  color: COLOR_SECONDARY,
  fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
  fontSize: 12,
  lineHeight: '18px',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
}

/** 面板草稿：路径 / cwd / project 与三个抽取开关 + dry-run。 */
export interface SessionImportDraft {
  root: string
  cwd: string
  project: string
  explicit: boolean
  summary: boolean
  facts: boolean
  dryRun: boolean
}

/** 三个按钮对应的动作。 */
export type SessionImportAction = 'list' | 'preview' | 'run'

/** 默认草稿（localStorage 无记录时）：显式记忆与摘要开，用户事实与 dry-run 关。 */
export const SESSION_IMPORT_DEFAULTS: SessionImportDraft = {
  root: '',
  cwd: '',
  project: '',
  explicit: true,
  summary: true,
  facts: false,
  dryRun: false,
}

/**
 * 构造一次请求（纯函数，便于单测）：路由字面量 + 请求体。
 *
 * - `list` 只带目录/过滤字段（列出会话不导入，不发送抽取开关）；
 * - `preview` 是 `import` 的 dry-run 形态，`dryRun` 恒为 true；
 * - `run` 使用用户勾选的 `dryRun`（勾上时等同预览，但走「导入」按钮）。
 * 空字符串一律不发送，交给服务端走默认值。
 */
export function buildSessionImportRequest(
  action: SessionImportAction,
  draft: SessionImportDraft,
): { path: string; body: Record<string, unknown> } {
  const optional = (value: string): string | undefined => {
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }
  const root = optional(draft.root)
  const cwd = optional(draft.cwd)
  const project = optional(draft.project)

  if (action === 'list') {
    return { path: SESSION_LIST_API, body: { root, cwd } }
  }
  return {
    path: SESSION_IMPORT_API,
    body: {
      root,
      cwd,
      project,
      explicit: draft.explicit,
      summary: draft.summary,
      facts: draft.facts,
      dryRun: action === 'preview' ? true : draft.dryRun,
    },
  }
}

function readStored(key: string): string | undefined {
  try {
    return localStorage.getItem(STORAGE_PREFIX + key) ?? undefined
  } catch {
    // SSR / localStorage 不可用：忽略记住的路径（用默认值渲染）。
    return undefined
  }
}

function readStoredFlag(key: string, fallback: boolean): boolean {
  const raw = readStored(key)
  if (raw === '1') return true
  if (raw === '0') return false
  return fallback
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, value)
  } catch {
    // localStorage 不可用时忽略（仅失去记住输入的便利）
  }
}

function initialDraft(): SessionImportDraft {
  return {
    root: readStored('root') ?? SESSION_IMPORT_DEFAULTS.root,
    cwd: readStored('cwd') ?? SESSION_IMPORT_DEFAULTS.cwd,
    project: readStored('project') ?? SESSION_IMPORT_DEFAULTS.project,
    explicit: readStoredFlag('explicit', SESSION_IMPORT_DEFAULTS.explicit),
    summary: readStoredFlag('summary', SESSION_IMPORT_DEFAULTS.summary),
    facts: readStoredFlag('facts', SESSION_IMPORT_DEFAULTS.facts),
    dryRun: readStoredFlag('dryRun', SESSION_IMPORT_DEFAULTS.dryRun),
  }
}

function Field(props: { label: string; hint: string; children: ReactNode }): ReactNode {
  const { label, hint, children } = props
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={labelStyle}>{label}</span>
      {children}
      <p style={hintStyle}>{hint}</p>
    </div>
  )
}

/**
 * 「DSH 会话历史导入」配置分组。
 *
 * 只依赖 `t`：不读表单快照、不写配置——三个动作都是即时请求，
 * 与「Obsidian 桥」分组一致（路径记在浏览器 localStorage，不进配置/数据仓）。
 */
export function SessionImportPanel(props: SessionImportPanelProps): ReactNode {
  const { t } = props
  const [draft, setDraft] = useState<SessionImportDraft>(initialDraft)
  const [busy, setBusy] = useState<SessionImportAction>()
  const [result, setResult] = useState<{ ok: boolean; text: string }>()

  const edit = <K extends keyof SessionImportDraft>(key: K, value: SessionImportDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }))
    setResult(undefined)
    writeStored(key, typeof value === 'boolean' ? (value ? '1' : '0') : value)
  }

  const run = async (action: SessionImportAction): Promise<void> => {
    if (busy !== undefined) return
    const request = buildSessionImportRequest(action, draft)
    setBusy(action)
    setResult(undefined)
    try {
      const response = await fetch(request.path, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.body),
      })
      let payload: { ok?: boolean; text?: string; error?: string } = {}
      try {
        payload = (await response.json()) as typeof payload
      } catch {
        payload = {}
      }
      if (response.ok && payload.ok !== false && typeof payload.text === 'string') {
        setResult({ ok: true, text: payload.text })
      } else {
        setResult({
          ok: false,
          text:
            payload.error ??
            t('sessionRequestFailed', { message: `HTTP ${response.status}` }),
        })
      }
    } catch (error) {
      setResult({
        ok: false,
        text: t('sessionRequestFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      })
    } finally {
      setBusy(undefined)
    }
  }

  const textField = (
    key: 'root' | 'cwd' | 'project',
    label: string,
    hint: string,
    placeholder: string,
  ): ReactNode => (
    <Field label={label} hint={hint}>
      <input
        type="text"
        aria-label={label}
        style={inputStyle}
        value={draft[key]}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => edit(key, event.target.value)}
      />
    </Field>
  )

  const checkField = (
    key: 'explicit' | 'summary' | 'facts' | 'dryRun',
    label: string,
    hint: string,
  ): ReactNode => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ ...checkboxRowStyle, cursor: 'pointer' }}>
        <input
          type="checkbox"
          aria-label={label}
          style={checkboxStyle}
          checked={draft[key]}
          onChange={(event) => edit(key, event.target.checked)}
        />
        <span style={checkboxLabelStyle}>{label}</span>
      </label>
      <span style={checkboxHintStyle}>{hint}</span>
    </div>
  )

  const actionButton = (action: SessionImportAction, label: string): ReactNode => (
    <button
      type="button"
      style={busy !== undefined ? actionDisabledStyle : actionButtonStyle}
      disabled={busy !== undefined}
      onClick={() => {
        void run(action)
      }}
    >
      {busy === action ? t('sessionBusy') : label}
    </button>
  )

  return (
    <div style={groupStyle} data-memlite-panel={SESSION_IMPORT_PANEL_MARKER}>
      <h3 style={groupTitleStyle}>{t('groupSessionImport')}</h3>
      <p style={{ margin: 0, color: COLOR_TERTIARY, fontSize: 12, lineHeight: '18px' }}>
        {t('sessionImportIntro')}
      </p>

      {textField('root', t('sessionRoot'), t('sessionRootHint'), '~/.dsh/sessions')}
      {textField('cwd', t('sessionCwd'), t('sessionCwdHint'), '/Users/you/projects/example')}
      {textField('project', t('sessionProject'), t('sessionProjectHint'), 'project name')}

      <div style={checkboxGridStyle}>
        {checkField('explicit', t('sessionExplicit'), t('sessionExplicitHint'))}
        {checkField('summary', t('sessionSummary'), t('sessionSummaryHint'))}
        {checkField('facts', t('sessionFacts'), t('sessionFactsHint'))}
        {checkField('dryRun', t('sessionDryRun'), t('sessionDryRunHint'))}
      </div>

      <div style={buttonRowStyle}>
        {actionButton('list', t('sessionList'))}
        {actionButton('preview', t('sessionPreview'))}
        {actionButton('run', t('sessionRun'))}
      </div>

      {result !== undefined ? (
        <pre
          style={{
            ...resultStyle,
            color: result.ok ? COLOR_SECONDARY : COLOR_ERROR,
            border: `.5px solid ${result.ok ? COLOR_BORDER : COLOR_ERROR}`,
          }}
        >
          {result.text}
        </pre>
      ) : null}
    </div>
  )
}
