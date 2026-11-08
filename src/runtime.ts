/**
 * 配置热更新运行时。
 *
 * 根 Config 是 `.volatile()`：Loader 只把新配置提交进运行中的引用，不重挂插件。
 * 因此这里给命令面/工具面一个稳定的 Memlite 门面：
 * - 每次访问都重新读取配置快照；
 * - 结构性字段（dataDir / embedding / sync / sensitiveGate）变化时，重建 Memlite 引擎；
 * - recallLimit 等非结构字段由调用方各自读取，不触发重建。
 */
import type { Memlite } from '@rsrsai/memlite'
import { assembleMemlite, createCredentialResolver, type Assembled, type CredentialResolver } from './lifecycle'
import { readConfig, type ConfigRef, type PluginConfig } from './schema'
import type { PluginContext } from './types'

/** 重建引擎需要关心的配置指纹（其余字段可原地生效）。 */
function structuralSignature(config: PluginConfig): string {
  return JSON.stringify([
    config.dataDir,
    config.embedding,
    config.sync,
    config.sensitiveGate,
  ])
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class MemoryRuntime {
  private assembled: Assembled
  private signature: string
  private readonly credentialResolver: CredentialResolver
  private readonly facade: Memlite
  private rebuilding = false
  /** 引擎代次：结构性配置重建后 +1；记忆浏览器据此清理失效详情（不读旧引擎）。 */
  private generationCounter = 1

  constructor(
    private readonly ctx: PluginContext,
    private readonly config: ConfigRef,
  ) {
    this.credentialResolver = createCredentialResolver(ctx)
    const initial = readConfig(config)
    this.assembled = assembleMemlite(ctx, initial, this.credentialResolver)
    this.signature = structuralSignature(initial)

    // 门面：命令/工具只拿这一份引用，重建后自动指向新引擎。
    this.facade = new Proxy({} as Memlite, {
      get: (_target, property) => {
        this.refresh()
        const current = this.assembled.mem as unknown as Record<PropertyKey, unknown>
        const value = Reflect.get(current, property)
        return typeof value === 'function' ? value.bind(current) : value
      },
    })
  }

  /** 稳定的 Memlite 门面。 */
  get mem(): Memlite {
    return this.facade
  }

  /** 当前引擎代次（结构性配置变化重建引擎时递增）。 */
  get generation(): number {
    this.refresh()
    return this.generationCounter
  }

  /** 配置结构性字段变化时重建引擎；幂等，可安全地在每次访问时调用。 */
  refresh(): void {
    if (this.rebuilding) return
    const next = readConfig(this.config)
    const signature = structuralSignature(next)
    if (signature === this.signature) return

    this.rebuilding = true
    const previous = this.assembled
    try {
      const assembled = assembleMemlite(this.ctx, next, this.credentialResolver)
      this.assembled = assembled
      this.signature = signature
      this.generationCounter += 1
      previous.dispose()
      if (next.enabled && next.sync.auto) {
        void assembled.mem
          .sync()
          .catch((error: unknown) => this.ctx.logger?.warn?.(`memlite: 配置变更后同步失败: ${errorText(error)}`))
      }
    } finally {
      this.rebuilding = false
    }
  }

  dispose(): void {
    this.assembled.dispose()
  }
}
