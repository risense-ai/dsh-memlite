/**
 * UI 写入服务（M9b）：守卫 → 条件写 → 读回 → 统一回执。
 *
 * - 浏览器不直接读写 JSONL；每个动作都经 Memlite 主类。
 * - 编辑/改挂/忘记必须带 `expectedRevision`，由 memlite 0.2.0 的条件写在同一同步段内比较，
 *   冲突返回 `STALE_VERSION` 与当前安全投影；不静默 LWW。
 * - 回执按 operationId 幂等，最多保留 200 条内存记录（重载清空，不是永久审计）。
 * - 错误只回稳定错误码与安全文案；原始异常写宿主日志。
 */
import type { Memlite } from '@rsrsai/memlite'
import { StaleVersionError } from '@rsrsai/memlite'
import type {
  MemoryDetail,
  MemoryEmbeddedStatus,
  MemoryWriteKind,
  MemoryWriteReceipt,
  MemoryWriteResponse,
  MemoryWriteScope,
  MemoryWriteStatus,
} from './browser-contract'
import { showMemory } from './browse'

const MAX_RECEIPTS = 200
const MAX_SCOPE_ENTRIES = 50

export interface WriteServiceDeps {
  /** 每次调用取当前引擎（配置热更新重建后自动指向新实例）。 */
  getMem(): Memlite
  /** 宿主日志（真实异常只写这里）。 */
  log?(message: string): void
}

interface StoredReceipt {
  receipt: MemoryWriteReceipt
  sessionId: string
  agentId: string
  seq: number
}

/** 有界内存回执表；按 operationId 幂等、按会话/agent 过滤。 */
export class WriteReceiptStore {
  private readonly items: StoredReceipt[] = []
  private readonly byOperation = new Map<string, StoredReceipt>()
  private seq = 0

  get(operationId: string): MemoryWriteReceipt | undefined {
    return this.byOperation.get(operationId)?.receipt
  }

  put(receipt: MemoryWriteReceipt, scope: MemoryWriteScope = {}): void {
    if (this.byOperation.has(receipt.operationId)) return
    this.seq += 1
    const stored: StoredReceipt = {
      receipt,
      sessionId: (scope.sessionId ?? '').slice(0, 200),
      agentId: (scope.agentId ?? '').slice(0, 200),
      seq: this.seq,
    }
    this.items.push(stored)
    this.byOperation.set(receipt.operationId, stored)
    while (this.items.length > MAX_RECEIPTS) {
      const oldest = this.items.shift()
      if (oldest !== undefined) this.byOperation.delete(oldest.receipt.operationId)
    }
  }

  /** 按会话（优先）或 agent 过滤；无 scope 时返回全部。按时间倒序。 */
  list(scope: MemoryWriteScope = {}, limit = MAX_SCOPE_ENTRIES): MemoryWriteReceipt[] {
    const sessionId = (scope.sessionId ?? '').trim()
    const agentId = (scope.agentId ?? '').trim()
    const selected =
      sessionId === '' && agentId === ''
        ? this.items
        : this.items.filter((item) =>
            sessionId !== '' ? item.sessionId === sessionId : item.agentId === agentId,
          )
    return selected
      .slice()
      .sort((left, right) => right.seq - left.seq)
      .slice(0, Math.min(MAX_SCOPE_ENTRIES, Math.max(1, limit)))
      .map((item) => item.receipt)
  }

  clear(): void {
    this.items.length = 0
    this.byOperation.clear()
    this.seq = 0
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function clip(value: string | undefined, cap: number): string {
  return (value ?? '').slice(0, cap)
}

function embeddedStatus(mem: Memlite, id: string): MemoryEmbeddedStatus {
  const provider = mem.config.embedding?.provider ?? 'none'
  // host 档在当前 DSH（0.2.x）没有 embeddings API，插件装配的是 dim-0 占位；
  // 不把「已配置」冒充「本次已使用」。
  if (provider === 'none' || provider === 'host') return 'disabled'
  try {
    return mem.vectors.has(id) ? 'updated' : 'pending'
  } catch {
    return 'pending'
  }
}

function receiptOf(
  kind: MemoryWriteKind,
  status: MemoryWriteStatus,
  input: { operationId: string; title: string; id?: string; revision?: number; code?: string; message?: string; verified?: boolean; embedded?: MemoryEmbeddedStatus; current?: MemoryDetail },
): MemoryWriteReceipt {
  return {
    operationId: clip(input.operationId, 100),
    kind,
    status,
    id: clip(input.id, 200),
    title: clip(input.title, 200),
    verified: input.verified === true,
    embedded: input.embedded ?? 'not-applicable',
    ...(input.code !== undefined ? { code: input.code } : {}),
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(input.revision !== undefined ? { revision: input.revision } : {}),
    ...(input.current !== undefined ? { current: input.current } : {}),
    timestamp: nowSeconds(),
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isSensitive(error: unknown): boolean {
  return errorText(error).startsWith('拒绝入库')
}

/** 一次写入动作的统一执行器。 */
export class MemoryWriteService {
  constructor(
    private readonly deps: WriteServiceDeps,
    private readonly receipts: WriteReceiptStore,
  ) {}

  private mem(): Memlite {
    return this.deps.getMem()
  }

  private detail(id: string): MemoryDetail | undefined {
    try {
      return showMemory(this.mem(), id).record
    } catch {
      return undefined
    }
  }

  private failed(
    kind: MemoryWriteKind,
    input: { operationId: string; title: string; id?: string; message?: string; code?: string },
    error: unknown,
    scope: MemoryWriteScope,
  ): MemoryWriteResponse {
    const text = errorText(error)
    const sensitive = isSensitive(error)
    const notFound = text.startsWith('记忆不存在')
    const parentMissing = text.startsWith('目标因（父）不存在')
    const cycle = text.includes('防环') || text.includes('不能挂自己')
    const rejected = sensitive || notFound || parentMissing || cycle
    const code = sensitive
      ? 'SENSITIVE'
      : parentMissing
        ? 'PARENT_NOT_FOUND'
        : cycle
          ? 'CYCLE'
          : notFound
            ? 'NOT_FOUND'
            : (input.code ?? 'ENGINE')
    const message = sensitive
      ? text
      : parentMissing
        ? '前因不存在，未保存。'
        : cycle
          ? '不能挂到自身或后代之下，改挂未执行。'
          : notFound
            ? '记忆不存在或已被删除。'
            : (input.message ?? '操作未完成，请稍后重试。')
    const receipt = receiptOf(kind, rejected ? 'rejected' : 'failed', {
      ...input,
      code,
      message,
      verified: false,
    })
    this.receipts.put(receipt, scope)
    this.deps.log?.(`memlite: ${kind} 失败: ${errorText(error)}`)
    return { receipt }
  }

  async remember(
    input: {
      operationId: string
      title: string
      content: string
      tags?: string[]
      project?: string
      importance?: 'important' | 'trivial'
      parentId?: string
    },
    scope: MemoryWriteScope,
  ): Promise<MemoryWriteResponse> {
    const existing = this.receipts.get(input.operationId)
    if (existing !== undefined) return { receipt: existing }
    try {
      const mem = this.mem()
      const id = await mem.remember(input.content, {
        title: input.title,
        tags: input.tags ?? [],
        project: input.project ?? '',
        ...(input.parentId !== undefined && input.parentId !== '' ? { parent: input.parentId } : {}),
        ...(input.importance !== undefined ? { extra: { importance: input.importance } } : {}),
      })
      const record = this.detail(id)
      if (record === undefined) {
        const receipt = receiptOf('remember', 'unconfirmed', {
          operationId: input.operationId,
          title: input.title,
          id,
          code: 'READBACK_UNAVAILABLE',
          message: '已发出写入，但暂未读回；先刷新核实，不要重复写。',
        })
        this.receipts.put(receipt, scope)
        return { receipt }
      }
      const verified =
        record.id === id &&
        (input.title.trim() === '' || record.title === input.title.trim()) &&
        record.content.trim() === input.content.trim()
      const receipt = receiptOf('remember', verified ? 'saved' : 'unconfirmed', {
        operationId: input.operationId,
        title: record.title,
        id,
        revision: record.revision,
        verified,
        embedded: embeddedStatus(mem, id),
        ...(verified
          ? {}
          : { code: 'READBACK_MISMATCH', message: '写入已发出，但读回内容与草稿不一致；先核实，不要重复写。' }),
      })
      this.receipts.put(receipt, scope)
      return { receipt }
    } catch (error) {
      return this.failed('remember', { operationId: input.operationId, title: input.title }, error, scope)
    }
  }

  async update(
    input: {
      operationId: string
      id: string
      expectedRevision: number
      title?: string
      content?: string
      tags?: string[]
      importance?: '' | 'important' | 'trivial'
    },
    scope: MemoryWriteScope,
  ): Promise<MemoryWriteResponse> {
    const existing = this.receipts.get(input.operationId)
    if (existing !== undefined) return { receipt: existing }
    const before = this.detail(input.id)
    if (before === undefined) {
      const receipt = receiptOf('update', 'rejected', {
        operationId: input.operationId,
        title: '',
        id: input.id,
        code: 'NOT_FOUND',
        message: '记忆不存在或已被删除。',
      })
      this.receipts.put(receipt, scope)
      return { receipt }
    }
    if (before.revision !== input.expectedRevision) {
      const receipt = receiptOf('update', 'conflict', {
        operationId: input.operationId,
        title: before.title,
        id: before.id,
        revision: before.revision,
        code: 'STALE_VERSION',
        message: '这条记忆已在其他窗口更新；你的草稿仍保留。',
        current: before,
      })
      this.receipts.put(receipt, scope)
      return { receipt }
    }
    try {
      const mem = this.mem()
      const updated = await mem.update(
        input.id,
        {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.content !== undefined ? { content: input.content } : {}),
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
          ...(input.importance !== undefined ? { extra: { importance: input.importance } } : {}),
        },
        { expectedRevision: input.expectedRevision },
      )
      const record = this.detail(input.id)
      const verified =
        record !== undefined &&
        record.title === updated.title &&
        (input.content === undefined || record.content.trim() === input.content.trim()) &&
        (input.tags === undefined || record.tags.join('\u0000') === input.tags.join('\u0000'))
      const receipt = receiptOf('update', verified ? 'saved' : 'unconfirmed', {
        operationId: input.operationId,
        title: record?.title ?? updated.title,
        id: input.id,
        revision: updated.revision,
        verified,
        embedded: updated.embedded ? 'updated' : embeddedStatus(mem, input.id),
        ...(verified ? {} : { code: 'READBACK_MISMATCH', message: '已提交更新，但读回不一致；先刷新核实。' }),
      })
      this.receipts.put(receipt, scope)
      return { receipt }
    } catch (error) {
      if (error instanceof StaleVersionError) {
        const current = this.detail(input.id)
        const receipt = receiptOf('update', 'conflict', {
          operationId: input.operationId,
          title: current?.title ?? before.title,
          id: input.id,
          revision: current?.revision ?? error.currentRevision,
          code: 'STALE_VERSION',
          message: '这条记忆已在其他窗口更新；你的草稿仍保留。',
          ...(current !== undefined ? { current } : {}),
        })
        this.receipts.put(receipt, scope)
        return { receipt }
      }
      return this.failed('update', { operationId: input.operationId, title: before.title, id: input.id }, error, scope)
    }
  }

  attach(
    input: { operationId: string; id: string; expectedRevision: number; parentId: string },
    scope: MemoryWriteScope,
  ): MemoryWriteResponse {
    const existing = this.receipts.get(input.operationId)
    if (existing !== undefined) return { receipt: existing }
    const before = this.detail(input.id)
    if (before === undefined) {
      const receipt = receiptOf('attach', 'rejected', {
        operationId: input.operationId,
        title: '',
        id: input.id,
        code: 'NOT_FOUND',
        message: '记忆不存在或已被删除。',
      })
      this.receipts.put(receipt, scope)
      return { receipt }
    }
    if (before.revision !== input.expectedRevision) {
      const receipt = receiptOf('attach', 'conflict', {
        operationId: input.operationId,
        title: before.title,
        id: before.id,
        revision: before.revision,
        code: 'STALE_VERSION',
        message: '这条记忆已在其他窗口更新；改挂未执行。',
        current: before,
      })
      this.receipts.put(receipt, scope)
      return { receipt }
    }
    try {
      const mem = this.mem()
      const attached = mem.attach(input.id, input.parentId, { expectedRevision: input.expectedRevision })
      const record = this.detail(input.id)
      const verified = record !== undefined && record.parentId === attached.parent
      const receipt = receiptOf('attach', verified ? 'saved' : 'unconfirmed', {
        operationId: input.operationId,
        title: record?.title ?? before.title,
        id: input.id,
        revision: attached.revision,
        verified,
        embedded: 'not-applicable',
        ...(verified ? {} : { code: 'READBACK_MISMATCH', message: '已提交改挂，但读回父链不一致；先刷新核实。' }),
      })
      this.receipts.put(receipt, scope)
      return { receipt }
    } catch (error) {
      if (error instanceof StaleVersionError) {
        const current = this.detail(input.id)
        const receipt = receiptOf('attach', 'conflict', {
          operationId: input.operationId,
          title: current?.title ?? before.title,
          id: input.id,
          revision: current?.revision ?? error.currentRevision,
          code: 'STALE_VERSION',
          message: '这条记忆已在其他窗口更新；改挂未执行。',
          ...(current !== undefined ? { current } : {}),
        })
        this.receipts.put(receipt, scope)
        return { receipt }
      }
      return this.failed('attach', { operationId: input.operationId, title: before.title, id: input.id }, error, scope)
    }
  }

  forget(
    input: { operationId: string; id: string; expectedRevision: number; confirmTitle: string },
    scope: MemoryWriteScope,
  ): MemoryWriteResponse {
    const existing = this.receipts.get(input.operationId)
    if (existing !== undefined) return { receipt: existing }
    const before = this.detail(input.id)
    if (before === undefined) {
      const receipt = receiptOf('forget', 'rejected', {
        operationId: input.operationId,
        title: '',
        id: input.id,
        code: 'NOT_FOUND',
        message: '记忆不存在或已被删除。',
      })
      this.receipts.put(receipt, scope)
      return { receipt }
    }
    const expectedConfirm = before.title !== '' ? before.title : before.id
    if (expectedConfirm !== input.confirmTitle.trim()) {
      const receipt = receiptOf('forget', 'rejected', {
        operationId: input.operationId,
        title: before.title,
        id: input.id,
        revision: before.revision,
        code: 'CONFIRM_MISMATCH',
        message: '确认标题与当前标题不一致，忘记操作未执行。',
        current: before,
      })
      this.receipts.put(receipt, scope)
      return { receipt }
    }
    if (before.revision !== input.expectedRevision) {
      const receipt = receiptOf('forget', 'conflict', {
        operationId: input.operationId,
        title: before.title,
        id: before.id,
        revision: before.revision,
        code: 'STALE_VERSION',
        message: '这条记忆已在其他窗口更新；忘记操作未执行。',
        current: before,
      })
      this.receipts.put(receipt, scope)
      return { receipt }
    }
    try {
      const mem = this.mem()
      mem.forget(input.id, { expectedRevision: input.expectedRevision })
      const verified = mem.show(input.id) === undefined
      const receipt = receiptOf('forget', verified ? 'saved' : 'unconfirmed', {
        operationId: input.operationId,
        title: before.title,
        id: input.id,
        verified,
        embedded: 'not-applicable',
        ...(verified ? {} : { code: 'READBACK_MISMATCH', message: '已提交忘记，但当前仍能读到该条；先刷新核实。' }),
      })
      this.receipts.put(receipt, scope)
      return { receipt }
    } catch (error) {
      if (error instanceof StaleVersionError) {
        const current = this.detail(input.id)
        const receipt = receiptOf('forget', 'conflict', {
          operationId: input.operationId,
          title: current?.title ?? before.title,
          id: input.id,
          revision: current?.revision ?? error.currentRevision,
          code: 'STALE_VERSION',
          message: '这条记忆已在其他窗口更新；忘记操作未执行。',
          ...(current !== undefined ? { current } : {}),
        })
        this.receipts.put(receipt, scope)
        return { receipt }
      }
      return this.failed('forget', { operationId: input.operationId, title: before.title, id: input.id }, error, scope)
    }
  }
}
