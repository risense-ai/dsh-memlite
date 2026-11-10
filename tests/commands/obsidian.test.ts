/** M5 Obsidian 整合：三命令真核测试（导入/导出/状态 + 空串守卫 + dry-run + 幂等互通）。 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../../src/index'
import { createTestHost, expectError, expectSuccess, type TestHost } from '../harness'

const hosts: TestHost[] = []
const vaultDirs: string[] = []

function makeVault(): string {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'memlite-vault-'))
  vaultDirs.push(v)
  fs.writeFileSync(path.join(v, '甲.md'), '---\ntitle: 甲题\n---\n\n甲正文内容')
  fs.writeFileSync(path.join(v, '乙.md'), '---\ntitle: 乙题\n---\n\n乙正文内容')
  fs.mkdirSync(path.join(v, '子目录'))
  fs.writeFileSync(path.join(v, '子目录', '丙.md'), '---\ntitle: 丙题\n---\n\n丙正文内容')
  return v
}

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.dispose()
  for (const v of vaultDirs.splice(0)) fs.rmSync(v, { recursive: true, force: true })
})

async function hostWithPlugin() {
  const h = await createTestHost()
  hosts.push(h)
  h.cleanup = apply(h.ctx as never, { dataDir: h.dataDir, sync: { auto: false } })
  await new Promise((r) => setTimeout(r, 10))
  return h
}

describe('命令注册', () => {
  it('18 个命令（13 基础 + 3 Obsidian + 2 会话导入）', async () => {
    const h = await hostWithPlugin()
    for (const name of ['memlite-import', 'memlite-export', 'memlite-vault-status']) {
      expect(h.commands.definitions.has(name), name).toBe(true)
    }
    expect(h.commands.definitions.size).toBe(18)
  })
})

describe('memlite-import', () => {
  it('导入 vault：报告新建数；二次导入全部不变（幂等）', async () => {
    const h = await hostWithPlugin()
    const v = makeVault()
    const first = expectSuccess(await h.commands.invoke('a1', `/memlite-import ${v}`), '扫描 4 条')
    expect(first).toContain('新建 4') // 3 篇 md + 1 个目录条
    const second = expectSuccess(await h.commands.invoke('a1', `/memlite-import ${v}`), '不变 4')
    expect(second).toContain('新建 0')
    expect(second).toContain('更新 0')
    // 库里可召回
    const r = expectSuccess(await h.commands.invoke('a1', '/memlite-recall 甲题'), '[bm25')
    expect(r).toContain('甲题')
  })

  it('dry-run 不写库并出预览', async () => {
    const h = await hostWithPlugin()
    const v = makeVault()
    const text = expectSuccess(await h.commands.invoke('a1', `/memlite-import ${v} --dry-run`), '[dry-run]')
    expect(text).toContain('将新建 4')
    expect(text).toContain('去掉 --dry-run')
    expect(h.commands.definitions.get('memlite-import')).toBeDefined()
    const status = expectSuccess(await h.commands.invoke('a1', '/memlite-status'))
    expect(status).toContain('记忆条数: 0')
  })

  it('空串 path 与不存在路径走 error', async () => {
    const h = await hostWithPlugin()
    expectError(await h.commands.invoke('a1', '/memlite-import ""'), '路径不能为空串')
    expectError(await h.commands.invoke('a1', '/memlite-import /definitely/not/a/dir'), '不存在或不是目录')
    expectError(await h.commands.invoke('a1', '/memlite-import'), '路径不能为空串')
  })

  it('--write-id 回填 frontmatter id', async () => {
    const h = await hostWithPlugin()
    const v = makeVault()
    // 单文件 vault 便于断言
    const solo = fs.mkdtempSync(path.join(os.tmpdir(), 'memlite-vault-solo-'))
    vaultDirs.push(solo)
    fs.writeFileSync(path.join(solo, '单条.md'), '---\ntitle: 单条题\n---\n\n单条正文')
    expectSuccess(await h.commands.invoke('a1', `/memlite-import ${solo} --write-id`), '新建 1')
    const md = fs.readFileSync(path.join(solo, '单条.md'), 'utf8')
    expect(md).toMatch(/id: [0-9a-f]{12}/)
    expect(v).toBeDefined()
  })
})

describe('memlite-export', () => {
  it('导出 vault：文件落盘；非空目录无 --overwrite 拒绝；带 --overwrite 成功', async () => {
    const h = await hostWithPlugin()
    const v = makeVault()
    expectSuccess(await h.commands.invoke('a1', `/memlite-import ${v}`), '新建 4')
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'memlite-out-')), 'vault-out')
    vaultDirs.push(out)
    const text = expectSuccess(await h.commands.invoke('a1', `/memlite-export ${out}`), '导出 4/4')
    expect(fs.existsSync(path.join(out, '.obsidian', 'app.json'))).toBe(true)
    // 再导出同目录 → 拒绝
    expectError(await h.commands.invoke('a1', `/memlite-export ${out}`), '已存在且非空')
    // --overwrite → 成功
    expectSuccess(await h.commands.invoke('a1', `/memlite-export ${out} --overwrite`), `导出 4/4`)
    expect(text).toBeDefined()
  })

  it('空串 output 走 error', async () => {
    const h = await hostWithPlugin()
    expectError(await h.commands.invoke('a1', '/memlite-export ""'), '路径不能为空串')
  })
})

describe('memlite-vault-status', () => {
  it('导入前 missing、导入后 synced；改动后 outdated', async () => {
    const h = await hostWithPlugin()
    const v = makeVault()
    const before = expectSuccess(await h.commands.invoke('a1', `/memlite-vault-status ${v}`), 'missing 4')
    expect(before).toContain('synced 0')
    expectSuccess(await h.commands.invoke('a1', `/memlite-import ${v}`), '新建 4')
    const after = expectSuccess(await h.commands.invoke('a1', `/memlite-vault-status ${v}`), 'synced 4')
    expect(after).toContain('missing 0')
    // 改动 vault 文件 → outdated
    fs.writeFileSync(path.join(v, '甲.md'), '---\ntitle: 甲题\n---\n\n甲正文已改动')
    const stale = expectSuccess(await h.commands.invoke('a1', `/memlite-vault-status ${v}`), 'outdated 1')
    expect(stale).toContain('synced 3')
  })

  it('不存在路径走 error', async () => {
    const h = await hostWithPlugin()
    expectError(await h.commands.invoke('a1', '/memlite-vault-status /no/such/dir'), '不存在或不是目录')
  })
})

describe('三方互通：导入 → 召回 → 导出 → 再导入幂等', () => {
  it('vault 进库后可召回，导出再导入零变更', async () => {
    const h = await hostWithPlugin()
    const v = makeVault()
    expectSuccess(await h.commands.invoke('a1', `/memlite-import ${v}`), '新建 4')
    expectSuccess(await h.commands.invoke('a1', '/memlite-recall 丙正文'), '[bm25')
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'memlite-out2-')), 'vault')
    vaultDirs.push(out)
    expectSuccess(await h.commands.invoke('a1', `/memlite-export ${out}`), '导出 4/4')
    const again = expectSuccess(await h.commands.invoke('a1', `/memlite-import ${out}`), '不变')
    expect(again).toContain('新建 0')
    expect(again).toContain('更新 0')
  })
})
