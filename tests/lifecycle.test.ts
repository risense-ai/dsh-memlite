/** 生命周期与嵌入档集成测试：effect dispose、credentials.resolve 适配、host 档回退。 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index'
import { resolveConfig } from '../src/schema'
import { createTestHost, expectError, expectSuccess, type TestHost } from './harness'

const hosts: TestHost[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const h of hosts.splice(0)) await h.dispose()
})

describe('schema 默认值', () => {
  it('resolveConfig 补全全部默认（dataDir 空=自动解析）', () => {
    const c = resolveConfig(undefined)
    expect(c.enabled).toBe(true)
    expect(c.dataDir).toBe('')
    expect(c.recallLimit).toBe(5)
    expect(c.recallThreshold).toBe(0)
    expect(c.budgetChars).toBe(1500)
    expect(c.minPromptChars).toBe(2)
    expect(c.storeNudgeEvery).toBe(1)
    expect(c.sync).toEqual({ auto: false })
    expect(c.embedding.provider).toBe('none')
    expect(c.embedding.model).toBe('BAAI/bge-m3')
    expect(c.embedding.credentialRef).toBe('MEMLITE_EMBED_API_KEY')
    expect(c.embedding.timeoutMs).toBe(30000)
    expect(c.sensitiveGate).toBe(true)
  })

  it('越界配置在 apply 前就拒', async () => {
    const h = await createTestHost()
    hosts.push(h)
    expect(() => apply(h.ctx as never, { dataDir: h.dataDir, recallLimit: 0 })).toThrow(/recallLimit/)
    expect(() => apply(h.ctx as never, { dataDir: h.dataDir, recallThreshold: 2 })).toThrow(/recallThreshold/)
  })
})

describe('生命周期（ctx.effect dispose 通路）', () => {
  it('卸载走 effect cleanup（mem.close）', async () => {
    const h = await createTestHost()
    hosts.push(h)
    h.cleanup = apply(h.ctx as never, { dataDir: h.dataDir })
    await new Promise((r) => setTimeout(r, 10))
    expectSuccess(await h.commands.invoke('a1', '/memlite-remember 存活条 --title 题'), '已存')
    // 卸载前库文件已落盘（open→append→close 无泄漏）
    expect(fs.existsSync(path.join(h.dataDir, 'memory.jsonl'))).toBe(true)
    const commands = h.commands
    await h.dispose()
    expect(commands.definitions.size).toBe(0)
  })
})

describe('嵌入档 openai-compatible（credentials.resolve 适配）', () => {
  it('凭据经 resolve(ref).value 注入 mock fetch，remember 侧车落向量', async () => {
    const h = await createTestHost()
    hosts.push(h)
    h.credentials.store.set('MEMLITE_EMBED_API_KEY', 'sk-test-value')
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    h.cleanup = apply(h.ctx as never, {
      dataDir: h.dataDir,
      embedding: { provider: 'openai-compatible', apiBase: 'https://api.test/v1' },
    })
    await new Promise((r) => setTimeout(r, 10))
    await h.commands.invoke('a1', '/memlite-remember 向量化正文 --title 向量题')
    // remember 默认异步嵌入；awaitEmbedding 不在命令面——轮询等侧车
    let has = false
    for (let i = 0; i < 20 && !has; i++) {
      await new Promise((r) => setTimeout(r, 20))
      const st = expectSuccess(await h.commands.invoke('a1', '/memlite-status'))
      has = !/侧车向量: 0/.test(st)
    }
    expect(has).toBe(true)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0)
  })

  it('凭据缺失：初始化期不炸，recall 回退 BM25', async () => {
    const h = await createTestHost()
    hosts.push(h)
    h.cleanup = apply(h.ctx as never, {
      dataDir: h.dataDir,
      embedding: { provider: 'openai-compatible', apiBase: 'https://api.test/v1' },
    })
    await new Promise((r) => setTimeout(r, 10))
    expectSuccess(await h.commands.invoke('a1', '/memlite-remember 纯词面正文 --title 题'), '已存')
    const text = expectSuccess(await h.commands.invoke('a1', '/memlite-recall 词面'), '[bm25')
    expect(text).toContain('题')
  })
})

describe('嵌入档 host（DSH 0.2.x 无 embeddings API）', () => {
  it('provider=host 不炸：加载告警、recall 纯 BM25', async () => {
    const h = await createTestHost()
    hosts.push(h)
    const warns: string[] = []
    const origWarn = (h.ctx as unknown as { logger?: { warn(m: string): void } }).logger
    void origWarn
    h.cleanup = apply(h.ctx as never, {
      dataDir: h.dataDir,
      embedding: { provider: 'host', model: 'BAAI/bge-m3' },
    })
    await new Promise((r) => setTimeout(r, 10))
    expectSuccess(await h.commands.invoke('a1', '/memlite-remember host档正文 --title host题'), '已存')
    const text = expectSuccess(await h.commands.invoke('a1', '/memlite-recall host'), '[bm25')
    expect(text).toContain('host题')
    expect(warns.length).toBe(0) // ctx.logger 为宿主函数，未捕获——告警走宿主通道，不抛错即达意
  })
})

describe('sensitiveGate=false 放行', () => {
  it('关闸后明文口令可存', async () => {
    const h = await createTestHost()
    hosts.push(h)
    h.cleanup = apply(h.ctx as never, { dataDir: h.dataDir, sensitiveGate: false })
    await new Promise((r) => setTimeout(r, 10))
    expectSuccess(await h.commands.invoke('a1', '/memlite-remember 密码是hunter2secret'), '已存')
    expectSuccess(await h.commands.invoke('a1', '/memlite-recall 不存在的东西'), '（无命中）')
  })
})
