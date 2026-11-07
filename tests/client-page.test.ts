/** 浏览器半区：注册契约（slot 键、locale、whileServed）与构建产物形状。 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { apply, inject } from '../src/client/index'
import { MemliteConfigPage } from '../src/client/MemliteSettings'
import { DEFAULTS } from '../src/client/form'

interface Registered {
  name?: unknown
  key?: unknown
  locale?: unknown
}

function fakeClientContext(): {
  ctx: Parameters<typeof apply>[0]
  registrations: Registered[]
  injectedSlots: string[]
  servedNamespaces: string[][]
  dictionaries: Record<string, unknown>
} {
  const registrations: Registered[] = []
  const injectedSlots: string[] = []
  const servedNamespaces: string[][] = []
  const dictionaries: Record<string, unknown> = {}

  const ctx = {
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
  } as unknown as Parameters<typeof apply>[0]

  return { ctx, registrations, injectedSlots, servedNamespaces, dictionaries }
}

describe('client half registration', () => {
  it('声明 slots/locale/configForms', () => {
    expect(inject).toEqual(['slots', 'locale', 'configForms'])
  })

  it('只在 settings 提供 memlite 命名空间时注册行配置页', () => {
    const fake = fakeClientContext()
    apply(fake.ctx)
    expect(fake.servedNamespaces).toEqual([['memlite']])
    expect(fake.injectedSlots).toEqual(['plugins.row.config'])
    expect(fake.registrations).toHaveLength(1)
    expect(fake.registrations[0]).toMatchObject({
      name: 'plugins.row.config',
      key: '@rsrsai/dsh-memlite#memlite',
      locale: 'memliteConfig',
    })
    expect(Object.keys(fake.dictionaries)).toEqual(['memliteConfig'])
  })

  it('没有 whileServed 的老部署直接注册', () => {
    const fake = fakeClientContext()
    ;(fake.ctx as { configForms?: unknown }).configForms = undefined
    apply(fake.ctx)
    expect(fake.injectedSlots).toEqual(['plugins.row.config'])
    expect(fake.registrations).toHaveLength(1)
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
