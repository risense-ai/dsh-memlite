/** 浏览器半区：注册契约（slot 键、locale、whileServed、右侧 Memory 页类型）与构建产物形状。 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MEMORY_TAB_ID, MEMORY_TAB_KIND, apply, inject } from '../src/client/index'
import { MemliteConfigPage } from '../src/client/MemliteSettings'
import { DEFAULTS } from '../src/client/form'
import { MEMORY_LOCALE_NS } from '../src/client/memory-locales'

interface Registered {
  name?: unknown
  key?: unknown
  locale?: unknown
  inject?: unknown
}

function fakeClientContext(options: { tabs?: boolean; cordisInject?: boolean } = {}): {
  ctx: Parameters<typeof apply>[0]
  registrations: Registered[]
  tabDefinitions: Array<Record<string, unknown>>
  injectedSlots: string[]
  injectedDeps: string[][]
  servedNamespaces: string[][]
  dictionaries: Record<string, unknown>
} {
  const registrations: Registered[] = []
  const tabDefinitions: Array<Record<string, unknown>> = []
  const injectedSlots: string[] = []
  const injectedDeps: string[][] = []
  const servedNamespaces: string[][] = []
  const dictionaries: Record<string, unknown> = {}

  const ctx: Record<string, unknown> = {
    locale: {
      register: (namespace: string, dictionary: Record<string, unknown>) => {
        dictionaries[namespace] = dictionary
        return () => {}
      },
      bind: () => (key: string) => key,
    },
    slots: {
      inject: (name: string, callback: () => () => void) => {
        injectedSlots.push(name)
        return callback()
      },
      register: (options: Registered) => {
        registrations.push(options)
        return () => {}
      },
    },
    configForms: {
      whileServed: (namespaces: string[], register: () => () => void) => {
        servedNamespaces.push(namespaces)
        return register()
      },
    },
    effect: (run: () => (() => void) | void) => run() ?? (() => {}),
  }
  if (options.tabs === true) {
    ctx['sidebarRightTabs'] = {
      register: (definition: Record<string, unknown>) => {
        tabDefinitions.push(definition)
        return () => {}
      },
    }
  }
  if (options.cordisInject === true) {
    ctx['inject'] = (deps: string[], callback: (scoped: unknown) => void) => {
      injectedDeps.push(deps)
      callback(ctx)
      return () => {}
    }
  }

  return {
    ctx: ctx as unknown as Parameters<typeof apply>[0],
    registrations,
    tabDefinitions,
    injectedSlots,
    injectedDeps,
    servedNamespaces,
    dictionaries,
  }
}

describe('client half registration', () => {
  it('声明 slots/locale/configForms', () => {
    expect(inject).toEqual(['slots', 'locale', 'configForms'])
  })

  it('只在 settings 提供 memlite 命名空间时注册行配置页', () => {
    const fake = fakeClientContext()
    apply(fake.ctx)
    expect(fake.servedNamespaces).toEqual([['memlite']])
    // 没有 sidebarRightTabs 服务时不出现记忆页相关注册
    expect(fake.injectedSlots).toEqual(['plugins.row.config'])
    expect(fake.registrations).toHaveLength(1)
    expect(fake.registrations[0]).toMatchObject({
      name: 'plugins.row.config',
      key: '@rsrsai/dsh-memlite#memlite',
      locale: 'memliteConfig',
    })
    expect(Object.keys(fake.dictionaries)).toEqual(['memliteConfig', MEMORY_LOCALE_NS])
  })

  it('没有 whileServed 的老部署直接注册', () => {
    const fake = fakeClientContext()
    ;(fake.ctx as { configForms?: unknown }).configForms = undefined
    apply(fake.ctx)
    expect(fake.injectedSlots).toEqual(['plugins.row.config'])
    expect(fake.registrations).toHaveLength(1)
  })
})

describe('memory tab registration', () => {
  it('cordis inject 可用时等 sidebarRightTabs 后再注册页类型与页体', () => {
    const fake = fakeClientContext({ tabs: true, cordisInject: true })
    apply(fake.ctx)
    expect(fake.injectedDeps).toEqual([['sidebarRightTabs']])
    // 页类型：id/kind/priority + Guide 入口
    expect(fake.tabDefinitions).toHaveLength(1)
    const definition = fake.tabDefinitions[0]!
    expect(definition['id']).toBe(MEMORY_TAB_ID)
    expect(definition['kind']).toBe(MEMORY_TAB_KIND)
    expect(definition['priority']).toBe('extension')
    expect(typeof definition['title']).toBe('function')
    const guide = definition['guide'] as Array<Record<string, unknown>>
    expect(guide).toHaveLength(1)
    expect(guide[0]?.['id']).toBe('memory')
    expect(guide[0]?.['order']).toBe(40)
    expect(typeof guide[0]?.['title']).toBe('function')
    expect(typeof guide[0]?.['description']).toBe('function')
    expect(typeof guide[0]?.['icon']).toBe('function')
    // 页体：sidebar.right.pane.tab 键ed slot，注入 sessionId
    expect(fake.injectedSlots).toContain('sidebar.right.pane.tab')
    const body = fake.registrations.find((item) => item.name === 'sidebar.right.pane.tab')
    expect(body).toBeDefined()
    expect(body?.key).toBe(MEMORY_TAB_ID)
    expect(body?.locale).toBe(MEMORY_LOCALE_NS)
    expect(typeof body?.inject).toBe('function')
    expect((body?.inject as (sessionId: string) => unknown)('session-1')).toEqual({ sessionId: 'session-1' })
  })

  it('没有 cordis inject 的宿主仍直接注册（sidebarRightTabs 存在即可）', () => {
    const fake = fakeClientContext({ tabs: true })
    apply(fake.ctx)
    expect(fake.tabDefinitions).toHaveLength(1)
    expect(fake.injectedSlots).toContain('sidebar.right.pane.tab')
  })
})

describe('config page rendering', () => {
  it('渲染 Obsidian 导入/导出分组与操作', () => {
    const html = renderToStaticMarkup(
      createElement(MemliteConfigPage, {
        t: (key: string) => key,
        view: 'page',
        form: {
          state: {
            status: 'ready',
            value: DEFAULTS,
            base: DEFAULTS,
            user: {},
            revision: 0,
            writable: true,
          },
          mutate: async () => true,
        },
      }),
    )
    expect(html).toContain('groupObsidian')
    expect(html).toContain('vaultPath')
    expect(html).toContain('exportPath')
    expect(html).toContain('importStatus')
    expect(html).toContain('previewImport')
    expect(html).toContain('runImport')
    expect(html).toContain('runExport')
  })
})

describe('built client bundle', () => {
  const bundle = path.join(process.cwd(), 'dist', 'client.js')

  it.skipIf(!existsSync(bundle))('是 ModuleLoader factory 形状，登记包名并返回 exports', () => {
    const source = readFileSync(bundle, 'utf8')
    expect(source.startsWith('window.__ModuleLoader__.load({')).toBe(true)
    expect(source).toContain('id: "@rsrsai/dsh-memlite"')
    expect(source).toContain('factory: (require) => {')
    expect(source).toContain('return module.exports;')
  })

  it.skipIf(!existsSync(bundle))('在假 ModuleLoader 下可执行并导出 apply', async () => {
    let definition: { id?: string; factory?: (require: (spec: string) => unknown) => unknown } | undefined
    ;(globalThis as { window?: unknown }).window = {
      __ModuleLoader__: {
        load: (loaded: typeof definition) => {
          definition = loaded
        },
      },
    }
    try {
      await import(`${pathToFileURL(bundle).href}?test=${Date.now()}`)
      expect(definition?.id).toBe('@rsrsai/dsh-memlite')
      const stubs: Record<string, unknown> = {
        react: { useState: () => [undefined, () => {}], useEffect: () => {}, useMemo: () => ({}) },
        'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: null },
      }
      const exports = definition?.factory?.((spec) => stubs[spec]) as { apply?: unknown } | undefined
      expect(typeof exports?.apply).toBe('function')
    } finally {
      delete (globalThis as { window?: unknown }).window
    }
  })
})
