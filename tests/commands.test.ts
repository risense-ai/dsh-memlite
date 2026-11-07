/** 命令面集成测试：真 cordis 核 + 宿主命令替身按真实分发语义调用。 */
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index'
import { createTestHost, expectError, expectSuccess, type TestHost } from './harness'

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

describe('命令注册（单 token 名校验）', () => {
  it('16 个命令全部注册且名符合 COMMAND_NAME', async () => {
    const h = await hostWithPlugin()
    const expected = [
      'memlite', 'memlite-recall', 'memlite-remember', 'memlite-show', 'memlite-forget',
      'memlite-update', 'memlite-attach', 'memlite-tree', 'memlite-chain', 'memlite-sync',
      'memlite-status', 'memlite-reembed', 'memlite-bench',
      'memlite-import', 'memlite-export', 'memlite-vault-status',
    ]
    for (const name of expected) expect(h.commands.definitions.has(name), name).toBe(true)
    expect(h.commands.definitions.size).toBe(expected.length)
  })

  it('/memlite 概览返回条数与引导', async () => {
    const h = await hostWithPlugin()
    const text = expectSuccess(await h.commands.invoke('a1', '/memlite'), 'memlite 记忆库')
    expect(text).toContain('0 条')
  })
})

describe('memlite-remember / show / forget / update', () => {
  it('存取删改全链路', async () => {
    const h = await hostWithPlugin()
    const text = expectSuccess(await h.commands.invoke('a1', '/memlite-remember nginx 504 排查 --title nginx题'), '已存')
    const id = /已存 ([0-9a-f]{12})/.exec(text)![1]!
    expectSuccess(await h.commands.invoke('a1', `/memlite-show ${id}`), 'nginx 504')
    expectSuccess(await h.commands.invoke('a1', `/memlite-update ${id} --content 改后正文`), `已更新 ${id}`)
    expectSuccess(await h.commands.invoke('a1', `/memlite-show ${id}`), '改后正文')
    expectSuccess(await h.commands.invoke('a1', `/memlite-forget ${id}`), `已删 ${id}`)
    expectError(await h.commands.invoke('a1', `/memlite-show ${id}`), '记忆不存在')
  })

  it('缺参数与未知 id 走 error 路径', async () => {
    const h = await hostWithPlugin()
    expectError(await h.commands.invoke('a1', '/memlite-remember'), '缺 content')
    expectError(await h.commands.invoke('a1', '/memlite-show zzzzzz'), '记忆不存在')
    expectError(await h.commands.invoke('a1', '/memlite-update nope'), '记忆不存在')
    expectError(await h.commands.invoke('a1', '/memlite-update nope --title t'), '记忆不存在')
  })

  it('敏感闸命中即拒（写前扫描）', async () => {
    const h = await hostWithPlugin()
    expectError(await h.commands.invoke('a1', '/memlite-remember 密码是hunter2secret'), '拒绝入库')
  })

  it('认因挂载：--parent 建立因果', async () => {
    const h = await hostWithPlugin()
    const p = expectSuccess(await h.commands.invoke('a1', '/memlite-remember 父正文 --title 父题'), '已存')
    const pid = /已存 ([0-9a-f]{12})/.exec(p)![1]!
    const c = expectSuccess(await h.commands.invoke('a1', `/memlite-remember 子正文 --parent ${pid}`), '已存')
    const cid = /已存 ([0-9a-f]{12})/.exec(c)![1]!
    const shown = expectSuccess(await h.commands.invoke('a1', `/memlite-show ${cid}`), '因链')
    expect(shown).toContain('父题')
    expectError(await h.commands.invoke('a1', '/memlite-remember 子 --parent nope'), '目标因（父）不存在')
  })
})

describe('memlite-recall', () => {
  it('命中与格式（backend 标注 + 因果视界）', async () => {
    const h = await hostWithPlugin()
    const p = expectSuccess(await h.commands.invoke('a1', '/memlite-remember nginx 反代超时排查 --title nginx题'), '已存')
    const pid = /已存 ([0-9a-f]{12})/.exec(p)![1]!
    expectSuccess(await h.commands.invoke('a1', '/memlite-remember 下游果条 --parent ' + pid), '已存')
    const text = expectSuccess(await h.commands.invoke('a1', '/memlite-recall nginx 超时'), '[bm25')
    expect(text).toContain('nginx题')
    expect(text).toContain('🔻果')
    // limit 截断
    const limited = expectSuccess(await h.commands.invoke('a1', '/memlite-recall nginx --limit 1'))
    expect(limited.split('\n').filter((l) => l.startsWith('[')).length).toBeLessThanOrEqual(2)
  })

  it('--bm25 强制词面档；缺 query 报错', async () => {
    const h = await hostWithPlugin()
    expectSuccess(await h.commands.invoke('a1', '/memlite-remember 词面正文'))
    const text = expectSuccess(await h.commands.invoke('a1', '/memlite-recall 词面 --bm25'), '[bm25')
    expect(text).toContain('词面正文')
    expectError(await h.commands.invoke('a1', '/memlite-recall'), '缺 query')
  })
})

describe('memlite-tree / chain / attach', () => {
  it('树渲染与 outline 计数', async () => {
    const h = await hostWithPlugin()
    const p = expectSuccess(await h.commands.invoke('a1', '/memlite-remember 纲A正文 --title 纲A'), '已存')
    const a = /已存 ([0-9a-f]{12})/.exec(p)![1]!
    expectSuccess(await h.commands.invoke('a1', `/memlite-remember 子B正文 --title 子B --parent ${a}`), '已存')
    expectSuccess(await h.commands.invoke('a1', `/memlite-remember 子C正文 --title 子C --parent ${a}`), '已存')
    const tree = expectSuccess(await h.commands.invoke('a1', '/memlite-tree'), '🌳 因果树根')
    expect(tree).toContain('子B')
    const outline = expectSuccess(await h.commands.invoke('a1', '/memlite-tree --outline'), '共 3 节点')
    expect(outline).toContain(`[${a.slice(0, 8)}] 纲A`)
  })

  it('attach 防环；chain 因果层号', async () => {
    const h = await hostWithPlugin()
    const p = expectSuccess(await h.commands.invoke('a1', '/memlite-remember 纲 --title R'), '已存')
    const r = /已存 ([0-9a-f]{12})/.exec(p)![1]!
    const c = expectSuccess(await h.commands.invoke('a1', `/memlite-remember 子 --title C --parent ${r}`), '已存')
    const cid = /已存 ([0-9a-f]{12})/.exec(c)![1]!
    expectError(await h.commands.invoke('a1', `/memlite-attach ${r} --parent ${cid}`), '防环')
    expectError(await h.commands.invoke('a1', `/memlite-attach ${r} --parent ${r}`), '不能挂自己')
    const chain = expectSuccess(await h.commands.invoke('a1', `/memlite-chain ${r}`), '🔻果链')
    const leafChain = expectSuccess(await h.commands.invoke('a1', `/memlite-chain ${cid}`))
    expect(leafChain).toContain('🔺因链（1 层')
    expect(leafChain).toContain('（无果')
    expectError(await h.commands.invoke('a1', '/memlite-chain zzzz'), '记忆不存在')
  })
})

describe('memlite-status / sync / reembed / bench', () => {
  it('status 报目录与嵌入档', async () => {
    const h = await hostWithPlugin()
    const text = expectSuccess(await h.commands.invoke('a1', '/memlite-status'), '数据目录')
    expect(text).toContain('嵌入档: none')
    expect(text).toContain('同步:')
  })

  it('sync 无仓走 error 路径', async () => {
    const h = await hostWithPlugin()
    expectError(await h.commands.invoke('a1', '/memlite-sync'), '都不是 git 仓')
  })

  it('reembed 未开嵌入档报错', async () => {
    const h = await hostWithPlugin()
    expectError(await h.commands.invoke('a1', '/memlite-reembed'), '嵌入档未开启')
  })

  it('bench 端到端跑通（纯 BM25 档）', async () => {
    const h = await hostWithPlugin()
    const text = expectSuccess(await h.commands.invoke('a1', '/memlite-bench'), 'hit@3')
    expect(text).toContain('模式: bm25')
  }, 30000)
})
