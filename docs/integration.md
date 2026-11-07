# 与 memlite-js / memlite-obsidian 的集成契约

> 本文件锁定 `@rsrsai/dsh-memlite` 对 `@rsrsai/memlite` 与 `@rsrsai/memlite-obsidian` 的依赖接口。
> 任何一侧变更需同步。

---

## 一、依赖版本

```json
{
  "dependencies": {
    "@rsrsai/memlite": "^0.1.0",
    "@rsrsai/memlite-obsidian": "^0.1.0"
  }
}
```

跟随两个依赖仓的 minor 升级；major 升级需重新评估契约。

---

## 二、使用的公开 API

### 2.1 memlite-js 主类

```ts
import { Memlite } from '@rsrsai/memlite'

const mem = new Memlite(config, deps)
await mem.open()
await mem.close()
```

### 2.2 memlite-obsidian 桥（M5 新增）

```ts
import {
  importVault,
  exportVault,
  statusVault,
  // M5 计划给 memlite-obsidian 提 PR 加共享实例重载：
  // importVaultWith,
  // exportVaultWith,
} from '@rsrsai/memlite-obsidian'
import type {
  ImportOptions,
  ImportReport,
  ExportOptions,
  ExportReport,
  StatusReport,
} from '@rsrsai/memlite-obsidian'
```

**调用约束**：
- 优先用 `*With(mem, ...)` 重载（共享 dsh-memlite 的常驻 Memlite 实例）
- 若 obsidian 仓暂未提供 `*With`，调用前**暂停** dsh-memlite 的 recall cache 刷新（避免两实例写冲突），调用后**强制刷新**缓存

### 2.3 配置

直接透传 memlite-js 的 `MemliteConfig`：

```ts
import type { MemliteConfig } from '@rsrsai/memlite'
```

插件 schema 里的 `dataDir / recallLimit / sync / embedding / sensitiveGate` 字段**逐字段映射**到 `MemliteConfig`。

### 2.4 装配 deps

```ts
import type { MemliteDeps } from '@rsrsai/memlite'

const deps: MemliteDeps = {
  credentialResolver: (ref) => ctx.credentials.get(ref),
  hostEmbedder: config.embedding.provider === 'host'
    ? makeDshHostEmbedder(ctx)
    : undefined,
}
```

### 2.5 命令调用面

| 命令 | 来源包 | 方法 |
|---|---|---|
| `recall` | memlite | `mem.recall(query, opts)` |
| `remember` | memlite | `mem.remember(content, opts)` |
| `show` | memlite | `mem.show(id)` |
| `forget` | memlite | `mem.forget(id)` |
| `update` | memlite | `mem.update(id, opts)` |
| `attach` | memlite | `mem.attach(child, parent)` |
| `tree` | memlite | `mem.tree(opts)` |
| `chain` | memlite | `mem.chain(id, depth)` |
| `sync` | memlite | `mem.sync()` |
| `status` | memlite | `mem.status()` |
| `reembed` | memlite | `mem.reembed()` |
| `bench` | memlite | `mem.bench(opts)` |
| **`import`** | memlite-obsidian | `importVaultWith(mem, vaultPath, opts)` |
| **`export`** | memlite-obsidian | `exportVaultWith(mem, outputPath, opts)` |
| **`vault-status`** | memlite-obsidian | `statusVault(vaultPath, { dataDir })` |

**约束**：插件**不绕过** Memlite 主类直接调用底层模块（store/bm25/vectors 等）。若主类未暴露某能力，应**在 memlite-js 仓加方法**，而非在插件侧直接 import 内部模块。Obsidian 命令同理——优先 `*With` 重载。

### 2.6 嵌入 provider

```ts
import { makeHostEmbedder, makeOpenAIEmbedder, noneEmbedder } from '@rsrsai/memlite'
```

- `none` → memlite-js 默认行为（纯 BM25）
- `host` → 插件注入 `makeDshHostEmbedder(ctx)` 作为 `deps.hostEmbedder`
- `openai-compatible` → memlite-js 内置 `makeOpenAIEmbedder`，密钥走 `deps.credentialResolver`

---

## 三、DSH API 依赖

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
```

### 必需服务（inject）

```ts
export const inject = ['credentials', 'commands', 'systemPrompt', 'providers'] as const
```

| 服务 | 用途 |
|---|---|
| `credentials` | 嵌入档密钥读取 |
| `commands` | 注册 `/memlite*` 系列命令（含 Obsidian 三命令） |
| `systemPrompt` | 注册 prompt section |
| `providers` | host 嵌入档（`ctx.providers.embed(...)`） |

### 关键陷阱（来自 plur-ai 实战 + memlite-obsidian fb8a0c73 事故）

| 陷阱 | 症状 | 对策 |
|---|---|---|
| 未声明 inject 就访问属性 | `cannot get property without inject` throw | 用 `ctx.inject([...], scoped => ...)` 隔离 |
| 命令字段写成 `execute` | 静默不注册无日志 | 用 `handler` |
| 命令返回 string | 类型错 | 返回 `CommandResult`（`{kind, text}`） |
| 命令名含空格 | COMMAND_NAME 正则拒绝 | 扁平单 token：`memlite-import` 而非 `memlite import` |
| skill 字段写成 `body` | 注册成功但打开时 throw | 用 `content` + `source` |
| 事件 payload 当 agent | 读 undefined | 事件给 `{agent, turn, signal}`，需解构 |
| 多 agent 注册同名 section | throw / 串味 | 注册一次，按 `assembly.agent?.id` 取 |
| `apply` 加第三参数做测试注入 | 生产不传入 | 用 `ctx.plugin(sub, config)` 二参数形式 |
| **空串 vault path** | 落 cwd 污染文件 | `requireRest` 非空校验 + 绝对化 + 存在性检查 |
| **空串 dataDir** | 误入用户级库 | 同上 |
| **不经 dry-run 直接导入大 vault** | 用户不可预期 | 命令 description 明确建议先 `--dry-run` |

---

## 四、宿主接口（0.2.0 新增：消息与工具）

插件不引入 `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-tools` 运行时依赖，
按宿主公开形状手写两个结构子集：

### 4.1 注入消息（`src/messages.ts`）

```ts
{
  id: string,            // randomUUID；宿主 brandString 运行时即原字符串
  role: 'user',
  content: [{ type: 'text', text: string }],
  source: { kind: 'memlite' },   // pre-step 只认 kind==='user'，自己的注入不会二次召回
}
```

深冻结后追加到 `agent/pre-step` 决策的 `messages`；与 `createUserMessage` 同形。

### 4.2 模型工具（`src/tools.ts`）

```ts
{
  name, description,
  parameters,            // 宿主支持的 JSON Schema 子集（object/string/integer/array/enum）
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute(args, exec): string,
}
```

经 `ctx.inject(['tools'])` 的 `tools.register()` 注册；五个工具
`memlite_recall/show/remember/update/attach` 直接调用常驻 `Memlite` 实例。

---

## 五、版本对齐策略

| memlite-js | memlite-obsidian | dsh-memlite | 策略 |
|---|---|---|---|
| 0.1.0 | 0.1.0 | 0.1.0 | 起点 |
| 0.1.x | 0.1.x | 0.1.x | 跟随；bug 修复直通 |
| 0.2.0 | 0.2.0 | 0.2.0 | 评估新能力，决定是否暴露 |
| 1.0.0 | 1.0.0 | 1.0.0 | 同步 major；契约变更须文档化 |

**禁止**：
- dsh-memlite 不用 memlite-js / memlite-obsidian 的内部模块（`@rsrsai/memlite/dist/store`）
- dsh-memlite 不直接读 memlite 数据文件——一切经 Memlite 主类
- dsh-memlite 不直接读 Obsidian 文件——一切经 memlite-obsidian 的 importer/exporter

---

## 六、测试契约

### 5.1 集成测试必须包含

- [ ] 用真实 `dsh-commands` 注册器跑命令（不是 mock）
- [ ] 用真实 `dsh-system-prompt` 注册器跑 section（不是 mock）
- [ ] 用真实 `dsh-credentials` 读 key（不是 mock）
- [ ] 用真实 `dsh-providers` 测 host 嵌入（不是 mock）

参考 plur-ai 教训：**单一真机测试文件比 200 个 mock 测试更有价值**。

### 5.2 三方互通测试

- [ ] 用 memlite-js 写库 → 插件读出
- [ ] 用插件写库 → memlite-js 读出
- [ ] 用 Rust memlite 写库 → 插件读出（端到端互通）
- [ ] **M5 新增**：用 memlite-obsidian 导入 vault → 插件 recall 命中
- [ ] **M5 新增**：插件 remember → memlite-obsidian 导出 vault → Obsidian 可读
- [ ] **M5 新增**：三方端到端：Obsidian → memlite-obsidian → 插件召回 → memlite-obsidian 导出 → Obsidian 可读

---

## 七、变更流程

任一侧契约变更：

1. 在变更仓库开 issue + 链接到对侧仓
2. 更新本文件（`docs/integration.md`）
3. 双侧 CI 加互通测试覆盖变更点
4. 发版时 CHANGELOG 标注对侧最低兼容版本

