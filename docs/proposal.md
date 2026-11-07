# dsh-memlite 方案

> **状态**：草稿
> **仓库**：`risense/dsh-memlite`
> **npm 包名**：`@rsrsai/dsh-memlite`
> **依赖**：[`@rsrsai/memlite@0.1.0`](https://github.com/risense-ai/memlite-js)
> **DSH 版本**：`@deepseek-ai/dsh-*@0.1.0-rc.6` 或更高（**勿用 `latest`，它指向陈旧版**）
> **撰写日期**：2026-11-07

---

## 一、定位

让 DSH（DeepSeek Harness）拥有**持久本地记忆**。把 memlite-js 的核心机制装进 dsh 插件形态，做到：

1. **零配置可用**：`dsh plugin add @rsrsai/dsh-memlite` 即可用，默认纯 BM25
2. **零外网默认**：所有数据落本地，sync 走用户私有 git 仓（用户显式开启）
3. **密钥走 credentials**：嵌入档密钥永不入 cordis.yml / 永不入数据仓
4. **系统提示注入**：通过 `ctx.systemPrompt.section` 在每轮拼装时动态注入相关记忆——**无 tool 调用，不占上下文**

### 与 plur-ai/dsh 的差异

[plur-ai/dsh](https://github.com/plur-ai/dsh-plugin) 是 DSH 生态已存在的记忆插件（BM25+BGE 融合、YAML 存储、Apache-2.0）。本插件的差异点：

| 维度 | plur-ai/dsh | dsh-memlite |
|---|---|---|
| 存储格式 | YAML（自有） | **JSONL（与 Rust memlite 互通）** |
| 数据结构 | engram 列表 | **因果树（parent_id 父子链）** |
| 同步 | 本地 only | **git 白名单同步（多设备/工作区）** |
| 项目级隔离 | 全局 | **项目级 .memlite/ + 用户级回退** |
| 敏感闸 | 未公开 | **写前扫描（密码/密钥/身份证/JWT/PEM）** |
| 嵌入档 | 内置 BGE | **三档可选：none / host / openai-compatible** |
| 评测 | LongMemEval-S Hit@5=76.7% | **memlite bench 与 Rust 对齐（hit@1=85%）** |

**核心定位**：memlite 的"宿主生态"扩展——和 Rust CLI、未来的 Kimi/ZCode/Codex 插件共享同一份数据。

---

## 二、核心机制

### 2.1 系统提示注入（关键设计）

DSH 每轮重渲染 system prompt。插件注册一个 section，其 `text` 是**函数**，在每轮拼装时被调用：

```ts
ctx.systemPrompt.section({
  name: 'memlite:context',
  order: 120,
  text: (assembly) => renderMemoryFor(assembly),
})
```

**关键不变量**（参考 plur-ai 实战经验）：

- **text 必须同步且廉价**——prompt 拼装不能等数据库
- **recall 走 off-turn**：在 `agent/turn-stopping` 时后台跑 recall，结果存内存缓存；`text()` 只读缓存
- **多 agent 单 section**：注册一次，按 `assembly.agent?.id` 取对应缓存——不能每 agent 注册（重复名会 throw 且串味）
- **无 agent 时返回空**：诊断拼装无 agent，不要发上一次缓存

后果：**记忆从第二轮开始出现，永不阻塞当前轮**。

### 2.2 用户主动召回

```
/memlite recall <query>     # 显式召回
/memlite remember <content> # 显式存
/memlite show <id>          # 看全文 + 因果视界
/memlite tree               # 因果树
/memlite sync               # git 同步
/memlite status             # 库状态
```

### 2.3 自动捕获（可选）

通过 `agent/turn-stopping` 事件监听，按启发式（重要结论 / 决策 / 错误修复）自动写记忆。M3 才做，且**默认关闭**——避免垃圾记忆污染库。

---

## 三、配置 Schema

```ts
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  dataDir: string
  recallLimit: number
  autoInject: {
    enabled: boolean
    maxMemories: number       // 注入到 system prompt 的最大记忆条数
    maxChars: number          // 注入总字符上限（防爆上下文）
  }
  autoCapture: {
    enabled: boolean          // 默认 false
    minImportance: 'important' | 'trivial'
  }
  sync: {
    auto: boolean
    remote?: string
  }
  embedding: {
    provider: 'none' | 'host' | 'openai-compatible'
    apiBase?: string
    model?: string
    credentialRef?: string    // 默认 'MEMLITE_EMBED_API_KEY'
    timeoutMs?: number
  }
  sensitiveGate: boolean
}

export const Config: Schema<Config> = Schema.object({
  dataDir: Schema.string().default('~/.memlite')
    .description('记忆库目录；项目级 .memlite/ 优先'),
  recallLimit: Schema.number().default(10).min(1).max(100),
  autoInject: Schema.object({
    enabled: Schema.boolean().default(true),
    maxMemories: Schema.number().default(5).min(1).max(20),
    maxChars: Schema.number().default(2000).min(200).max(8000),
  }).default({}),
  autoCapture: Schema.object({
    enabled: Schema.boolean().default(false),
    minImportance: Schema.union(['important', 'trivial']).default('important'),
  }).default({}),
  sync: Schema.object({
    auto: Schema.boolean().default(false),
    remote: Schema.string(),
  }).default({}),
  embedding: Schema.object({
    provider: Schema.union(['none', 'host', 'openai-compatible']).default('none'),
    apiBase: Schema.string(),
    model: Schema.string().default('BAAI/bge-m3'),
    credentialRef: Schema.string().default('MEMLITE_EMBED_API_KEY'),
    timeoutMs: Schema.number().default(30000),
  }).default({}),
  sensitiveGate: Schema.boolean().default(true),
})
```

DSH 框架自动渲染设置页表单，**零前端代码**。

---

## 四、依赖与装配

### 4.1 必需服务（inject）

```ts
export const inject = ['credentials', 'commands', 'systemPrompt'] as const
```

- `credentials`：嵌入档密钥读取
- `commands`：注册 `/memlite` 系列命令
- `systemPrompt`：注册 prompt section

### 4.2 装配代码

```ts
import { Memlite, makeHostEmbedder } from '@rsrsai/memlite'
import type { Context } from '@deepseek-ai/cordis'
import { Config } from './schema'
import { MemliteCache } from './cache'
import { registerCommands } from './commands'
import { registerPromptSection } from './prompt'
import { registerAutoCapture } from './capture'

export function apply(ctx: Context, config: Config) {
  // 1. 装配 Memlite 实例
  const mem = new Memlite(
    {
      dataDir: config.dataDir,
      recallLimit: config.recallLimit,
      sync: config.sync,
      embedding: config.embedding,
      sensitiveGate: config.sensitiveGate,
    },
    {
      credentialResolver: (ref) => ctx.credentials.get(ref),
      hostEmbedder: config.embedding.provider === 'host'
        ? makeHostEmbedder(
            (text, opts) => ctx.providers.embed(ctx.providers.current().id, text, opts),
          )
        : undefined,
    },
  )

  // 2. 生命周期
  ctx.effect(async () => {
    await mem.open()
    return () => mem.close()
  }, 'memlite:lifecycle')

  // 3. 缓存与召回
  const cache = new MemliteCache(mem, config.autoInject)
  ctx.on('agent/turn-stopping', ({ agent }) => cache.refresh(agent))

  // 4. 注册面
  ctx.inject(['systemPrompt'], (scoped) => registerPromptSection(scoped, cache, config))
  ctx.inject(['commands'], (scoped) => registerCommands(scoped, mem))
  if (config.autoCapture.enabled) {
    registerAutoCapture(ctx, mem, config.autoCapture)
  }
}
```

---

## 五、命令面

```
/memlite recall <query> [--limit N] [--bm25] [--project P]
/memlite remember <content> [--title T] [--tags a,b] [--parent ID]
/memlite show <id>
/memlite forget <id>
/memlite update <id> [--title T] [--content C]
/memlite attach <child> --parent <parent>
/memlite tree [--from ID] [--depth N] [--outline]
/memlite chain <id> [--depth N]
/memlite sync
/memlite status
/memlite reembed          # 嵌入档开启后回填旧记忆向量
/memlite bench            # 命中率评测
```

命令实现 = 调用 `@rsrsai/memlite` 对应方法，返回 `CommandResult`：

```ts
ctx.commands.register({
  name: 'memlite recall',
  description: '检索记忆（语义/词面/RRF 融合自动选档）',
  handler: async (args) => {
    const hits = await mem.recall(args.query, { limit: args.limit })
    return {
      kind: 'success',
      text: formatHits(hits),
    }
  },
})
```

**关键陷阱**（plur-ai 实战）：
- 字段是 `handler` 不是 `execute`——写错会**静默不注册**
- 返回 `CommandResult` 联合类型（`kind: 'success' | 'error' | ...`），不是 string

---

## 六、系统提示注入细节

### 6.1 缓存刷新策略

```ts
class MemliteCache {
  private byAgent = new Map<string, string>()  // agent.id → 渲染后的文本

  async refresh(agent: Agent) {
    const project = agent.workspace?.project ?? ''
    const lastUser = agent.lastUserMessage ?? ''
    if (!lastUser) return

    const hits = await mem.recall(lastUser, {
      limit: config.autoInject.maxMemories,
      project,
    })
    const text = renderMemories(hits, config.autoInject.maxChars)
    this.byAgent.set(agent.id, text)
  }

  read(agentId: string): string {
    return this.byAgent.get(agentId) ?? ''
  }
}
```

### 6.2 section 注册

```ts
export function registerPromptSection(ctx: Context, cache: MemliteCache, config: Config) {
  ctx.systemPrompt.section({
    name: 'memlite:context',
    order: 120,
    text: (assembly) => {
      if (!config.autoInject.enabled) return ''
      const id = assembly.agent?.id
      if (!id) return ''                   // 诊断拼装
      return cache.read(id)
    },
  })
}
```

### 6.3 渲染格式

```markdown
## 相关记忆

- **[标题1]** 正文截断... (id:abc123)
- **[标题2]** ... (id:def456)

使用 `/memlite show <id>` 查看完整记忆与因果链。
```

---

## 七、凭证流（密钥永不落盘）

```
用户在 DSH Models 设置页填 apiKey
  ↓
DSH 写入 profile 的 credentials store（write-only）
  ↓
插件 apply 时 ctx.credentials.get('MEMLITE_EMBED_API_KEY')
  ↓
注入 makeOpenAIEmbedder
  ↓
fetch /embeddings 时放进 Authorization header
  ↓
内存中持有，进程退出即消
```

**永不出现在**：cordis.yml、memlite 数据仓、日志、错误信息。

---

## 八、首次运行引导

用户首次启动插件时，若数据目录为空，注册一次性欢迎 skill：

```ts
ctx.skills.register({
  name: 'memlite-onboarding',
  description: 'memlite 快速上手',
  source: 'runtime',
  content: ONBOARDING_BODY,  // 字段是 content，不是 body
})
```

**关键陷阱**（plur-ai 实战）：skill 字段是 `content` + 必填 `source`。注册时**只校验 name/description**，写错 shape 会**注册成功但打开时 throw**——比缺失更糟。

---

## 九、非目标

- 不做 Web 管理台（DSH 已有 web 客户端，插件可后续加 panel；M1-M3 不做）
- 不做跨宿主 IPC（DSH 插件只服务 DSH）
- 不做多用户/权限（memlite 是个人记忆模型）
- 不做语义自动捕获（autoCapture 默认关闭）

---

## 十、风险与对策

| 风险 | 概率 | 对策 |
|---|---|---|
| DSH API 变动（rc 阶段） | 高 | 锁版本到 `0.1.0-rc.6`，CI 跑 rc 升级检测 |
| `ctx.providers.current()` 不存在 | 中 | M1 先做技术验证（spike），确认 host 嵌入可行性 |
| `systemPrompt.section` 注入性能 | 中 | text 必须 < 1ms；recall 走 off-turn 缓存 |
| 多 agent 缓存串味 | 高 | 严格按 agent.id 索引；诊断拼装返回空 |
| 密钥泄漏到错误信息 | 低 | EmbedError 信息 sanitize，永不带 Authorization |
| 用户已有 Rust memlite 库 | 中 | 数据格式互通，插件直接读 |
| DSH Plugin Hub 审核拒 | 低 | 参考 [publish checklist](https://dsh-plugin.org/tutorials/publish-plugin-pr-checklist) |

---

## 十一、与 memlite-js 的依赖关系

```
risense/memlite-js         →  @rsrsai/memlite@0.1.0    （已发布/待发布）
       ↓ depends on
risense/dsh-memlite        →  @rsrsai/dsh-memlite@0.1.0 （本仓）
       ↓ installed into
dsh profile                →  cordis.yml 引用
```

**关键前提**：`@rsrsai/memlite` 需先发布到 npm，或在 monorepo 内通过 workspace 链接。当前 memlite-js 仓 0.1.0 代码已完成（commit `0393968`），但 npm 发布状态需确认。

---

## 十二、下一步

进入 [plan.md](./plan.md) 的里程碑拆解。
