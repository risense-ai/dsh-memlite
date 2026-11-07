/**
 * respire 式插件逻辑集成测试：静态规则、pre-step 召回/存储、状态体检、
 * 敏感闸、/nomem、收尾 steer、模型工具面。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index'
import {
  createTestHost,
  dispatchPreStep,
  emitEvent,
  expectSuccess,
  injectedTexts,
  type TestHost,
} from './harness'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.dispose()
})

async function hostWithPlugin(config: Record<string, unknown> = {}) {
  const h = await createTestHost()
  hosts.push(h)
  h.cleanup = apply(h.ctx as never, { dataDir: h.dataDir, sync: { auto: false }, ...config })
  await new Promise((r) => setTimeout(r, 10))
  return h
}

function human(id: string, text: string) {
  return {
    id,
    role: 'user' as const,
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

describe('静态规则 section', () => {
  it('注册 memlite:rules（order 850），不再有 off-turn 记忆 section', async () => {
    const h = await hostWithPlugin()
    expect([...h.systemPrompt.sections.keys()]).toEqual(['memlite:rules'])
    const section = h.systemPrompt.sections.get('memlite:rules')!
    expect(section.order).toBe(850)
    const rules = h.systemPrompt.assemble('a1').find((s) => s.name === 'memlite:rules')
    expect(rules?.text).toContain('memlite 记忆层')
    expect(rules?.text).toContain('memlite_show')
  })
})

describe('pre-step 召回', () => {
  it('人类消息触发召回，注入标题 + 读正文提示；首条消息附带状态体检', async () => {
    const h = await hostWithPlugin()
    expectSuccess(
      await h.commands.invoke('seed', '/memlite-remember nginx 反代 504 超时排查手册 --title nginx手册'),
      '已存',
    )
    const agent = { id: 'a1' }
    const decision = await dispatchPreStep(
      h,
      { agent, turn: 1, signal: signal() },
      { kind: 'enter', messages: [human('m1', 'nginx 504 怎么排查')] },
    )
    const texts = injectedTexts(decision)
    const recall = texts.find((t) => t.includes('自动召回'))
    expect(recall, '召回消息已注入').toBeDefined()
    expect(recall).toContain('nginx手册')
    expect(recall).toContain('memlite_show')
    expect(texts.some((t) => t.includes('状态'))).toBe(true)
  })

  it('同一 turn 同一条消息不重复召回', async () => {
    const h = await hostWithPlugin()
    expectSuccess(await h.commands.invoke('seed', '/memlite-remember redis 大 key 排查 --title redis题'), '已存')
    const agent = { id: 'a2' }
    const payload = { agent, turn: 1, signal: signal() }
    await dispatchPreStep(h, payload, { kind: 'enter', messages: [human('m1', 'redis 内存涨')] })
    const second = await dispatchPreStep(h, payload, { kind: 'enter', messages: [human('m1', 'redis 内存涨')] })
    expect(injectedTexts(second)).toHaveLength(0)
  })

  it('/nomem 只跳过该条消息', async () => {
    const h = await hostWithPlugin()
    expectSuccess(await h.commands.invoke('seed', '/memlite-remember nginx 504 排查 --title nginx题'), '已存')
    const agent = { id: 'a3' }
    await dispatchPreStep(h, { agent, turn: 1, signal: signal() }, { kind: 'enter', messages: [human('m1', 'nginx 504')] })
    const ignored = await dispatchPreStep(
      h,
      { agent, turn: 1, signal: signal() },
      { kind: 'enter', messages: [human('m2', '/nomem nginx 504')] },
    )
    expect(injectedTexts(ignored)).toHaveLength(0)
  })

  it('敏感输入不用于召回/存储，并给出跳过回执', async () => {
    const h = await hostWithPlugin()
    expectSuccess(await h.commands.invoke('seed', '/memlite-remember 普通记忆 --title 题'), '已存')
    const agent = { id: 'a4' }
    const decision = await dispatchPreStep(
      h,
      { agent, turn: 1, signal: signal() },
      { kind: 'enter', messages: [human('m1', '密码是hunter2secret')] },
    )
    const texts = injectedTexts(decision)
    expect(texts.some((t) => t.includes('已跳过'))).toBe(true)
    expect(texts.some((t) => t.includes('自动召回'))).toBe(false)
  })
})

describe('显式存储（记：/存：/remember:）', () => {
  it('写入 + 读回校验 + 回执', async () => {
    const h = await hostWithPlugin()
    const agent = { id: 's1' }
    const decision = await dispatchPreStep(
      h,
      { agent, turn: 1, signal: signal() },
      { kind: 'enter', messages: [human('m1', '记：redis 大 key 排查步骤 先看 slowlog')] },
    )
    const texts = injectedTexts(decision)
    const receipt = texts.find((t) => t.includes('已存'))
    expect(receipt).toContain('读回校验通过')
    const overview = expectSuccess(await h.commands.invoke('s1', '/memlite'))
    expect(overview).toContain('1 条')
  })

  it('空内容不写，回执说明未存', async () => {
    const h = await hostWithPlugin()
    const agent = { id: 's2' }
    const decision = await dispatchPreStep(
      h,
      { agent, turn: 1, signal: signal() },
      { kind: 'enter', messages: [human('m1', '记：   ')] },
    )
    expect(injectedTexts(decision).some((t) => t.includes('未存'))).toBe(true)
    expect(expectSuccess(await h.commands.invoke('s2', '/memlite'))).toContain('0 条')
  })
})

describe('收尾 steer（turn-stopping）', () => {
  async function readyAgent(h: TestHost, id: string) {
    const steers: string[] = []
    const agent = {
      id,
      steer: (message: { content: Array<{ text: string }> }) => {
        steers.push(message.content.map((b) => b.text).join('\n'))
      },
    }
    await dispatchPreStep(
      h,
      { agent, turn: 1, signal: signal() },
      { kind: 'enter', messages: [human(`${id}-m1`, 'redis 大 key')] },
    )
    return { agent, steers }
  }

  it('本轮有用户消息且引擎可用 → 提醒一次；重复 stop 不再提醒', async () => {
    const h = await hostWithPlugin()
    expectSuccess(await h.commands.invoke('seed', '/memlite-remember redis 大 key 排查 --title redis题'), '已存')
    const { agent, steers } = await readyAgent(h, 't1')
    emitEvent(h, 'agent/turn-stopping', { agent, turn: 1, signal: signal() })
    expect(steers).toHaveLength(1)
    expect(steers[0]).toContain('收尾自查')
    emitEvent(h, 'agent/turn-stopping', { agent, turn: 1, signal: signal() })
    expect(steers).toHaveLength(1)
  })

  it('本轮已显式存过 → 不再提醒', async () => {
    const h = await hostWithPlugin()
    const steers: string[] = []
    const agent = { id: 't2', steer: (m: { content: Array<{ text: string }> }) => steers.push(m.content.map((b) => b.text).join('\n')) }
    await dispatchPreStep(
      h,
      { agent, turn: 1, signal: signal() },
      { kind: 'enter', messages: [human('m1', '记：本轮结论已存')] },
    )
    emitEvent(h, 'agent/turn-stopping', { agent, turn: 1, signal: signal() })
    expect(steers).toHaveLength(0)
  })

  it('storeNudgeEvery=0 关闭提醒', async () => {
    const h = await hostWithPlugin({ storeNudgeEvery: 0 })
    expectSuccess(await h.commands.invoke('seed', '/memlite-remember redis 大 key 排查 --title redis题'), '已存')
    const { agent, steers } = await readyAgent(h, 't3')
    emitEvent(h, 'agent/turn-stopping', { agent, turn: 1, signal: signal() })
    expect(steers).toHaveLength(0)
  })
})

describe('模型工具面', () => {
  it('注册 5 个 memlite_* 工具', async () => {
    const h = await hostWithPlugin()
    expect([...h.tools.definitions.keys()]).toEqual([
      'memlite_recall',
      'memlite_show',
      'memlite_remember',
      'memlite_update',
      'memlite_attach',
    ])
  })

  it('remember → recall → show → update 全链路', async () => {
    const h = await hostWithPlugin()
    const receipt = await h.tools.invoke('memlite_remember', {
      content: 'redis 大 key 排查：先看 slowlog 再抽样',
      title: 'redis大key排查',
      importance: 'important',
    })
    expect(receipt).toContain('已存')
    expect(receipt).toContain('读回校验通过')
    const id = /已存 ([0-9a-f]{8,})/.exec(receipt)![1]!
    const recalled = await h.tools.invoke('memlite_recall', { query: 'redis 大 key' })
    expect(recalled).toContain('redis大key排查')
    const shown = await h.tools.invoke('memlite_show', { id })
    expect(shown).toContain('slowlog')
    const updated = await h.tools.invoke('memlite_update', { id, title: 'redis大key排查法' })
    expect(updated).toContain('redis大key排查法')
  })

  it('敏感内容写入被拒（与引擎同一道闸）', async () => {
    const h = await hostWithPlugin()
    await expect(
      h.tools.invoke('memlite_remember', { content: '密码是hunter2secret' }),
    ).rejects.toThrow(/拒绝入库/)
  })
})

