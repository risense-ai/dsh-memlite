/**
 * 配置表单的纯逻辑：草稿归一化、校验、与 settings 快照求差集（set/unset 操作）。
 *
 * 与 React 无关，可直接在 node 下单测。设置写入语义来自 @deepseek-ai/dsh-settings：
 * - 表单只投影 volatile 字段（本插件根对象 volatile），value=生效值、base=继承层、
 *   user=profile patch 覆盖层；
 * - `unset` 等于恢复继承层（base）的值。
 */
import type { EmbeddingConfig, PluginConfig } from '../schema'

export type StringKey =
  | 'dataDir'
  | 'recallLimit'
  | 'recallThreshold'
  | 'budgetChars'
  | 'minPromptChars'
  | 'storeNudgeEvery'
  | 'syncRemote'
  | 'embeddingApiBase'
  | 'embeddingModel'
  | 'embeddingCredentialRef'
  | 'embeddingTimeoutMs'

export type BoolKey = 'enabled' | 'syncAuto' | 'sensitiveGate'
export type Provider = EmbeddingConfig['provider']

export interface Draft {
  enabled: boolean
  dataDir: string
  recallLimit: string
  recallThreshold: string
  budgetChars: string
  minPromptChars: string
  storeNudgeEvery: string
  syncAuto: boolean
  syncRemote: string
  embeddingProvider: Provider
  embeddingApiBase: string
  embeddingModel: string
  embeddingCredentialRef: string
  embeddingTimeoutMs: string
  sensitiveGate: boolean
}

/** Schema 默认值（与 src/schema.ts 一致；表单“恢复默认”与空值都回落到这里）。 */
export const DEFAULTS: PluginConfig = {
  enabled: true,
  dataDir: '',
  recallLimit: 5,
  recallThreshold: 0,
  budgetChars: 1500,
  minPromptChars: 2,
  storeNudgeEvery: 1,
  sync: { auto: false },
  embedding: {
    provider: 'none',
    model: 'BAAI/bge-m3',
    credentialRef: 'MEMLITE_EMBED_API_KEY',
    timeoutMs: 30000,
  },
  sensitiveGate: true,
}

export interface ConfigFormState {
  status?: 'loading' | 'ready' | 'unavailable' | string
  value?: Partial<PluginConfig>
  base?: Partial<PluginConfig>
  user?: Partial<PluginConfig>
  revision?: number
  writable?: boolean
}

export interface ConfigFormLike {
  state: ConfigFormState
  mutate(ops: ConfigOp[], revision?: number): Promise<boolean>
}

export type ConfigOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

export interface FieldError {
  key: 'errIntRange' | 'errNumberRange'
  params: { min: number; max: number }
}

export type DraftErrors = Partial<Record<keyof Draft, FieldError>>

interface NumberField {
  id: [StringKey]
  path: string[]
  min: number
  max: number
  integer: boolean
}

const NUMBER_FIELDS: NumberField[] = [
  { id: ['recallLimit'], path: ['recallLimit'], min: 1, max: 50, integer: true },
  { id: ['recallThreshold'], path: ['recallThreshold'], min: 0, max: 1, integer: false },
  { id: ['budgetChars'], path: ['budgetChars'], min: 200, max: 20000, integer: true },
  { id: ['minPromptChars'], path: ['minPromptChars'], min: 1, max: 1000, integer: true },
  { id: ['storeNudgeEvery'], path: ['storeNudgeEvery'], min: 0, max: 1000, integer: true },
  { id: ['embeddingTimeoutMs'], path: ['embedding', 'timeoutMs'], min: 1, max: 3_600_000, integer: true },
]

/** 取嵌套值（own property 语义与 settings 项目投影一致）。 */
export function readPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function safeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function safeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 生成表单草稿（数字先变字符串，留空表示“恢复继承层”）。 */
export function normalizeDraft(value?: Partial<PluginConfig>): Draft {
  const embedding: Partial<EmbeddingConfig> = value?.embedding ?? {}
  const sync: { auto?: boolean; remote?: string } = value?.sync ?? {}
  return {
    enabled: typeof value?.enabled === 'boolean' ? value.enabled : DEFAULTS.enabled,
    dataDir: safeString(value?.dataDir, DEFAULTS.dataDir),
    recallLimit: String(safeNumber(value?.recallLimit, DEFAULTS.recallLimit)),
    recallThreshold: String(safeNumber(value?.recallThreshold, DEFAULTS.recallThreshold)),
    budgetChars: String(safeNumber(value?.budgetChars, DEFAULTS.budgetChars)),
    minPromptChars: String(safeNumber(value?.minPromptChars, DEFAULTS.minPromptChars)),
    storeNudgeEvery: String(safeNumber(value?.storeNudgeEvery, DEFAULTS.storeNudgeEvery)),
    syncAuto: typeof sync.auto === 'boolean' ? sync.auto : DEFAULTS.sync.auto,
    syncRemote: safeString(sync.remote, ''),
    embeddingProvider:
      embedding.provider === 'host' || embedding.provider === 'openai-compatible'
        ? embedding.provider
        : 'none',
    embeddingApiBase: safeString(embedding.apiBase, ''),
    embeddingModel: safeString(embedding.model, DEFAULTS.embedding.model ?? ''),
    embeddingCredentialRef: safeString(
      embedding.credentialRef,
      DEFAULTS.embedding.credentialRef ?? 'MEMLITE_EMBED_API_KEY',
    ),
    embeddingTimeoutMs: String(safeNumber(embedding.timeoutMs, DEFAULTS.embedding.timeoutMs ?? 30000)),
    sensitiveGate: typeof value?.sensitiveGate === 'boolean' ? value.sensitiveGate : DEFAULTS.sensitiveGate,
  }
}

/** 数值字段解析；空串校验通过但返回 undefined（保存时走 reset/unset）。 */
function parseNumber(raw: string, spec: NumberField): number | undefined | FieldError {
  const text = raw.trim()
  if (text === '') return undefined
  const value = Number(text)
  if (!Number.isFinite(value)) return { key: 'errNumberRange', params: { min: spec.min, max: spec.max } }
  if (spec.integer && !Number.isInteger(value)) {
    return { key: 'errNumberRange', params: { min: spec.min, max: spec.max } }
  }
  if (value < spec.min || value > spec.max) {
    return { key: spec.integer ? 'errIntRange' : 'errNumberRange', params: { min: spec.min, max: spec.max } }
  }
  return value
}

/** 表单校验；只在有错误时返回条目。 */
export function validateDraft(draft: Draft): DraftErrors {
  const errors: DraftErrors = {}
  for (const spec of NUMBER_FIELDS) {
    const result = parseNumber(draft[spec.id[0]], spec)
    if (result !== undefined && typeof result === 'object' && 'key' in result) errors[spec.id[0]] = result
  }
  return errors
}

function sameValue(left: unknown, right: unknown): boolean {
  return left === right
}

interface StringSpec {
  id: StringKey
  path: string[]
}

const STRING_FIELDS: StringSpec[] = [
  { id: 'dataDir', path: ['dataDir'] },
  { id: 'syncRemote', path: ['sync', 'remote'] },
  { id: 'embeddingApiBase', path: ['embedding', 'apiBase'] },
  { id: 'embeddingModel', path: ['embedding', 'model'] },
  { id: 'embeddingCredentialRef', path: ['embedding', 'credentialRef'] },
]

/** user（profile patch）里是否已经有该路径的覆盖值——用于“已覆盖”标记。 */
export function hasOverride(state: ConfigFormState, path: readonly string[]): boolean {
  return readPath(state.user, path) !== undefined
}

/** 草稿字段 → settings 配置路径（嵌套字段用多段）。 */
export function configPath(key: keyof Draft): string[] {
  switch (key) {
    case 'syncAuto':
      return ['sync', 'auto']
    case 'syncRemote':
      return ['sync', 'remote']
    case 'embeddingProvider':
      return ['embedding', 'provider']
    case 'embeddingApiBase':
      return ['embedding', 'apiBase']
    case 'embeddingModel':
      return ['embedding', 'model']
    case 'embeddingCredentialRef':
      return ['embedding', 'credentialRef']
    case 'embeddingTimeoutMs':
      return ['embedding', 'timeoutMs']
    default:
      return [key]
  }
}

/** 继承层值；缺失时回落到 Schema 默认。 */
export function baseValue(state: ConfigFormState, path: readonly string[], fallback: unknown): unknown {
  const value = readPath(state.base, path)
  return value !== undefined ? value : fallback
}

/**
 * 计算一次保存需要的操作集。
 * - 空串 / 空数字 = “恢复继承层”：有覆盖则 unset，否则不动；
 * - 其他字段与生效值不同才 set；
 * - 校验失败时返回 errors（同时 ops 为空）。
 */
export function buildChangeSet(
  draft: Draft,
  state: ConfigFormState,
): { ops: ConfigOp[]; errors: DraftErrors } {
  const errors = validateDraft(draft)
  if (Object.keys(errors).length > 0) return { ops: [], errors }
  const ops: ConfigOp[] = []

  for (const spec of NUMBER_FIELDS) {
    const result = parseNumber(draft[spec.id[0]], spec)
    if (result === undefined || typeof result === 'object') {
      // 空值：恢复继承层
      if (hasOverride(state, spec.path)) ops.push({ op: 'unset', path: spec.path })
      continue
    }
    const fallback = readPath(DEFAULTS, spec.path)
    const base = baseValue(state, spec.path, fallback)
    const current = readPath(state.value, spec.path)
    if (sameValue(result, base) && hasOverride(state, spec.path)) {
      ops.push({ op: 'unset', path: spec.path })
    } else if (!sameValue(result, current)) {
      ops.push({ op: 'set', path: spec.path, value: result })
    }
  }

  for (const spec of STRING_FIELDS) {
    const text = (draft[spec.id] as string).trim()
    const fallback = readPath(DEFAULTS, spec.path) ?? ''
    const base = baseValue(state, spec.path, fallback)
    const current = readPath(state.value, spec.path) ?? ''
    if (text === '') {
      if (hasOverride(state, spec.path)) ops.push({ op: 'unset', path: spec.path })
      continue
    }
    if (sameValue(text, base) && hasOverride(state, spec.path)) {
      ops.push({ op: 'unset', path: spec.path })
    } else if (!sameValue(text, current)) {
      ops.push({ op: 'set', path: spec.path, value: text })
    }
  }

  const provider = draft.embeddingProvider
  if (!sameValue(provider, baseValue(state, ['embedding', 'provider'], 'none')) && !sameValue(provider, readPath(state.value, ['embedding', 'provider']))) {
    ops.push({ op: 'set', path: ['embedding', 'provider'], value: provider })
  } else if (sameValue(provider, baseValue(state, ['embedding', 'provider'], 'none')) && hasOverride(state, ['embedding', 'provider'])) {
    ops.push({ op: 'unset', path: ['embedding', 'provider'] })
  }

  for (const spec of [
    { id: 'enabled' as BoolKey, path: ['enabled'] },
    { id: 'sensitiveGate' as BoolKey, path: ['sensitiveGate'] },
    { id: 'syncAuto' as BoolKey, path: ['sync', 'auto'] },
  ]) {
    const desired = draft[spec.id]
    const base = baseValue(state, spec.path, readPath(DEFAULTS, spec.path))
    const current = readPath(state.value, spec.path)
    if (sameValue(desired, base) && hasOverride(state, spec.path)) {
      ops.push({ op: 'unset', path: spec.path })
    } else if (!sameValue(desired, current)) {
      ops.push({ op: 'set', path: spec.path, value: desired })
    }
  }

  return { ops, errors: {} }
}

/** 恢复某个字段到继承层/默认值（浏览器侧草稿操作）。 */
export function resetField(draft: Draft, state: ConfigFormState, id: keyof Draft): Draft {
  const spec =
    NUMBER_FIELDS.find((entry) => entry.id[0] === id)
    ?? STRING_FIELDS.find((entry) => entry.id === id)
  const boolSpec = [
    { id: 'enabled' as keyof Draft, path: ['enabled'] },
    { id: 'sensitiveGate' as keyof Draft, path: ['sensitiveGate'] },
    { id: 'syncAuto' as keyof Draft, path: ['sync', 'auto'] },
  ].find((entry) => entry.id === id)

  const next = { ...draft }
  const assign = (value: unknown): void => {
    ;(next as unknown as Record<string, unknown>)[id] = value
  }
  const fallback = spec !== undefined ? readPath(DEFAULTS, spec.path) : undefined
  const base = spec !== undefined ? baseValue(state, spec.path, fallback ?? '') : undefined

  if (spec !== undefined && typeof fallback === 'number') {
    assign(String(base ?? fallback))
  } else if (spec !== undefined) {
    assign(safeString(base, ''))
  } else if (boolSpec !== undefined) {
    assign(Boolean(base ?? readPath(DEFAULTS, boolSpec.path)))
  } else if (id === 'embeddingProvider') {
    next.embeddingProvider = baseValue(state, ['embedding', 'provider'], 'none') as Provider
  }
  return next
}
