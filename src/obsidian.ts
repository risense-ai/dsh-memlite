/**
 * Obsidian 桥：路径守卫、报告格式化、以及配置页使用的精确 HTTP 路由。
 *
 * 路由通过 DSH 的 `connection.fetch` 注册在 `/api/memlite/obsidian/*`：
 * - 与官方文件上传等插件同一套机制：经过浏览器认证、Host/Origin 信任栅栏与 owner Peer 校验，
 *   不需要也不允许自建鉴权；Web 与 Desktop（dsh-app 载体）共用同一路径。
 * - 只接受 POST + application/json；请求体较小（路径与选项），因此走 buffered。
 * - 同一时刻只允许一个导入/导出任务，避免两个写库流程互相覆盖。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  exportVaultWith,
  importVaultWith,
  statusVaultWith,
  type ExportReport,
  type ImportReport,
  type StatusReport,
} from '@rsrsai/memlite-obsidian'
import type { Memlite } from '@rsrsai/memlite'
import {
  HttpError,
  errorText,
  json,
  optionalBoolean,
  optionalString as optionalText,
  readJson,
} from './http'

export const OBSIDIAN_IMPORT_PATH = '/api/memlite/obsidian/import'
export const OBSIDIAN_EXPORT_PATH = '/api/memlite/obsidian/export'
export const OBSIDIAN_STATUS_PATH = '/api/memlite/obsidian/status'

/** 配置页使用的 document-relative 路径（与官方文件上传一致，去掉前导斜杠）。 */
export const OBSIDIAN_CLIENT_PATHS = {
  import: OBSIDIAN_IMPORT_PATH.slice(1),
  export: OBSIDIAN_EXPORT_PATH.slice(1),
  status: OBSIDIAN_STATUS_PATH.slice(1),
} as const

export interface FetchRoute {
  path: string
  methods: string[]
  requestBody?: 'buffered' | 'streaming'
  fetch(request: Request): Promise<Response> | Response
}

/** 宿主侧 connection 服务的最小子集。 */
export interface ConnectionService {
  fetch: {
    register(route: FetchRoute): () => void
  }
}

const MAX_PATH_CHARS = 1000

/** 路径守卫：非空、无 NUL、支持 ~ 展开，最后 resolve。 */
export function resolvePathArg(raw: unknown, field: string): string {
  if (typeof raw !== 'string') throw new HttpError(400, `${field} 必须是字符串`)
  const input = raw.trim()
  if (input === '' || input === '""' || input === "''") {
    throw new HttpError(400, '路径不能为空串')
  }
  if (input.length > MAX_PATH_CHARS) throw new HttpError(400, `${field} 过长`)
  if (input.includes('\0')) throw new HttpError(400, `${field} 含非法字符`)
  const expanded =
    input === '~' ? os.homedir() : input.startsWith('~/') || input.startsWith('~\\') ? path.join(os.homedir(), input.slice(2)) : input
  return path.resolve(expanded)
}

/** vault 目录守卫：绝对化 + 存在且为目录。 */
export function requireVaultDir(raw: unknown, field = 'vaultPath'): string {
  const dir = resolvePathArg(raw, field)
  let stat: fs.Stats
  try {
    stat = fs.statSync(dir)
  } catch {
    throw new HttpError(400, `vault 目录不存在或不是目录: ${dir}`)
  }
  if (!stat.isDirectory()) throw new HttpError(400, `vault 目录不存在或不是目录: ${dir}`)
  return dir
}

export function formatImportReport(report: ImportReport, dryRun: boolean): string {
  const lines: string[] = []
  if (dryRun) {
    lines.push(
      `[dry-run] 扫描 ${report.scanned} 条：将新建 ${report.wouldCreate}，将更新 ${report.wouldUpdate}，不变 ${report.unchanged}`,
    )
    lines.push('确认无误后去掉 --dry-run（配置页取消“仅预览”）再执行正式入库。')
  } else {
    lines.push(
      `扫描 ${report.scanned} 条：新建 ${report.created.length}，更新 ${report.updated.length}，不变 ${report.unchanged}，跳过 ${report.skipped.length}`,
    )
  }
  if (report.warnings.length > 0) {
    lines.push(`警告 ${report.warnings.length} 条：`)
    for (const warning of report.warnings.slice(0, 5)) lines.push(`  - ${warning}`)
    if (report.warnings.length > 5) lines.push(`  …另 ${report.warnings.length - 5} 条`)
  }
  return lines.join('\n')
}

export function formatExportReport(report: ExportReport): string {
  const lines = [`导出 ${report.written}/${report.total} 条 → ${report.output}`]
  if (report.dangling > 0) lines.push(`悬空父指针 ${report.dangling} 条（按根处理）`)
  for (const warning of report.warnings.slice(0, 5)) lines.push(`警告: ${warning}`)
  return lines.join('\n')
}

export function formatStatusReport(report: StatusReport): string {
  const lines = [
    `synced ${report.synced} · outdated ${report.outdated} · missing ${report.missing}${report.skipped.length > 0 ? ` · skipped ${report.skipped.length}` : ''}`,
  ]
  const rows = report.rows.filter((row) => row.state !== 'synced')
  for (const row of rows.slice(0, 20)) {
    const idPart = row.id !== '' ? ` [${row.id.slice(0, 8)}]` : ''
    const changes = row.changes.length > 0 ? `（${row.changes.join(',')}）` : ''
    lines.push(`  ${row.state}${idPart} ${row.path}${changes}`)
  }
  if (rows.length > 20) lines.push(`  …另 ${rows.length - 20} 行`)
  if (rows.length === 0) lines.push('  （全部同步）')
  return lines.join('\n')
}

export interface ObsidianHttpHandlers {
  import(request: Request): Promise<Response>
  export(request: Request): Promise<Response>
  status(request: Request): Promise<Response>
}

/** 建立一组 HTTP handler；getMem 每次调用取当前引擎（配置热更新后仍指向新实例）。 */
export function createObsidianHandlers(
  getMem: () => Memlite,
  activity?: import('./memory-status').ObsidianActivity,
): ObsidianHttpHandlers {
  let busy = false

  const exclusive = async <T>(label: string, operation: () => Promise<T> | T): Promise<T> => {
    if (busy) throw new HttpError(409, `另一个 Obsidian 操作（${label}）尚未完成，请稍后再试`)
    busy = true
    try {
      return await operation()
    } finally {
      busy = false
    }
  }

  const respond = async (
    label: 'status' | 'import' | 'export',
    operation: () => Promise<{ text: string; report?: Record<string, unknown> }>,
  ): Promise<Response> => {
    activity?.begin(label)
    let ok = false
    try {
      const result = await operation()
      const response = json({ ok: true, text: result.text, ...(result.report !== undefined ? { report: result.report } : {}) })
      ok = true
      return response
    } catch (error) {
      if (error instanceof HttpError) return json({ ok: false, error: error.message }, error.status)
      return json({ ok: false, error: errorText(error) }, 400)
    } finally {
      activity?.finish(label, ok)
    }
  }

  return {
    import(request) {
      return respond('import', () =>
        exclusive('import', async () => {
          const body = await readJson(request)
          const vaultDir = requireVaultDir(body['vaultPath'])
          const project = optionalText(body['project'], 'project')
          const writeId = optionalBoolean(body['writeId'], 'writeId')
          const dryRun = optionalBoolean(body['dryRun'], 'dryRun')
          const report = await importVaultWith(getMem(), vaultDir, { project, writeId, dryRun })
          return {
            text: formatImportReport(report, dryRun),
            report: {
              dryRun,
              scanned: report.scanned,
              created: report.created.length,
              updated: report.updated.length,
              unchanged: report.unchanged,
              skipped: report.skipped.length,
              warnings: report.warnings.length,
              ...(dryRun
                ? { wouldCreate: report.wouldCreate, wouldUpdate: report.wouldUpdate }
                : {}),
            },
          }
        }),
      )
    },
    export(request) {
      return respond('export', () =>
        exclusive('export', async () => {
          const body = await readJson(request)
          const outputPath = resolvePathArg(body['outputPath'], 'outputPath')
          const overwrite = optionalBoolean(body['overwrite'], 'overwrite')
          const report = exportVaultWith(getMem(), outputPath, { overwrite })
          return {
            text: formatExportReport(report),
            report: {
              written: report.written,
              total: report.total,
              dangling: report.dangling,
              warnings: report.warnings.length,
            },
          }
        }),
      )
    },
    status(request) {
      return respond('status', () =>
        exclusive('status', async () => {
          const body = await readJson(request)
          const vaultDir = requireVaultDir(body['vaultPath'])
          const report = await statusVaultWith(getMem(), vaultDir)
          return {
            text: formatStatusReport(report),
            report: {
              synced: report.synced,
              outdated: report.outdated,
              missing: report.missing,
              skipped: report.skipped.length,
            },
          }
        }),
      )
    },
  }
}

/** 注册三条精确路由；返回 disposers（由调用方放进 ctx.effect/清理列表）。 */
export function registerObsidianRoutes(
  connection: ConnectionService,
  handlers: ObsidianHttpHandlers,
): Array<() => void> {
  return [
    connection.fetch.register({
      path: OBSIDIAN_IMPORT_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handlers.import(request),
    }),
    connection.fetch.register({
      path: OBSIDIAN_EXPORT_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handlers.export(request),
    }),
    connection.fetch.register({
      path: OBSIDIAN_STATUS_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handlers.status(request),
    }),
  ]
}
