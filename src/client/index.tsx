/**
 * 浏览器半区入口（三个面）：
 * 1. 配置页：注册进侧栏「插件」页的行详情（`plugins.row.config`）。
 * 2. 设置分节：同一份配置表单注册进「设置」对话框（`settings.section` + `settings.section.icon`）。
 * 3. 记忆浏览器：注册右侧 Sidebar 的 Memory 页类型（`ctx.sidebarRightTabs`）与页体
 *    （`sidebar.right.pane.tab`，键=页类型 id），Guide 里出现入口。
 *
 * 组合方式（来自 @deepseek-ai/dsh-client-modules 与 ui-plugin-manager / ui-sidebar-right 文档）：
 * - package.json `dsh.client` 声明 platform=web，导出 `./client` bundle；
 * - bundle 由 Loader 行（id `memlite`，模块 `@rsrsai/dsh-memlite`）挂载，行停用即卸载；
 * - 行配置 slot 的键是 `<包名>#<行 id>`，即 `@rsrsai/dsh-memlite#memlite`；
 * - 页面只在 settings 服务真的提供 `memlite` 命名空间时注册（避免出现不可用的“配置”入口）；
 * - `sidebarRightTabs` 用可选注入：老宿主没有该服务时配置页照常工作，记忆页不注册。
 */
import type { ReactNode } from 'react'
import {
  MemliteConfigPage,
  MemliteSettingsSection,
  type ConfigFormControllerLike,
  type PageProps,
} from './MemliteSettings'
import { locales } from './locales'
import { MemliteMemoryPanel } from './MemliteMemory'
import { MEMORY_LOCALE_NS, memoryLocales } from './memory-locales'

/** settings 命名空间 = profile 条目 id（bundle patch 里 insert 的行 id）。 */
const ENTRY_ID = 'memlite'
/** 本页字典命名空间。 */
const NS = 'memliteConfig'
/** 行配置 slot 的键：包名#行 id。 */
const ROW_CONFIG_KEY = '@rsrsai/dsh-memlite#memlite'
/** 记忆浏览器页类型 id（页类型/页体的键）。 */
export const MEMORY_TAB_ID = '@rsrsai/dsh-memlite/memory'
/** 记忆浏览器页类型 kind。 */
export const MEMORY_TAB_KIND = 'memlite-memory'

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
  get?(entryId: string): ConfigFormControllerLike
}

/** 右侧 Sidebar 页类型注册面（dsh-client-ui-sidebar-right 的 `ctx.sidebarRightTabs`）。 */
interface SidebarRightTabsService {
  register(definition: Record<string, unknown>): () => void
}

interface ClientContext {
  readonly locale: LocaleService
  readonly slots: SlotsService
  readonly configForms?: ConfigFormsService
  readonly sidebarRightTabs?: SidebarRightTabsService
  effect(effect: () => (() => void) | void, label?: string): () => void
  /** cordis 可选服务注入（宿主是 cordis context 时存在；测试替身可缺省）。 */
  inject?(deps: string[], callback: (scoped: ClientContext) => void): unknown
}

/** 必需服务（浏览器侧 cordis fiber inject）。 */
export const inject = ['slots', 'locale', 'configForms']

/** 记忆浏览器的内联图标（不 import ui-primitives，保持 bundle 只外置 react）。
 *  与包图标 `icon.svg` 同一母题：因果星图（三个记忆节点 + 连线），这里用 currentColor 单色。 */
function MemoryGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" strokeOpacity="0.8">
        <path d="M7.65 4.4 4.5 10.3" />
        <path d="M7.65 4.4 11.85 9.4" />
        <path d="M4.5 10.3 11.85 9.4" />
      </g>
      <circle cx="7.65" cy="4.4" r="1.75" fill="currentColor" />
      <circle cx="4.5" cy="10.3" r="1.35" fill="currentColor" fillOpacity="0.9" />
      <circle cx="11.85" cy="9.4" r="1.35" fill="currentColor" fillOpacity="0.9" />
    </svg>
  )
}

/**
 * 注册 Memory 页类型与页体。
 *
 * 页类型：Guide 收录一个入口，点它按 kind 打开本页；
 * 页体：`sidebar.right.pane.tab` 的键ed slot，slot 框架把 `sessionId` 与
 * `useTabInfo` 等 hooks 作为 props 注入（`inject` 返回值合并进 props）。
 * 两处注册都放进 `scoped.effect`，随插件卸载一起消失。
 */
export function registerMemoryTab(scoped: ClientContext): void {
  const tabs = scoped.sidebarRightTabs
  // 老宿主没有右侧栏页类型注册面：记忆页整体不注册，配置页不受影响。
  if (tabs === undefined) return

  const t = scoped.locale.bind(MEMORY_LOCALE_NS)
  scoped.effect(
    () =>
      tabs.register({
        id: MEMORY_TAB_ID,
        kind: MEMORY_TAB_KIND,
        priority: 'extension',
        title: () => t('tab.title'),
        guide: [
          {
            id: 'memory',
            order: 40,
            title: () => t('guide.title'),
            description: () => t('guide.description'),
            icon: MemoryGlyph,
          },
        ],
      }),
    'memlite: memory tab type',
  )

  scoped.effect(
    () =>
      scoped.slots.inject('sidebar.right.pane.tab', () =>
        scoped.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: MEMORY_TAB_ID,
            locale: MEMORY_LOCALE_NS,
            inject: (sessionId: string) => ({ sessionId }),
          },
          MemliteMemoryPanel as (props: PageProps) => ReactNode,
        ),
      ),
    'memlite: memory tab body',
  )
}

export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(NS, locales as unknown as Record<string, Record<string, string>>),
    'memlite: config page dictionaries',
  )
  ctx.effect(
    () =>
      ctx.locale.register(
        MEMORY_LOCALE_NS,
        memoryLocales as unknown as Record<string, Record<string, string>>,
      ),
    'memlite: memory browser dictionaries',
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

  // 「设置」对话框里的 Memlite 分节（settings.section，id=memlite）：
  // 与插件页行配置同一份表单的第二个入口，命名空间被服务时才出现。
  const tConfig = ctx.locale.bind(NS)
  const registerSettingsSection = (): (() => void) => {
    const offSection = ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: ENTRY_ID,
          order: 16,
          label: () => tConfig('settings.nav'),
          locale: NS,
          inject: () => {
            const form = ctx.configForms?.get?.(ENTRY_ID)
            return form === undefined ? {} : { form }
          },
        },
        MemliteSettingsSection as unknown as (props: PageProps) => ReactNode,
      ),
    )
    const offIcon = ctx.slots.inject('settings.section.icon', () =>
      ctx.slots.register(
        {
          name: 'settings.section.icon',
          id: ENTRY_ID,
          locale: NS,
        },
        (() => <MemoryGlyph />) as unknown as (props: PageProps) => ReactNode,
      ),
    )
    return () => {
      offIcon()
      offSection()
    }
  }
  ctx.effect(() => {
    if (typeof ctx.configForms?.whileServed === 'function') {
      return ctx.configForms.whileServed([ENTRY_ID], registerSettingsSection)
    }
    return registerSettingsSection()
  }, 'memlite: settings section')

  // 记忆浏览器：只在宿主提供 sidebarRightTabs 时注册；老宿主上配置页不受影响。
  ctx.effect(() => {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['sidebarRightTabs'], (scoped) => registerMemoryTab(scoped as ClientContext))
      return
    }
    registerMemoryTab(ctx)
  }, 'memlite: memory browser tab')
}
