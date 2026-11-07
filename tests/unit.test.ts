/** args/render 纯单元测试。 */
import { describe, expect, it } from 'vitest'
import { flagBool, flagNumber, flagString, parseArgs } from '../src/args'
import { renderMemories } from '../src/render'
import { messageText } from '../src/types'
import type { RecallResult } from '@rsrsai/memlite'

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

describe('renderMemories', () => {
  const base: RecallResult = {
    backend: 'bm25', fallback: '', ms: 3, hits: [],
  }
  it('无命中 → 空串（不占 prompt）', () => {
    expect(renderMemories(base, 2000)).toBe('')
  })
  it('渲染标题/正文/id 与尾部引导', () => {
    const r: RecallResult = {
      ...base,
      hits: [{ score: 0.8, id: 'abcdefgh1234', ts: 1, title: 'nginx题', content: '正文细节', tags: [], project: '', ancestors: [], children: [] }],
    }
    const text = renderMemories(r, 2000)
    expect(text).toContain('## 相关记忆')
    expect(text).toContain('[nginx题]')
    expect(text).toContain('正文细节')
    expect(text).toContain('(id:abcdefgh)')
    expect(text).toContain('/memlite-show')
  })
  it('maxChars 截断', () => {
    const hits = Array.from({ length: 20 }, (_, i) => ({
      score: 0.5, id: String(i).padStart(12, '0'), ts: i, title: `题${i}`, content: 'x'.repeat(120),
      tags: [], project: '', ancestors: [], children: [],
    }))
    const text = renderMemories({ ...base, hits }, 400)
    expect(text.length).toBeLessThanOrEqual(400)
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
