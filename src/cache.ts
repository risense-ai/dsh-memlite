/**
 * 系统提示注入缓存：off-turn recall + 每 agent 隔离 + 同步零延迟读取。
 * 双点刷新（M0 时序实测）：agent/inbox/inserted（最早，BM25 通常赶在本步 assemble 前）
 * + agent/turn-stopping（保底下一轮）。text 函数只读缓存，永不阻塞。
 */
import type { Memlite, RecallResult } from '@rsrsai/memlite'
import { renderMemories } from './render'

export interface CacheEntry {
  text: string
  /** 最近一次 recall 的 query（turn-stopping 保底刷新复用）。 */
  lastQuery: string
  ts: number
}

export interface AutoInjectConfigShape {
  enabled: boolean
  maxMemories: number
  maxChars: number
}

export class MemliteCache {
  private readonly byAgent = new Map<string, CacheEntry>()
  private readonly inflight = new Set<string>()

  constructor(
    private readonly mem: Memlite,
    private readonly config: AutoInjectConfigShape,
    private readonly warn: (msg: string) => void = () => {},
  ) {}

  /** 异步刷新一个 agent 的缓存（off-turn 调用；同 agent 并发去重）。 */
  async refresh(agentId: string, query: string, project: string): Promise<void> {
    if (!this.config.enabled) return
    const q = query.trim()
    if (q === '') return
    if (this.inflight.has(agentId)) return
    this.inflight.add(agentId)
    try {
      const r = await this.mem.recall(q, { limit: this.config.maxMemories, project })
      this.byAgent.set(agentId, {
        text: renderMemories(r, this.config.maxChars),
        lastQuery: q,
        ts: Date.now(),
      })
    } catch (e) {
      // recall 失败永不阻塞：保留旧缓存，仅告警
      this.warn(`自动注入 recall 失败（保留旧缓存）: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      this.inflight.delete(agentId)
    }
  }

  /** 同步读缓存（section text 调用，<1ms）。无条目返回空串。 */
  read(agentId: string): string {
    return this.byAgent.get(agentId)?.text ?? ''
  }

  /** turn-stopping 保底刷新：复用该 agent 最近一次 query。 */
  refreshLast(agentId: string, project: string): Promise<void> {
    const last = this.byAgent.get(agentId)?.lastQuery ?? ''
    return this.refresh(agentId, last, project)
  }

  /** turn 关闭后从记忆库取该项目最近 query 的命中数（诊断用，可测缓存是否曾填充）。 */
  peek(agentId: string): CacheEntry | undefined {
    return this.byAgent.get(agentId)
  }

  drop(agentId: string): void {
    this.byAgent.delete(agentId)
  }
}

/** 从 RecallResult 提取命中 id 数（测试辅助）。 */
export function hitIds(r: RecallResult): string[] {
  return r.hits.map((h) => h.id)
}
