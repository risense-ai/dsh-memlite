/**
 * M5 Obsidian 整合：vault ↔ memlite 三命令（经 @rsrsai/memlite-obsidian 的
 * *With 共享实例重载，复用插件常驻 Memlite——无双实例写冲突）。
 *
 * 路径守卫（memlite-obsidian fb8a0c73 事故教训）：路径参数绝不接受空串，
 * 绝对化 + 存在性校验前置；description 写明建议先 --dry-run。
 */
import * as fs from 'node:fs'
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
import { flagBool, flagString, parseArgs } from '../args'
import { fail, ok, type CommandDefinition, type CommandInvocation, type CommandResult } from '../types'

function id8(id: string): string {
  return id.slice(0, 8)
}

/** 路径守卫：非空（requireRest 之后再过一遍）→ 绝对化。 */
function resolvePathArg(raw: string, usage: string): CommandResult | string {
  const p = raw.trim()
  if (p === '' || p === '""' || p === "''") return fail(`路径不能为空串。用法：${usage}`)
  return path.resolve(p)
}

/** vault 目录守卫：绝对化 + 存在且为目录。 */
function requireVaultDir(raw: string, usage: string): CommandResult | string {
  const r = resolvePathArg(raw, usage)
  if (typeof r !== 'string') return r
  if (!fs.existsSync(r) || !fs.statSync(r).isDirectory()) {
    return fail(`vault 目录不存在或不是目录: ${r}`)
  }
  return r
}

function formatImport(r: ImportReport, dryRun: boolean): string {
  const lines: string[] = []
  if (dryRun) {
    lines.push(`[dry-run] 扫描 ${r.scanned} 条：将新建 ${r.wouldCreate}，将更新 ${r.wouldUpdate}，不变 ${r.unchanged}`)
    lines.push('确认无误后去掉 --dry-run 重新执行正式入库。')
  } else {
    lines.push(
      `扫描 ${r.scanned} 条：新建 ${r.created.length}，更新 ${r.updated.length}，不变 ${r.unchanged}，跳过 ${r.skipped.length}`,
    )
  }
  if (r.warnings.length > 0) {
    lines.push(`警告 ${r.warnings.length} 条：`)
    for (const w of r.warnings.slice(0, 5)) lines.push(`  - ${w}`)
    if (r.warnings.length > 5) lines.push(`  …另 ${r.warnings.length - 5} 条`)
  }
  return lines.join('\n')
}

function formatExport(r: ExportReport): string {
  const lines: string[] = [
    `导出 ${r.written}/${r.total} 条 → ${r.output}`,
  ]
  if (r.dangling > 0) lines.push(`悬空父指针 ${r.dangling} 条（按根处理）`)
  for (const w of r.warnings.slice(0, 5)) lines.push(`警告: ${w}`)
  return lines.join('\n')
}

function formatVaultStatus(r: StatusReport): string {
  const lines: string[] = [
    `synced ${r.synced} · outdated ${r.outdated} · missing ${r.missing}${r.skipped.length > 0 ? ` · skipped ${r.skipped.length}` : ''}`,
  ]
  const show = r.rows.filter((row) => row.state !== 'synced')
  for (const row of show.slice(0, 20)) {
    const idPart = row.id !== '' ? ` [${id8(row.id)}]` : ''
    const ch = row.changes.length > 0 ? `（${row.changes.join(',')}）` : ''
    lines.push(`  ${row.state}${idPart} ${row.path}${ch}`)
  }
  if (show.length > 20) lines.push(`  …另 ${show.length - 20} 行`)
  if (show.length === 0) lines.push('  （全部同步）')
  return lines.join('\n')
}

export function obsidianCommandDefinitions(mem: Memlite): CommandDefinition[] {
  return [
    {
      name: 'memlite-import',
      description:
        '把 Obsidian vault 导入记忆库（强烈建议先加 --dry-run 预览）。用法：/memlite-import <vault-path> [--project P] [--write-id] [--dry-run]',
      handler: (invocation: CommandInvocation): Promise<CommandResult> => {
        const run = async (): Promise<CommandResult> => {
          const { rest, flags } = parseArgs(invocation.rawInput)
          const vaultDir = requireVaultDir(rest, '/memlite-import <vault-path> [--project P] [--write-id] [--dry-run]')
          if (typeof vaultDir !== 'string') return vaultDir
          const report = await importVaultWith(mem, vaultDir, {
            project: flagString(flags, 'project'),
            writeId: flagBool(flags, 'write-id'),
            dryRun: flagBool(flags, 'dry-run'),
          })
          return ok(formatImport(report, flagBool(flags, 'dry-run')))
        }
        return run().then(
          (text) => (typeof text === 'string' ? ok(text) : text),
          (e) => fail(e instanceof Error ? e.message : String(e)),
        )
      },
    },
    {
      name: 'memlite-export',
      description: '把记忆库导出为 Obsidian vault（因果树→目录树）。用法：/memlite-export <output-path> [--overwrite]',
      handler: (invocation: CommandInvocation): CommandResult => {
        try {
          const { rest, flags } = parseArgs(invocation.rawInput)
          const out = resolvePathArg(rest, '/memlite-export <output-path> [--overwrite]')
          if (typeof out !== 'string') return out
          const report = exportVaultWith(mem, out, { overwrite: flagBool(flags, 'overwrite') })
          return ok(formatExport(report))
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e))
        }
      },
    },
    {
      name: 'memlite-vault-status',
      description: 'vault 各文件相对当前库的同步态（synced/outdated/missing）。用法：/memlite-vault-status <vault-path>',
      handler: (invocation: CommandInvocation): Promise<CommandResult> => {
        const run = async (): Promise<CommandResult> => {
          const { rest } = parseArgs(invocation.rawInput)
          const vaultDir = requireVaultDir(rest, '/memlite-vault-status <vault-path>')
          if (typeof vaultDir !== 'string') return vaultDir
          const report: StatusReport = await statusVaultWith(mem, vaultDir)
          return ok(formatVaultStatus(report))
        }
        return run().then(
          (text) => (typeof text === 'string' ? ok(text) : text),
          (e) => fail(e instanceof Error ? e.message : String(e)),
        )
      },
    },
  ]
}
