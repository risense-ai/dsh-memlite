/**
 * 会话召回账本（M8c）：记录「本轮自动召回了什么、哪些真正注入」。
 *
 * 设计约束（proposal §14.5）：
 * - 默认只存内存、按会话隔离、有界；插件/宿主重载后清空（不是审计日志）。
 * - 注入状态必须来自 `selectRecallTitles()` 的同一份阈值/预算结果，不能事后重算。
 * - 不保存原始提示词；只在失败时保留安全错误码（由调用方转成 status='error'，不存 message）。
 * - `sessionId` 取不到时退化为 agent 级并在响应里明示 `scope:'agent'`，不伪造会话关联。
 * - 全局与会话都有容量上限，超限淘汰最旧；`agent/disposed` 时清理。
 */
import type {
  MemoryRecallExclusion,
  MemoryRecallStatus,
  MemorySessionHit,
  MemorySessionRecall,
  MemorySkipReason,
} from './browser-contract'

/** 账本容量上限（可被测试覆盖）。 */
export interface RecallLedgerLimits {
  /** 单会话最多保留多少条回合记录。 */
  maxEntriesPerSession: number
  /** 全局最多保留多少条（跨会话）。 */
  maxTotalEntries: number
  /** 单条记录最多保留多少 hit。 */
  maxHitsPerEntry: number
}

export const DEFAULT_LEDGER_LIMITS: RecallLedgerLimits = {
  maxEntriesPerSession: 100,
  maxTotalEntries: 500,
  maxHitsPerEntry: 50,
}

/** 记账输入：index.ts 在 pre-step 里收集，按 message 计一条。 */
export interface RecallLedgerDraft {
  sessionId: string
  agentId: string
  turn: number
  messageId: string
  backend: string
  fallback: string
  status: MemoryRecallStatus
  skipReason?: MemorySkipReason
  hits: Array<{
    id: string
    score: number
    title: string
    injected: boolean
    exclusion?: MemoryRecallExclusion
  }>
  /** 实际注入标题块（不含原始提示词/正文；长度已在渲染时受预算约束）。 */
  injectedText?: string
  threshold?: number
  budgetChars?: number
  usedChars?: number
  limit?: number
  elapsedMs?: number
}

export interface RecallFeedbackInput {
  sessionId?: string
  agentId?: string
  turn: number
  messageId: string
  memoryId: string
  feedback: 'helpful' | 'irrelevant'
}

export interface RecallLedgerQuery {
  sessionId?: string
  agentId?: string
  limit?: number
}

export interface RecallLedgerList {
  scope: 'session' | 'agent'
  entries: MemorySessionRecall[]
  trimmed: boolean
}

const MAX_LIMIT = 100
const TITLE_CAP = 200
const ID_CAP = 200

function clip(value: unknown, cap: number): string {
  if (typeof value !== 'string') return ''
  return value.length <= cap ? value : value.slice(0, cap)
}

function bucketKey(sessionId: string, agentId: string): string {
  // sessionId 优先；拿不到稳定 sessionId 时按 agent 明示降级（键前缀区分，不混淆）。
  return sessionId !== '' ? `s:${sessionId}` : `a:${agentId}`
}

function normalizeHit(
  hit: RecallLedgerDraft['hits'][number],
  cap: number,
): MemorySessionHit {
  // 原始召回分数（BM25 可 >1；RRF 融合分通常 ≤1）——只做非负截断，与 UI 展示口径一致。
  const score = Number.isFinite(hit.score) ? Math.max(0, hit.score) : 0
  const exclusion: MemoryRecallExclusion | undefined =
    hit.exclusion === 'threshold' || hit.exclusion === 'budget' ? hit.exclusion : undefined
  return {
    id: clip(hit.id, cap),
    score,
    title: clip(hit.title, TITLE_CAP),
    injected: hit.injected === true,
    ...(exclusion !== undefined ? { exclusion } : {}),
    // 路由层再按当前库补 exists；账本只存召回时的事实。
    exists: true,
  }
}

/**
 * 内部槽位：对外时间戳是秒级（与 memlite 的 `MemRecord.ts` 同一口径），
 * 淘汰顺序另用单调序号，避免整秒粒度下大量条目并列时 LRU 失真。
 */
interface LedgerSlot {
  recall: MemorySessionRecall
  seq: number
}

/** 有界、按会话隔离的内存召回账本。 */
export class RecallLedger {
  private readonly limits: RecallLedgerLimits
  private readonly buckets = new Map<string, LedgerSlot[]>()
  private total = 0
  private seq = 0

  constructor(limits: Partial<RecallLedgerLimits> = {}) {
    this.limits = {
      maxEntriesPerSession: Math.max(1, limits.maxEntriesPerSession ?? DEFAULT_LEDGER_LIMITS.maxEntriesPerSession),
      maxTotalEntries: Math.max(1, limits.maxTotalEntries ?? DEFAULT_LEDGER_LIMITS.maxTotalEntries),
      maxHitsPerEntry: Math.max(1, limits.maxHitsPerEntry ?? DEFAULT_LEDGER_LIMITS.maxHitsPerEntry),
    }
  }

  /**
   * 记录一次 pre-step 里的一条消息（按时间顺序追加）。
   * `nowSeconds` 是**秒级**时间戳（默认当前秒）；与 `MemRecord.ts` 同口径，UI 直接乘 1000 渲染。
   */
  record(draft: RecallLedgerDraft, nowSeconds: number = Math.floor(Date.now() / 1000)): void {
    const sessionId = clip(draft.sessionId, ID_CAP)
    const agentId = clip(draft.agentId, ID_CAP)
    const key = bucketKey(sessionId, agentId)
    const entry: MemorySessionRecall = {
      agentId,
      turn: Number.isSafeInteger(draft.turn) ? Math.max(0, draft.turn) : 0,
      messageId: clip(draft.messageId, ID_CAP),
      timestamp: Number.isFinite(nowSeconds) ? Math.max(0, Math.floor(nowSeconds)) : Math.floor(Date.now() / 1000),
      backend: clip(draft.backend, 40),
      fallback: clip(draft.fallback, 40),
      status: draft.status,
      ...(draft.skipReason !== undefined ? { skipReason: draft.skipReason } : {}),
      hits: Array.isArray(draft.hits)
        ? draft.hits.slice(0, this.limits.maxHitsPerEntry).map((hit) => normalizeHit(hit, ID_CAP))
        : [],
      ...(typeof draft.injectedText === 'string' && draft.injectedText !== ''
        ? { injectedText: draft.injectedText.slice(0, 20_000) }
        : {}),
      ...(Number.isFinite(draft.threshold) ? { threshold: draft.threshold as number } : {}),
      ...(Number.isFinite(draft.budgetChars) ? { budgetChars: draft.budgetChars as number } : {}),
      ...(Number.isFinite(draft.usedChars) ? { usedChars: draft.usedChars as number } : {}),
      ...(Number.isFinite(draft.limit) ? { limit: draft.limit as number } : {}),
      ...(Number.isFinite(draft.elapsedMs) ? { elapsedMs: draft.elapsedMs as number } : {}),
    }
    // 同一 messageId 重复记账（重试/热重载后的重放）以新记录为准：先删旧。
    const bucket = this.buckets.get(key) ?? []
    if (entry.messageId !== '') {
      const existing = bucket.findIndex(
        (item) => item.recall.messageId === entry.messageId && item.recall.turn === entry.turn,
      )
      if (existing >= 0) {
        bucket.splice(existing, 1)
        this.total -= 1
      }
    }
    this.seq += 1
    bucket.push({ recall: entry, seq: this.seq })
    this.total += 1
    while (bucket.length > this.limits.maxEntriesPerSession) {
      bucket.shift()
      this.total -= 1
    }
    this.buckets.set(key, bucket)
    this.evictGlobal()
  }

  private evictGlobal(): void {
    while (this.total > this.limits.maxTotalEntries) {
      let oldestKey = ''
      let oldestIndex = -1
      let oldestSeq = Number.POSITIVE_INFINITY
      for (const [key, bucket] of this.buckets) {
        for (let index = 0; index < bucket.length; index++) {
          const seq = bucket[index]!.seq
          if (seq < oldestSeq) {
            oldestSeq = seq
            oldestKey = key
            oldestIndex = index
          }
        }
      }
      if (oldestKey === '' || oldestIndex < 0) break
      const bucket = this.buckets.get(oldestKey)!
      bucket.splice(oldestIndex, 1)
      this.total -= 1
      if (bucket.length === 0) this.buckets.delete(oldestKey)
    }
  }

  /** 读账本：sessionId 优先；否则 agent 级降级；条目按时间倒序。 */
  list(query: RecallLedgerQuery): RecallLedgerList {
    const sessionId = (query.sessionId ?? '').trim()
    const agentId = (query.agentId ?? '').trim()
    const limitRaw = query.limit
    const limit =
      typeof limitRaw === 'number' && Number.isSafeInteger(limitRaw)
        ? Math.min(MAX_LIMIT, Math.max(1, limitRaw))
        : 30
    const scope: 'session' | 'agent' = sessionId !== '' ? 'session' : 'agent'
    const key = sessionId !== '' ? `s:${sessionId}` : `a:${agentId}`
    const bucket = this.buckets.get(key) ?? []
    const entries = bucket
      .slice()
      .sort((left, right) => right.seq - left.seq)
      .map((slot) => slot.recall)
    return {
      scope,
      entries: entries.slice(0, limit),
      trimmed: entries.length > limit,
    }
  }

  /** 显式反馈：只允许账本里已有的 memory id；不接收任意正文，不自动调权。 */
  setFeedback(input: RecallFeedbackInput): boolean {
    const sessionId = clip(input.sessionId ?? '', ID_CAP)
    const agentId = clip(input.agentId ?? '', ID_CAP)
    if (sessionId === '' && agentId === '') return false
    if (!Number.isSafeInteger(input.turn) || input.turn < 0) return false
    const messageId = clip(input.messageId, ID_CAP)
    const memoryId = clip(input.memoryId, ID_CAP)
    if (messageId === '' || memoryId === '') return false
    const bucket = this.buckets.get(bucketKey(sessionId, agentId))
    if (bucket === undefined) return false
    const slot = [...bucket]
      .reverse()
      .find((item) => item.recall.turn === input.turn && item.recall.messageId === messageId)
    if (slot === undefined) return false
    if (!slot.recall.hits.some((hit) => hit.id === memoryId)) return false
    slot.recall.feedback = { ...(slot.recall.feedback ?? {}), [memoryId]: input.feedback }
    return true
  }

  /** 清理一个会话/agent 的账本（agent/disposed）。 */
  drop(query: { sessionId?: string; agentId?: string }): void {
    const keys: string[] = []
    const sessionId = (query.sessionId ?? '').trim()
    const agentId = (query.agentId ?? '').trim()
    if (sessionId !== '') keys.push(`s:${sessionId}`)
    if (agentId !== '') keys.push(`a:${agentId}`)
    for (const key of keys) {
      const bucket = this.buckets.get(key)
      if (bucket === undefined) continue
      this.total -= bucket.length
      this.buckets.delete(key)
    }
  }

  /** 清空（插件卸载/测试）。 */
  clear(): void {
    this.buckets.clear()
    this.total = 0
  }

  /** 当前全局条目数（测试/诊断用）。 */
  get size(): number {
    return this.total
  }
}
