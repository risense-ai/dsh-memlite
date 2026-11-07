/**
 * 召回渲染：自动注入只给标题（对齐 respire-dsh 的标题档），正文由 memlite_show 按需读。
 * 工具面的召回输出可多带因果邻居；预算与阈值的裁剪规则与 respire-dsh 相同。
 */
import type { RecallResult, RecallHit } from '@rsrsai/memlite'
import { id8 } from './rules'

const HEADER = '【memlite · 自动召回】以下为标题级记忆；需要正文用 memlite_show <id> 读取：'

function titleOfHit(hit: RecallHit): string {
  if (hit.title !== '') return hit.title.replace(/[\r\n]+/g, ' ')
  return [...hit.content.replace(/\s+/g, ' ')].slice(0, 40).join('')
}

/** 自动注入块；无命中/全部低于阈值返回空串（不占 prompt）。 */
export function renderRecallTitles(r: RecallResult, threshold: number, budget: number): string {
  let text = HEADER
  let count = 0
  for (const hit of r.hits) {
    if (!Number.isFinite(hit.score) || hit.score < threshold) continue
    const line = `\n- [${hit.score.toFixed(2)}] ${titleOfHit(hit)}（${id8(hit.id)}）`
    if (text.length + line.length > budget && count > 0) break
    text += line
    count++
  }
  return count > 0 ? text : ''
}

/** 工具面召回：标题之外再带因果邻居，方便模型判断要不要展开。 */
export function renderRecallTool(r: RecallResult): string {
  if (r.hits.length === 0) return '（无命中）'
  const lines: string[] = [`[${r.backend} ${r.ms}ms]`]
  for (const hit of r.hits) {
    lines.push(`- [${hit.score.toFixed(2)}] ${titleOfHit(hit)}（${id8(hit.id)}）`)
    if (hit.ancestors.length > 0) {
      lines.push(`    🔺因: ${hit.ancestors.map((a) => (a.title !== '' ? a.title : id8(a.id))).join(' ← ')}`)
    }
    if (hit.children.length > 0) {
      lines.push(`    🔻果: ${hit.children.map((c) => (c.title !== '' ? c.title : id8(c.id))).join('、')}`)
    }
  }
  return lines.join('\n')
}
