/**
 * 测试宿主：真 cordis 核 + 形状忠实的宿主服务替身（dsh 服务的形状按 0.2.2-rc.1 权威 .d.ts）。
 * 插件侧代码（apply/cache/prompt/commands）全部真实运行；替身只替代宿主服务本身。
 */
import { Context, Service } from '@deepseek-ai/cordis'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { expect } from 'vitest'
import type { CommandDefinition, CommandResult, ToolDefinition } from '../src/types'

/** 命令注册表替身：单 token 名强校验（复刻 dsh COMMAND_NAME 行为） + 分发。 */
export class CommandsHost extends Service {
  static provide = 'commands'
  readonly definitions = new Map<string, CommandDefinition>()

  register(d: CommandDefinition): () => void {
    // dsh-commands index.js:150 同款校验——含空格/大写即 throw（M0 漂移四）
    if (!/^[a-z][a-z0-9_-]*$/u.test(d.name)) {
      throw new TypeError(`command name "${d.name}" must match /^[a-z][a-z0-9_-]*$/u`)
    }
    if (typeof d.handler !== 'function') {
      throw new TypeError(`command "${d.name}" handler must be a function`)
    }
    this.definitions.set(d.name, d)
    return () => this.definitions.delete(d.name)
  }

  /** 按宿主分发语义调用：/name rawInput → handler({agent, rawInput})。 */
  async invoke(agentId: string, line: string): Promise<CommandResult> {
    const m = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line)
    if (m === null) throw new Error(`bad command line: ${line}`)
    const d = this.definitions.get(m[1]!)
    if (!d) throw new Error(`command not found: ${m[1]}`)
    const rawInput = line.slice(m[0].length)
    return d.handler({ commandId: 'test', agent: { id: agentId }, rawInput, signal: new AbortController().signal })
  }
}

export interface AssembledSectionView {
  name: string
  text: string
}

/** systemPrompt 服务替身：section 记录 + 按 AssembleContext 形状拼装（无 agent 时 agent 字段缺席）。 */
export class SystemPromptHost extends Service {
  static provide = 'systemPrompt'
  readonly sections = new Map<string, { order: number; text: string | ((c: unknown) => string) }>()

  section(s: { name: string; order: number; text: string | ((c: unknown) => string) }): () => void {
    if (this.sections.has(s.name)) throw new Error(`duplicate section: ${s.name}`)
    this.sections.set(s.name, { order: s.order, text: s.text })
    return () => this.sections.delete(s.name)
  }

  /** 复刻宿主拼装：有 agentId 时传 {agent:{id}, scope:{}, signal}；无 agent 时对象里没有 agent 键。 */
  assemble(agentId?: string): AssembledSectionView[] {
    const out: AssembledSectionView[] = []
    for (const [name, s] of [...this.sections.entries()].sort((a, b) => a[1].order - b[1].order)) {
      const ctx: Record<string, unknown> = { scope: agentId ? { sid: agentId } : undefined, signal: undefined }
      if (agentId !== undefined) ctx['agent'] = { id: agentId }
      out.push({ name, text: typeof s.text === 'string' ? s.text : s.text(ctx) })
    }
    return out
  }
}

/** credentials 服务替身：dsh-credentials 形状（resolve → {value, source} | undefined）。 */
export class CredentialsHost extends Service {
  static provide = 'credentials'
  readonly store = new Map<string, string>()

  async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
    const v = this.store.get(ref)
    return v !== undefined ? { value: v, source: 'file' } : undefined
  }
}

/** tools 服务替身：注册表 + 直接调用（形状按 dsh-tools register/execute 的公共面）。 */
export class ToolsHost extends Service {
  static provide = 'tools'
  readonly definitions = new Map<string, ToolDefinition>()

  register(definition: ToolDefinition): () => void {
    if (definition?.output === undefined || typeof definition.output.render !== 'function') {
      throw new TypeError(`tool "${definition?.name}" must declare output { schema, render }`)
    }
    if (this.definitions.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`)
    this.definitions.set(definition.name, definition)
    return () => this.definitions.delete(definition.name)
  }

  async invoke(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const definition = this.definitions.get(name)
    if (!definition) throw new Error(`tool not found: ${name}`)
    return await definition.execute(args, { signal: new AbortController().signal })
  }
}

export interface TestHost {
  ctx: Context
  commands: CommandsHost
  systemPrompt: SystemPromptHost
  credentials: CredentialsHost
  tools: ToolsHost
  dataDir: string
  /** apply 返回的清理句柄（effect 唯一 dispose 通路）。由 withPlugin() 注入。 */
  cleanup?: () => void
  dispose(): Promise<void>
}

const dirs: string[] = []

/** 隔离用户级回退：memlite 在项目级无命中时会读 ~/memlite-data，测试不能命中真实记忆库。 */
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }

export async function createTestHost(): Promise<TestHost> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memlite-'))
  dirs.push(dataDir)
  process.env.HOME = dataDir
  process.env.USERPROFILE = dataDir
  const ctx = new Context()
  const plugin = ctx.plugin as unknown as (p: unknown) => unknown
  plugin(CommandsHost)
  plugin(SystemPromptHost)
  plugin(CredentialsHost)
  plugin(ToolsHost)
  await new Promise((r) => setTimeout(r, 5))
  const h: TestHost = {
    ctx,
    // 真核把服务实例挂到 ctx 属性上（cordis Service.provide 语义）
    commands: (ctx as unknown as { commands: CommandsHost }).commands,
    systemPrompt: (ctx as unknown as { systemPrompt: SystemPromptHost }).systemPrompt,
    credentials: (ctx as unknown as { credentials: CredentialsHost }).credentials,
    tools: (ctx as unknown as { tools: ToolsHost }).tools,
    dataDir,
    dispose: async () => {
      h.cleanup?.()
      if (savedEnv.HOME === undefined) delete process.env.HOME
      else process.env.HOME = savedEnv.HOME
      if (savedEnv.USERPROFILE === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = savedEnv.USERPROFILE
      fs.rmSync(dataDir, { recursive: true, force: true })
      const i = dirs.indexOf(dataDir)
      if (i >= 0) dirs.splice(i, 1)
    },
  }
  return h
}

export function expectSuccess(r: CommandResult, contains?: string): string {
  expect(r.kind).toBe('success')
  const text = r.kind === 'success' ? (r.text ?? '') : ''
  if (contains !== undefined) expect(text).toContain(contains)
  return text
}

export function expectError(r: CommandResult, contains?: string): string {
  expect(r.kind).toBe('error')
  const text = r.kind === 'error' ? r.text : ''
  if (contains !== undefined) expect(text).toContain(contains)
  return text
}

/** 按宿主语义派发 agent/pre-step waterfall（最后一段是基础决策）。 */
export async function dispatchPreStep(
  host: TestHost,
  payload: { agent: unknown; turn: number; signal: AbortSignal },
  decision: { kind: 'enter' | 'reject'; messages?: unknown[] },
): Promise<Record<string, unknown>> {
  const waterfall = (host.ctx as unknown as {
    waterfall(...args: unknown[]): unknown
  }).waterfall
  return (await waterfall.call(host.ctx, 'agent/pre-step', payload, () => decision)) as Record<string, unknown>
}

/** 从决策里取插件注入的 memlite 消息文本。 */
export function injectedTexts(decision: Record<string, unknown>): string[] {
  const messages = (decision['messages'] ?? []) as Array<{
    source?: { kind?: string }
    content?: Array<{ text?: string }>
  }>
  return messages
    .filter((m) => m.source?.kind === 'memlite')
    .map((m) => (m.content ?? []).map((b) => b.text ?? '').join('\n'))
}

/** 派发任意字符串事件（agent/* 不在 cordis Events 映射内，测试侧收窄）。 */
export function emitEvent(host: TestHost, event: string, payload: unknown): void {
  ;(host.ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit(event, payload)
}
