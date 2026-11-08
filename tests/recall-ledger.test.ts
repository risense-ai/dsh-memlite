/**
 * M8c 召回账本纯单元测试 + selectRecallTitles 判定测试。
 *
 * 账本是内存有界的会话历史：容量、LRU 淘汰、会话隔离、agent 级降级、
 * 以及「注入状态与渲染同源」的判定（threshold/budget exclusion）。
 */
import { describe, expect, it } from 'vitest'
import type { RecallResult } from '@rsrsai/memlite'
import { RecallLedger, type RecallLedgerDraft } from '../src/recall-ledger'
import { selectRecallTitles } from '../src/render'

function hit(id: string, score: number, title = `标题-${id}`) {
  return {
    id,
    score,
    title,
    content: `${title} 的正文`,
    ts: 1_700_000_000,
    tags: [],
    project: '',
    ancestors: [],
    children: [],
  }
}

function result(hits: ReturnType<typeof hit>[], extra: Partial<RecallResult> = {}): RecallResult {
  return { backend: 'bm25', fallback: '', ms: 1, hits, ...extra }
}

describe('selectRecallTitles（阈值/预算与账本同源）', () => {
  it('低于 threshold 的候选标记 exclusion=threshold，不注入', () => {
    const selection = selectRecallTitles(result([hit('a', 0.9), hit('b', 0.2)]), 0.5, 1500)
    expect(selection.text).toContain('标题-a')
    expect(selection.text).not.toContain('标题-b')
    expect(selection.hits).toEqual([
      { id: 'a', score: 0.9, title: '标题-a', injected: true },
      { id: 'b', score: 0.2, title: '标题-b', injected: false, exclusion: 'threshold' },
    ])
  })

  it('预算截断后的候选标记 exclusion=budget；第一条无论多长都保留', () => {
    const long = 'x'.repeat(400)
    const selection = selectRecallTitles(result([hit('a', 1, long), hit('b', 1, '第二个')]), 0, 300)
    expect(selection.text).toContain(long)
    expect(selection.text).not.toContain('第二个')
    expect(selection.hits[0]?.injected).toBe(true)
    expect(selection.hits[1]).toEqual({
      id: 'b',
      score: 1,
      title: '第二个',
      injected: false,
      exclusion: 'budget',
    })
  })

  it('零命中/全部低于阈值 → 空串（不占 prompt）', () => {
    expect(selectRecallTitles(result([]), 0, 1500).text).toBe('')
    expect(selectRecallTitles(result([hit('a', 0.1)]), 0.5, 1500).text).toBe('')
    expect(selectRecallTitles(result([hit('a', 0.1)]), 0.5, 1500).hits).toHaveLength(1)
  })
})

function draft(partial: Partial<RecallLedgerDraft> = {}): RecallLedgerDraft {
  return {
    sessionId: 's1',
    agentId: 'a1',
    turn: 1,
    messageId: 'm1',
    backend: 'bm25',
    fallback: '',
    status: 'ok',
    hits: [{ id: 'mem-1', score: 0.8, title: '记忆一', injected: true }],
    ...partial,
  }
}

describe('RecallLedger', () => {
  it('按会话隔离，sessionId 优先，条目时间倒序', () => {
    const ledger = new RecallLedger()
    ledger.record(draft({ sessionId: 's1', turn: 1, messageId: 'm1' }), 1000)
    ledger.record(draft({ sessionId: 's1', turn: 2, messageId: 'm2' }), 2000)
    ledger.record(draft({ sessionId: 's2', turn: 1, messageId: 'm3' }), 3000)

    const s1 = ledger.list({ sessionId: 's1' })
    expect(s1.scope).toBe('session')
    expect(s1.entries.map((entry) => entry.messageId)).toEqual(['m2', 'm1'])
    expect(s1.entries[0]?.timestamp).toBe(2000)
    expect(ledger.list({ sessionId: 's2' }).entries).toHaveLength(1)
    expect(ledger.list({ sessionId: 'nope' }).entries).toEqual([])
  })

  it('拿不到稳定 sessionId 时按 agent 降级并返回 scope=agent', () => {
    const ledger = new RecallLedger()
    ledger.record(draft({ sessionId: '', agentId: 'agent-1', messageId: 'm1' }), 1)
    const listed = ledger.list({ agentId: 'agent-1' })
    expect(listed.scope).toBe('agent')
    expect(listed.entries).toHaveLength(1)
    // sessionId 存在时不会串到同名 agent 桶
    expect(ledger.list({ sessionId: 'agent-1' }).entries).toEqual([])
  })

  it('limit 截断并置 trimmed，条目上限内取最新', () => {
    const ledger = new RecallLedger()
    for (let index = 0; index < 5; index++) {
      ledger.record(draft({ messageId: `m${index}` }), 1000 + index)
    }
    const limited = ledger.list({ sessionId: 's1', limit: 2 })
    expect(limited.entries.map((entry) => entry.messageId)).toEqual(['m4', 'm3'])
    expect(limited.trimmed).toBe(true)
    const all = ledger.list({ sessionId: 's1', limit: 100 })
    expect(all.trimmed).toBe(false)
  })

  it('单会话容量上限淘汰最旧，全局容量上限跨会话淘汰', () => {
    const ledger = new RecallLedger({ maxEntriesPerSession: 2, maxTotalEntries: 3, maxHitsPerEntry: 2 })
    ledger.record(draft({ sessionId: 's1', messageId: 'm1' }), 1000)
    ledger.record(draft({ sessionId: 's1', messageId: 'm2' }), 2000)
    ledger.record(draft({ sessionId: 's1', messageId: 'm3' }), 3000)
    expect(ledger.list({ sessionId: 's1', limit: 10 }).entries.map((entry) => entry.messageId)).toEqual(['m3', 'm2'])

    ledger.record(draft({ sessionId: 's2', messageId: 'm4' }), 4000)
    ledger.record(draft({ sessionId: 's2', messageId: 'm5' }), 5000)
    expect(ledger.size).toBe(3)
    // 全局淘汰最旧：s1/m2 被挤掉
    expect(ledger.list({ sessionId: 's1', limit: 10 }).entries.map((entry) => entry.messageId)).toEqual(['m3'])
    expect(ledger.list({ sessionId: 's2', limit: 10 }).entries.map((entry) => entry.messageId)).toEqual(['m5', 'm4'])
  })

  it('hits 有上限且字段收敛（分数 clamp、标题截断）', () => {
    const ledger = new RecallLedger({ maxHitsPerEntry: 2 })
    ledger.record(
      draft({
        hits: [
          { id: 'a', score: 2, title: 'A', injected: true },
          { id: 'b', score: -1, title: 'B'.repeat(500), injected: false, exclusion: 'threshold' },
          { id: 'c', score: 0.5, title: 'C', injected: true },
        ],
      }),
      1000,
    )
    const entry = ledger.list({ sessionId: 's1' }).entries[0]!
    expect(entry.hits).toHaveLength(2)
    // 原始分数保留（BM25 可 >1），只截掉负数
    expect(entry.hits[0]?.score).toBe(2)
    expect(entry.hits[1]?.score).toBe(0)
    expect(entry.hits[1]?.title.length).toBeLessThanOrEqual(200)
    expect(entry.hits[1]?.exclusion).toBe('threshold')
  })

  it('同一 turn/messageId 重放以新记录为准（热重载不重复记账）', () => {
    const ledger = new RecallLedger()
    ledger.record(draft({ messageId: 'm1', status: 'error' }), 1000)
    ledger.record(draft({ messageId: 'm1', status: 'ok' }), 2000)
    const entries = ledger.list({ sessionId: 's1' }).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]?.status).toBe('ok')
    expect(ledger.size).toBe(1)
  })

  it('drop 清理指定会话/agent，clear 清空', () => {
    const ledger = new RecallLedger()
    ledger.record(draft({ sessionId: 's1', agentId: 'a1' }), 1000)
    ledger.record(draft({ sessionId: 's2', agentId: 'a2' }), 2000)
    ledger.drop({ sessionId: 's1', agentId: 'a1' })
    expect(ledger.list({ sessionId: 's1' }).entries).toEqual([])
    expect(ledger.list({ sessionId: 's2' }).entries).toHaveLength(1)
    expect(ledger.size).toBe(1)
    ledger.clear()
    expect(ledger.size).toBe(0)
  })

  it('skipped/error 记录不带 hits，与 ok 可区分', () => {
    const ledger = new RecallLedger()
    ledger.record(draft({ messageId: 'm1', status: 'skipped', skipReason: 'nomem', hits: [] }), 1000)
    ledger.record(draft({ messageId: 'm2', status: 'error', hits: [] }), 2000)
    const entries = ledger.list({ sessionId: 's1' }).entries
    expect(entries[0]?.status).toBe('error')
    expect(entries[1]?.status).toBe('skipped')
    expect(entries[1]?.skipReason).toBe('nomem')
    expect(entries[0]?.hits).toEqual([])
  })
})
