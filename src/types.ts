/**
 * DSH 服务与插件的形状类型（结构化、零 dsh 包运行时依赖——服务由宿主在挂载时提供）。
 * 形状按 @deepseek-ai/dsh@0.2.2-rc.1 的权威 .d.ts 抄录（M0 实测，docs/proposal.md §十三）。
 */
import type { Context } from '@deepseek-ai/cordis'

/** 命令结果（dsh-commands types.d.ts）：kind 联合，UI 直接渲染。 */
export type CommandResult =
  | { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: unknown }
  | { readonly kind: 'error'; readonly text: string }

export function ok(text: string): CommandResult {
  return { kind: 'success', text }
}

export function fail(text: string): CommandResult {
  return { kind: 'error', text }
}

/** 命令调用实参（dsh-commands CommandInvocation 的结构子集）。 */
export interface CommandInvocation {
  readonly commandId: unknown
  readonly agent?: { readonly id?: unknown }
  /** 命令名之后的原文（含分隔空白）。 */
  readonly rawInput: string
  readonly signal?: AbortSignal
}

/** 命令定义（dsh-commands）：字段是 handler 不是 execute——写错静默不注册。 */
export interface CommandDefinition {
  readonly name: string
  readonly description: string
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

/** 命令注册表服务面（插件只用 register）。 */
export interface CommandsService {
  register(definition: CommandDefinition): () => void
}

/** section text 收到的拼装上下文：类型面只有 {scope?, signal?}，
 * 运行时 dsh-agent 的 assembleContextFor 实传 {agent, scope, signal}——防御性读取 agent。 */
export interface AssembleContext {
  readonly scope?: unknown
  readonly signal?: AbortSignal
  readonly agent?: { readonly id?: unknown }
}

export interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: AssembleContext) => string)
  /** respire-dsh 同款：静态文案不做模板插值。 */
  readonly interpolate?: boolean
}

export interface SystemPromptService {
  section(section: PromptSection): () => void
}

/** 凭据解析结果（dsh-credentials ResolvedCredential）。 */
export interface ResolvedCredential {
  readonly value: string
  readonly source: string
}

export interface CredentialsService {
  /** 0.2.2-rc.1：方法名是 resolve 不是 get（M0 漂移一）。 */
  resolve(ref: string): Promise<ResolvedCredential | undefined>
}

/** 插件所需宿主服务集合（经 ctx.inject 作用域收到的形状）。 */
export interface HostServices {
  credentials?: CredentialsService
  commands?: CommandsService
  systemPrompt?: SystemPromptService
}

/** 插件可用的宿主上下文面（真 cordis Context；inject/effect/on/logger 全部用宿主自带）。 */
export type PluginContext = Context

/** 任意字符串事件的类型收窄监听（agent/* 事件不在 cordis Events 映射内）。 */
export function onEvent(ctx: PluginContext, event: string, listener: (payload: unknown) => void): () => void {
  const on = ctx.on as unknown as (e: string, l: (payload: unknown) => void) => () => void
  return on(event, listener)
}

/** turn-stopping 事件 payload（dsh-agent runtime-types）。 */
export interface TurnStoppingPayload {
  readonly agent: { readonly id?: unknown }
  readonly turn: number
  readonly signal: AbortSignal
}

/** inbox/inserted 事件 payload：用户消息入队（M3 的 recall 触发点）。 */
export interface InboxInsertedPayload {
  readonly agent: { readonly id?: unknown }
  readonly message: unknown
}

/** 宿主作用域（ctx.inject 回调实参的结构化视图）。 */
export type Scoped = {
  credentials?: CredentialsService
  commands?: CommandsService
  systemPrompt?: SystemPromptService
  tools?: ToolsService
  [key: string]: unknown
}

/** 注入的用户消息（宿主 Message 的结构子集；id 由插件生成）。 */
export interface UserMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>
  readonly source: { readonly kind: string }
}

/** agent/pre-step 载荷里的 agent 面（steer 由 turn-stopping 用；session 是运行时附加面）。 */
export interface AgentLike {
  readonly id?: unknown
  /** 运行时 Agent 的 Session（dsh-agent-loop：this.session；id 与 agent.id 同源）。 */
  readonly session?: { readonly id?: unknown; readonly cwd?: unknown }
  steer?(message: UserMessage): unknown
}

/** agent/pre-step 载荷（dsh-agent runtime-types）。 */
export interface PreStepPayload {
  readonly agent: AgentLike
  readonly turn: number
  readonly signal: AbortSignal
}

/** 下游 waterfall 的决策：enter 可带 messages，reject 不再追加。 */
export interface PreStepDecision {
  readonly kind: 'enter' | 'reject'
  readonly messages?: ReadonlyArray<unknown>
  [key: string]: unknown
}

/** 模型工具定义（dsh-tools 注册面所需字段；output.render 产出具名内容块）。 */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    readonly render: (
      args: Record<string, unknown>,
      value: string,
    ) => Array<{ readonly type: 'text'; readonly text: string }>
  }
  execute(
    args: Record<string, unknown>,
    exec: { readonly signal?: AbortSignal },
  ): Promise<string> | string
}

export interface ToolsService {
  register(definition: ToolDefinition): () => void
}

/** 任意字符串事件的 waterfall 监听（agent/pre-step 不在 cordis Events 映射内）。 */
export function onWaterfall<T>(
  ctx: PluginContext,
  event: string,
  listener: (payload: T, next: () => unknown) => unknown,
): () => void {
  const on = ctx.on as unknown as (
    e: string,
    l: (payload: T, next: () => unknown) => unknown,
  ) => () => void
  return on(event, listener)
}

/** 从宿主消息对象提取纯文本（MessageBase.content: string | ContentBlock[] 的防御式读取）。 */
export function messageText(message: unknown): string {
  if (typeof message === 'string') return message
  if (message && typeof message === 'object') {
    const content = (message as { content?: unknown }).content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .map((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
          ? String((b as { text?: unknown }).text ?? '')
          : ''))
        .filter((t) => t !== '')
        .join('\n')
        .trim()
    }
  }
  return ''
}
