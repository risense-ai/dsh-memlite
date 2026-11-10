/**
 * DSH 会话导入的中文报告文本：命令面与配置页 HTTP 路由共用同一套格式
 * （契约见 docs/session-import-contract.md 第八节；测试按这些中文子串断言）。
 */
import type { DshSessionOverview, SessionImportReport } from './types'

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 本地日期 `YYYY-MM-DD`。 */
export function formatDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '未知日期'
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 本地时间 `YYYY-MM-DD HH:mm`。 */
export function formatDateTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '未知时间'
  const date = new Date(ms)
  return `${formatDate(ms)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** 跳过原因汇总（只列非 0 项）。 */
function skippedDetail(report: SessionImportReport): string | undefined {
  const counts = { sensitive: 0, empty: 0, 'write-error': 0 }
  for (const item of report.skipped) counts[item.reason]++
  const parts: string[] = []
  if (counts.sensitive > 0) parts.push(`sensitive ${counts.sensitive}`)
  if (counts.empty > 0) parts.push(`empty ${counts.empty}`)
  if (counts['write-error'] > 0) parts.push(`write-error ${counts['write-error']}`)
  return parts.length > 0 ? `跳过明细：${parts.join(' / ')}` : undefined
}

/**
 * 导入报告：
 *
 *   [dry-run] 扫描 2 个会话（跳过 0）/ 120 条事件：候选 5 条 → 将新建 4，将更新 1，不变 0，跳过 0
 *   确认无误后去掉 --dry-run（配置页取消“仅预览”）再执行正式入库。
 */
export function formatSessionImportReport(report: SessionImportReport, dryRun: boolean): string {
  const created = dryRun ? report.wouldCreate : report.created.length
  const updated = dryRun ? report.wouldUpdate : report.updated.length
  const head = dryRun ? '[dry-run] ' : ''
  const createLabel = dryRun ? '将新建' : '新建'
  const updateLabel = dryRun ? '将更新' : '更新'
  const lines = [
    `${head}扫描 ${report.sessionsScanned} 个会话（跳过 ${report.sessionsSkipped}）/ ${report.events} 条事件：` +
      `候选 ${report.candidates} 条 → ${createLabel} ${created}，${updateLabel} ${updated}，` +
      `不变 ${report.unchanged}，跳过 ${report.skipped.length}`,
  ]
  if (dryRun) {
    lines.push('确认无误后去掉 --dry-run（配置页取消“仅预览”）再执行正式入库。')
  }
  const detail = skippedDetail(report)
  if (detail !== undefined) lines.push(detail)
  if (report.warnings.length > 0) {
    lines.push(`警告 ${report.warnings.length} 条：`)
    for (const warning of report.warnings.slice(0, 5)) lines.push(`  - ${warning}`)
    if (report.warnings.length > 5) lines.push(`  …另 ${report.warnings.length - 5} 条`)
  }
  return lines.join('\n')
}

/** 会话清单（最多 30 行，超出折叠）。 */
export function formatSessionList(overviews: DshSessionOverview[], root: string): string {
  if (overviews.length === 0) return `未发现会话（根：${root}）。`
  const lines = [`发现 ${overviews.length} 个会话（根：${root}）：`]
  for (const overview of overviews.slice(0, 30)) {
    const project = overview.cwd !== '' ? overview.cwd.split(/[\\/]/u).filter((part) => part !== '').pop() ?? '' : ''
    const title = overview.title !== '' ? overview.title : '无标题'
    lines.push(
      `- ${formatDateTime(overview.createdAt)} · ${project !== '' ? project : '未标注项目'} · ` +
        `${overview.messages} 条人类消息 / ${overview.explicit} 条显式记忆 · ${title}`,
    )
  }
  if (overviews.length > 30) lines.push(`…另 ${overviews.length - 30} 个会话`)
  return lines.join('\n')
}
