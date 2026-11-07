/**
 * 配置 schema（@deepseek-ai/schemastery）。
 *
 * 整个根对象声明 `.volatile()`：DSH 的 settings 服务只会把 volatile 字段投影成可编辑表单，
 * 而同一对象内不允许嵌套 volatile（验收见 schemastery validateVolatileSchema），因此只能
 * 根级 volatile。效果：
 * - 设置写入只更新运行中的配置引用（`updateVolatile`），不重挂插件；
 * - 插件必须在每次使用时读取最新快照，结构性字段（dataDir/embedding/sync/sensitiveGate）
 *   由 MemoryRuntime 检测变化后重建引擎；
 * - 设置页表单（浏览器半区）绑定本条目的 entry id（`memlite`）。
 *
 * 字段与默认值对齐 respire-dsh（recallLimit/budgetChars/minPromptChars/storeNudgeEvery），
 * 另保留 memlite 自己的 dataDir/sync/embedding/sensitiveGate。
 */
import Schema from '@deepseek-ai/schemastery'

export interface EmbeddingConfig {
  provider: 'none' | 'host' | 'openai-compatible'
  apiBase?: string
  model?: string
  credentialRef?: string
  timeoutMs?: number
}

export interface PluginConfig {
  /** 总开关。 */
  enabled: boolean
  /** 留空自动解析（MEMLITE_DATA > 项目级 .memlite/ > 用户级 > ~/memlite-data）。 */
  dataDir: string
  /** 自动召回条数上限。 */
  recallLimit: number
  /** 召回分数阈值（0 不筛）。 */
  recallThreshold: number
  /** 自动注入总字符上限。 */
  budgetChars: number
  /** 小于该长度的提示词不召回（避免“好”“继续”污染查询）。 */
  minPromptChars: number
  /** 收尾提醒频率：每 N 轮一次；0=关闭。 */
  storeNudgeEvery: number
  sync: { auto: boolean; remote?: string }
  embedding: EmbeddingConfig
  sensitiveGate: boolean
}

export const Config = Schema.object({
  enabled: Schema.boolean().default(true)
    .description('总开关；关闭后不注入规则、不召回、不提醒，工具与命令回执拒绝（挂载时即关闭需重启后重新启用才生效）'),
  dataDir: Schema.string()
    .default('')
    .description('记忆库目录；留空自动解析（MEMLITE_DATA > 项目级 .memlite/ > 用户级 > ~/memlite-data）'),
  recallLimit: Schema.number().default(5).min(1).max(50)
    .description('单次自动召回条数上限'),
  recallThreshold: Schema.number().default(0).min(0).max(1)
    .description('召回分数阈值；低于该分数的命中不进注入'),
  budgetChars: Schema.number().default(1500).min(200).max(20000)
    .description('自动注入总字符上限'),
  minPromptChars: Schema.number().default(2).min(1).max(1000)
    .description('提示词短于该长度时跳过召回'),
  storeNudgeEvery: Schema.number().default(1).min(0).max(1000)
    .description('收尾提醒频率（每 N 轮一次）；0=关闭'),
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
}).volatile() as unknown as Schema<PluginConfig>

/** 运行中的配置引用：Settings/Loader 会把 volatile 根对象解析成这个形状。 */
export interface ConfigRef {
  get(): PluginConfig
}

/** 鸭子类型识别 volatile 配置引用（不直接依赖 @deepseek-ai/cosmokit）。 */
function isConfigRef(value: unknown): value is ConfigRef {
  return typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
}

/**
 * 拿到配置引用。宿主（Loader）传入 volatile 引用；测试/无 schema 宿主传入普通对象，
 * 这里用 Schema 解析后再包成稳定的引用。
 */
export function resolveConfigRef(input?: unknown): ConfigRef {
  if (isConfigRef(input)) return input
  const parsed = (Config as unknown as { (input?: unknown): unknown })(input ?? {})
  if (isConfigRef(parsed)) return parsed
  return { get: () => parsed as PluginConfig }
}

/** 读取一次最新配置快照。 */
export function readConfig(ref: ConfigRef): PluginConfig {
  return ref.get()
}

/** 应用 Schema 默认值，得到完整配置对象（测试与无 schema 宿主用）。 */
export function resolveConfig(input?: Partial<PluginConfig>): PluginConfig {
  return readConfig(resolveConfigRef(input))
}
