/**
 * systemPrompt section 注册：单 section、按 assembly.agent.id 取缓存（多 agent 不串味）。
 * M0 漂移二：AssembleContext 类型面无 agent，运行时实传——防御性读取；无 agent 返回空。
 */
import type { MemliteCache } from './cache'
import type { AssembleContext, PluginContext, SystemPromptService } from './types'

export const SECTION_NAME = 'memlite:context'
export const SECTION_ORDER = 120

export function registerPromptSection(
  systemPrompt: SystemPromptService,
  cache: MemliteCache,
  enabled: () => boolean,
): () => void {
  return systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (assembly: AssembleContext): string => {
      if (!enabled()) return ''
      // 防御性读取：运行时 dsh-agent 实传 agent（类型面未声明）；诊断拼装无 agent → 空串
      const agent = (assembly as AssembleContext | undefined)?.agent
      const id = agent?.id
      if (typeof id !== 'string' || id === '') return ''
      return cache.read(id)
    },
  })
}

/** wire 事件 + section 注册（在拥有 systemPrompt 服务的作用域调用）。 */
export function mountPromptLayer(
  ctx: PluginContext,
  systemPrompt: SystemPromptService,
  cache: MemliteCache,
  enabled: () => boolean,
): () => void {
  return registerPromptSection(systemPrompt, cache, enabled)
}
