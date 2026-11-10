# 与 memlite-js / memlite-obsidian 的集成契约

> 本文件锁定 `@rsrsai/dsh-memlite` 对 `@rsrsai/memlite` 与 `@rsrsai/memlite-obsidian` 的依赖接口。
> 任何一侧变更需同步。

---

## 一、依赖版本

```json
{
  "dependencies": {
    "@rsrsai/memlite": "^0.2.0",
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
| `update` | memlite | `mem.update(id, opts, {expectedRevision?})` |
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

### 2.4 条件写（memlite-js 0.2.0+）

- JSONL 平铺字段 `revision`（Rust `serde(flatten)` 原样保留）；新记录从 0 起，更新/改挂递增。
- `Memlite.update/attach/forget` 可选 `{expectedRevision}`；不一致抛 `StaleVersionError`（`code='STALE_VERSION'`）。
- 检查与追加在同一同步段；条件写前比较 `memory*.jsonl` 的 size+mtime 签名，外部进程写入会先重载再判冲突。
- UI 写请求必须带 `expectedRevision`；插件把冲突映射为 HTTP 409 + 当前安全投影，不静默 LWW。

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
| 0.2.0 | 0.1.0 | 0.5.0 | 条件写/revision；仓库测试用 `pnpm.overrides` 统一引擎版本，插件向 `*With` 传入 0.2.0 实例（结构兼容） |
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

---

## 八、DSH 会话导入：使用的宿主事件格式与 memlite 写入 API

> 0.7.0 新增。完整语义见 [`session-import-contract.md`](./session-import-contract.md)；
> 本节只记录**与宿主文件格式、memlite 写入面的耦合点**，供任一侧变更时对照。
> 不新增依赖：zstd/gzip 解压用 `node:zlib` 内置函数，解析/抽取/去重都在本仓内。

### 8.1 源文件（宿主落盘格式，只读）

```
~/.dsh/sessions/<cwd 编码>/<session-id>/session.v4.jsonl.zstd
```

- 同一目录按顺序取第一个存在的候选：`session.v4.jsonl.zstd`、`session.v4.jsonl.gz`、
  `session.v4.jsonl`、`session.jsonl.zstd`；
- 解压按魔数判断（zstd `28 b5 2f fd` / gzip `1f 8b`，否则按 UTF-8 明文）；
- zstd 用 `node:zlib.zstdDecompressSync`（Node ≥ 22.15），运行时缺失则抛
  `当前 Node 不支持 zstd 解压（需要 Node 22.15+）：<path>`；
- 逐行 `JSON.parse`，坏行计入 `badLines` 而不是抛错。

### 8.2 事件子集（逐行 JSON）

| `type` | 用到的字段 | 用途 |
|---|---|---|
| `session` | `version`、`id`、`createdAt`（ms）、`cwd` | 会话 id / 创建时间 / 工作目录 |
| `user/message` | `seq`、`time`（ms）、`data.role==='user'`、`data.source.kind==='user'`、`data.id`、`data.content[].text` | 人类消息：会话摘要素材、`user-fact` 候选、「记：」显式存储 |
| `session/title` | `data.title`（可能多次，取最后一次非空） | 会话标题 |
| `tool/call` | `data.name==='memlite_remember'`、`data.arguments`（JSON 字符串：`content`/`title`/`tags`） | 显式记忆候选 |
| `command/run` | `data.name==='memlite-remember'`、`data.args`（rawInput，`--title`/`--tags`） | 显式记忆候选 |

其余事件（`system` / `assistant/*` / `tool/result` / `step` / `turn` / `job` / `approval` /
`request` / `agent/inbox/spliced` …）一律不进候选：`agent/inbox/spliced` 是同一批用户消息的副本，
重复计入会污染摘要。

### 8.3 memlite 写入 API（复用常驻实例，不另开）

导入器接收调用方的 `Memlite` 实例（`importDshSessionsWith(mem, options)`），
逐候选写入，不自建实例、不 import memlite-js 内部模块：

```ts
// 新建：内容 + 平铺元数据 + 可选父子
await mem.remember(candidate.content, {
  title: candidate.title,
  tags: candidate.tags,        // ['dsh-session', 'explicit' | 'session' | 'user-fact', ...]
  project: candidate.project,
  ts: candidate.ts,            // 秒级
  extra: candidate.extra,      // source=dsh-session / dsh_anchor / dsh_session_id / dsh_kind / source_hash / dsh_project
  parent: summaryId,           // 同会话摘要 id；摘要本身是根
})

// 命中已有条目且内容 hash 变化：原地追加新版本（extra 按键合并，锚不丢）
await mem.update(hit.id, { title, content, tags, project, extra })

// 写前敏感闸（与插件其它写入同一套）
mem.scanOrReject(candidate.title + '\n' + candidate.content)
```

- `extra.source === 'dsh-session'` 是导入去重与外部识别的唯一标记；`source_hash` 是
  `sha1(title + '\n' + content)` 的 40 位小写 hex，用于覆盖「宿主当年已自动存过、但没有导入元数据」的记录；
- dry-run 不调用 `remember`/`update`（不产生真实 id，也不写 `parent`）；命中且 hash 不同计 `wouldUpdate`，
  否则计 `wouldCreate`；
- 单条 `scanOrReject`/`remember`/`update` 抛错只记为 `skipped`（`sensitive` / `empty` / `write-error`），
  继续处理后续候选；整批幂等：同批连导两次，第二次 `created=0, updated=0`。

### 8.4 本仓接口面（不对外新增依赖）

| 位置 | 内容 |
|---|---|
| `src/session-import/reader.ts` | 根目录解析、文件发现、解压解行、会话解析、会话清单 |
| `src/session-import/extract.ts` | 显式记忆 / 会话摘要 / 用户事实 → `SessionCandidate` |
| `src/session-import/importer.ts` | 去重 + 写库（dry-run 只报告） |
| `src/session-import/report.ts` | 命令与配置页共用的中文报告文本 |
| `src/commands/session.ts` | `/memlite-session-import`、`/memlite-session-list` |
| `src/session-import/routes.ts` | `POST api/memlite/session/{import,list}` |
| `src/client/session-import-panel.tsx` | 配置页分组（浏览器半区只写字面量路由，不 import 服务端模块） |

宿主侧变更（新事件类型、文件名、zstd 版本）时：先改 `docs/session-import-contract.md`，
再改 reader/extract，并同步本节与 `MEMLITE_REAL_SESSIONS=1` 的真机只读冒烟。

