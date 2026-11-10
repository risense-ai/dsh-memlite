/**
 * 真实 DSH 会话数据的端到端冒烟（默认跳过：依赖本机 ~/.dsh/sessions 与 Node ≥22.15 的 zstd）。
 *
 * 开启方式：MEMLITE_REAL_SESSIONS=1 pnpm vitest run tests/session-import.smoke.test.ts
 *
 * 只读红线：真实会话目录只读；写库只发生在临时 Memlite 数据目录（测试结束即删）。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Memlite, parentId as recordParentId } from '@rsrsai/memlite'
import { afterAll, describe, expect, it } from 'vitest'
import { importDshSessionsWith, resolveSessionsRoot } from '../src/session-import'

const enabled = process.env['MEMLITE_REAL_SESSIONS'] === '1'
const SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions')
const hasRealSessions = fs.existsSync(SESSIONS_ROOT)

const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memlite-session-smoke-'))
  tempDirs.push(dir)
  return dir
}

describe.skipIf(!enabled || !hasRealSessions)('真实 DSH 会话导入冒烟', () => {
  it('真实会话目录：解析、dry-run 不写库、正式导入可幂等重复', async () => {
    const mem = new Memlite({ dataDir: tempDataDir() }, {})
    mem.open()
    try {
      const root = resolveSessionsRoot()
      const preview = await importDshSessionsWith(mem, { root, dryRun: true })
      expect(preview.sessionsScanned).toBeGreaterThan(0)
      expect(preview.candidates).toBeGreaterThan(0)
      expect(preview.created).toEqual([])
      expect(mem.snapshot().count()).toBe(0)

      const imported = await importDshSessionsWith(mem, { root })
      expect(imported.created.length).toBeGreaterThan(0)
      const records = mem.snapshot().all()

      // 每个会话摘要都应是根；同会话显式记忆/用户事实挂在摘要之下
      const summaries = records.filter((record) => record.extra['dsh_kind'] === 'session-summary')
      expect(summaries.length).toBeGreaterThan(0)
      for (const summary of summaries) {
        expect(recordParentId(summary)).toBe('')
        expect(String(summary.extra['dsh_anchor'])).toContain(':summary')
        expect(JSON.stringify(summary.extra)).not.toContain(os.homedir())
      }
      const children = records.filter((record) => record.extra['dsh_kind'] === 'explicit')
      for (const child of children) {
        expect(recordParentId(child)).not.toBe('')
        expect(JSON.stringify(child.extra)).not.toContain(os.homedir())
      }

      const again = await importDshSessionsWith(mem, { root })
      expect(again.created).toEqual([])
      expect(again.updated).toEqual([])
      expect(again.unchanged).toBe(again.candidates)
      expect(mem.snapshot().count()).toBe(records.length)
    } finally {
      mem.close()
    }
  }, 120_000)
})
