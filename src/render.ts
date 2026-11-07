/**
 * 记忆块渲染：hits → markdown 段（maxMemories/maxChars 截断 + 尾部引导）。
 */
import type { RecallResult } from '@rsrsai/memlite'

function id8(id: string): string {
  return id.slice(0, 8)
}

function oneLine(s: string, cap: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return [...flat].length > cap ? [...flat].slice(0, cap).join('') + '…' : flat
}

export function renderMemories(r: RecallResult, maxChars: number): string {
  if (r.hits.length === 0) return ''
  const lines: string[] = ['## 相关记忆', '']
  let used = lines[0]!.length + 1
  let count = 0
  for (const h of r.hits) {
    const title = h.title !== '' ? h.title : oneLine(h.content, 20)
    const body = oneLine(h.content, 80)
    const suffix = body !== '' && body !== title ? ` ${body}` : ''
    const line = `- **[${title}]**${suffix} (id:${id8(h.id)})`
    if (used + line.length + 1 > maxChars && count > 0) break
    lines.push(line)
    used += line.length + 1
    count++
  }
  if (count === 0) return ''
  lines.push('')
  lines.push('使用 /memlite-show <id> 查看完整记忆与因果链。')
  return lines.join('\n')
}
