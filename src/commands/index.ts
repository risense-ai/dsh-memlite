/**
 * 命令面：13 个扁平单 token 命令（M0 漂移四——注册名含空格会被 COMMAND_NAME 正则拒绝）。
 * 每个命令 = 调 Memlite 主类方法 → CommandResult（{kind, text}，不是 string）。
 */
import type { Memlite } from '@rsrsai/memlite'
import { flagBool, flagNumber, flagString, parseArgs } from '../args'
import {
  formatChain,
  formatOverview,
  formatRecall,
  formatShow,
  formatStatus,
  formatTree,
} from '../format'
import { fail, ok, type CommandDefinition, type CommandInvocation, type CommandResult } from '../types'

type Handler = (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>

function def(name: string, description: string, handler: Handler): CommandDefinition {
  return { name, description, handler }
}

function requireRest(invocation: CommandInvocation, usage: string): string | CommandResult {
  const { rest } = parseArgs(invocation.rawInput)
  if (rest === '') return fail(`缺参数。用法：${usage}`)
  return rest
}

async function guard(fn: () => Promise<string | CommandResult>): Promise<CommandResult> {
  try {
    const text = await fn()
    return typeof text === 'string' ? ok(text) : text
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

export function commandDefinitions(mem: Memlite): CommandDefinition[] {
  return [
    def('memlite', 'memlite 记忆库概览与快速上手', () =>
      guard(async () => formatOverview(mem))),

    def('memlite-recall', '检索记忆（语义/词面/RRF 自动选档）。用法：/memlite-recall <query> [--limit N] [--bm25] [--project P]', (invocation) =>
      guard(async () => {
        const { rest, flags } = parseArgs(invocation.rawInput)
        if (rest === '') throw new Error('缺 query。用法：/memlite-recall <query> [--limit N] [--bm25] [--project P]')
        const r = await mem.recall(rest, {
          limit: flagNumber(flags, 'limit'),
          project: flagString(flags, 'project') ?? '',
          bm25Only: flagBool(flags, 'bm25'),
        })
        return formatRecall(r, flagString(flags, 'project') ?? '')
      })),

    def('memlite-remember', '存一条记忆。用法：/memlite-remember <content> [--title T] [--tags a,b] [--parent ID]', (invocation) =>
      guard(async () => {
        const { rest, flags } = parseArgs(invocation.rawInput)
        if (rest === '') throw new Error('缺 content。用法：/memlite-remember <content> [--title T] [--tags a,b] [--parent ID]')
        const tags = (flagString(flags, 'tags') ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t !== '')
        const rid = await mem.remember(rest, {
          title: flagString(flags, 'title'),
          tags,
          project: flagString(flags, 'project') ?? '',
          parent: flagString(flags, 'parent'),
        })
        return `已存 ${rid}（共 ${mem.store.count()} 条）`
      })),

    def('memlite-show', '看全文与因果视界。用法：/memlite-show <id|前缀|纲名>', (invocation) =>
      guard(async () => {
        const arg = requireRest(invocation, '/memlite-show <id>')
        if (typeof arg !== 'string') return arg
        return formatShow(mem, arg)
      })),

    def('memlite-forget', '删一条记忆。用法：/memlite-forget <id>', (invocation) =>
      guard(async () => {
        const arg = requireRest(invocation, '/memlite-forget <id>')
        if (typeof arg !== 'string') return arg
        const rid = mem.forget(arg)
        return `已删 ${rid}`
      })),

    def('memlite-update', '就地改一条（同 id 追加新版本）。用法：/memlite-update <id> [--title T] [--content C]', (invocation) =>
      guard(async () => {
        const arg = requireRest(invocation, '/memlite-update <id> [--title T] [--content C]')
        if (typeof arg !== 'string') return arg
        const { flags } = parseArgs(invocation.rawInput)
        const title = flagString(flags, 'title')
        const content = flagString(flags, 'content')
        const old = mem.store.resolve(arg)
        if (!old) throw new Error(`记忆不存在: ${arg}`)
        if (title === undefined && content === undefined) {
          throw new Error('未给 --title 或 --content——没有可改字段')
        }
        const r = await mem.update(arg, { title, content })
        return `已更新 ${r.id}「${r.title}」${r.embedded ? '（向量已更新）' : ''}`
      })),

    def('memlite-attach', '挂链：子条挂到父之下（防自挂防环）。用法：/memlite-attach <child> --parent <parent>', (invocation) =>
      guard(async () => {
        const arg = requireRest(invocation, '/memlite-attach <child> --parent <parent>')
        if (typeof arg !== 'string') return arg
        const { flags } = parseArgs(invocation.rawInput)
        const parent = flagString(flags, 'parent')
        if (parent === undefined) throw new Error('缺 --parent。用法：/memlite-attach <child> --parent <parent>')
        const r = mem.attach(arg, parent)
        return `已挂链：${r.child.slice(0, 8)} → 父 ${r.parent.slice(0, 8)}`
      })),

    def('memlite-tree', '因果树渲染。用法：/memlite-tree [--from ID] [--depth N] [--outline]', (invocation) =>
      guard(async () => {
        const { flags } = parseArgs(invocation.rawInput)
        return formatTree(mem, {
          from: flagString(flags, 'from'),
          depth: flagNumber(flags, 'depth') ?? 3,
          outline: flagBool(flags, 'outline'),
        })
      })),

    def('memlite-chain', '因果链深挖：因链全文+本条+果链下探。用法：/memlite-chain <id> [--depth N]', (invocation) =>
      guard(async () => {
        const arg = requireRest(invocation, '/memlite-chain <id> [--depth N]')
        if (typeof arg !== 'string') return arg
        const { flags } = parseArgs(invocation.rawInput)
        return formatChain(mem, arg, flagNumber(flags, 'depth') ?? 3)
      })),

    def('memlite-sync', 'git 白名单同步（add pathspec 限定 + sha 双通道核验）', () =>
      guard(async () => {
        const r = await mem.sync()
        return [
          `committed: ${r.committed}`,
          `local_sha: ${r.local_sha.slice(0, 8)}`,
          `remote_sha: ${r.remote_sha.slice(0, 8)}`,
          `verified: ${r.verified}`,
        ].join('\n')
      })),

    def('memlite-status', '库状态：目录/条数/向量/嵌入档/同步', () =>
      guard(async () => formatStatus(mem))),

    def('memlite-reembed', '给旧记忆批量回填嵌入向量（须配嵌入档）', () =>
      guard(async () => {
        const r = await mem.reembed()
        return `回填 ${r.embedded} 条，失败 ${r.failed}，库容 ${r.total}`
          + (r.failures.length > 0 ? `\n失败明细：\n${r.failures.join('\n')}` : '')
      })),

    def('memlite-bench', '检索命中率评测：20 记忆 × 20 改写查询，报 hit@1/hit@3', () =>
      guard(async () => {
        const { bench } = await import('@rsrsai/memlite')
        const r = await bench({ embedder: undefined, logger: undefined })
        return [
          `模式: ${r.mode} | 库容: ${r.records} 条 | 查询: ${r.queries} 个`,
          `hit@1: ${r.hit1} = ${r.hit1_pct}%`,
          `hit@3: ${r.hit3} = ${r.hit3_pct}%`,
          ...(r.misses.length > 0 ? ['未进 top3 的查询：', ...r.misses.map((q) => `  - ${q}`)] : []),
        ].join('\n')
      })),
  ]
}

/** 把全部命令注册进宿主 commands 服务。 */
export function registerCommands(commands: { register(d: CommandDefinition): () => void }, mem: Memlite): () => void {
  const disposers = commandDefinitions(mem).map((d) => commands.register(d))
  return () => {
    for (const d of disposers) d()
  }
}
