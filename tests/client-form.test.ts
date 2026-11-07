/** 配置表单纯逻辑：默认值、差集（set/unset）、校验、覆盖标记。 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULTS,
  buildChangeSet,
  configPath,
  hasOverride,
  normalizeDraft,
  resetField,
  validateDraft,
  type ConfigFormState,
} from '../src/client/form'

function state(over: Partial<ConfigFormState> = {}): ConfigFormState {
  return {
    status: 'ready',
    value: DEFAULTS,
    base: DEFAULTS,
    user: {},
    revision: 0,
    writable: true,
    ...over,
  }
}

describe('normalizeDraft', () => {
  it('空配置回落到 Schema 默认值', () => {
    const draft = normalizeDraft(undefined)
    expect(draft.enabled).toBe(true)
    expect(draft.recallLimit).toBe('5')
    expect(draft.recallThreshold).toBe('0')
    expect(draft.budgetChars).toBe('1500')
    expect(draft.minPromptChars).toBe('2')
    expect(draft.storeNudgeEvery).toBe('1')
    expect(draft.embeddingProvider).toBe('none')
    expect(draft.embeddingModel).toBe('BAAI/bge-m3')
    expect(draft.embeddingCredentialRef).toBe('MEMLITE_EMBED_API_KEY')
    expect(draft.embeddingTimeoutMs).toBe('30000')
    expect(draft.syncAuto).toBe(false)
    expect(draft.sensitiveGate).toBe(true)
  })

  it('保留已有值（含嵌套 embedding/sync）', () => {
    const draft = normalizeDraft({
      dataDir: 'D:/mem',
      recallLimit: 12,
      sync: { auto: true, remote: 'git@x:y.git' },
      embedding: { provider: 'openai-compatible', apiBase: 'https://api.test/v1', timeoutMs: 1000 },
    })
    expect(draft.dataDir).toBe('D:/mem')
    expect(draft.recallLimit).toBe('12')
    expect(draft.syncAuto).toBe(true)
    expect(draft.syncRemote).toBe('git@x:y.git')
    expect(draft.embeddingProvider).toBe('openai-compatible')
    expect(draft.embeddingApiBase).toBe('https://api.test/v1')
    expect(draft.embeddingTimeoutMs).toBe('1000')
  })
})

describe('buildChangeSet', () => {
  it('无改动 → 空操作', () => {
    expect(buildChangeSet(normalizeDraft(DEFAULTS), state()).ops).toEqual([])
  })

  it('普通字段改动 → set，路径正确', () => {
    const draft = { ...normalizeDraft(DEFAULTS), recallLimit: '10', dataDir: 'D:/mem' }
    const { ops } = buildChangeSet(draft, state())
    expect(ops).toEqual([
      { op: 'set', path: ['recallLimit'], value: 10 },
      { op: 'set', path: ['dataDir'], value: 'D:/mem' },
    ])
  })

  it('嵌套字段：embedding.provider / sync.auto / timeoutMs', () => {
    const draft = {
      ...normalizeDraft(DEFAULTS),
      embeddingProvider: 'openai-compatible' as const,
      embeddingTimeoutMs: '45000',
      syncAuto: true,
    }
    const { ops } = buildChangeSet(draft, state())
    expect(ops).toContainEqual({ op: 'set', path: ['embedding', 'provider'], value: 'openai-compatible' })
    expect(ops).toContainEqual({ op: 'set', path: ['embedding', 'timeoutMs'], value: 45000 })
    expect(ops).toContainEqual({ op: 'set', path: ['sync', 'auto'], value: true })
  })

  it('清空数值且已有覆盖 → unset（恢复继承层）', () => {
    const draft = { ...normalizeDraft(DEFAULTS), recallLimit: '' }
    const s = state({
      value: { ...DEFAULTS, recallLimit: 10 },
      user: { recallLimit: 10 },
    })
    expect(buildChangeSet(draft, s).ops).toEqual([{ op: 'unset', path: ['recallLimit'] }])
  })

  it('清空数值但没有覆盖 → 不动', () => {
    const draft = { ...normalizeDraft(DEFAULTS), recallLimit: '' }
    expect(buildChangeSet(draft, state()).ops).toEqual([])
  })

  it('值等于 base 且仍有覆盖 → unset 清理覆盖', () => {
    const draft = { ...normalizeDraft(DEFAULTS), dataDir: '' }
    const s = state({ user: { dataDir: 'D:/old' } })
    expect(buildChangeSet(draft, s).ops).toEqual([{ op: 'unset', path: ['dataDir'] }])
  })

  it('校验失败 → 空 ops + 错误', () => {
    const draft = { ...normalizeDraft(DEFAULTS), recallLimit: '999' }
    const { ops, errors } = buildChangeSet(draft, state())
    expect(ops).toEqual([])
    expect(errors.recallLimit?.key).toBe('errIntRange')
    expect(errors.recallLimit?.params).toEqual({ min: 1, max: 50 })
  })
})

describe('validateDraft', () => {
  it('整数/小数/越界/空值', () => {
    expect(validateDraft({ ...normalizeDraft(DEFAULTS), recallLimit: '2.5' }).recallLimit).toBeDefined()
    expect(validateDraft({ ...normalizeDraft(DEFAULTS), recallLimit: '0' }).recallLimit).toBeDefined()
    expect(validateDraft({ ...normalizeDraft(DEFAULTS), recallLimit: '' }).recallLimit).toBeUndefined()
    expect(validateDraft({ ...normalizeDraft(DEFAULTS), recallThreshold: '1.5' }).recallThreshold).toBeDefined()
  })
})

describe('hasOverride / resetField', () => {
  it('configPath 把草稿字段映射到嵌套配置路径', () => {
    expect(configPath('recallLimit')).toEqual(['recallLimit'])
    expect(configPath('syncAuto')).toEqual(['sync', 'auto'])
    expect(configPath('embeddingProvider')).toEqual(['embedding', 'provider'])
    expect(configPath('embeddingTimeoutMs')).toEqual(['embedding', 'timeoutMs'])
  })

  it('识别 user 层的覆盖（含嵌套）', () => {
    const s = state({ user: { recallLimit: 9, embedding: { provider: 'host' } } })
    expect(hasOverride(s, ['recallLimit'])).toBe(true)
    expect(hasOverride(s, ['embedding', 'provider'])).toBe(true)
    expect(hasOverride(s, ['dataDir'])).toBe(false)
  })

  it('resetField 取 base 的嵌套值', () => {
    const s = state({ base: { ...DEFAULTS, embedding: { ...DEFAULTS.embedding, timeoutMs: 1000 } } })
    const draft = { ...normalizeDraft(DEFAULTS), embeddingTimeoutMs: '30000' }
    expect(resetField(draft, s, 'embeddingTimeoutMs').embeddingTimeoutMs).toBe('1000')
  })
})
