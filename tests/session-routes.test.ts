/** DSH 会话导入配置页路由：注册契约、请求体校验、409 互斥、list/import、dry-run 与幂等。 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index'
import {
  SESSION_CLIENT_PATHS,
  SESSION_IMPORT_PATH,
  SESSION_LIST_PATH,
} from '../src/session-import/routes'
import { createTestHost, type TestHost } from './harness'

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

/** 宿主 HOME 下的默认会话根（createTestHost 会把 HOME 指到临时 dataDir）。 */
function defaultSessionsRoot(h: TestHost): string {
  return path.join(h.dataDir, '.dsh', 'sessions')
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

/**
 * 造一个真实的 DSH 会话落盘结构：
 * `<root>/<sessionId>/session.v4.jsonl.zstd`（zstd 压缩的逐行事件流）。
 */
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
  // 非候选事件（assistant 消息不进抽取）
  events.push({ type: 'assistant/message', seq: seq++, time: createdAt + 10000, data: { role: 'assistant' } })

  const body = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body, 'utf8')))
  return dir
}

async function setup(): Promise<TestHost> {
  const h = await createTestHost()
  hosts.push(h)
  h.cleanup = apply(h.ctx as never, { dataDir: h.dataDir, sync: { auto: false } })
  await new Promise((r) => setTimeout(r, 10))
  return h
}

async function post(
  h: TestHost,
  route: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const request = new Request(`http://127.0.0.1${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const response = await h.connection.invoke(route, request)
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

function reportOf(response: { json: Record<string, unknown> }): Record<string, unknown> {
  const report = response.json['report']
  expect(report).toBeTypeOf('object')
  return report as Record<string, unknown>
}

describe('会话导入 exact routes', () => {
  it('注册两条 buffered POST 路由（与 Obsidian/记忆浏览器合计 18 条）', async () => {
    const h = await setup()
    expect(h.connection.routes.size).toBe(18)
    for (const route of [SESSION_IMPORT_PATH, SESSION_LIST_PATH]) {
      expect(h.connection.routes.get(route)?.methods).toEqual(['POST'])
      expect(h.connection.routes.get(route)?.requestBody).toBe('buffered')
    }
    // 配置页用的 document-relative 路径
    expect(SESSION_CLIENT_PATHS).toEqual({
      import: 'api/memlite/session/import',
      list: 'api/memlite/session/list',
    })
  })

  it('list：缺省 root 读宿主 ~/.dsh/sessions，回 text 与 report.sessions', async () => {
    const h = await setup()
    writeSession(defaultSessionsRoot(h), { title: 'Nginx 排查' })
    const res = await post(h, SESSION_LIST_PATH, {})
    expect(res.status).toBe(200)
    expect(res.json['ok']).toBe(true)
    const text = String(res.json['text'])
    expect(text).toContain('发现 1 个会话')
    expect(text).toContain('alpha') // project = cwd basename
    expect(text).toContain('Nginx 排查')
    expect(reportOf(res)['sessions']).toBe(1)
  })

  it('list：空目录友好提示；坏 root 回 400', async () => {
    const h = await setup()
    const root = tempDir('dsh-sessions-empty-')
    const empty = await post(h, SESSION_LIST_PATH, { root })
    expect(empty.status).toBe(200)
    expect(String(empty.json['text'])).toContain('未发现会话')
    expect(reportOf(empty)['sessions']).toBe(0)

    const missing = await post(h, SESSION_LIST_PATH, { root: path.join(root, 'nope') })
    expect(missing.status).toBe(400)
    expect(missing.json['ok']).toBe(false)
    expect(String(missing.json['error'])).toContain('会话目录不存在')
  })

  it('import dry-run 不写库；正式导入幂等（二次全部不变）', async () => {
    const h = await setup()
    const root = tempDir('dsh-sessions-import-')
    writeSession(root, { title: 'Nginx 排查' })

    const preview = await post(h, SESSION_IMPORT_PATH, { root, dryRun: true })
    expect(preview.status).toBe(200)
    expect(preview.json['ok']).toBe(true)
    const previewText = String(preview.json['text'])
    expect(previewText).toContain('[dry-run]')
    expect(previewText).toContain('候选 3 条')
    expect(previewText).toContain('将新建 3')
    expect(previewText).toContain('去掉 --dry-run')
    const previewReport = reportOf(preview)
    expect(previewReport['dryRun']).toBe(true)
    expect(previewReport['wouldCreate']).toBe(3)
    expect(previewReport['candidates']).toBe(3)
    expect(previewReport['sessionsScanned']).toBe(1)
    expect((previewReport['created'] as unknown[]).length).toBe(0)

    // dry-run 不写库
    const status = await h.commands.invoke('a1', '/memlite-status')
    expect(status.kind === 'success' ? (status.text ?? '') : '').toContain('记忆条数: 0')

    const imported = await post(h, SESSION_IMPORT_PATH, { root })
    expect(imported.status).toBe(200)
    expect(String(imported.json['text'])).toContain('新建 3')
    const importedReport = reportOf(imported)
    expect((importedReport['created'] as unknown[]).length).toBe(3)
    expect(importedReport['wouldCreate']).toBe(3)

    const again = await post(h, SESSION_IMPORT_PATH, { root })
    expect(again.status).toBe(200)
    expect(String(again.json['text'])).toContain('不变 3')
    const againReport = reportOf(again)
    expect((againReport['created'] as unknown[]).length).toBe(0)
    expect((againReport['updated'] as unknown[]).length).toBe(0)
    expect(againReport['unchanged']).toBe(3)
  })

  it('布尔/过滤字段透传：facts、explicit=false、summary=false、sessionId 与 cwd', async () => {
    const h = await setup()
    const root = tempDir('dsh-sessions-flags-')
    writeSession(root)

    const withFacts = await post(h, SESSION_IMPORT_PATH, { root, dryRun: true, facts: true })
    expect(String(withFacts.json['text'])).toContain('候选 4 条')

    const noExplicit = await post(h, SESSION_IMPORT_PATH, { root, dryRun: true, explicit: false })
    expect(String(noExplicit.json['text'])).toContain('候选 1 条') // 只剩摘要

    const noSummary = await post(h, SESSION_IMPORT_PATH, { root, dryRun: true, summary: false })
    expect(String(noSummary.json['text'])).toContain('候选 2 条') // 两条显式

    const byId = await post(h, SESSION_IMPORT_PATH, { root, dryRun: true, sessionId: 'session-11111111' })
    expect(String(byId.json['text'])).toContain('扫描 1 个会话')

    const noMatch = await post(h, SESSION_IMPORT_PATH, { root, dryRun: true, sessionId: 'session-ffffffff' })
    expect(String(noMatch.json['text'])).toContain('扫描 0 个会话')

    const byCwd = await post(h, SESSION_IMPORT_PATH, { root, dryRun: true, cwd: '/work/alpha' })
    expect(String(byCwd.json['text'])).toContain('扫描 1 个会话')

    const otherCwd = await post(h, SESSION_IMPORT_PATH, { root, dryRun: true, cwd: '/work/beta' })
    expect(String(otherCwd.json['text'])).toContain('扫描 0 个会话')
  })

  it('请求体字段类型错误一律 400（安全文案）', async () => {
    const h = await setup()
    const cases: Array<[string, Record<string, unknown>, string]> = [
      [SESSION_IMPORT_PATH, { root: 123 }, 'root 必须是字符串'],
      [SESSION_IMPORT_PATH, { root: 'x'.repeat(1001) }, 'root 过长'],
      [SESSION_IMPORT_PATH, { limit: 0 }, 'limit 必须在 1..200 之间'],
      [SESSION_IMPORT_PATH, { limit: 201 }, 'limit 必须在 1..200 之间'],
      [SESSION_IMPORT_PATH, { limit: 1.5 }, 'limit 必须是整数'],
      [SESSION_IMPORT_PATH, { since: {} }, 'since 必须是字符串或数字'],
      [SESSION_IMPORT_PATH, { explicit: 'yes' }, 'explicit 必须是布尔值'],
      [SESSION_IMPORT_PATH, { facts: 1 }, 'facts 必须是布尔值'],
      [SESSION_LIST_PATH, { cwd: [] }, 'cwd 必须是字符串'],
    ]
    for (const [route, body, message] of cases) {
      const res = await post(h, route, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.json['ok']).toBe(false)
      expect(String(res.json['error']), JSON.stringify(body)).toContain(message)
    }
  })

  it('非法 JSON 请求体返回 400', async () => {
    const h = await setup()
    const request = new Request(`http://127.0.0.1${SESSION_IMPORT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    const response = await h.connection.invoke(SESSION_IMPORT_PATH, request)
    expect(response.status).toBe(400)
  })

  it('两条路由共享 busy 锁：并发第二个请求回 409，结束后释放', async () => {
    const h = await setup()
    const root = tempDir('dsh-sessions-busy-')
    writeSession(root)
    const makeRequest = (route: string): Request =>
      new Request(`http://127.0.0.1${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ root }),
      })

    // 不 await 第一个：busy 在第一个 await 之前同步置位
    const first = h.connection.invoke(SESSION_IMPORT_PATH, makeRequest(SESSION_IMPORT_PATH))
    const second = await h.connection.invoke(SESSION_LIST_PATH, makeRequest(SESSION_LIST_PATH))
    expect(second.status).toBe(409)
    const secondJson = (await second.json()) as Record<string, unknown>
    expect(String(secondJson['error'])).toContain('另一个会话导入操作尚未完成')

    const firstResponse = await first
    expect(firstResponse.status).toBe(200)

    // 锁已释放：后续请求正常
    const after = await post(h, SESSION_LIST_PATH, { root })
    expect(after.status).toBe(200)
  })
})
