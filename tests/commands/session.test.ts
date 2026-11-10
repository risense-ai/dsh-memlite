/** DSH 会话导入命令面：注册、用法、dry-run、幂等、过滤与错误路径。 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../../src/index'
import { createTestHost, expectError, expectSuccess, type TestHost } from '../harness'

const hosts: TestHost[] = []
const roots: string[] = []

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.dispose()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(dir)
  return dir
}

async function hostWithPlugin(): Promise<TestHost> {
  const h = await createTestHost()
  hosts.push(h)
  h.cleanup = apply(h.ctx as never, { dataDir: h.dataDir, sync: { auto: false } })
  await new Promise((r) => setTimeout(r, 10))
  return h
}

interface SessionFixtureOptions {
  sessionId?: string
  title?: string
  cwd?: string
  createdAt?: number
  messages?: string[]
  toolCall?: boolean
}

const DEFAULT_MESSAGES = [
  '帮我排查 nginx 504 上游超时',
  '记：项目约定：所有服务必须走统一网关',
  '以后部署必须先跑统一网关的健康检查',
]

/** 造 `<root>/<sessionId>/session.v4.jsonl.zstd`（zstd 压缩的逐行事件流）。 */
function writeSession(root: string, options: SessionFixtureOptions = {}): string {
  const sessionId = options.sessionId ?? 'session-11111111-2222-3333-4444-555555555555'
  const createdAt = options.createdAt ?? Date.UTC(2026, 0, 2, 3, 4, 5)
  const cwd = options.cwd ?? '/work/alpha'
  const messages = options.messages ?? DEFAULT_MESSAGES
  const dir = path.join(root, sessionId)
  fs.mkdirSync(dir, { recursive: true })

  const events: unknown[] = [{ type: 'session', version: 4, id: sessionId, createdAt, cwd }]
  if (options.title !== undefined) events.push({ type: 'session/title', data: { title: options.title } })
  let seq = 1
  for (const [i, text] of messages.entries()) {
    events.push({
      type: 'user/message',
      seq: seq++,
      time: createdAt + (i + 1) * 1000,
      data: {
        role: 'user',
        source: { kind: 'user' },
        id: `message-${i + 1}`,
        content: [{ type: 'text', text }],
      },
    })
  }
  if (options.toolCall !== false) {
    events.push({
      type: 'tool/call',
      seq: seq++,
      time: createdAt + 9000,
      data: {
        name: 'memlite_remember',
        arguments: JSON.stringify({ content: '显式记忆正文：网关统一', title: '显式标题' }),
      },
    })
  }
  events.push({ type: 'assistant/message', seq: seq++, time: createdAt + 10000, data: { role: 'assistant' } })

  const body = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body, 'utf8')))
  return dir
}

describe('会话导入命令注册', () => {
  it('18 个命令（13 基础 + 3 Obsidian + 2 会话导入），用法写进 description', async () => {
    const h = await hostWithPlugin()
    for (const name of ['memlite-session-import', 'memlite-session-list']) {
      expect(h.commands.definitions.has(name), name).toBe(true)
    }
    expect(h.commands.definitions.size).toBe(18)
    expect(h.commands.definitions.get('memlite-session-import')?.description).toContain(
      '/memlite-session-import [--root P] [--cwd P] [--project P] [--session ID] [--limit N] [--since ISO] [--no-explicit] [--no-summary] [--facts] [--dry-run]',
    )
    expect(h.commands.definitions.get('memlite-session-list')?.description).toContain(
      '/memlite-session-list [--root P] [--cwd P] [--session ID] [--limit N] [--since ISO]',
    )
  })
})

describe('memlite-session-import', () => {
  it('dry-run 出预览且不写库', async () => {
    const h = await hostWithPlugin()
    const root = tempDir('memlite-sessions-dry-')
    writeSession(root, { title: 'Nginx 排查' })
    const text = expectSuccess(
      await h.commands.invoke('a1', `/memlite-session-import --root ${root} --dry-run`),
      '[dry-run]',
    )
    expect(text).toContain('候选 3 条')
    expect(text).toContain('将新建 3')
    expect(text).toContain('去掉 --dry-run')
    const status = expectSuccess(await h.commands.invoke('a1', '/memlite-status'))
    expect(status).toContain('记忆条数: 0')
  })

  it('正式导入后二次导入幂等（全部不变）', async () => {
    const h = await hostWithPlugin()
    const root = tempDir('memlite-sessions-import-')
    writeSession(root)
    const first = expectSuccess(await h.commands.invoke('a1', `/memlite-session-import --root ${root}`), '新建 3')
    expect(first).toContain('候选 3 条')
    const second = expectSuccess(await h.commands.invoke('a1', `/memlite-session-import --root ${root}`), '不变 3')
    expect(second).toContain('新建 0')
    expect(second).toContain('更新 0')
    // 导入的记忆可召回
    const recalled = expectSuccess(await h.commands.invoke('a1', '/memlite-recall 网关'))
    expect(recalled).toContain('网关')
  })

  it('--facts / --no-explicit / --no-summary 控制候选来源', async () => {
    const h = await hostWithPlugin()
    const root = tempDir('memlite-sessions-flags-')
    writeSession(root)
    const withFacts = expectSuccess(
      await h.commands.invoke('a1', `/memlite-session-import --root ${root} --dry-run --facts`),
      '候选 4 条',
    )
    expect(withFacts).toContain('将新建 4')
    expectSuccess(
      await h.commands.invoke('a1', `/memlite-session-import --root ${root} --dry-run --no-explicit`),
      '候选 1 条',
    )
    expectSuccess(
      await h.commands.invoke('a1', `/memlite-session-import --root ${root} --dry-run --no-summary`),
      '候选 2 条',
    )
  })

  it('--limit / --since / --session / --cwd 过滤会话', async () => {
    const h = await hostWithPlugin()
    const root = tempDir('memlite-sessions-filter-')
    writeSession(root, { sessionId: 'session-aaaaaaaa-0000-0000-0000-000000000001', createdAt: Date.UTC(2026, 0, 2) })
    writeSession(root, {
      sessionId: 'session-bbbbbbbb-0000-0000-0000-000000000002',
      createdAt: Date.UTC(2026, 1, 2),
      cwd: '/work/beta',
    })
    expectSuccess(await h.commands.invoke('a1', `/memlite-session-import --root ${root} --dry-run`), '扫描 2 个会话')
    expectSuccess(
      await h.commands.invoke('a1', `/memlite-session-import --root ${root} --dry-run --limit 1`),
      '扫描 1 个会话',
    )
    expectSuccess(
      await h.commands.invoke('a1', `/memlite-session-import --root ${root} --dry-run --since 2099-01-01`),
      '扫描 0 个会话',
    )
    expectSuccess(
      await h.commands.invoke('a1', `/memlite-session-import --root ${root} --dry-run --session session-aaaaaaaa`),
      '扫描 1 个会话',
    )
    expectSuccess(
      await h.commands.invoke('a1', `/memlite-session-import --root ${root} --dry-run --cwd /work/beta`),
      '扫描 1 个会话',
    )
  })

  it('不存在的 root 走 error', async () => {
    const h = await hostWithPlugin()
    expectError(
      await h.commands.invoke('a1', '/memlite-session-import --root /definitely/not/a/session/dir'),
      '会话目录不存在',
    )
  })
})

describe('memlite-session-list', () => {
  it('列出会话（标题/项目/计数）', async () => {
    const h = await hostWithPlugin()
    const root = tempDir('memlite-sessions-list-')
    writeSession(root, { title: 'Nginx 排查' })
    const text = expectSuccess(await h.commands.invoke('a1', `/memlite-session-list --root ${root}`), '发现 1 个会话')
    expect(text).toContain('alpha')
    expect(text).toContain('Nginx 排查')
    // 3 条 user/message（含「记：」那条）；显式记忆 2 条（tool/call + 「记：」）
    expect(text).toContain('3 条人类消息')
    expect(text).toContain('2 条显式记忆')
  })

  it('空目录友好提示；不存在的 root 走 error', async () => {
    const h = await hostWithPlugin()
    const empty = tempDir('memlite-sessions-list-empty-')
    expectSuccess(await h.commands.invoke('a1', `/memlite-session-list --root ${empty}`), '未发现会话')
    expectError(await h.commands.invoke('a1', '/memlite-session-list --root /no/such/sessions'), '会话目录不存在')
  })

  it('--session / --limit / --since 过滤', async () => {
    const h = await hostWithPlugin()
    const root = tempDir('memlite-sessions-list-filter-')
    writeSession(root, { sessionId: 'session-aaaaaaaa-0000-0000-0000-000000000001', createdAt: Date.UTC(2026, 0, 2) })
    writeSession(root, { sessionId: 'session-bbbbbbbb-0000-0000-0000-000000000002', createdAt: Date.UTC(2026, 1, 2) })
    expectSuccess(await h.commands.invoke('a1', `/memlite-session-list --root ${root}`), '发现 2 个会话')
    expectSuccess(
      await h.commands.invoke('a1', `/memlite-session-list --root ${root} --session session-aaaaaaaa`),
      '发现 1 个会话',
    )
    expectSuccess(await h.commands.invoke('a1', `/memlite-session-list --root ${root} --limit 1`), '发现 1 个会话')
    expectSuccess(
      await h.commands.invoke('a1', `/memlite-session-list --root ${root} --since 2099-01-01`),
      '未发现会话',
    )
  })
})
