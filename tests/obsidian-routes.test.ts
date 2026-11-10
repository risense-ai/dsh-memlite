/** Obsidian 配置页路由：注册契约、导入/预览/状态/导出与路径守卫。 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index'
import {
  OBSIDIAN_EXPORT_PATH,
  OBSIDIAN_IMPORT_PATH,
  OBSIDIAN_STATUS_PATH,
} from '../src/obsidian'
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

function makeVault(): string {
  const vault = tempDir('dsh-memlite-vault-')
  fs.writeFileSync(path.join(vault, 'Nginx 504.md'), '# Nginx 504\n\n排查顺序：上游超时 → 连接池 → keepalive。\n', 'utf8')
  return vault
}

async function setup(): Promise<TestHost> {
  const h = await createTestHost()
  hosts.push(h)
  h.cleanup = apply(h.ctx as never, { dataDir: h.dataDir })
  await new Promise((r) => setTimeout(r, 10))
  return h
}

async function post(h: TestHost, route: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const request = new Request(`http://127.0.0.1${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const response = await h.connection.invoke(route, request)
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

describe('Obsidian exact routes', () => {
  it('注册三条 buffered POST 路由（另有 15 条只读/写路由）', async () => {
    const h = await setup()
    // 3 条 Obsidian 写路由 + 13 条记忆浏览器路由 + 2 条会话导入路由共用 connection 服务
    expect(h.connection.routes.size).toBe(18)
    for (const route of [OBSIDIAN_IMPORT_PATH, OBSIDIAN_EXPORT_PATH, OBSIDIAN_STATUS_PATH]) {
      expect(h.connection.routes.get(route)?.methods).toEqual(['POST'])
      expect(h.connection.routes.get(route)?.requestBody).toBe('buffered')
    }
  })

  it('预览导入不写库，正式导入后 status 显示 synced', async () => {
    const h = await setup()
    const vault = makeVault()

    const preview = await post(h, OBSIDIAN_IMPORT_PATH, { vaultPath: vault, dryRun: true })
    expect(preview.status).toBe(200)
    expect(preview.json['ok']).toBe(true)
    expect(String(preview.json['text'])).toContain('dry-run')

    const imported = await post(h, OBSIDIAN_IMPORT_PATH, { vaultPath: vault })
    expect(imported.status).toBe(200)
    expect(imported.json['ok']).toBe(true)
    expect(String(imported.json['text'])).toContain('新建 1')

    const status = await post(h, OBSIDIAN_STATUS_PATH, { vaultPath: vault })
    expect(status.status).toBe(200)
    expect(String(status.json['text'])).toContain('synced 1')
  })

  it('导出到新目录并拒绝覆盖非空目录（除非 overwrite）', async () => {
    const h = await setup()
    const vault = makeVault()
    await post(h, OBSIDIAN_IMPORT_PATH, { vaultPath: vault })

    const out = tempDir('dsh-memlite-export-')
    const exported = await post(h, OBSIDIAN_EXPORT_PATH, { outputPath: out })
    expect(exported.status).toBe(200)
    expect(exported.json['ok']).toBe(true)
    expect(fs.readdirSync(out).some((name) => name.endsWith('.md'))).toBe(true)

    const again = await post(h, OBSIDIAN_EXPORT_PATH, { outputPath: out })
    expect(again.status).toBe(400)
    expect(String(again.json['error'])).toMatch(/存在|覆盖/)

    const overwritten = await post(h, OBSIDIAN_EXPORT_PATH, { outputPath: out, overwrite: true })
    expect(overwritten.status).toBe(200)
    expect(overwritten.json['ok']).toBe(true)
  })

  it('空路径 / 不存在的 vault 返回 400', async () => {
    const h = await setup()
    const empty = await post(h, OBSIDIAN_IMPORT_PATH, { vaultPath: '   ' })
    expect(empty.status).toBe(400)
    expect(empty.json['ok']).toBe(false)

    const missing = await post(h, OBSIDIAN_STATUS_PATH, { vaultPath: path.join(h.dataDir, 'nope') })
    expect(missing.status).toBe(400)
    expect(String(missing.json['error'])).toContain('不存在')
  })

  it('非法 JSON 请求体返回 400', async () => {
    const h = await setup()
    const request = new Request(`http://127.0.0.1${OBSIDIAN_IMPORT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    const response = await h.connection.invoke(OBSIDIAN_IMPORT_PATH, request)
    expect(response.status).toBe(400)
  })
})
