/** 系统提示注入集成测试：双点刷新、多 agent 隔离、诊断拼装返回空、开关关闭。 */
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index'
import { createTestHost, expectSuccess, type TestHost } from './harness'

const hosts: TestHost[] = []

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.dispose()
})

async function hostWithPlugin(config: Record<string, unknown> = {}) {
  const h = await createTestHost()
  hosts.push(h)
  h.cleanup = apply(h.ctx as never, { dataDir: h.dataDir, sync: { auto: false }, ...config })
  // 等插件 fiber 内的 inject 注册生效
  await new Promise((r) => setTimeout(r, 10))
  return h
}

function sectionText(h: TestHost, agentId?: string): string {
  const sections = h.systemPrompt.assemble(agentId)
  const mem = sections.find((s) => s.name === 'memlite:context')
  expect(mem, 'memlite section 已注册').toBeDefined()
  return mem!.text
}

describe('section 注册与读取', () => {
  it('单一 section 注册（重复注册会 throw 的名字只出现一次）', async () => {
    const h = await hostWithPlugin()
    expect([...h.systemPrompt.sections.keys()]).toEqual(['memlite:context'])
  })

  it('诊断拼装（无 agent）返回空', async () => {
    const h = await hostWithPlugin()
    expect(sectionText(h)).toBe('')
  })
})

describe('off-turn 双点刷新', () => {
  it('inbox/inserted 触发 recall → section 读到记忆块', async () => {
    const h = await hostWithPlugin()
    expectSuccess(await h.commands.invoke('seed', '/memlite-remember nginx 反代 504 超时排查手册 --title nginx手册'), '已存')
    // 模拟宿主派发 inbox/inserted
    const listeners = listenersOf(h, 'agent/inbox/inserted')
    expect(listeners.length).toBeGreaterThan(0)
    for (const l of listeners) l({ agent: { id: 'sess-1' }, message: { role: 'user', content: [{ type: 'text', text: 'nginx 504 怎么排查' }] } })
    await new Promise((r) => setTimeout(r, 30)) // recall 异步完成
    const text = sectionText(h, 'sess-1')
    expect(text).toContain('## 相关记忆')
    expect(text).toContain('nginx手册')
    expect(text).toContain('/memlite-show')
    // 另一个 agent 读不到（不串味）
    expect(sectionText(h, 'sess-2')).toBe('')
  })

  it('turn-stopping 复用最近 query 保底刷新', async () => {
    const h = await hostWithPlugin()
    expectSuccess(await h.commands.invoke('seed', '/memlite-remember redis 大 key 排查 --title redis题'), '已存')
    for (const l of listenersOf(h, 'agent/inbox/inserted')) {
      l({ agent: { id: 's1' }, message: { role: 'user', content: 'redis 内存涨' } })
    }
    await new Promise((r) => setTimeout(r, 30))
    expect(sectionText(h, 's1')).toContain('redis题')
    // turn-stopping：再命中一次（库可能已被本轮更新）
    for (const l of listenersOf(h, 'agent/turn-stopping')) {
      l({ agent: { id: 's1' }, turn: 1, signal: new AbortController().signal })
    }
    await new Promise((r) => setTimeout(r, 30))
    expect(sectionText(h, 's1')).toContain('redis题')
    // disposed 清缓存
    for (const l of listenersOf(h, 'agent/disposed')) l({ agent: { id: 's1' } })
    expect(sectionText(h, 's1')).toBe('')
  })

  it('autoInject.enabled=false 时 section 恒空', async () => {
    const h = await hostWithPlugin({ autoInject: { enabled: false, maxMemories: 5, maxChars: 2000 } })
    expectSuccess(await h.commands.invoke('seed', '/memlite-remember 某条记忆 --title 题'), '已存')
    for (const l of listenersOf(h, 'agent/inbox/inserted')) {
      l({ agent: { id: 's1' }, message: { role: 'user', content: '某条' } })
    }
    await new Promise((r) => setTimeout(r, 30))
    expect(sectionText(h, 's1')).toBe('')
  })

  it('maxChars 截断注入块', async () => {
    const h = await hostWithPlugin({ autoInject: { enabled: true, maxMemories: 10, maxChars: 400 } })
    for (let i = 0; i < 8; i++) {
      expectSuccess(await h.commands.invoke('seed', `/memlite-remember 长内容条目${i} ${'细节'.repeat(40)} --title 题${i}`), '已存')
    }
    for (const l of listenersOf(h, 'agent/inbox/inserted')) {
      l({ agent: { id: 's1' }, message: { role: 'user', content: '长内容' } })
    }
    await new Promise((r) => setTimeout(r, 40))
    const text = sectionText(h, 's1')
    expect(text.length).toBeLessThanOrEqual(400)
    expect(text).toContain('## 相关记忆')
  })

  it('60 轮会话 prompt 长度稳定（每轮刷新覆盖同键）', async () => {
    const h = await hostWithPlugin()
    expectSuccess(await h.commands.invoke('seed', '/memlite-remember 稳定记忆 --title 稳定'), '已存')
    let first = ''
    for (let turn = 0; turn < 60; turn++) {
      for (const l of listenersOf(h, 'agent/inbox/inserted')) {
        l({ agent: { id: 's1' }, message: { role: 'user', content: `稳定 第${turn}轮` } })
      }
      for (const l of listenersOf(h, 'agent/turn-stopping')) {
        l({ agent: { id: 's1' }, turn, signal: new AbortController().signal })
      }
      await new Promise((r) => setTimeout(r, 5))
      const t = sectionText(h, 's1')
      if (turn === 0) first = t
      else expect(t.length).toBeLessThanOrEqual(Math.max(first.length, 2000) + 10)
    }
    expect(first).toContain('稳定记忆')
  }, 60000)
})

/** 经真核事件总线派发（onEvent 注册的监听由 cordis 路由）。 */
function listenersOf(_h: TestHost, event: string): Array<(p: unknown) => void> {
  return [(payload: unknown) => {
    (_h.ctx as unknown as { emit(e: string, p: unknown): void }).emit(event, payload)
  }]
}
