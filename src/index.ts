/**
 * @rsrsai/dsh-memlite 插件入口：持久本地记忆（@rsrsai/memlite 内核）。
 *
 * 装配次序（docs/proposal.md §四 / §十三）：
 * 1. ctx.effect 装配 Memlite（open/close 生命周期）
 * 2. MemliteCache + 双点 off-turn 刷新（inbox/inserted 最早 + turn-stopping 保底）
 * 3. commands / systemPrompt 经 ctx.inject 作用域注册（服务未就绪不炸）
 */
import { messageText, onEvent, type PluginContext } from './types'
import { Config, resolveConfig, type PluginConfig } from './schema'
import { assembleMemlite } from './lifecycle'
import { MemliteCache } from './cache'
import { registerCommands } from './commands'
import { SECTION_NAME, mountPromptLayer } from './prompt'
import type { Scoped, TurnStoppingPayload, InboxInsertedPayload } from './types'

export const name = '@rsrsai/dsh-memlite'
export { Config }

/** 宿主须提供的服务（providers 在 0.2.x 不存在，host 嵌入档不支持，见 proposal §十三）。 */
export const inject = ['credentials', 'commands', 'systemPrompt'] as const

export function apply(ctx: PluginContext, configInput?: Partial<PluginConfig>): () => void {
  const config = resolveConfig(configInput)
  const logger = ctx.logger ?? { warn: () => {}, info: () => {}, error: () => {} }

  // 1. 生命周期（effect 句柄即唯一 dispose 通路——宿主忽略返回值，测试直接调）
  const { mem, dispose } = assembleMemlite(ctx, config)

  // 2. 缓存与双点刷新
  const cache = new MemliteCache(mem, config.autoInject, (m) => logger.warn(m))

  // 项目解析：Agent 公共面无 workspace——从 runtime 面 session.cwd 防御性读取，走 memlite 项目解析
  const projectOf = (agentId: unknown): string => ''

  onEvent(ctx, 'agent/inbox/inserted', (payload) => {
    const p = payload as InboxInsertedPayload
    const id = p?.agent?.id
    if (typeof id !== 'string' || id === '') return
    const text = messageText(p.message)
    if (text === '') return
    void cache.refresh(id, text, projectOf(id))
  })

  onEvent(ctx, 'agent/turn-stopping', (payload) => {
    const p = payload as TurnStoppingPayload
    const id = p?.agent?.id
    if (typeof id !== 'string' || id === '') return
    void cache.refreshLast(id, projectOf(id))
  })

  onEvent(ctx, 'agent/disposed', (payload) => {
    const id = (payload as { agent?: { id?: unknown } })?.agent?.id
    if (typeof id === 'string') cache.drop(id)
  })

  // 3. 注册面：服务可用即挂载；命令是插件核心（即使无 systemPrompt 服务也要能用）
  const disposers: Array<() => void> = []
  ctx.inject(['commands'], (scoped) => {
    const commands = (scoped as unknown as Scoped).commands
    if (!commands) return
    disposers.push(registerCommands(commands, mem))
  })

  ctx.inject(['systemPrompt'], (scoped) => {
    const systemPrompt = (scoped as unknown as Scoped).systemPrompt
    if (!systemPrompt) return
    disposers.push(mountPromptLayer(ctx, systemPrompt, cache, () => config.autoInject.enabled))
    logger.info(`[memlite] 系统提示 section 已注册（${SECTION_NAME}）`)
  })

  // 同步开关（挂载时自动同步一次；失败不阻塞）
  if (config.sync.auto) {
    void mem.sync().catch((e) => logger.warn(`[memlite] 启动同步失败: ${e instanceof Error ? e.message : String(e)}`))
  }

  return () => {
    dispose()
    for (const d of disposers.splice(0)) d()
  }
}

