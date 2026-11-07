/**
 * @rsrsai/dsh-memlite 插件入口（0.2.0 架构对齐版）。
 *
 * 与 respire-dsh（@rsrsai/dsh）同构的插件逻辑，只把两个面留成 memlite：
 * - 子进程 → 进程内 Memlite（recall/store 不再起 CLI）
 * - 命令面 → 原 16 个 /memlite-* 命令保持不变
 *
 * 其余全部按 respire-dsh：
 * 1. 静态规则 section（memlite:rules, order 850）
 * 2. agent/pre-step 同步召回 → 以 user 消息注入（source=memlite）
 * 3. 每 agent 一次 status 体检；敏感闸；显式「记：」存储 + 读回校验
 * 4. agent/turn-stopping 一次性收尾 steer
 * 5. 每 agent / 每 turn 状态机：processed / hadUser / stored / reminded
 * 6. 失败一律变成模型可见回执，不阻塞任务
 * 7. 模型侧读写通道：memlite_recall/show/remember/update/attach 工具
 */
import type { Memlite } from '@rsrsai/memlite'
import { MemoryRuntime } from './runtime'
import { registerCommands } from './commands'
import { registerMemoryTools } from './tools'
import { contextMessage } from './messages'
import { States } from './state'
import { RULES, SKIP_PREFIX, SKILL_PREFIX, STORE_PREFIX, WRAP_UP, id8, titleOf } from './rules'
import { renderRecallTitles } from './render'
import { Config, readConfig, resolveConfigRef, type ConfigRef, type PluginConfig } from './schema'
import { createObsidianHandlers, registerObsidianRoutes, type ConnectionService } from './obsidian'
import {
  messageText,
  onEvent,
  onWaterfall,
  type AgentLike,
  type PreStepDecision,
  type PreStepPayload,
  type Scoped,
  type TurnStoppingPayload,
  type UserMessage,
} from './types'

export const name = '@rsrsai/dsh-memlite'
export { Config }

/** 必需服务；tools 用作用域 inject 可选挂载（宿主无 tools 时命令仍可用）。 */
export const inject = ['credentials', 'commands', 'systemPrompt'] as const

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function validateConfig(config: PluginConfig): void {
  for (const [key, min, max] of [
    ['recallLimit', 1, 50],
    ['budgetChars', 200, 20000],
    ['minPromptChars', 1, 1000],
    ['storeNudgeEvery', 0, 1000],
  ] as const) {
    const value = config[key]
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new TypeError(`memlite: invalid ${key}`)
    }
  }
  if (!Number.isFinite(config.recallThreshold) || config.recallThreshold < 0 || config.recallThreshold > 1) {
    throw new TypeError('memlite: invalid recallThreshold')
  }
}

/** 显式存储回执（对齐 respire-dsh 的 R11 读回：id/标题/全文逐项比对）。 */
function storeReceipt(mem: Memlite, id: string, title: string, content: string): string {
  let verdict = 'unavailable'
  try {
    const shown = mem.show(id)
    if (shown) {
      verdict =
        shown.record.id === id &&
        shown.record.title === title.trim() &&
        shown.record.content.trim() === content.trim()
          ? 'verified'
          : 'mismatch'
    }
  } catch {
    verdict = 'unavailable'
  }
  const tail =
    verdict === 'verified'
      ? '读回校验通过（id/标题/全文一致）。标题是暂定的，需要时用 memlite_update 改；不要重复写。'
      : verdict === 'mismatch'
        ? `读回显示 id/标题/全文与写入不一致；先用 memlite_show ${id8(id)} 检查，不要重写。`
        : `读回不可用；需要时用 memlite_show ${id8(id)} 核实。不要重复写。`
  return `【memlite · 已存】${title}（${id}）。${tail}`
}

export function apply(
  context: import('./types').PluginContext,
  configInput?: Partial<PluginConfig> | ConfigRef,
): (() => void) | undefined {
  const configRef = resolveConfigRef(configInput)
  const config = (): PluginConfig => readConfig(configRef)
  const enabled = (): boolean => config().enabled
  validateConfig(config())
  if (!enabled()) return undefined

  const lifetime = new AbortController()
  context.effect(() => () => lifetime.abort())

  const runtime = new MemoryRuntime(context, configRef)
  const mem = runtime.mem
  const states = new States()
  const disposers: Array<() => void> = []

  // 1. 静态规则：与是否召回命中无关，恒定注入（volatile 关闭时按次返回空串）。
  context.inject(['systemPrompt'], (scoped) => {
    const systemPrompt = (scoped as unknown as Scoped).systemPrompt
    if (!systemPrompt) return
    disposers.push(
      systemPrompt.section({
        name: 'memlite:rules',
        order: 850,
        text: () => (enabled() ? RULES : ''),
        interpolate: false,
      }),
    )
  })

  // 2. 命令面：原 16 个 /memlite-* 保持不变（关闭时回执拒绝）。
  context.inject(['commands'], (scoped) => {
    const commands = (scoped as unknown as Scoped).commands
    if (!commands) return
    disposers.push(registerCommands(commands, mem, enabled))
  })

  // 3. 模型工具面：等价于 respire-dsh 里模型执行 rsrs CLI 的那条通道（关闭时回执拒绝）。
  context.inject(['tools'], (scoped) => {
    const tools = (scoped as unknown as Scoped).tools
    if (!tools) return
    disposers.push(registerMemoryTools(tools, mem, enabled))
  })

  // 3b. Obsidian 配置页路由：认证、Host/Origin 栅栏与 owner Peer 由 connection 负责。
  context.inject(['connection'], (scoped) => {
    const connection = (scoped as unknown as Scoped).connection as ConnectionService | undefined
    if (!connection) return
    const handlers = createObsidianHandlers(() => runtime.mem)
    disposers.push(...registerObsidianRoutes(connection, handlers))
  })

  // 4. 召回 / 显式存储：pre-step waterfall，先等下游决策，再追加消息。
  onWaterfall<PreStepPayload>(context, 'agent/pre-step', async ({ agent, turn, signal }, next) => {
    const decision = (await next()) as PreStepDecision
    if (!decision || decision.kind === 'reject' || signal.aborted || lifetime.signal.aborted) return decision

    const messages = Array.isArray(decision.messages) ? decision.messages : []
    const humans = messages.filter((message) => {
      const source = (message as { source?: { kind?: unknown } } | undefined)?.source
      return source?.kind === 'user'
    })
    if (humans.length === 0) return decision
    if (!enabled()) return decision

    const state = states.of(agent)
    const current = state.turn?.turn === turn ? state.turn : states.startTurn(state, turn)
    const additions: UserMessage[] = []
    const aborted = (): boolean => signal.aborted || lifetime.signal.aborted

    for (const raw of humans) {
      // 每条消息取一次快照：召回条数/阈值/预算等 volatile 字段即时生效。
      const cfg = config()
      if (!cfg.enabled) return decision
      const message = raw as { id?: unknown }
      const messageId = typeof message.id === 'string' ? message.id : ''
      if (messageId !== '') {
        if (current.processed.has(messageId)) continue
        current.processed.add(messageId)
      } else {
        const key = raw as object
        if (current.seen.has(key)) continue
        current.seen.add(key)
      }

      const prompt = messageText(raw).trim()
      if (prompt === '') continue
      current.hadUser = true

      // 每 agent 一生一次 status 体检（respire-dsh 的 state.checked）。
      if (!state.checked) {
        state.checked = true
        try {
          const status = await mem.status()
          if (aborted()) return decision
          state.ready = true
          const records = Number((status as Record<string, unknown>)['records'] ?? 0)
          const badLines = Number((status as Record<string, unknown>)['bad_lines'] ?? 0)
          if (records === 0) {
            additions.push(
              contextMessage('【memlite · 状态】记忆库为空。空召回是正常的；把已确认的项目约定/决策用「记：…」显式存下来。'),
            )
          } else if (records < 10) {
            additions.push(
              contextMessage(`【memlite · 状态】库里只有 ${records} 条记忆，空召回很正常；把已确认的项目约定显式存下来。`),
            )
          }
          if (badLines > 0) {
            additions.push(contextMessage(`【memlite · 状态】库里有 ${badLines} 行坏数据；必要时用 /memlite-status 检查。`))
          }
        } catch (error) {
          if (aborted()) return decision
          state.ready = false
          additions.push(
            contextMessage(
              `【memlite · 状态】记忆引擎不可用（${errorText(error)}）。本次任务继续；本轮不自动召回、也不做收尾提醒。`,
            ),
          )
        }
      }

      if (SKIP_PREFIX.test(prompt)) continue

      // 敏感闸与 memlite 引擎同源（sensitiveGate=false 时自然放行）。
      try {
        mem.scanOrReject(prompt)
      } catch (error) {
        additions.push(
          contextMessage(`【memlite · 已跳过】输入疑似包含凭据，未用于召回或存储。${errorText(error)}`),
        )
        continue
      }

      const store = STORE_PREFIX.exec(prompt)
      if (store) {
        const content = prompt.slice(store[0].length).trim()
        if (content === '') {
          additions.push(contextMessage('【memlite · 未存】内容为空；请给出要存的事实。'))
          continue
        }
        const title = titleOf(content)
        try {
          const id = await mem.remember(content, { title, extra: { importance: 'important' } })
          if (aborted()) return decision
          state.ready = true
          current.stored = true
          additions.push(contextMessage(storeReceipt(mem, id, title, content)))
        } catch (error) {
          if (aborted()) return decision
          additions.push(
            contextMessage(`【memlite · 未存】${errorText(error)}。本条没有写入；不要自动重试，也不要声称成功。`),
          )
        }
        continue
      }

      if (prompt.length < cfg.minPromptChars) continue

      const query = prompt.replace(SKILL_PREFIX, '').trim() || prompt
      try {
        const result = await mem.recall(query, { limit: cfg.recallLimit })
        if (aborted()) return decision
        state.ready = true
        const text = renderRecallTitles(result, cfg.recallThreshold, cfg.budgetChars)
        if (text !== '') additions.push(contextMessage(text))
      } catch (error) {
        if (aborted()) return decision
        additions.push(
          contextMessage(`【memlite · 召回不可用】${errorText(error)}。未获得记忆；继续用当前材料。`),
        )
      }
    }

    if (aborted() || additions.length === 0) return decision
    return { ...decision, messages: [...messages, ...additions] }
  })

  // 5. 收尾 steer：不查库、不写库，只提醒一次（respire-dsh 的 one-round bounded steer）。
  onEvent(context, 'agent/turn-stopping', (payload) => {
    const p = payload as TurnStoppingPayload
    const agent = p?.agent as AgentLike | undefined
    if (agent === undefined || agent === null || typeof agent !== 'object') return
    if (p.signal?.aborted || lifetime.signal.aborted) return

    const state = states.peek(agent)
    const current = state?.turn
    if (!state?.ready || !current || current.turn !== p.turn) return
    if (!current.hadUser || current.stored || current.reminded) return
    const cfg = config()
    if (!cfg.enabled) return
    if (cfg.storeNudgeEvery === 0 || state.rounds % cfg.storeNudgeEvery !== 0) return

    current.reminded = true
    if (typeof agent.steer !== 'function') return
    agent.steer(contextMessage(WRAP_UP))
  })

  // 6. agent 销毁时清状态（WeakMap 本身可回收，显式 drop 更干净）。
  onEvent(context, 'agent/disposed', (payload) => {
    const agent = (payload as { agent?: object } | undefined)?.agent
    if (agent !== null && typeof agent === 'object') states.drop(agent)
  })

  if (config().sync.auto) {
    void mem.sync().catch((error: unknown) => {
      context.logger?.warn?.(`memlite: 启动同步失败: ${errorText(error)}`)
    })
  }

  return () => {
    runtime.dispose()
    for (const d of disposers.splice(0)) d()
  }
}
