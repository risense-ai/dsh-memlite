/**
 * 存入 / 编辑 / 续写 / 改挂 / 忘记的统一编辑器。
 *
 * 窄侧栏用面板内整页，宽屏仍是同一表单（宿主不提供稳定的全局 dialog API 时不伪造弹窗）。
 * 正文只以 textarea 编辑；不执行记忆中的 HTML/命令。
 */
import type { ReactNode } from 'react'
import type { MemoryWriteReceipt } from '../browser-contract'
import {
  COLOR_ERROR,
  COLOR_WARNING,
  badgeRowStyle,
  badgeStyle,
  cardStyle,
  columnStyle,
  errorTextStyle,
  hintStyle,
  inputStyle,
  itemTitleStyle,
  linkButtonStyle,
  listButtonStyle,
  plainButtonStyle,
  primaryButtonStyle,
  rowBetweenStyle,
  rowStyle,
  sectionTitleStyle,
  selectStyle,
  textareaStyle,
  warningBadgeStyle,
  type Translate,
} from './memory-ui'

export interface ParentCandidate {
  id: string
  title: string
  revision: number
}

export type EditorMode = 'create' | 'edit' | 'reply' | 'attach' | 'forget'

export interface EditorState {
  mode: EditorMode
  status: 'closed' | 'open' | 'saving'
  id?: string
  expectedRevision?: number
  title: string
  content: string
  tags: string
  project: string
  importance: 'important' | 'trivial' | ''
  parentId: string
  parentTitle: string
  parentQuery: string
  parentResults: ParentCandidate[]
  parentSearching: boolean
  confirmTitle: string
  /** 续写/改挂/忘记时展示的当前记忆标题。 */
  baseTitle?: string
  error?: string
  conflict?: MemoryWriteReceipt
}

export interface EditorActions {
  setTitle(value: string): void
  setContent(value: string): void
  setTags(value: string): void
  setProject(value: string): void
  setImportance(value: 'important' | 'trivial' | ''): void
  setParentQuery(value: string): void
  setParent(id: string, title: string): void
  clearParent(): void
  searchParent(): void
  setConfirmTitle(value: string): void
  save(): void
  cancel(): void
  reloadConflict(): void
  copyDraft(): void
}

export function emptyEditorState(overrides: Partial<EditorState> = {}): EditorState {
  return {
    mode: 'create',
    status: 'closed',
    title: '',
    content: '',
    tags: '',
    project: '',
    importance: 'important',
    parentId: '',
    parentTitle: '',
    parentQuery: '',
    parentResults: [],
    parentSearching: false,
    confirmTitle: '',
    ...overrides,
  }
}

const MODE_KEY: Record<EditorMode, string> = {
  create: 'editor.create',
  edit: 'editor.edit',
  reply: 'editor.reply',
  attach: 'editor.attach',
  forget: 'editor.forget',
}

function Field(props: { label: string; hint?: string; children: ReactNode }): ReactNode {
  return (
    <label style={columnStyle}>
      <span style={sectionTitleStyle}>{props.label}</span>
      {props.children}
      {props.hint !== undefined ? <span style={hintStyle}>{props.hint}</span> : null}
    </label>
  )
}

function ParentPicker(props: {
  t: Translate
  state: EditorState
  actions: EditorActions
}): ReactNode {
  const { t, state, actions } = props
  return (
    <div style={columnStyle}>
      <span style={sectionTitleStyle}>{t('editor.parent')}</span>
      {state.parentId !== '' ? (
        <div style={badgeRowStyle}>
          <span style={badgeStyle}>{state.parentTitle !== '' ? state.parentTitle : state.parentId}</span>
          <button type="button" style={linkButtonStyle} onClick={actions.clearParent}>
            {t('editor.clearParent')}
          </button>
        </div>
      ) : (
        <span style={hintStyle}>{t('editor.parentHint')}</span>
      )}
      <div style={rowStyle}>
        <input
          type="search"
          aria-label={t('editor.parentSearch')}
          placeholder={t('editor.parentSearch')}
          style={inputStyle}
          value={state.parentQuery}
          onChange={(event) => actions.setParentQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              actions.searchParent()
            }
          }}
        />
        <button
          type="button"
          style={state.parentSearching ? plainButtonStyle : plainButtonStyle}
          disabled={state.parentSearching}
          onClick={actions.searchParent}
        >
          {state.parentSearching ? t('editor.parentSearching') : t('editor.parentSearch')}
        </button>
      </div>
      {state.parentSearching ? <p style={hintStyle}>{t('editor.parentSearching')}</p> : null}
      {!state.parentSearching && state.parentQuery.trim() !== '' && state.parentResults.length === 0 ? (
        <p style={hintStyle}>{t('editor.parentNone')}</p>
      ) : null}
      {state.parentResults.map((candidate) => (
        <button
          key={candidate.id}
          type="button"
          style={listButtonStyle}
          onClick={() => actions.setParent(candidate.id, candidate.title)}
        >
          <span style={itemTitleStyle}>{candidate.title !== '' ? candidate.title : candidate.id}</span>
          <span style={hintStyle}>{candidate.id}</span>
        </button>
      ))}
    </div>
  )
}

export function MemoryEditor(props: {
  t: Translate
  state: EditorState
  actions: EditorActions
}): ReactNode {
  const { t, state, actions } = props
  if (state.status === 'closed') return null
  const saving = state.status === 'saving'
  const isForget = state.mode === 'forget'
  const isAttach = state.mode === 'attach'
  const showBody = !isForget && !isAttach
  const showParent = state.mode === 'create' || isAttach

  return (
    <div style={cardStyle}>
      <div style={rowBetweenStyle}>
        <p style={sectionTitleStyle}>{t(MODE_KEY[state.mode])}</p>
        <button type="button" style={linkButtonStyle} onClick={actions.cancel}>
          {t('editor.cancel')}
        </button>
      </div>

      {state.baseTitle !== undefined ? (
        <p style={itemTitleStyle}>{state.baseTitle !== '' ? state.baseTitle : state.id ?? ''}</p>
      ) : null}

      {state.conflict !== undefined ? (
        <div style={{ ...cardStyle, border: `.5px solid ${COLOR_WARNING}` }}>
          <div style={badgeRowStyle}>
            <span style={warningBadgeStyle}>{t('editor.conflictTitle')}</span>
            {state.conflict.current !== undefined ? (
              <span style={badgeStyle}>revision {state.conflict.current.revision}</span>
            ) : null}
          </div>
          <p style={hintStyle}>{t('editor.conflictHint')}</p>
          <div style={badgeRowStyle}>
            <button type="button" style={primaryButtonStyle} onClick={actions.reloadConflict}>
              {t('editor.reload')}
            </button>
            <button type="button" style={plainButtonStyle} onClick={actions.copyDraft}>
              {t('editor.copyDraft')}
            </button>
          </div>
        </div>
      ) : null}

      {state.error !== undefined ? <p style={errorTextStyle}>{state.error}</p> : null}

      {isForget ? (
        <div style={columnStyle}>
          <p style={hintStyle}>{t('editor.confirmForgetHint')}</p>
          <Field label={t('editor.confirmForget')}>
            <input
              type="text"
              style={inputStyle}
              value={state.confirmTitle}
              onChange={(event) => actions.setConfirmTitle(event.target.value)}
            />
          </Field>
        </div>
      ) : null}

      {isAttach ? (
        <div style={columnStyle}>
          <p style={hintStyle}>{t('editor.attachHint')}</p>
          <ParentPicker t={t} state={state} actions={actions} />
        </div>
      ) : null}

      {showBody ? (
        <div style={columnStyle}>
          <Field label={t('editor.title')}>
            <input
              type="text"
              style={inputStyle}
              value={state.title}
              onChange={(event) => actions.setTitle(event.target.value)}
            />
          </Field>
          <Field label={t('editor.content')}>
            <textarea
              style={textareaStyle}
              value={state.content}
              onChange={(event) => actions.setContent(event.target.value)}
            />
          </Field>
          <div style={rowStyle}>
            <Field label={t('editor.tags')}>
              <input
                type="text"
                style={inputStyle}
                value={state.tags}
                onChange={(event) => actions.setTags(event.target.value)}
              />
            </Field>
            <Field label={t('editor.importance')}>
              <select
                style={selectStyle}
                value={state.importance}
                onChange={(event) =>
                  actions.setImportance(event.target.value as 'important' | 'trivial' | '')
                }
              >
                <option value="important">{t('editor.importanceImportant')}</option>
                <option value="trivial">{t('editor.importanceTrivial')}</option>
                <option value="">{t('editor.importanceUnmarked')}</option>
              </select>
            </Field>
          </div>
          {state.mode === 'create' ? (
            <Field label={t('editor.project')}>
              <input
                type="text"
                style={inputStyle}
                value={state.project}
                onChange={(event) => actions.setProject(event.target.value)}
              />
            </Field>
          ) : null}
          {state.mode === 'reply' ? <p style={hintStyle}>{t('editor.replyHint')}</p> : null}
          {showParent ? <ParentPicker t={t} state={state} actions={actions} /> : null}
        </div>
      ) : null}

      <div style={badgeRowStyle}>
        <button
          type="button"
          style={saving ? { ...primaryButtonStyle, opacity: 0.5 } : primaryButtonStyle}
          disabled={saving}
          onClick={actions.save}
        >
          {saving
            ? t('editor.saving')
            : t(
                state.mode === 'edit'
                  ? 'editor.saveEdit'
                  : state.mode === 'attach'
                    ? 'editor.saveAttach'
                    : state.mode === 'forget'
                      ? 'editor.saveForget'
                      : 'editor.save',
              )}
        </button>
        <button type="button" style={plainButtonStyle} disabled={saving} onClick={actions.cancel}>
          {t('editor.cancel')}
        </button>
      </div>
    </div>
  )
}
