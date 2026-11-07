/**
 * 配置 schema（@deepseek-ai/schemastery）：DSH 设置页自动渲染，逐字段映射 MemliteConfig。
 */
import Schema from '@deepseek-ai/schemastery'

export interface AutoInjectConfig {
  enabled: boolean
  maxMemories: number
  maxChars: number
}

export interface AutoCaptureConfig {
  enabled: boolean
}

export interface EmbeddingConfig {
  provider: 'none' | 'host' | 'openai-compatible'
  apiBase?: string
  model?: string
  credentialRef?: string
  timeoutMs?: number
}

export interface PluginConfig {
  /** 留空自动解析（MEMLITE_DATA > 项目级 .memlite/ > 用户级 > ~/memlite-data）。 */
  dataDir: string
  recallLimit: number
  autoInject: AutoInjectConfig
  autoCapture: AutoCaptureConfig
  sync: { auto: boolean; remote?: string }
  embedding: EmbeddingConfig
  sensitiveGate: boolean
}

export const Config = Schema.object({
  dataDir: Schema.string()
    .default('')
    .description('记忆库目录；留空自动解析（MEMLITE_DATA > 项目级 .memlite/ > 用户级 > ~/memlite-data）'),
  recallLimit: Schema.number().default(10).min(1).max(100)
    .description('单次召回条数上限'),
  autoInject: Schema.object({
    enabled: Schema.boolean().default(true).description('系统提示自动注入相关记忆（off-turn 缓存，零阻塞）'),
    maxMemories: Schema.number().default(5).min(1).max(20).description('注入最大条数'),
    maxChars: Schema.number().default(2000).min(200).max(8000).description('注入总字符上限'),
  }).default({}) as unknown as Schema<AutoInjectConfig>,
  autoCapture: Schema.object({
    enabled: Schema.boolean().default(false).description('自动捕获（0.1.0 未实现，预留开关）'),
  }).default({}) as unknown as Schema<AutoCaptureConfig>,
  sync: Schema.object({
    auto: Schema.boolean().default(false).description('命令式 /memlite-sync 之外，挂载时自动同步一次'),
    remote: Schema.string().description('git remote URL（留空用已有 origin）'),
  }).default({}) as unknown as Schema<{ auto: boolean; remote?: string }>,
  embedding: Schema.object({
    provider: Schema.union(['none', 'host', 'openai-compatible'] as const).default('none')
      .description('嵌入档：none=纯 BM25；openai-compatible=独立嵌入服务；host 在 DSH 0.2.x 暂不可用（无 embeddings API，自动回退 BM25）'),
    apiBase: Schema.string().description('openai-compatible 服务地址（如 https://api.siliconflow.cn/v1）'),
    model: Schema.string().default('BAAI/bge-m3').description('嵌入模型'),
    credentialRef: Schema.string().default('MEMLITE_EMBED_API_KEY')
      .description('凭据引用名——密钥存 DSH credentials，绝不写入配置或数据仓'),
    timeoutMs: Schema.number().default(30000).description('嵌入请求超时（毫秒）'),
  }).default({}) as unknown as Schema<EmbeddingConfig>,
  sensitiveGate: Schema.boolean().default(true)
    .description('写前敏感扫描（密码/密钥/身份证/JWT/PEM），命中即拒'),
}) as unknown as Schema<PluginConfig>

/** 应用 Schema 默认值，得到完整配置对象（测试与无 schema 宿主用）。 */
export function resolveConfig(input: Partial<PluginConfig> | undefined): PluginConfig {
  const value = (Config as unknown as { (input?: unknown): PluginConfig })(input ?? {})
  return value
}
