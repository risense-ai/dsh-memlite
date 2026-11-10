/**
 * DSH 会话历史导入命令面：把会话目录读成 memlite 记忆。
 *
 * 与配置页 HTTP 路由同源（见 src/session-import/routes.ts）：命令只是把同一套
 * 核心能力（reader/extract/importer/report）包成 `CommandResult`。
 */
import type { Memlite } from '@rsrsai/memlite'
import { flagBool, flagNumber, flagString, parseArgs } from '../args'
import {
  formatSessionImportReport,
  formatSessionList,
  importDshSessionsWith,
  listDshSessions,
  resolveSessionsRoot,
} from '../session-import'
import { fail, ok, type CommandDefinition, type CommandInvocation, type CommandResult } from '../types'

const IMPORT_USAGE =
  '/memlite-session-import [--root P] [--cwd P] [--project P] [--session ID] [--limit N] [--since ISO] [--no-explicit] [--no-summary] [--facts] [--dry-run]'
const LIST_USAGE = '/memlite-session-list [--root P] [--cwd P] [--session ID] [--limit N] [--since ISO]'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function sessionCommandDefinitions(mem: Memlite): CommandDefinition[] {
  return [
    {
      name: 'memlite-session-import',
      description: `从 DSH 会话历史导入记忆（先加 --dry-run 预览）。用法：${IMPORT_USAGE}`,
      handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
        try {
          const { flags } = parseArgs(invocation.rawInput)
          const dryRun = flagBool(flags, 'dry-run')
          const report = await importDshSessionsWith(mem, {
            root: flagString(flags, 'root'),
            cwd: flagString(flags, 'cwd'),
            project: flagString(flags, 'project'),
            sessionId: flagString(flags, 'session'),
            limit: flagNumber(flags, 'limit'),
            since: flagString(flags, 'since'),
            explicit: !flagBool(flags, 'no-explicit'),
            summary: !flagBool(flags, 'no-summary'),
            facts: flagBool(flags, 'facts'),
            dryRun,
          })
          return ok(formatSessionImportReport(report, dryRun))
        } catch (error) {
          return fail(errorText(error))
        }
      },
    },
    {
      name: 'memlite-session-list',
      description: `列出 DSH 会话历史（只读，不写库）。用法：${LIST_USAGE}`,
      handler: (invocation: CommandInvocation): CommandResult => {
        try {
          const { flags } = parseArgs(invocation.rawInput)
          const root = resolveSessionsRoot(flagString(flags, 'root'))
          const sessions = listDshSessions({
            root,
            cwd: flagString(flags, 'cwd'),
            sessionId: flagString(flags, 'session'),
            limit: flagNumber(flags, 'limit'),
            since: flagString(flags, 'since'),
          })
          return ok(formatSessionList(sessions, root))
        } catch (error) {
          return fail(errorText(error))
        }
      },
    },
  ]
}
