# 与 memlite-js 的集成契约

> 本文件锁定 `@rsrsai/dsh-memlite` 对 `@rsrsai/memlite` 的依赖接口。
> 任何一侧变更需同步。

---

## 一、依赖版本

```json
{
  "dependencies": {
    "@rsrsai/memlite": "^0.1.0"
  }
}
```

跟随 memlite-js 的 minor 升级（0.1.x → 0.2.x 允许），major 升级需重新评估契约。

---

## 二、使用的公开 API

### 2.1 主类

```ts
import { Memlite } from '@rsrsai/memlite'

const mem = new Memlite(config, deps)
await mem.open()
await mem.close()
```

### 2.2 配置

直接透传 memlite-js 的 `MemliteConfig`：

```ts
import type { MemliteConfig } from '@rsrsai/memlite'
```

插件 schema 里的 `dataDir / recallLimit / sync / embedding / sensitiveGate` 字段**逐字段映射**到 `MemliteConfig`。

### 2.3 装配 deps

```ts
import type { MemliteDeps } from '@rsrsai/memlite'

const deps: MemliteDeps = {
  credentialResolver: (ref) => ctx.credentials.get(ref),
  hostEmbedder: config.embedding.provider === 'host'
    ? makeDshHostEmbedder(ctx)
    : undefined,
}
```

### 2.4 命令调用面

| 命令 | memlite-js 方法 |
|---|---|
| `recall` | `mem.recall(query, opts)` |
| `remember` | `mem.remember(content, opts)` |
| `show` | `mem.show(id)` |
| `forget` | `mem.forget(id)` |
| `update` | `mem.update(id, opts)` |
| `attach` | `mem.attach(child, parent)` |
| `tree` | `mem.tree(opts)` |
| `chain` | `mem.chain(id, depth)` |
| `sync` | `mem.sync()` |
| `status` | `mem.status()` |
| `reembed` | `mem.reembed()` |
| `bench` | `mem.bench(opts)` |

**约束**：插件**不绕过** Memlite 主类直接调用底层模块（store/bm25/vectors 等）。若主类未暴露某能力，应**在 memlite-js 仓加方法**，而非在插件侧直接 import 内部模块。

### 2.5 嵌入 provider

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
| `commands` | 注册 `/memlite` 系列命令 |
| `systemPrompt` | 注册 prompt section |
| `providers` | host 嵌入档（`ctx.providers.embed(...)`） |

### 关键陷阱（来自 plur-ai 实战）

| 陷阱 | 症状 | 对策 |
|---|---|---|
| 未声明 inject 就访问属性 | `cannot get property without inject` throw | 用 `ctx.inject([...], scoped => ...)` 隔离 |
| 命令字段写成 `execute` | 静默不注册无日志 | 用 `handler` |
| 命令返回 string | 类型错 | 返回 `CommandResult`（`{kind, text}`） |
| skill 字段写成 `body` | 注册成功但打开时 throw | 用 `content` + `source` |
| 事件 payload 当 agent | 读 undefined | 事件给 `{agent, turn, signal}`，需解构 |
| 多 agent 注册同名 section | throw / 串味 | 注册一次，按 `assembly.agent?.id` 取 |
| `apply` 加第三参数做测试注入 | 生产不传入 | 用 `ctx.plugin(sub, config)` 二参数形式 |

---

## 四、版本对齐策略

| memlite-js | dsh-memlite | 策略 |
|---|---|---|
| 0.1.0 | 0.1.0 | 起点 |
| 0.1.x（patch） | 0.1.x | 跟随；bug 修复直通 |
| 0.2.0（minor） | 0.2.0 | 评估新能力，决定是否暴露 |
| 1.0.0（major） | 1.0.0 | 同步 major；契约变更须文档化 |

**禁止**：
- dsh-memlite 不用 memlite-js 的内部模块（`@rsrsai/memlite/dist/store`）
- dsh-memlite 不直接读 memlite 数据文件——一切经 Memlite 主类

---

## 五、测试契约

### 5.1 集成测试必须包含

- [ ] 用真实 `dsh-commands` 注册器跑命令（不是 mock）
- [ ] 用真实 `dsh-system-prompt` 注册器跑 section（不是 mock）
- [ ] 用真实 `dsh-credentials` 读 key（不是 mock）
- [ ] 用真实 `dsh-providers` 测 host 嵌入（不是 mock）

参考 plur-ai 教训：**单一真机测试文件比 200 个 mock 测试更有价值**。

### 5.2 与 memlite-js 的互通测试

- [ ] 用 memlite-js 写库 → 插件读出
- [ ] 用插件写库 → memlite-js 读出
- [ ] 用 Rust memlite 写库 → 插件读出（端到端互通）

---

## 六、变更流程

任一侧契约变更：

1. 在变更仓库开 issue + 链接到对侧仓
2. 更新本文件（`docs/integration.md`）
3. 双侧 CI 加互通测试覆盖变更点
4. 发版时 CHANGELOG 标注对侧最低兼容版本
