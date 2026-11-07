/**
 * 装配：Memlite 实例构造 + 凭据适配 + 生命周期（ctx.effect 是唯一 dispose 通路）。
 */
import { Memlite, type MemliteConfig, type MemliteDeps } from '@rsrsai/memlite'
import type { CredentialsService, PluginContext } from './types'
import type { PluginConfig } from './schema'

export interface Assembled {
  readonly mem: Memlite
  readonly dispose: () => void
}

export type CredentialResolver = MemliteDeps['credentialResolver']

/**
 * 凭据适配（M0 漂移一）：宿主是 `credentials.resolve(ref) → {value, source} | undefined`，
 * 插件侧拉平为 memlite 的 `(ref) → value | undefined`。
 * credentials 服务经 ctx.inject 捕获——apply 时刻服务未就绪也不炸，解析在调用期。
 * 只创建一次，供配置热更新时重建引擎复用。
 */
export function createCredentialResolver(ctx: PluginContext): CredentialResolver {
  let credentials: CredentialsService | undefined
  try {
    ctx.inject(['credentials'], (scoped) => {
      credentials = (scoped as unknown as { credentials?: CredentialsService }).credentials
    })
  } catch {
    // 无 credentials 服务（如裸 cordis 测试核）——嵌入档 openai-compatible 将在解析期报错
  }
  return async (ref) => {
    if (!credentials) return undefined
    const resolved = await credentials.resolve(ref).catch(() => undefined)
    return resolved?.value
  }
}

/** 插件配置 → MemliteConfig 逐字段映射（docs/integration.md §2.2）。 */
export function toMemliteConfig(config: PluginConfig): MemliteConfig {
  return {
    dataDir: config.dataDir !== '' ? config.dataDir : undefined,
    recallLimit: config.recallLimit,
    sync: { auto: config.sync.auto, remote: config.sync.remote },
    embedding: {
      provider: config.embedding.provider,
      apiBase: config.embedding.apiBase,
      model: config.embedding.model,
      credentialRef: config.embedding.credentialRef,
      timeoutMs: config.embedding.timeoutMs,
    },
    sensitiveGate: config.sensitiveGate,
  }
}

/**
 * 构造 Memlite 实例。credentialResolver 可复用（配置热更新重建时避免重复 ctx.inject）。
 */
export function assembleMemlite(
  ctx: PluginContext,
  config: PluginConfig,
  credentialResolver: CredentialResolver = createCredentialResolver(ctx),
): Assembled {
  const logger = ctx.logger ?? { warn: () => {}, info: () => {}, error: () => {} }
  // 宿主 Context 自带 logger；此处兜底供裸核测试

  // M0 漂移三：当前 DSH 无 providers 服务 / embeddings API——host 档不可用，明确告警并回退。
  // provider=host 时注入 dim-0 占位 Embedder：memlite 的检索/存储路径自动跳过语义臂。
  const hostEmbedder = config.embedding.provider === 'host'
    ? {
        dim: 0,
        embed: async () => {
          throw new Error('当前 DSH 版本（0.2.x）无 embeddings API，host 嵌入档不可用；已回退 BM25')
        },
      }
    : undefined
  if (config.embedding.provider === 'host') {
    logger.warn('[memlite] embedding.provider=host：当前 DSH 版本无 embeddings API，自动回退纯 BM25')
  }

  const mem = new Memlite(toMemliteConfig(config), {
    credentialResolver,
    hostEmbedder,
    logger: { warn: (msg) => logger.warn(`[memlite] ${msg}`) },
  })

  const dispose = ctx.effect(() => {
    mem.open()
    logger.info(`[memlite] 已挂载：${mem.dataDir}`)
    return () => {
      mem.close()
      logger.info('[memlite] 已卸载')
    }
  })
  return { mem, dispose }
}
