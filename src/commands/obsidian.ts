/**
 * M5 Obsidian 整合命令面：vault → memlite 的三条命令。
 *
 * 路径守卫、报告格式化与配置页 HTTP 路由同源（见 src/obsidian.ts），
 * 命令只是把同一套能力包成 `CommandResult`。
 */
import { importVaultWith, exportVaultWith, statusVaultWith } from '@rsrsai/memlite-obsidian'
import type { Memlite } from '@rsrsai/memlite'
import { flagBool, flagString, parseArgs } from '../args'
import {
  formatExportReport,
  formatImportReport,
  formatStatusReport,
  requireVaultDir,
  resolvePathArg,
} from '../obsidian'
import { fail, ok, type CommandDefinition, type CommandInvocation, type CommandResult } from '../types'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function obsidianCommandDefinitions(mem: Memlite): CommandDefinition[] {
  return [
    {
      name: 'memlite-import',
      description:
        '把 Obsidian vault 导入记忆库（强烈建议先加 --dry-run 预览）。用法：/memlite-import <vault-path> [--project P] [--write-id] [--dry-run]',
      handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
        try {
          const { rest, flags } = parseArgs(invocation.rawInput)
          const vaultDir = requireVaultDir(rest)
          const dryRun = flagBool(flags, 'dry-run')
          const report = await importVaultWith(mem, vaultDir, {
            project: flagString(flags, 'project'),
            writeId: flagBool(flags, 'write-id'),
            dryRun,
          })
          return ok(formatImportReport(report, dryRun))
        } catch (error) {
          return fail(errorText(error))
        }
      },
    },
    {
      name: 'memlite-export',
      description:
        '把记忆库导出为 Obsidian vault（因果树→目录树）。用法：/memlite-export <output-path> [--overwrite]',
      handler: (invocation: CommandInvocation): CommandResult => {
        try {
          const { rest, flags } = parseArgs(invocation.rawInput)
          const out = resolvePathArg(rest, 'outputPath')
          const report = exportVaultWith(mem, out, { overwrite: flagBool(flags, 'overwrite') })
          return ok(formatExportReport(report))
        } catch (error) {
          return fail(errorText(error))
        }
      },
    },
    {
      name: 'memlite-vault-status',
      description:
        'vault 各文件相对当前库的同步态（synced/outdated/missing）。用法：/memlite-vault-status <vault-path>',
      handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
        try {
          const { rest } = parseArgs(invocation.rawInput)
          const vaultDir = requireVaultDir(rest)
          const report = await statusVaultWith(mem, vaultDir)
          return ok(formatStatusReport(report))
        } catch (error) {
          return fail(errorText(error))
        }
      },
    },
  ]
}
