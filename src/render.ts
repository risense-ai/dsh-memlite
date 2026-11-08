/**
 * 召回渲染：自动注入只给标题（对齐 respire-dsh 的标题档），正文由 memlite_show 按需读。
 * 工具面的召回输出可多带因果邻居；预算与阈值的裁剪规则与 respire-dsh 相同。
 */
import type { RecallResult, RecallHit } from '@rsrsai/memlite'
import { id8 } from './rules'
import type { MemoryRecallExclusion } from './browser-contract'

const HEADER = '【memlite · 自动召回】以下为标题级记忆；需要正文用 memlite_show <id> 读取：'

function titleOfHit(hit: RecallHit): string {
  if (hit.title !== '') return hit.title.replace(/[\r\n]+/g, ' ')
  return [...hit.content.replace(/\s+/g, ' ')].slice(0, 40).join('')
}

/** 单条候选的注入判定（与渲染同一次遍历产生，供 M8c 召回账本使用）。 */
export interface RecallTitleDecision {
  id: string
  score: number
  title: string
  injected: boolean
  exclusion?: MemoryRecallExclusion
}

export interface RecallTitleSelection {
  /** 实际追加进 decision.messages 的标题块；零注入时为空串。 */
  text: string
  /** 每个候选（含未注入的）及其判定原因。 */
  hits: RecallTitleDecision[]
  /** 本轮实际使用的字符数（标题块长度）。 */
  usedChars: number
  /** 召回当时的阈值/预算/条数快照，供 UI 解释。 */
  threshold: number
  budgetChars: number
  candidateCount: number
  injectedCount: number
}

/**
 * 自动注入的阈值/预算筛选（唯一实现）。
 *
 * 预算规则与旧实现一致：第一条无论多长都保留；之后超预算即视为预算截断，
 * 其余候选一律不注入（exclusion='budget'）。低于阈值的候选 exclusion='threshold'。
 * `renderRecallTitles()` 与 M8c 召回账本都从这里取结果，避免两套口径漂移。
 */
export function selectRecallTitles(r: RecallResult, threshold: number, budget: number): RecallTitleSelection {
  const hits: RecallTitleDecision[] = []
  let text = HEADER
  let count = 0
  let budgetExhausted = false
  for (const hit of r.hits) {
    const title = titleOfHit(hit)
    if (!Number.isFinite(hit.score) || hit.score < threshold) {
      hits.push({ id: hit.id, score: hit.score, title, injected: false, exclusion: 'threshold' })
      continue
    }
    if (budgetExhausted) {
      hits.push({ id: hit.id, score: hit.score, title, injected: false, exclusion: 'budget' })
      continue
    }
    const line = `\n- [${hit.score.toFixed(2)}] ${title}（${id8(hit.id)}）`
    if (text.length + line.length > budget && count > 0) {
      budgetExhausted = true
      hits.push({ id: hit.id, score: hit.score, title, injected: false, exclusion: 'budget' })
      continue
    }
    text += line
    count++
    hits.push({ id: hit.id, score: hit.score, title, injected: true })
  }
  return {
    text: count > 0 ? text : '',
    hits,
    usedChars: count > 0 ? text.length : 0,
    threshold,
    budgetChars: budget,
    candidateCount: r.hits.length,
    injectedCount: count,
  }
}

/** 自动注入块；无命中/全部低于阈值返回空串（不占 prompt）。 */
export function renderRecallTitles(r: RecallResult, threshold: number, budget: number): string {
  return selectRecallTitles(r, threshold, budget).text
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
