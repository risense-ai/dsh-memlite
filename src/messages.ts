/**
 * 注入消息构造：宿主 Message 的结构子集（role/content/source/id），
 * 与 @deepseek-ai/dsh-llm 的 createUserMessage 同形；不引入宿主包依赖。
 * id 用 UUID（宿主的 brandString 在运行时就是原字符串）。
 */
import { randomUUID } from 'node:crypto'
import type { UserMessage } from './types'

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

/** 一条插件来源的用户消息；source.kind 让 pre-step 不把自己的注入当人类消息。 */
export function contextMessage(text: string): UserMessage {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'memlite' },
  }) as UserMessage
}
