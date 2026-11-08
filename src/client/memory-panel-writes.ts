/**
 * 记忆面板写入层：存入/编辑/续写/改挂/忘记编辑器、统一回执、同步/回填动作。
 *
 * 浏览数据与状态在 memory-panel-data.ts；本 hook 不直接读库，只经 MemoryApi。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import type { MemoryShowResponse, MemoryWriteReceipt } from '../browser-contract'
import {
  MemoryApiError,
  isAbortError,
  type MemoryApi,
} from './memory-api'
import { emptyEditorState, type EditorActions, type EditorState } from './memory-editor'
import type { StatusViewActions, StatusViewState } from './memory-status-view'
import { newOperationId } from './memory-ui'
import type { DetailViewState, MemoryView, Translate } from './memory-view-types'

export interface MemoryPanelWriteOptions {
  api: MemoryApi
  sessionId?: string
  t: Translate
  detail: DetailViewState
  statusState: StatusViewState
  setStatusState: Dispatch<SetStateAction<StatusViewState>>
  select(id: string): void
  closeDetail(): void
  bumpReload(): void
  loadStatus(): void
  changeView(view: MemoryView): void
  copy(kind: 'content' | 'id', text: string): void
  isAlive(): boolean
}

export interface MemoryPanelWrites {
  editor: EditorState
  receipt?: MemoryWriteReceipt
  openEditor(mode: EditorState['mode'], record?: MemoryShowResponse['record']): void
  editorActions: EditorActions
  statusActions: StatusViewActions
  abortEditor(): void
  resetWrites(): void
  dismissReceipt(): void
}

export function useMemoryPanelWrites(options: MemoryPanelWriteOptions): MemoryPanelWrites {
  const {
    api,
    sessionId,
    t,
    detail,
    statusState,
    setStatusState,
    select,
    closeDetail,
    bumpReload,
    loadStatus,
    changeView,
    copy,
    isAlive,
  } = options

  const [editor, setEditor] = useState<EditorState>(() => emptyEditorState())
  const [receipt, setReceipt] = useState<MemoryWriteReceipt>()

  const editorSearchRef = useRef<AbortController | undefined>(undefined)
  const saveRef = useRef<AbortController | undefined>(undefined)

  const abortEditor = useCallback(() => {
    editorSearchRef.current?.abort()
    editorSearchRef.current = undefined
    saveRef.current?.abort()
    saveRef.current = undefined
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
        if (controller.signal.aborted || !isAlive()) return
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
        if (controller.signal.aborted || isAbortError(error) || !isAlive()) return
        setEditor((previous) => ({ ...previous, parentSearching: false, parentResults: [] }))
      })
  }, [api, editor.parentQuery, editor.id, isAlive])

  const runSync = useCallback(() => {
    setStatusState((previous) => ({ ...previous, busy: 'sync', result: undefined }))
    void api
      .sync({ operationId: newOperationId() })
      .then((result) => {
        if (!isAlive()) return
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
        if (!isAlive()) return
        setStatusState((previous) => ({
          ...previous,
          busy: undefined,
          result: {
            ok: false,
            text: error instanceof Error ? error.message : t('state.errorGeneric'),
          },
        }))
      })
  }, [api, isAlive, loadStatus, t])

  const runReembed = useCallback(() => {
    setStatusState((previous) => ({ ...previous, busy: 'reembed', result: undefined }))
    void api
      .reembed({ operationId: newOperationId() })
      .then((result) => {
        if (!isAlive()) return
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
        if (!isAlive()) return
        setStatusState((previous) => ({
          ...previous,
          busy: undefined,
          result: {
            ok: false,
            text: error instanceof Error ? error.message : t('state.errorGeneric'),
          },
        }))
      })
  }, [api, isAlive, loadStatus, t])

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
        if (!isAlive()) return
        setReceipt(result)
        if (result.status === 'saved' || result.status === 'saved-degraded') {
          setEditor((previous) => ({ ...previous, status: 'closed' }))
          bumpReload()
          if (mode === 'forget') {
            closeDetail()
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
        if (!isAlive() || isAbortError(error)) return
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
  }, [api, bumpReload, closeDetail, editor, isAlive, loadStatus, select, sessionId, t])

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
      changeView('all')
      select(id)
    },
  }

  useEffect(() => () => abortEditor(), [abortEditor])

  const resetWrites = useCallback(() => {
    abortEditor()
    setEditor(emptyEditorState())
    setReceipt(undefined)
  }, [abortEditor])

  const dismissReceipt = useCallback(() => {
    setReceipt(undefined)
  }, [])

  return {
    editor,
    ...(receipt === undefined ? {} : { receipt }),
    openEditor,
    editorActions,
    statusActions,
    abortEditor,
    resetWrites,
    dismissReceipt,
  }
}
