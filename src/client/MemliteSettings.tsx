/**
 * memlite 配置页（浏览器半区）。
 *
 * 注册进侧栏「插件」页的 `plugins.row.config`，键 `@rsrsai/dsh-memlite#memlite`；
 * 页面宿主在行详情里传入 `form = { state, mutate }`（settings 表单快照 + 写入队列）。
 * 表单只负责画草稿与保存控件，标题/面包屑由插件页负责。
 */
import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import {
  buildChangeSet,
  configPath,
  hasOverride,
  normalizeDraft,
  resetField,
  validateDraft,
  type ConfigFormLike,
  type ConfigFormState,
  type ConfigOp,
  type Draft,
} from './form'

export interface PageProps {
  readonly t: (key: string, params?: Record<string, unknown>) => string
  readonly view?: 'page' | 'summary'
  readonly form?: ConfigFormLike
}

const COLOR_LABEL = 'var(--dsw-alias-label-primary, #2b2a27)'
const COLOR_SECONDARY = 'var(--dsw-alias-label-secondary, #6b675f)'
const COLOR_TERTIARY = 'var(--dsw-alias-label-tertiary, #8a857a)'
const COLOR_ERROR = 'var(--dsw-alias-state-error-primary, #b3261e)'
const COLOR_BORDER = 'var(--dsw-alias-border-l3, #e5e0d6)'
const COLOR_INPUT_BG = 'var(--dsw-alias-bg-layer-2, #ffffff)'
const COLOR_CARD_BG = 'var(--dsw-alias-settings-card-fill, #ffffff)'

const pageStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 20, color: COLOR_LABEL }
const introStyle: CSSProperties = { margin: 0, color: COLOR_SECONDARY, fontSize: 13, lineHeight: '20px' }
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
const errorStyle: CSSProperties = { margin: 0, color: COLOR_ERROR, fontSize: 12, lineHeight: '18px' }
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
const inputErrorStyle: CSSProperties = { ...inputStyle, border: `.5px solid ${COLOR_ERROR}` }
const selectStyle: CSSProperties = { ...inputStyle, appearance: 'auto' }
const checkboxRowStyle: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8 }
const checkboxStyle: CSSProperties = { margin: '3px 0 0', width: 16, height: 16, flex: 'none' }
const badgeStyle: CSSProperties = {
  padding: '1px 6px',
  borderRadius: 999,
  border: `.5px solid ${COLOR_BORDER}`,
  color: COLOR_SECONDARY,
  fontSize: 11,
  lineHeight: '16px',
}
const linkButtonStyle: CSSProperties = {
  marginLeft: 'auto',
  padding: 0,
  border: 0,
  background: 'transparent',
  color: COLOR_TERTIARY,
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
}
const saveBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 12,
  paddingTop: 4,
}
const saveButtonStyle: CSSProperties = {
  height: 32,
  padding: '0 16px',
  border: 0,
  borderRadius: 8,
  background: 'var(--dsw-alias-state-business-primary, #3e6b4f)',
  color: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
  font: 'inherit',
  fontSize: 13,
  cursor: 'pointer',
}
const disabledButtonStyle: CSSProperties = { ...saveButtonStyle, opacity: 0.5, cursor: 'default' }
const plainButtonStyle: CSSProperties = {
  height: 32,
  padding: '0 12px',
  border: `.5px solid ${COLOR_BORDER}`,
  borderRadius: 8,
  background: 'transparent',
  color: COLOR_SECONDARY,
  font: 'inherit',
  fontSize: 13,
  cursor: 'pointer',
}

const BOOLEAN_FIELDS = ['enabled', 'syncAuto', 'sensitiveGate'] as const

/** 配置页的 Obsidian 路由（document-relative，与官方文件上传同一约定）。 */
const OBSIDIAN_API = 'api/memlite/obsidian'
const OBSIDIAN_STORAGE_PREFIX = 'memlite.obsidian.'

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

interface ObsidianDraft {
  vaultPath: string
  project: string
  writeId: boolean
  dryRun: boolean
  exportPath: string
  overwrite: boolean
}

function readSaved(key: string, fallback: string): string {
  try {
    return localStorage.getItem(OBSIDIAN_STORAGE_PREFIX + key) ?? fallback
  } catch {
    return fallback
  }
}

function saveSaved(key: string, value: string): void {
  try {
    localStorage.setItem(OBSIDIAN_STORAGE_PREFIX + key, value)
  } catch {
    // localStorage 不可用时忽略（仅失去记住路径的便利）
  }
}

/** 配置页入口：summary 视图给插件页一行描述，page 视图给完整表单。 */
export function MemliteConfigPage(props: PageProps): ReactNode {
  if (props.view === 'summary') return props.t('summary')
  if (props.form === undefined) return <p style={introStyle}>{props.t('unavailable')}</p>
  return <MemliteConfigForm t={props.t} form={props.form} />
}

/** 宿主 settings 表单控制器的最小面（@deepseek-ai/dsh-client-ui-settings 的 ConfigFormController）。 */
export interface ConfigFormControllerLike {
  getSnapshot(): ConfigFormState
  subscribe(listener: () => void): () => void
  mutate(ops: ConfigOp[], expectedRevision?: number): Promise<boolean>
}

export interface SettingsSectionProps {
  readonly t: PageProps['t']
  readonly form?: ConfigFormControllerLike
}

const sectionStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16, color: COLOR_LABEL }
const sectionTitleStyle: CSSProperties = { margin: 0, fontSize: 18, fontWeight: 600, lineHeight: '26px' }

/**
 * 「设置」对话框里的 Memlite 分节（`settings.section`，id=memlite）。
 *
 * 复用插件页同款配置表单：注入的是宿主 settings 表单控制器，本组件只把它
 * 桥接成 `{ state, mutate }` 并跟随快照变化重渲染。
 */
export function MemliteSettingsSection(props: SettingsSectionProps): ReactNode {
  const { t, form } = props
  const state = useSyncExternalStore(
    (onChange) => (form === undefined ? () => {} : form.subscribe(onChange)),
    () => (form === undefined ? undefined : form.getSnapshot()),
    () => (form === undefined ? undefined : form.getSnapshot()),
  )
  const adapter = useMemo<ConfigFormLike | undefined>(() => {
    if (form === undefined || state === undefined) return undefined
    return { state, mutate: (ops, revision) => form.mutate(ops, revision) }
  }, [form, state])
  return (
    <div style={sectionStyle}>
      <div>
        <h2 style={sectionTitleStyle}>{t('settings.title')}</h2>
        <p style={introStyle}>{t('settings.intro')}</p>
      </div>
      {adapter === undefined ? (
        <p style={introStyle}>{t('loading')}</p>
      ) : adapter.state.status === 'unavailable' ? (
        <p style={introStyle}>{t('unavailable')}</p>
      ) : (
        <MemliteConfigPage t={t} view="page" form={adapter} />
      )}
    </div>
  )
}

function Field(props: {
  t: PageProps['t']
  label: string
  hint?: string
  error?: string
  overridden?: boolean
  onReset?: () => void
  children: ReactNode
}): ReactNode {
  const { t, label, hint, error, overridden = false, onReset, children } = props
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={labelStyle}>{label}</span>
        {overridden ? <span style={badgeStyle}>{t('overridden')}</span> : null}
        {onReset !== undefined ? (
          <button type="button" style={linkButtonStyle} onClick={onReset}>
            {t('reset')}
          </button>
        ) : null}
      </div>
      {children}
      {hint !== undefined ? <p style={hintStyle}>{hint}</p> : null}
      {error !== undefined ? <p style={errorStyle}>{error}</p> : null}
    </div>
  )
}

function Group(props: { title: string; children: ReactNode }): ReactNode {
  return (
    <div style={groupStyle}>
      <h3 style={groupTitleStyle}>{props.title}</h3>
      {props.children}
    </div>
  )
}

function MemliteConfigForm(props: { t: PageProps['t']; form: ConfigFormLike }): ReactNode {
  const { t, form } = props
  const state = form.state
  const [draft, setDraft] = useState<Draft>(() => normalizeDraft(state.value))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error' | 'info'; text: string }>()
  const [obsidian, setObsidian] = useState<ObsidianDraft>(() => ({
    vaultPath: readSaved('vaultPath', ''),
    project: readSaved('project', ''),
    writeId: readSaved('writeId', '0') === '1',
    dryRun: readSaved('dryRun', '0') === '1',
    exportPath: readSaved('exportPath', ''),
    overwrite: false,
  }))
  const [obsidianBusy, setObsidianBusy] = useState<'status' | 'preview' | 'import' | 'export'>()
  const [obsidianResult, setObsidianResult] = useState<{ ok: boolean; text: string }>()

  // 宿主写入成功/被拒后 revision 变化：草稿跟随最新生效值。
  useEffect(() => {
    setDraft(normalizeDraft(form.state.value))
  }, [form.state.revision, form.state.status])

  const errors = useMemo(() => validateDraft(draft), [draft])
  const changeSet = useMemo(() => buildChangeSet(draft, state), [draft, state])
  const editable = state.status === 'ready' && state.writable === true

  if (state.status === 'loading') return <p style={introStyle}>{t('loading')}</p>
  if (state.status !== 'ready' || state.value === undefined) {
    return <p style={introStyle}>{t('unavailable')}</p>
  }
  if (state.writable !== true) return <p style={introStyle}>{t('readOnly')}</p>

  const edit = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }))
    setMessage(undefined)
  }

  const reset = (key: keyof Draft): void => {
    setDraft((current) => resetField(current, state, key))
    setMessage(undefined)
  }

  const errorText = (key: keyof Draft): string | undefined => {
    const error = errors[key]
    return error === undefined ? undefined : t(error.key, error.params)
  }

  const save = async (): Promise<void> => {
    if (!editable || saving) return
    const result = buildChangeSet(draft, state)
    if (Object.keys(result.errors).length > 0) {
      setMessage({ kind: 'error', text: t('invalid') })
      return
    }
    if (result.ops.length === 0) {
      setMessage({ kind: 'info', text: t('noChanges') })
      return
    }
    setSaving(true)
    setMessage(undefined)
    try {
      const accepted = await form.mutate(result.ops, state.revision)
      setMessage({ kind: accepted ? 'ok' : 'error', text: t(accepted ? 'saved' : 'saveFailed') })
    } catch {
      setMessage({ kind: 'error', text: t('saveFailed') })
    } finally {
      setSaving(false)
    }
  }

  const discard = (): void => {
    setDraft(normalizeDraft(state.value))
    setMessage(undefined)
  }

  const editObsidian = <K extends keyof ObsidianDraft>(
    key: K,
    value: ObsidianDraft[K],
    persistKey?: string,
  ): void => {
    setObsidian((current) => ({ ...current, [key]: value }))
    setObsidianResult(undefined)
    if (persistKey !== undefined) saveSaved(persistKey, typeof value === 'boolean' ? (value ? '1' : '0') : String(value))
  }

  const runObsidian = async (action: 'status' | 'preview' | 'import' | 'export'): Promise<void> => {
    if (obsidianBusy !== undefined) return
    const isImportSide = action !== 'export'
    if (isImportSide && obsidian.vaultPath.trim() === '') {
      setObsidianResult({ ok: false, text: t('obsidianNeedPath') })
      return
    }
    if (!isImportSide && obsidian.exportPath.trim() === '') {
      setObsidianResult({ ok: false, text: t('obsidianNeedPath') })
      return
    }

    const route = action === 'status' ? 'status' : action === 'export' ? 'export' : 'import'
    const body =
      route === 'status'
        ? { vaultPath: obsidian.vaultPath }
        : route === 'import'
          ? {
              vaultPath: obsidian.vaultPath,
              project: obsidian.project.trim() === '' ? undefined : obsidian.project,
              writeId: obsidian.writeId,
              dryRun: action === 'preview' ? true : obsidian.dryRun,
            }
          : { outputPath: obsidian.exportPath, overwrite: obsidian.overwrite }

    setObsidianBusy(action)
    setObsidianResult(undefined)
    try {
      const response = await fetch(`${OBSIDIAN_API}/${route}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      let payload: { ok?: boolean; text?: string; error?: string } = {}
      try {
        payload = (await response.json()) as typeof payload
      } catch {
        payload = {}
      }
      if (response.ok && payload.ok !== false && typeof payload.text === 'string') {
        setObsidianResult({ ok: true, text: payload.text })
      } else {
        setObsidianResult({
          ok: false,
          text:
            payload.error ??
            t('obsidianRequestFailed', { message: `HTTP ${response.status}` }),
        })
      }
    } catch (error) {
      setObsidianResult({
        ok: false,
        text: t('obsidianRequestFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      })
    } finally {
      setObsidianBusy(undefined)
    }
  }

  const actionDisabled = obsidianBusy !== undefined
  const obsidianButton = (
    action: 'status' | 'preview' | 'import' | 'export',
    label: string,
  ): ReactNode => (
    <button
      type="button"
      style={actionDisabled ? actionDisabledStyle : actionButtonStyle}
      disabled={actionDisabled}
      onClick={() => {
        void runObsidian(action)
      }}
    >
      {obsidianBusy === action ? t('obsidianBusy') : label}
    </button>
  )

  const obsidianCheck = (
    key: 'writeId' | 'dryRun' | 'overwrite',
    label: string,
    hint?: string,
  ): ReactNode => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
        <input
          type="checkbox"
          aria-label={label}
          style={checkboxStyle}
          checked={obsidian[key]}
          onChange={(event) => editObsidian(key, event.target.checked, key)}
        />
        <span style={{ fontSize: 12, lineHeight: '18px', color: COLOR_LABEL }}>{label}</span>
      </label>
      {hint !== undefined ? <span style={{ ...hintStyle, paddingLeft: 24 }}>{hint}</span> : null}
    </div>
  )

  const numberField = (key: keyof Draft, label: string, hint: string): ReactNode => (
    <Field
      t={t}
      label={label}
      hint={hint}
      error={errorText(key)}
      overridden={hasOverride(state, configPath(key))}
      onReset={hasOverride(state, configPath(key)) ? () => reset(key) : undefined}
    >
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        style={errors[key] !== undefined ? inputErrorStyle : inputStyle}
        value={draft[key] as string}
        onChange={(event) => edit(key, event.target.value as never)}
      />
    </Field>
  )

  const stringField = (key: keyof Draft, label: string, hint: string, placeholder = ''): ReactNode => (
    <Field
      t={t}
      label={label}
      hint={hint}
      overridden={hasOverride(state, configPath(key))}
      onReset={hasOverride(state, configPath(key)) ? () => reset(key) : undefined}
    >
      <input
        type="text"
        aria-label={label}
        style={inputStyle}
        value={draft[key] as string}
        placeholder={placeholder}
        onChange={(event) => edit(key, event.target.value as never)}
      />
    </Field>
  )

  const boolField = (key: (typeof BOOLEAN_FIELDS)[number], label: string, hint: string): ReactNode => (
    <Field
      t={t}
      label={label}
      hint={hint}
      overridden={hasOverride(state, configPath(key))}
      onReset={hasOverride(state, configPath(key)) ? () => reset(key) : undefined}
    >
      <div style={checkboxRowStyle}>
        <input
          type="checkbox"
          aria-label={label}
          style={checkboxStyle}
          checked={draft[key] as boolean}
          onChange={(event) => edit(key, event.target.checked as never)}
        />
      </div>
    </Field>
  )

  return (
    <div style={pageStyle}>
      <p style={introStyle}>{t('intro')}</p>

      <Group title={t('groupGeneral')}>
        {boolField('enabled', t('enabled'), t('enabledHint'))}
        {stringField('dataDir', t('dataDir'), t('dataDirHint'))}
      </Group>

      <Group title={t('groupRecall')}>
        {numberField('recallLimit', t('recallLimit'), t('recallLimitHint'))}
        {numberField('recallThreshold', t('recallThreshold'), t('recallThresholdHint'))}
        {numberField('budgetChars', t('budgetChars'), t('budgetCharsHint'))}
        {numberField('minPromptChars', t('minPromptChars'), t('minPromptCharsHint'))}
        {numberField('storeNudgeEvery', t('storeNudgeEvery'), t('storeNudgeEveryHint'))}
      </Group>

      <Group title={t('groupEmbedding')}>
        <Field
          t={t}
          label={t('provider')}
          hint={t('providerHint')}
          overridden={hasOverride(state, configPath('embeddingProvider'))}
          onReset={
            hasOverride(state, configPath('embeddingProvider'))
              ? () => reset('embeddingProvider')
              : undefined
          }
        >
          <select
            aria-label={t('provider')}
            style={selectStyle}
            value={draft.embeddingProvider}
            onChange={(event) => edit('embeddingProvider', event.target.value as Draft['embeddingProvider'])}
          >
            <option value="none">{t('providerNone')}</option>
            <option value="openai-compatible">{t('providerOpenai')}</option>
            <option value="host">{t('providerHost')}</option>
          </select>
        </Field>
        {stringField('embeddingApiBase', t('apiBase'), t('apiBaseHint'), 'https://api.siliconflow.cn/v1')}
        {stringField('embeddingModel', t('model'), t('modelHint'))}
        {stringField('embeddingCredentialRef', t('credentialRef'), t('credentialRefHint'))}
        {numberField('embeddingTimeoutMs', t('timeoutMs'), t('timeoutMsHint'))}
      </Group>

      <Group title={t('groupSync')}>
        {boolField('syncAuto', t('syncAuto'), t('syncAutoHint'))}
        {stringField('syncRemote', t('syncRemote'), t('syncRemoteHint'), 'git@github.com:org/memlite-data.git')}
      </Group>

      <Group title={t('groupObsidian')}>
        <p style={{ margin: 0, color: COLOR_TERTIARY, fontSize: 12, lineHeight: '18px' }}>{t('obsidianIntro')}</p>

        <Field t={t} label={t('vaultPath')} hint={t('vaultPathHint')}>
          <input
            type="text"
            aria-label={t('vaultPath')}
            style={inputStyle}
            value={obsidian.vaultPath}
            placeholder="C:\\Users\\you\\Documents\\MyVault"
            onChange={(event) => editObsidian('vaultPath', event.target.value, 'vaultPath')}
          />
        </Field>

        <Field t={t} label={t('obsidianProject')} hint={t('obsidianProjectHint')}>
          <input
            type="text"
            aria-label={t('obsidianProject')}
            style={inputStyle}
            value={obsidian.project}
            placeholder="project name"
            onChange={(event) => editObsidian('project', event.target.value, 'project')}
          />
        </Field>

        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {obsidianCheck('writeId', t('writeId'), t('writeIdHint'))}
          {obsidianCheck('dryRun', t('dryRun'), t('dryRunHint'))}
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {obsidianButton('status', t('importStatus'))}
          {obsidianButton('preview', t('previewImport'))}
          {obsidianButton('import', t('runImport'))}
        </div>

        <Field t={t} label={t('exportPath')} hint={t('exportPathHint')}>
          <input
            type="text"
            aria-label={t('exportPath')}
            style={inputStyle}
            value={obsidian.exportPath}
            placeholder="C:\\Users\\you\\Documents\\MemliteVault"
            onChange={(event) => editObsidian('exportPath', event.target.value, 'exportPath')}
          />
        </Field>

        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          {obsidianCheck('overwrite', t('overwrite'), t('overwriteHint'))}
          <div style={{ marginLeft: 'auto' }}>{obsidianButton('export', t('runExport'))}</div>
        </div>

        {obsidianResult !== undefined ? (
          <pre
            style={{
              ...resultStyle,
              color: obsidianResult.ok ? COLOR_SECONDARY : COLOR_ERROR,
              border: `.5px solid ${obsidianResult.ok ? COLOR_BORDER : COLOR_ERROR}`,
            }}
          >
            {obsidianResult.text}
          </pre>
        ) : null}
      </Group>

      <Group title={t('groupSecurity')}>
        {boolField('sensitiveGate', t('sensitiveGate'), t('sensitiveGateHint'))}
      </Group>

      <div style={saveBarStyle}>
        {message !== undefined ? (
          <span
            style={{
              marginRight: 'auto',
              fontSize: 12,
              lineHeight: '18px',
              color: message.kind === 'error' ? COLOR_ERROR : COLOR_SECONDARY,
            }}
          >
            {message.text}
          </span>
        ) : null}
        <button type="button" style={plainButtonStyle} onClick={discard} disabled={saving}>
          {t('discard')}
        </button>
        <button
          type="button"
          style={!editable || saving || changeSet.ops.length === 0 ? disabledButtonStyle : saveButtonStyle}
          onClick={() => {
            void save()
          }}
          disabled={!editable || saving || changeSet.ops.length === 0}
        >
          {saving ? t('saving') : t('save')}
        </button>
      </div>
    </div>
  )
}
