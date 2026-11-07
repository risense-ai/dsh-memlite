# dsh-memlite

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的持久本地记忆插件。
> 基于 [`@rsrsai/memlite`](https://github.com/risense-ai/memlite-js)，与 [respire-memlite](https://github.com/risense-ai/respire-memlite)（Rust）数据互通。

## 状态

✅ **0.3.1 GUI 配置页 + 本地化展示名完成**（2026-11-08）：在侧栏「插件」页的 **Memlite 记忆**行打开**配置**，
可视化编辑全部字段，保存写入 profile 的 `cordis.patch.yml`；展示名/描述由 `locale/` 的 `meta` 提供。
其余行为保持 0.2.0 架构（静态规则、pre-step 召回、status 体检、敏感闸、显式存储 + 读回、收尾 steer、模型工具、16 命令）。
75 测试全绿；`pnpm build` 同时产出宿主与浏览器 bundle。

## 与 respire-dsh 的差别

| 面 | respire-dsh | dsh-memlite（0.3.1） |
|---|---|---|
| 引擎 | `rsrs` CLI 子进程 | 进程内 `@rsrsai/memlite` |
| 模型读写 | 模型用 shell 跑 `rsrs` | 模型调 `memlite_*` 工具 |
| 用户命令 | 无 | 16 个 `/memlite-*` 斜杠命令 |
| 存储 | rsrs 加密库 | JSONL 因果树 + git 同步 + 三档嵌入 |
| 其余 | 规则 / pre-step / status / 敏感闸 / 读回 / 收尾 steer / 失败回执 | **同左** |

详见 [respire 对齐说明](./docs/respire-alignment.md)。

## 机制

1. **静态规则**：`memlite:rules` section（order 850）每轮注入 9 条行为契约；与命中无关。
2. **pre-step**：只处理 `source.kind === 'user'` 的新消息——
   - 每 agent 一次 `status` 体检（空库/坏行提示）；
   - 敏感闸（与引擎同一套扫描）；
   - `记：/存：/记住：/remember:` → 进程内 `remember` + 读回校验 + 模型可见回执；
   - 其余 → `recall`（标题档，threshold/budget 截断），以 `source=memlite` 的 user 消息追加；
   - `/nomem`、`#nomem` 单条跳过。
3. **turn-stopping**：不查库、不写库，满足条件时 `agent.steer` 一条「收尾自查」提醒（每轮最多一次）。
4. **模型工具**：`memlite_recall` / `memlite_show` / `memlite_remember` / `memlite_update` / `memlite_attach`
   —— 等价于 respire 让模型执行 rsrs CLI 的那条通道。
5. **命令面**：原 16 个 `/memlite-*` 不变（recall/remember/show/tree/chain/import/export…）。

## 特性

- 🧠 **本地记忆**：纯 BM25（默认零配置）/ openai-compatible 嵌入 / RRF 融合
- 🌳 **因果树**：parent_id 父子链，命中即见前因后果（防环 64 层）
- 📌 **脱手注入**：pre-step 召回，标题级、预算内，不占 tool 调用
- 🧾 **可追溯写入**：显式存储带读回校验；失败/未存都有模型可见回执
- 🛠️ **模型工具面**：召回、展开、写入、更新、挂链
- 📝 **Obsidian 整合**：`/memlite-import`、`/memlite-export`、`/memlite-vault-status`
- 🔐 **密钥安全**：`credentials.resolve(ref)` 注入，永不入配置/数据仓/日志
- 📦 **项目级隔离**：项目级 `.memlite/` 优先，用户级回退
- 🔄 **git 同步**：白名单 + pathspec commit（不卷走用户暂存）+ sha 双通道核验
- 🛡️ **敏感闸**：写前扫描密码/密钥/身份证/银行卡/手机号/JWT/PEM，命中即拒

## 配置

### GUI（推荐）

侧栏**「插件」**→ 已安装插件 **@rsrsai/dsh-memlite** → 行 **memlite** → **配置**。
表单暂存草稿，点**保存**才写入 profile 的 `cordis.patch.yml`；每个字段带「已覆盖」与「恢复默认」。

- 召回参数（条数/阈值/预算/最短提示词/收尾频率）保存后立即生效；
- `dataDir` / `embedding` / `sync` / `sensitiveGate` 变化会重建记忆引擎（不重挂插件）；
- 关闭 `enabled` 立即停止规则注入、召回与提醒，工具/命令回执拒绝；重启后不再加载；
- 该页面由插件自带的浏览器半区注册（`plugins.row.config`），不是设置页的自动渲染。

### 展示名称

插件页卡片和 memlite 行的标题来自 **locale `meta`**，不是包名本身：

- [locale/zh.json](locale/zh.json) 与 [locale/en.json](locale/en.json) 的 `meta.title` / `meta.description`；
- 缺失时回退 `package.json` 的 `name` / `description`，两者都没有才显示完整包名/模块名；
- 需要 `exports["./locale/*.json"]` 与发布 `files` 收录这些文件，Host 才能读取；
- 图标可在 `package.json` 声明 `"icon": "./icon.png"`（或导出 `./icon`）。

改名称只动 locale JSON，不需要重写客户端代码；保存后重启对应插件行（本 profile 用 `set_bundle` 关/开）即可生效。

### YAML

也可以直接写 profile 的 `cordis.patch.yml`（同 id 覆盖）：

```yaml
- id: memlite
  config:
    recallLimit: 8
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `dataDir` | `''` | 留空自动解析（`MEMLITE_DATA` > 项目 `.memlite/` > 用户级 > `~/memlite-data`） |
| `recallLimit` | `5` | 自动召回条数上限（1–50） |
| `recallThreshold` | `0` | 召回分数阈值（0–1） |
| `budgetChars` | `1500` | 自动注入总字符上限（200–20000） |
| `minPromptChars` | `2` | 短于该长度不召回 |
| `storeNudgeEvery` | `1` | 收尾提醒频率（每 N 轮）；`0` 关闭 |
| `sync` | `{auto:false}` | 挂载时自动同步（可选 remote） |
| `embedding` | `none` | `none` / `host`（0.2.x 不可用，回退 BM25）/ `openai-compatible` |
| `sensitiveGate` | `true` | 写前敏感扫描 |

## 安装（待发布）

```bash
dsh plugin --profile <profile> add @rsrsai/dsh-memlite
```

本地开发装载：

```bash
pnpm -C dsh-memlite build
dsh plugin --profile <profile> add ./dsh-memlite
```

## 测试

```bash
pnpm test   # 75 例：真 cordis 核 + 形状忠实宿主服务替身 + 配置表单/浏览器半区契约
```

## 协议

MIT。
