/**
 * 测试宿主：真 cordis 核 + 形状忠实的宿主服务替身（dsh 服务的形状按 0.2.2-rc.1 权威 .d.ts）。
 * 插件侧代码（apply/cache/prompt/commands）全部真实运行；替身只替代宿主服务本身。
 */
import { Context, Service } from '@deepseek-ai/cordis'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { expect } from 'vitest'
import type { CommandDefinition, CommandResult } from '../src/types'

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

export interface TestHost {
  ctx: Context
  commands: CommandsHost
  systemPrompt: SystemPromptHost
  credentials: CredentialsHost
  dataDir: string
  /** apply 返回的清理句柄（effect 唯一 dispose 通路）。由 withPlugin() 注入。 */
  cleanup?: () => void
  dispose(): Promise<void>
}

const dirs: string[] = []

export async function createTestHost(): Promise<TestHost> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memlite-'))
  dirs.push(dataDir)
  const ctx = new Context()
  const plugin = ctx.plugin as unknown as (p: unknown) => unknown
  plugin(CommandsHost)
  plugin(SystemPromptHost)
  plugin(CredentialsHost)
  await new Promise((r) => setTimeout(r, 5))
  const h: TestHost = {
    ctx,
    // 真核把服务实例挂到 ctx 属性上（cordis Service.provide 语义）
    commands: (ctx as unknown as { commands: CommandsHost }).commands,
    systemPrompt: (ctx as unknown as { systemPrompt: SystemPromptHost }).systemPrompt,
    credentials: (ctx as unknown as { credentials: CredentialsHost }).credentials,
    dataDir,
    dispose: async () => {
      h.cleanup?.()
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
