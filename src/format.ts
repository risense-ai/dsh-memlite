/**
 * 命令输出渲染器：hits / 全文 / 树 / 链 / 状态 的纯文本形态。
 * 从 @rsrsai/memlite 的返回类型出发，不依赖 memlite 内部模块（integration.md §四约束）。
 */
import type { Memlite, RecallResult } from '@rsrsai/memlite'

function id8(id: string): string {
  return id.slice(0, 8)
}

export function formatRecall(r: RecallResult, project: string): string {
  const lines: string[] = []
  lines.push(`[${r.backend}${r.fallback ? ` · 回退${r.fallback === 'user' ? '用户级' : r.fallback}` : ''} ${r.ms}ms]`)
  if (r.hits.length === 0) {
    lines.push('（无命中）')
    return lines.join('\n')
  }
  for (const h of r.hits) {
    const head = h.title !== '' ? h.title : [...h.content].slice(0, 40).join('').replace(/\n/g, ' ')
    lines.push(`[${h.score.toFixed(3)}] ${id8(h.id)}  ${head}`)
    if (h.ancestors.length > 0) {
      lines.push(`    🔺因链: ${h.ancestors.map((a) => a.title !== '' ? a.title : id8(a.id)).join(' ← ')}`)
    }
    if (h.children.length > 0) {
      lines.push(`    🔻果: ${h.children.map((c) => c.title !== '' ? c.title : id8(c.id)).join('、')}`)
    }
  }
  if (project !== '') lines.push(`（project=${project}）`)
  return lines.join('\n')
}

export function formatShow(mem: Memlite, id: string): string {
  const shown = mem.show(id)
  if (!shown) throw new Error(`记忆不存在: ${id}`)
  const r = shown.record
  const lines: string[] = [
    `id: ${r.id}`,
    `created: ${new Date(r.ts * 1000).toISOString()}`,
    `title: ${r.title}`,
    `tags: ${r.tags.join(', ')}`,
    `project: ${r.project}`,
    '---',
    r.content,
  ]
  lines.push(...shown.causalLines)
  return lines.join('\n')
}

export function formatTree(mem: Memlite, opts: { from?: string; depth?: number; outline?: boolean }): string {
  const result = mem.tree({ from: opts.from, depth: opts.depth, mode: opts.outline ? 'outline' : 'render' })
  if (opts.outline) {
    const { lines, count } = result as { lines: string[]; count: number }
    return [...lines, `—— 共 ${count} 节点`].join('\n')
  }
  return (result as string[]).join('\n')
}

export function formatChain(mem: Memlite, id: string, depth: number): string {
  const v = mem.chain(id, depth)
  const idOf = (x: { id: string; title: string }) => (x.title !== '' ? x.title : id8(x.id))
  const lines: string[] = [`🔗 因果链（自 ${id8(v.entry.id)}）`]
  if (v.ancestors.length === 0) {
    lines.push('   （无因——本条为根/纲）')
  } else {
    lines.push(`   🔺因链（${v.ancestors.length} 层，根在前）：`)
    for (const a of v.ancestors) {
      lines.push(`\n   ┌─ [${id8(a.id)}] ${idOf(a)}`)
      for (const line of a.content.split('\n')) lines.push(`   │ ${line}`)
    }
  }
  lines.push(`\n   ◆ 本条 [${id8(v.entry.id)}] ${idOf(v.entry)}`)
  for (const line of v.entry.content.split('\n')) lines.push(`   │ ${line}`)
  if (v.descendants.length === 0) {
    lines.push('\n   （无果——本条为叶）')
  } else {
    lines.push(`\n   🔻果链（${v.descendants.length} 条，下探 ${depth} 层）：`)
    for (const [lv, d] of v.descendants) {
      lines.push(`\n   ${'  '.repeat(lv - 1)}┌─ L${lv} [${id8(d.id)}] ${idOf(d)}`)
      for (const line of d.content.split('\n')) lines.push(`   ${'  '.repeat(lv - 1)}│ ${line}`)
    }
  }
  return lines.join('\n')
}

export async function formatStatus(mem: Memlite): Promise<string> {
  const st = (await mem.status()) as Record<string, unknown>
  const lines: string[] = [
    `数据目录: ${st['data_dir']}`,
    `记忆条数: ${st['records']}（行 ${st['lines']}，坏行 ${st['bad_lines']}）`,
    `侧车向量: ${st['vectors']}`,
  ]
  const emb = st['embedding'] as Record<string, unknown> | undefined
  if (emb) lines.push(`嵌入档: ${emb['provider']}（model=${emb['model']}）`)
  const sync = st['sync'] as Record<string, unknown> | undefined
  if (sync && typeof sync['repo'] === 'string') {
    lines.push(`同步: repo=${sync['repo']} dirty=${String(sync['dirty'])} has_remote=${String(sync['has_remote'])}`)
  } else {
    lines.push('同步: 不在任何 git 仓内（/memlite-sync 前先 git init）')
  }
  return lines.join('\n')
}

export function formatOverview(mem: Memlite): string {
  const s = mem.store
  return [
    `memlite 记忆库：${s.count()} 条 @ ${mem.dataDir}`,
    '快速上手：/memlite-remember <内容> 存一条；/memlite-recall <关键词> 检索；/memlite-tree 看因果树；/memlite-status 看状态。',
  ].join('\n')
}
