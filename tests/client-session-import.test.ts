/**
 * 浏览器半区：DSH 会话历史导入面板。
 *
 * 覆盖契约第十一/十二节：分组与三个按钮、四个勾选项、三个路径输入框、
 * 请求体（list / preview / run 的路由与 dry-run 语义）、localStorage 记住的输入、
 * 中英字典键齐全，以及「客户端不得 import 服务端模块」的静态守卫。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULTS } from '../src/client/form'
import { locales } from '../src/client/locales'
import { MemliteConfigPage, MemliteSettingsSection } from '../src/client/MemliteSettings'
import {
  SESSION_IMPORT_DEFAULTS,
  SESSION_IMPORT_PANEL_MARKER,
  SessionImportPanel,
  buildSessionImportRequest,
  type SessionImportDraft,
} from '../src/client/session-import-panel'

const t = (key: string): string => key

/** 契约第十一节锁定的 21 个字典键（键名逐字一致，zh/en 都必需）。 */
const SESSION_IMPORT_KEYS = [
  'groupSessionImport',
  'sessionImportIntro',
  'sessionRoot',
  'sessionRootHint',
  'sessionCwd',
  'sessionCwdHint',
  'sessionProject',
  'sessionProjectHint',
  'sessionExplicit',
  'sessionExplicitHint',
  'sessionSummary',
  'sessionSummaryHint',
  'sessionFacts',
  'sessionFactsHint',
  'sessionDryRun',
  'sessionDryRunHint',
  'sessionList',
  'sessionPreview',
  'sessionRun',
  'sessionBusy',
  'sessionRequestFailed',
] as const

function renderPanel(): string {
  return renderToStaticMarkup(createElement(SessionImportPanel, { t }))
}

/** 取某个 aria-label 对应的 `<input …>` 开标签，便于断言类型/勾选态。 */
function inputTag(html: string, label: string): string {
  const match = new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`).exec(html)
  expect(match, `找不到 aria-label="${label}" 的输入控件`).not.toBeNull()
  return match![0]
}

function countInputs(html: string, type: string): number {
  return (html.match(new RegExp(`<input[^>]*type="${type}"`, 'g')) ?? []).length
}

const PAGE_FORM = {
  state: {
    status: 'ready' as const,
    value: DEFAULTS,
    base: DEFAULTS,
    user: {},
    revision: 0,
    writable: true,
  },
  mutate: async () => true,
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage
})

describe('SessionImportPanel 渲染', () => {
  it('画出分组标题、说明、三个按钮与面板标记', () => {
    const html = renderPanel()
    expect(html).toContain(`data-memlite-panel="${SESSION_IMPORT_PANEL_MARKER}"`)
    expect(html).toContain('groupSessionImport')
    expect(html).toContain('sessionImportIntro')
    expect(html).toContain('sessionList')
    expect(html).toContain('sessionPreview')
    expect(html).toContain('sessionRun')
  })

  it('三个路径输入框与各自的标签/提示', () => {
    const html = renderPanel()
    expect(countInputs(html, 'text')).toBe(3)
    for (const key of ['sessionRoot', 'sessionCwd', 'sessionProject']) {
      expect(inputTag(html, key)).toContain('type="text"')
      expect(html).toContain(key)
    }
    for (const key of ['sessionRootHint', 'sessionCwdHint', 'sessionProjectHint']) {
      expect(html).toContain(key)
    }
  })

  it('四个勾选项（显式记忆/摘要开，用户事实/dry-run 关）', () => {
    const html = renderPanel()
    expect(countInputs(html, 'checkbox')).toBe(4)
    for (const key of ['sessionExplicit', 'sessionSummary', 'sessionFacts', 'sessionDryRun']) {
      expect(inputTag(html, key)).toContain('type="checkbox"')
    }
    expect(inputTag(html, 'sessionExplicit')).toContain('checked')
    expect(inputTag(html, 'sessionSummary')).toContain('checked')
    expect(inputTag(html, 'sessionFacts')).not.toContain('checked')
    expect(inputTag(html, 'sessionDryRun')).not.toContain('checked')
    for (const key of [
      'sessionExplicitHint',
      'sessionSummaryHint',
      'sessionFactsHint',
      'sessionDryRunHint',
    ]) {
      expect(html).toContain(key)
    }
  })

  it('结果块在请求前不渲染（等宽 pre-wrap 只在有结果时出现）', () => {
    const html = renderPanel()
    expect(html).not.toContain('<pre')
  })
})

describe('localStorage 记住输入', () => {
  it('读取 root/cwd/project 与四个勾选项（前缀 memlite.sessionImport.）', () => {
    const store = new Map<string, string>([
      ['memlite.sessionImport.root', '~/.dsh/sessions'],
      ['memlite.sessionImport.cwd', '/Users/you/proj'],
      ['memlite.sessionImport.project', 'demo'],
      ['memlite.sessionImport.explicit', '0'],
      ['memlite.sessionImport.summary', '0'],
      ['memlite.sessionImport.facts', '1'],
      ['memlite.sessionImport.dryRun', '1'],
    ])
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, String(value))
      },
      removeItem: (key: string) => {
        store.delete(key)
      },
    }

    const html = renderPanel()
    expect(html).toContain('value="~/.dsh/sessions"')
    expect(html).toContain('value="/Users/you/proj"')
    expect(html).toContain('value="demo"')
    expect(inputTag(html, 'sessionExplicit')).not.toContain('checked')
    expect(inputTag(html, 'sessionSummary')).not.toContain('checked')
    expect(inputTag(html, 'sessionFacts')).toContain('checked')
    expect(inputTag(html, 'sessionDryRun')).toContain('checked')
  })

  it('localStorage 不可用时回落到默认值', () => {
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error('storage disabled')
      },
      setItem: () => {
        throw new Error('storage disabled')
      },
    }
    const html = renderPanel()
    expect(inputTag(html, 'sessionExplicit')).toContain('checked')
    expect(inputTag(html, 'sessionSummary')).toContain('checked')
    expect(inputTag(html, 'sessionFacts')).not.toContain('checked')
    expect(inputTag(html, 'sessionDryRun')).not.toContain('checked')
  })
})

describe('buildSessionImportRequest', () => {
  const base: SessionImportDraft = {
    ...SESSION_IMPORT_DEFAULTS,
    root: '~/.dsh/sessions',
    cwd: '/Users/you/proj',
    project: 'demo',
  }

  it('列出会话走 list 字面量路由，不带抽取开关', () => {
    const request = buildSessionImportRequest('list', base)
    expect(request.path).toBe('api/memlite/session/list')
    expect(request.body).toEqual({ root: '~/.dsh/sessions', cwd: '/Users/you/proj' })
    expect(JSON.stringify(request.body)).not.toContain('dryRun')
    expect(JSON.stringify(request.body)).not.toContain('explicit')
  })

  it('预览导入走 import 字面量路由且 dryRun 恒为 true', () => {
    const request = buildSessionImportRequest('preview', { ...base, dryRun: false })
    expect(request.path).toBe('api/memlite/session/import')
    expect(request.body).toMatchObject({
      root: '~/.dsh/sessions',
      cwd: '/Users/you/proj',
      project: 'demo',
      explicit: true,
      summary: true,
      facts: false,
      dryRun: true,
    })
  })

  it('导入使用用户勾选的 dryRun 与三个抽取开关', () => {
    const dry = buildSessionImportRequest('run', { ...base, dryRun: true })
    expect(dry.path).toBe('api/memlite/session/import')
    expect(dry.body['dryRun']).toBe(true)

    const real = buildSessionImportRequest('run', {
      ...base,
      explicit: false,
      summary: true,
      facts: true,
      dryRun: false,
    })
    expect(real.body).toMatchObject({ explicit: false, summary: true, facts: true, dryRun: false })
  })

  it('空白路径不发送（交给服务端默认值）', () => {
    const request = buildSessionImportRequest('run', {
      ...base,
      root: '   ',
      cwd: ' /Users/you/proj ',
      project: '',
    })
    expect(request.body['root']).toBeUndefined()
    expect(request.body['cwd']).toBe('/Users/you/proj')
    expect(request.body['project']).toBeUndefined()
  })
})

describe('挂进配置页（Obsidian 桥之后）', () => {
  it('MemliteConfigPage 在 groupObsidian 之后渲染新分组', () => {
    const html = renderToStaticMarkup(
      createElement(MemliteConfigPage, { t, view: 'page', form: PAGE_FORM }),
    )
    expect(html).toContain('groupObsidian')
    expect(html).toContain('groupSessionImport')
    expect(html).toContain('sessionImportIntro')
    const obsidianAt = html.indexOf('groupObsidian')
    const sessionAt = html.indexOf('groupSessionImport')
    expect(obsidianAt).toBeGreaterThanOrEqual(0)
    expect(sessionAt).toBeGreaterThan(obsidianAt)
    for (const key of ['sessionList', 'sessionPreview', 'sessionRun']) {
      expect(html).toContain(key)
    }
    // 既有 Obsidian 分组不受影响。
    expect(html).toContain('vaultPath')
    expect(html).toContain('runExport')
  })

  it('设置对话框分节复用同一份表单，新分组同样出现', () => {
    const html = renderToStaticMarkup(
      createElement(MemliteSettingsSection, {
        t,
        form: {
          getSnapshot: () => PAGE_FORM.state,
          subscribe: () => () => {},
          mutate: async () => true,
        },
      }),
    )
    expect(html).toContain('groupSessionImport')
    expect(html).toContain('sessionRun')
  })
})

describe('字典与客户端边界', () => {
  it('zh/en 各含契约列出的 21 个键且非空', () => {
    expect(SESSION_IMPORT_KEYS).toHaveLength(21)
    const zh = locales.zh as Record<string, string>
    const en = locales.en as Record<string, string>
    for (const key of SESSION_IMPORT_KEYS) {
      expect(zh[key], `zh.${key}`).toBeTruthy()
      expect(en[key], `en.${key}`).toBeTruthy()
    }
  })

  it('客户端面板不 import src/session-import（会拉 node:zlib）', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src', 'client', 'session-import-panel.tsx'),
      'utf8',
    )
    expect(source).not.toMatch(/from\s+['"](?:\.\.?\/)*session-import\//)
    expect(source).not.toContain('node:zlib')
    expect(source).not.toContain('@rsrsai/memlite')
  })
})
