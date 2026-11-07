/** args/render/rules 纯单元测试。 */
import { describe, expect, it } from 'vitest'
import { flagBool, flagNumber, flagString, parseArgs } from '../src/args'
import { renderRecallTitles, renderRecallTool } from '../src/render'
import { SKIP_PREFIX, STORE_PREFIX, titleOf } from '../src/rules'
import { messageText } from '../src/types'
import type { RecallResult, RecallHit } from '@rsrsai/memlite'

describe('parseArgs', () => {
  it('位置参数保留原文', () => {
    expect(parseArgs('nginx 504 怎么排查').rest).toBe('nginx 504 怎么排查')
  })
  it('--flag value / --flag=value / 布尔', () => {
    const p = parseArgs('查询 --limit 5 --bm25 --project goldscale --title=甲')
    expect(p.rest).toBe('查询')
    expect(p.flags['limit']).toBe('5')
    expect(p.flags['bm25']).toBe(true)
    expect(p.flags['project']).toBe('goldscale')
    expect(p.flags['title']).toBe('甲')
    expect(flagNumber(p.flags, 'limit')).toBe(5)
    expect(flagBool(p.flags, 'bm25')).toBe(true)
    expect(flagString(p.flags, 'project')).toBe('goldscale')
    expect(flagNumber(p.flags, 'nope')).toBeUndefined()
  })
  it('空输入', () => {
    expect(parseArgs('  ').rest).toBe('')
  })
})

const base: RecallResult = { backend: 'bm25', fallback: '', ms: 3, hits: [] }

function hit(over: Partial<RecallHit> = {}): RecallHit {
  return {
    score: 0.8,
    id: 'abcdefgh1234',
    ts: 1,
    title: 'nginx题',
    content: '正文细节',
    tags: [],
    project: '',
    ancestors: [],
    children: [],
    ...over,
  }
}

describe('renderRecallTitles（自动注入标题档）', () => {
  it('无命中 → 空串（不占 prompt）', () => {
    expect(renderRecallTitles(base, 0, 1500)).toBe('')
  })

  it('有命中 → 标题 + 分数 + id8 + 读正文指引', () => {
    const text = renderRecallTitles({ ...base, hits: [hit()] }, 0, 1500)
    expect(text).toContain('自动召回')
    expect(text).toContain('[0.80] nginx题（abcdefgh）')
    expect(text).toContain('memlite_show')
  })

  it('低于阈值不注入', () => {
    expect(renderRecallTitles({ ...base, hits: [hit({ score: 0.2 })] }, 0.5, 1500)).toBe('')
  })

  it('budgetChars 截断', () => {
    const hits = Array.from({ length: 30 }, (_, i) =>
      hit({ id: String(i).padStart(12, '0'), title: `第${i}条比较长的标题` }),
    )
    const text = renderRecallTitles({ ...base, hits }, 0, 300)
    expect(text.length).toBeLessThanOrEqual(300)
    expect(text).toContain('自动召回')
  })
})

describe('renderRecallTool（工具面召回）', () => {
  it('无命中 → （无命中）', () => {
    expect(renderRecallTool(base)).toBe('（无命中）')
  })
  it('带因果邻居', () => {
    const text = renderRecallTool({
      ...base,
      hits: [hit({ ancestors: [{ id: 'p1', title: '因题' }], children: [{ id: 'c1', title: '果题' }] })],
    })
    expect(text).toContain('nginx题')
    expect(text).toContain('🔺因: 因题')
    expect(text).toContain('🔻果: 果题')
  })
})

describe('消息前缀与标题', () => {
  it('显式存储前缀', () => {
    for (const line of ['记：甲', '存: 甲', '记录：甲', '记住：甲', 'remember: 甲']) {
      expect(STORE_PREFIX.test(line)).toBe(true)
    }
    expect(STORE_PREFIX.test('记住这段')).toBe(false)
  })
  it('跳过前缀', () => {
    expect(SKIP_PREFIX.test('/nomem 查询')).toBe(true)
    expect(SKIP_PREFIX.test('#nomem')).toBe(true)
    expect(SKIP_PREFIX.test('/nomemx')).toBe(false)
  })
  it('titleOf 取首句并截断 70 字', () => {
    expect(titleOf('第一句。 第二句')).toBe('第一句。')
    expect(titleOf('甲'.repeat(100)).length).toBe(70)
  })
})

describe('messageText', () => {
  it('string / blocks / 空', () => {
    expect(messageText('直接字符串')).toBe('直接字符串')
    expect(messageText({ content: [{ type: 'text', text: '甲' }, { type: 'image' }, { type: 'text', text: '乙' }] })).toBe('甲\n乙')
    expect(messageText({ content: 42 })).toBe('')
    expect(messageText(undefined)).toBe('')
  })
})
