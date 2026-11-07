/**
 * 浏览器半区入口：把 memlite 配置页注册进侧栏「插件」页的行详情。
 *
 * 组合方式（来自 @deepseek-ai/dsh-client-modules 与 ui-plugin-manager 文档）：
 * - package.json `dsh.client` 声明 platform=web，导出 `./client` bundle；
 * - bundle 由 Loader 行（id `memlite`，模块 `@rsrsai/dsh-memlite`）挂载，行停用即卸载；
 * - 行配置 slot 的键是 `<包名>#<行 id>`，即 `@rsrsai/dsh-memlite#memlite`；
 * - 页面只在 settings 服务真的提供 `memlite` 命名空间时注册（避免出现不可用的“配置”入口）。
 */
import type { ReactNode } from 'react'
import { MemliteConfigPage, type PageProps } from './MemliteSettings'
import { locales } from './locales'

/** settings 命名空间 = profile 条目 id（bundle patch 里 insert 的行 id）。 */
const ENTRY_ID = 'memlite'
/** 本页字典命名空间。 */
const NS = 'memliteConfig'
/** 行配置 slot 的键：包名#行 id。 */
const ROW_CONFIG_KEY = '@rsrsai/dsh-memlite#memlite'

interface LocaleService {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  bind(namespace: string): PageProps['t']
}

interface SlotsService {
  inject(name: string, callback: () => () => void): () => void
  register(options: Record<string, unknown>, component: (props: PageProps) => ReactNode): () => void
}

interface ConfigFormsService {
  whileServed?(namespaces: string[], register: () => () => void): () => void
}

interface ClientContext {
  readonly locale: LocaleService
  readonly slots: SlotsService
  readonly configForms?: ConfigFormsService
  effect(effect: () => (() => void) | void, label?: string): () => void
}

/** 必需服务（浏览器侧 cordis fiber inject）。 */
export const inject = ['slots', 'locale', 'configForms']

export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(NS, locales as unknown as Record<string, Record<string, string>>),
    'memlite: config page dictionaries',
  )

  const registerPage = (): (() => void) =>
    ctx.slots.inject('plugins.row.config', () =>
      ctx.slots.register(
        {
          name: 'plugins.row.config',
          key: ROW_CONFIG_KEY,
          locale: NS,
        },
        MemliteConfigPage,
      ),
    )

  // ui-settings 提供 whileServed 时跟随命名空间；老版本直接注册。
  ctx.effect(() => {
    if (typeof ctx.configForms?.whileServed === 'function') {
      return ctx.configForms.whileServed([ENTRY_ID], registerPage)
    }
    return registerPage()
  }, 'memlite: config page')
}
