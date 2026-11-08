# dsh-memlite

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的持久本地记忆插件。
> 基于 [`@rsrsai/memlite`](https://github.com/risense-ai/memlite-js)，与 [respire-memlite](https://github.com/risense-ai/respire-memlite)（Rust）数据互通。

## 状态

✅ **0.5.0 完整记忆 UI**（2026-11-08）：会话右侧 **Memory 页签**提供四视图——
**本次对话**（真实注入、逐条阈值/预算解释、实际注入原文、有帮助/不相关反馈）、
**全部记忆**（搜索 + 项目/标签/重要性筛选 + 游标分页 + 响应式列表—详情 + 编辑/续写/改挂/忘记）、
**因果树**（逐层展开、围绕检索、定位、改挂）、**状态**（库/检索/同步/Obsidian/近期回执）。
写入统一走 Memlite 主类与 `expectedRevision` 条件写；冲突返回当前投影并保留草稿，不静默覆盖。
同时保留 0.3.2 的 GUI 配置页 + Obsidian 桥 + 本地化展示名，以及 0.2.0 架构
（静态规则、pre-step 召回、status 体检、敏感闸、显式存储 + 读回、收尾 steer、模型工具、16 命令）。
197 例测试（14 个文件；其中 2 例依赖 `dist/` 的构建产物测试在未构建时自动 skip）；`pnpm build` 同时产出宿主与浏览器 bundle。

## 与 respire-dsh 的差别

| 面 | respire-dsh | dsh-memlite（0.5.0） |
|---|---|---|
| 引擎 | `rsrs` CLI 子进程 + 常驻 Runtime（Node 24+） | 进程内 `@rsrsai/memlite`，零子进程 |
| 模型读写 | 模型用 shell 跑 `rsrs` | 5 个 `memlite_*` 工具 |
| 存储 | 加密 SQLite（`~/.rsrs/rsrs.db`） | 明文 JSONL + `emb.f32` 侧车 |
| 同步 | 密文云同步（服务端不持密钥） | git 白名单同步 |
| 项目隔离 | 单库 + `project` 范围过滤 | 项目级库目录 + 用户级回退 |
| 命令面 | 无斜杠命令，走 `rsrs` CLI | 16 个 `/memlite-*` |
| 生态 | 12 个宿主插件共用同一 `rsrs` 库 | Harness / CLI / AstrBot / Obsidian 桥；Rust / TS / Python 数据互通 |
| 评测 | 自建中文集 hit@5=78.7%（2026-09，277 题）；LongMemEval 未跑 | BM25 hit@1=85%（与 Rust memlite 对齐） |
| 共同点 | 规则注入 / pre-step 召回 / status 体检 / 敏感闸 / 读回校验 / 收尾 steer / 失败回执 | 同左 |

- **数据格式不互通**：respire-dsh 用 `rsrs` 加密 SQLite；dsh-memlite 用 JSONL。dsh-memlite 与 [respire-memlite](https://github.com/risense-ai/respire-memlite)（Rust CLI）数据互通，不是与 respire-dsh 互通。
- **评测口径不同**：respire-dsh 行是自建中文真库 277 题，dsh-memlite 行是 BM25 基准集，不构成同题横比。
- 本地检索实现与数据结构见 [`docs/respire-alignment.md`](./docs/respire-alignment.md)。

## 数据与隐私

- **默认只写本机**：`dataDir` 留空时按 `MEMLITE_DATA` > 项目 `.memlite/` > 用户级 > `~/memlite-data` 解析。
- **明文 JSONL**：存储是 `memory.jsonl` + `emb.f32` 向量侧车，不是加密库；只在本机，不上传。
- **与 Rust 互通**：dsh-memlite 与 [respire-memlite](https://github.com/risense-ai/respire-memlite)（Rust CLI）读写同一数据契约，可共享同一记忆库；与 respire-dsh 的 `rsrs` 加密库不互通。
- **可选 Git 同步**：白名单 add + pathspec commit（不卷入其他暂存改动）；push 后双通道 sha 核验。
- **软删除**：`/memlite-forget` 追加删除记录，条目不再被召回；当前没有一键恢复命令，误删需手工处理。
- **敏感闸**：写前扫描密码、API 密钥、身份证、银行卡（Luhn）、手机号、JWT、PEM 私钥；命中即拒。
- **嵌入三档**：默认 `none`（纯 BM25，零外网）；`openai-compatible` 会把文本发给配置的嵌入服务；`host` 在 DSH 0.2.x 不可用，加载时告警并回退 BM25。
- **密钥**：只存 DSH credentials（`credentialRef`），不写入配置文件、数据仓或日志。

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
6. **记忆浏览器**：会话右侧 Memory 页签——本次对话召回账本与逐条解释、全库搜索/筛选/分页、
   因果树、运行状态；存入/编辑/续写/改挂/忘记经 `connection.fetch` 的写入路由与条件写读回。
   认证/信任栅栏由宿主负责，浏览器不直接读写文件。聊天回复内嵌入口因宿主无稳定 reply-action slot，
   本轮未挂载，只保留右侧入口。

### 命令参考

| 命令 | 作用 |
|---|---|
| `/memlite` | 概览与快速上手 |
| `/memlite-recall <query> [--limit N] [--bm25] [--project P]` | 检索（语义/词面/RRF 自动选档） |
| `/memlite-remember <content> [--title T] [--tags a,b] [--parent ID]` | 存记忆并认因 |
| `/memlite-show <id>` | 全文 + 前因后果 |
| `/memlite-forget <id>` | 删除（软删除，追加删除记录） |
| `/memlite-update <id> [--title T] [--content C]` | 就地改（追加新版本） |
| `/memlite-attach <child> --parent <parent>` | 挂因果链（防自挂、防环） |
| `/memlite-tree [--from ID] [--depth N] [--outline]` | 渲染因果树 |
| `/memlite-chain <id> [--depth N]` | 因链全文 + 果链下探 |
| `/memlite-sync` | git 白名单同步 |
| `/memlite-status` | 库状态 |
| `/memlite-reembed` | 旧记忆回填向量 |
| `/memlite-bench` | 命中率评测（20×20） |
| `/memlite-import <vault-path> [--dry-run]` | Obsidian vault 导入记忆库（建议先 dry-run） |
| `/memlite-export <output-path> [--overwrite]` | 记忆库导出为 vault |
| `/memlite-vault-status <vault-path>` | 同步态查询（synced/outdated/missing） |

## 特性

- 🔌 **零远程依赖**：默认 BM25 + 本地文件，不需要 Runtime、云服务或账号，断网可用；嵌入与同步都是可选项
- 🧠 **本地记忆**：纯 BM25（默认零配置）/ openai-compatible 嵌入 / RRF 融合
- 🌳 **因果树**：parent_id 父子链，命中即见前因后果（防环 64 层）
- 📌 **脱手注入**：pre-step 召回，标题级、预算内，不占 tool 调用
- 🧾 **可追溯写入**：显式存储带读回校验；失败/未存都有模型可见回执
- 🛠️ **模型工具面**：召回、展开、写入、更新、挂链
- 🧭 **聊天记忆浏览器**：右侧 Memory 页签四视图——本次对话注入与逐条解释、全库搜索/筛选/分页与写入、因果树、运行状态；条件写与统一回执，不需要命令
- 📝 **Obsidian 整合**：`/memlite-import`、`/memlite-export`、`/memlite-vault-status`
- 🔐 **密钥安全**：`credentials.resolve(ref)` 注入，永不入配置/数据仓/日志
- 📦 **项目级隔离**：项目级 `.memlite/` 优先，用户级回退
- 🔄 **git 同步**：白名单 + pathspec commit（不卷走用户暂存）+ sha 双通道核验
- 🛡️ **敏感闸**：写前扫描密码/密钥/身份证/银行卡/手机号/JWT/PEM，命中即拒

## 记忆浏览器（0.5.0）

不用记命令和 id，在聊天右侧直接回答三个问题：**本轮用了哪些记忆、库里有什么、记忆之间怎么因果相连**。

**打开**：会话右上角展开右侧栏 → Guide 里的 **Memlite 记忆** 入口；或从右侧栏的加号打开 Guide 后再点它。
面板随会话显示，沿用 DSH 的展开/分栏/悬浮/全屏能力；关闭页签不删数据。

| 视图 | 内容 |
|---|---|
| **本次对话** | 按回合倒序列出真实追加进本轮上下文的记忆：标题、**已注入/低于阈值/预算截断**徽章、召回分数、后端与时间；无活动时简洁空态 |
| **全部记忆** | 标题/正文/标签检索，项目/标签/重要性筛选，最近排序，游标分页；列表只给标题 + 两行摘要 + 徽章；选中读全文（纯文本渲染）与因果邻居，可复制正文 / 复制 id |
| **因果树** | 从根层开始的缩进树，逐层展开/收起（不一次取全深树）；点击节点看详情，父子/邻居可跳转；围绕选中记忆检索、定位当前节点、改挂入口；断链与环有截断提示，窄栏不横向溢出 |
| **状态** | 本地库条数/坏行/向量、检索后端与嵌入档、git 同步（可用/未配置/未验证/脏）、Obsidian 最近操作、当前会话近期回执；可立即同步、回填向量、复制脱敏诊断摘要 |

- **写入闭环**：存入、编辑、基于此续写、改挂因果、忘记记忆；统一回执与读回校验（id/标题/正文、父链或删除后不存在）。
  编辑/改挂/忘记带 `expectedRevision`，冲突返回 409 + `STALE_VERSION` + 当前投影，草稿保留；请求中断显示「保存结果待核实」，不自动重写。
- **写入边界**：所有写入经 Memlite 主类，浏览器不直写 JSONL；敏感闸拒绝只报类别不回显秘密；嵌入未启用/待回填与 JSONL 已保存分开显示。
- **注入状态可核对**：账本与自动注入的 `selectRecallTitles()` 用**同一份**阈值/预算结果，候选命中不会被显示成「已使用」；
  原记忆被删除后会话历史仍保留当时的标题并标「原记忆已删除」。
- **有界 + 会话隔离**：账本按 `sessionId` 隔离（拿不到稳定 sessionId 时明示按 agent 降级）；单会话 ≤100 条、全局 ≤500 条，
  单条 hits ≤50；不保存原始提示词、不暴露 querylog。
- **数据白名单**：13 条 `api/memlite/browser/*` 路由（5 条只读 + `status`/`remember`/`update`/`attach`/`forget`/
  `recall-feedback`/`sync`/`reembed`），列表/搜索/树不返回正文，show 正文限长；状态响应不含完整路径、remote URL、凭据或向量。
- **认证与信任**：路由经宿主 `connection.fetch`，浏览器认证 / Host-Origin 栅栏 / owner Peer 校验由 DSH 负责；
  关闭插件（`enabled=false`）时统一回 503 + 禁用态。
- **配置切换**：结构性配置（`dataDir`/embedding/sync/敏感闸）重建引擎后 `engine` 代次 +1，面板清空失效详情并重读，不显示旧引擎正文。

### 0.5.0 界面（320–420px 侧栏）

![本次对话：注入状态、逐条阈值/预算解释、反馈](./docs/images/ui-v0.5.0/session.png)

![全部记忆：筛选、列表—详情与写操作](./docs/images/ui-v0.5.0/all.png)

![因果树：逐层展开、围绕检索、定位与改挂](./docs/images/ui-v0.5.0/tree.png)

![状态：库、检索、同步、Obsidian 与回执](./docs/images/ui-v0.5.0/status.png)

> 截图为本地预览 fixture（`preview/`）+ 真实面板组件，演示数据明确标注；不是 DSH 官方界面截图。
> 交互与回执词典见 [`docs/ui-guide.md`](./docs/ui-guide.md)，完整规格见 [`docs/ui-complete-plan.md`](./docs/ui-complete-plan.md)。

![因果树：逐层展开的父子链，可跳转详情](./docs/images/memory-tree.png)

实现契约与验收对照见 [`docs/m8-contract.md`](./docs/m8-contract.md)；数据接口见
[`src/browser-contract.ts`](./src/browser-contract.ts)。

## 配置

### GUI（推荐）

侧栏**「插件」**→ 已安装插件 **Memlite 记忆** → 行 **memlite** → **配置**。
表单暂存草稿，点**保存**才写入 profile 的 `cordis.patch.yml`；每个字段带「已覆盖」与「恢复默认」。

- 召回参数（条数/阈值/预算/最短提示词/收尾频率）保存后立即生效；
- `dataDir` / `embedding` / `sync` / `sensitiveGate` 变化会重建记忆引擎（不重挂插件）；
- 关闭 `enabled` 立即停止规则注入、召回与提醒，工具/命令回执拒绝；重启后不再加载；
- 该页面由插件自带的浏览器半区注册（`plugins.row.config`），不是设置页的自动渲染。

### Obsidian 桥（GUI）

配置页的 **Obsidian 桥** 分组可以直接：

- **检查同步态**：vault 各笔记相对记忆库是 synced / outdated / missing；
- **预览导入**：dry-run 报告将新建/更新多少条，不写库；
- **导入**：把 vault（.md + 目录）写入记忆库；可填 project、勾选 writeId，dryRun 勾选时等同预览；
- **导出**：把记忆库导出为 vault 目录；目标目录非空时需勾选 overwrite。

路径是运行 DSH 的主机上的路径，支持 `~` 展开。三个按钮走插件自带的精确路由
（`/api/memlite/obsidian/{import,export,status}`），由 DSH 的 `connection` 服务负责浏览器认证与
Host/Origin 信任栅栏，仅 owner Peer 可用；Web 与桌面端共用，请求体上限 64 KiB，同一时刻只允许一个导入/导出任务。
最近使用的路径记在浏览器 localStorage，不写入配置或数据仓。

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

## 安装

发布版（npm `@rsrsai/dsh-memlite@0.5.0`）：

```bash
dsh plugin --profile <profile> add @rsrsai/dsh-memlite
```

装好后在侧栏「插件」→「Memlite 记忆」→「配置」；默认值即可用。日常说「记：」即可，不必背命令。
记忆浏览器随插件加载，无需额外配置（宿主需 DSH 0.2.2-alpha.2+，提供右侧栏页类型注册面）。

本地开发装载（在仓库根目录）：

```bash
pnpm install
pnpm build
dsh plugin --profile <profile> add .
```

## 实测记录

以下每条都先在真机 DSH 上确认，再回写代码与文档：

- **GUI 配置页**：UI 自动化保存 `recallLimit` 后，profile 的 `cordis.patch.yml` 出现 `- id: memlite / config: recallLimit: 6`；改回默认值时覆盖被 unset 移除。
- **volatile 投影**：settings 只投影 `.volatile()` 字段，同一 schema 内不允许嵌套 volatile；根 Config 整体 volatile，插件按次读快照。
- **展示名称**：来自 `locale/<lang>.json` 的 `meta.title` / `meta.description`；包声明 exports 时必须导出 `./locale/*.json`，否则静默回退包名。
- **重载方式**：本 profile 下 `set_plugin` 对 bundle 内行返回 overridden 且不生效；用 `set_bundle` 关/开组合包，行才会重启并重读 manifest 与客户端 bundle。
- **credentials.resolve(ref)**：返回 `{value, source}`，不是 `get(ref)`。
- **AssembleContext**：类型面无 `agent` 字段，运行时实传 `{agent, scope, signal}`，按防御性读取处理。
- **无 providers 服务**：`dsh-llm` 只有 chat，无 embeddings；host 嵌入档明示回退。
- **COMMAND_NAME**：单 token 正则，命令名含空格注册即拒。
- **右侧栏页类型（M8）**：宿主 0.2.2-alpha.2 提供 `ctx.sidebarRightTabs.register({id,kind,priority,title,guide})`
  与 `sidebar.right.pane.tab` 键ed slot（key=页类型 id，`inject(sessionId)` 注入当前会话）；
  `dsh.client.inject` 需列 `@deepseek-ai/dsh-client-ui-sidebar-right`，客户端 bundle 仍只外置 react / react/jsx-runtime。
- **记忆浏览器路由**：隔离实例真机实测——登录态 `POST /api/memlite/browser/list` 返回 200 + `engine`；
  未认证 401、跨站 Origin 403；`plugins/??@rsrsai/dsh-memlite/client.js` 组合包 200 且为 ModuleLoader factory 形状。

## 测试

```bash
pnpm test   # 197 例：真 cordis 核 + 形状忠实宿主服务替身 + 配置表单/Obsidian 路由/记忆浏览器（Host+Client）+ 独立验收
```

## 协议

MIT。
