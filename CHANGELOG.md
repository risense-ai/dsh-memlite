# Changelog

## 0.6.0 (2026-11-08，源码；npm 待发布)

并发协议接入与说明。

- 依赖 `@rsrsai/memlite@^0.3.0`：跨进程锁、快照代次、锁内提交、条件写、向量 revision manifest。
- 配置新增 `concurrency`（`mode` / `filesystem` / `lockTimeoutMs`），`toMemliteConfig` 透传；YAML 可开启本地多进程。
- 状态响应新增 `concurrency`：模式、锁后端、是否跨进程、`storage_protocol`；状态视图新增「并发与锁」卡片，
  `in-process` 时明确提示只能单写者。
- 全部记忆/因果树读取改用 `Memlite.snapshot()`，同一请求内不跨代拼接。
- 介绍页新增「多窗口、多进程同时用」章节；README 增加并发配置、冲突与 NFS 边界。
- 测试 197 例全绿；`pnpm build` 产出宿主与浏览器 bundle。

## 0.5.0 (2026-11-08)

完整 UI 闭环：在只读记忆浏览器之上增加统一写入、召回解释、状态视图与条件写版本守卫。
依赖 `@rsrsai/memlite@^0.2.0`（条件写 / revision）。

### 新能力

- **四视图**：本次对话 / 全部记忆 / 因果树 / 状态。顶栏显示真实可用状态，可直接存入与刷新。
- **写入闭环**（`src/memory-write-service.ts` + 路由）：
  - 存入、编辑、基于此续写、改挂因果、忘记记忆；保存后统一读回（id/标题/正文或父链/不存在）。
  - 编辑/改挂/忘记带 `expectedRevision`；冲突返回 409 + `STALE_VERSION` + 当前安全投影，草稿保留。
  - 回执按 operationId 幂等，内存最多 200 条；重载清空，不冒充永久审计。
  - 敏感闸拒绝只报类别，不回显秘密；嵌入未启用/待回填与 JSONL 已保存分开显示。
- **召回解释与反馈**：
  - 账本补充实际注入标题块、当时阈值/预算/使用字符/耗时；逐条显示 threshold/budget 原因。
  - 有帮助/不相关反馈只按会话账本记录，明确不自动调权、重载清空。
- **状态视图**：
  - 本地库条数/坏行/向量、检索后端与嵌入档、git 同步（可用/未配置/未验证/脏）、
    Obsidian 最近操作状态、当前会话近期回执。
  - 立即同步（四字段核验）、显式回填向量（无百分比、无假进度）、复制脱敏诊断摘要。
  - 不返回完整路径、remote URL、凭据、正文或向量。
- **全部记忆**：列表—详情响应式两栏（窄侧栏自动堆叠），详情提供编辑/续写/改挂/围绕检索/
  复制/忘记；技术 id 与 revision 保留在详情。
- **因果树**：围绕选中记忆检索、定位当前节点、改挂入口；继续逐层加载与断链/环提示。

### 接口与数据

- `@rsrsai/memlite` 0.2.0：`extra.revision` 版本字段；`update/attach/forget` 接受 `{expectedRevision}`；
  条件检查与 JSONL 追加在同一同步段完成；条件写前检测外部文件签名并重载，跨实例旧写入触发冲突。
- 13 条 `api/memlite/browser/*` 路由：原 5 条只读 + `status`、`remember`、`update`、`attach`、
  `forget`、`recall-feedback`、`sync`、`reembed`。
- `MemorySummaryItem`/`MemoryDetail` 增加 `revision`；详情增加 `parentId`；
  `MemorySessionRecall` 增加 `injectedText/threshold/budgetChars/usedChars/limit/elapsedMs/feedback`。
- Obsidian 三条路由保留 `text`，新增结构化的计数型 `report`（不含路径）。

### 安全与边界

- 写路由复用宿主认证/信任栅栏；64 KiB 请求体上限；operationId/标题/正文/标签/项目白名单校验。
- 浏览器不直写 JSONL；所有写入经 Memlite 主类与条件写。
- 不虚构能力：没有 pending 审批域、撤销删除、永久审计、自动反馈调权；聊天回复内嵌入口因
  宿主无稳定回复操作栏 slot，本轮只保留右侧入口（已在文档记录阻塞）。
- 正文仍只进 `<pre>`/textarea，不执行记忆中的 HTML 或命令。

### 质量

- 新增 `tests/memory-write-routes.test.ts`（9 例）与 `@rsrsai/memlite` 条件写 5 例。
- 客户端新增状态/回执/编辑器 SSR 覆盖；更新路由总数与字段白名单断言。
- `pnpm typecheck` / `pnpm test`（197 例）/ `pnpm build` 全绿；
  本地预览（`preview/`）在 320px 与桌面宽度做真实浏览器交互验证。

## 0.4.0 (2026-11-08)

M8 聊天记忆浏览器（只读）：会话右侧 **Memory 页签**，三视图 + 5 条只读路由 + 会话召回账本。
不新增模型请求、不把记忆卡片塞进消息流、不另建管理后台。**发布动作单列**（未随本次提交执行）。

### 新能力

- 右侧 Sidebar 页类型 `@rsrsai/dsh-memlite/memory`（kind `memlite-memory`）+ Guide 入口「Memlite 记忆」；
  页体注册在 `sidebar.right.pane.tab`（key=页类型 id），`dsh.client.inject` 增加
  `@deepseek-ai/dsh-client-ui-sidebar-right`；老宿主缺该服务时只跳过记忆页，配置页照常。
- **本次对话**：按回合列出真实追加进上下文的召回（标题、已注入/低于阈值/预算截断、分数、后端、时间）；
  注入状态与 `selectRecallTitles()` 同源，候选命中不冒充已使用；原记忆删除后保留标题并标「已删除」。
- **全部记忆**：搜索 + 项目/标签/重要性筛选 + keyset 游标分页；列表仅标题/两行摘要/徽章，详情纯文本渲染 + 因果邻居 + 复制正文/id。
- **因果树**：逐层展开（不一次取全深树）、父子跳转、断链/环截断提示、窄栏不横向溢出。
- 5 条只读路由（`connection.fetch`，认证/信任栅栏/owner Peer 由宿主负责）：
  - `POST /api/memlite/browser/list`
  - `POST /api/memlite/browser/search`
  - `POST /api/memlite/browser/show`
  - `POST /api/memlite/browser/tree`
  - `POST /api/memlite/browser/session-recalls`
- 召回账本（M8c）：按 `sessionId` 隔离（取不到稳定 id 时明示 agent 级降级），单会话 ≤100 / 全局 ≤500 / 单条 hits ≤50；
  不保存原始提示词、不暴露 querylog；`agent/disposed` 清理；插件重载即清空。
- 引擎代次 `engine`：结构性配置（dataDir/embedding/sync/敏感闸）重建引擎后 +1，浏览器据此清空失效详情，不读旧引擎正文。

### 安全与边界

- 路由入参全部做形状/长度/枚举/上限校验（请求体 ≤64 KiB），错误文案不含路径/密钥/原始请求；
  列表/搜索/树不返回正文，show 正文限 20k 字符；响应不含向量、凭据、`extra` 原字段、本地路径。
- `enabled=false` 时路由统一 503 + `disabled:true`。
- 客户端 bundle 仍只外置 `react` / `react/jsx-runtime`；详情禁止 `dangerouslySetInnerHTML`；
  切换视图/会话/刷新/卸载时 AbortController 中止在途请求。

### 质量

- 新增 `tests/memory-routes.test.ts`（19）`tests/recall-ledger.test.ts`（11）`tests/client-memory.test.ts`（42）
  `tests/memory-api-status.test.ts`（5）`tests/verification-m8.test.ts`（22，独立验收）；
  更新 `tests/client-page.test.ts`（注册契约）、`tests/obsidian-routes.test.ts`（路由总数）。
- 测试 81 → 182 例（13 文件）；`pnpm typecheck` / `pnpm test` / `pnpm build` 全绿。
- 真机隔离实例（`DSH_HOME=/tmp` + `dsh plugin add .`）：插件行激活、登录态路由 200（`engine:1`）、
  未认证 401、跨站 Origin 403、`plugins/??@rsrsai/dsh-memlite/client.js` 组合包 200。

### 文档与后续

- 新增 [`docs/m8-contract.md`](./docs/m8-contract.md)（Host↔Client 契约、实现偏差与真机实测记录）；README（含三张截图）/plan/proposal/progress 同步。
- 真机验收修复：会话召回时间戳单位（曾显示 58822 年）、搜索项目「（无）」退化、项目筛选下树 childCount 假断链、
  503 被误判为「已禁用」（引擎异常改 500）、分数上限截断（改为召回原始分）、threshold 用例假绿。
- 后续：Desktop 载体人工复验（与 Web 共用 bundle）、npm 发布与 Hub 提交、M8d 写操作另行授权。

## 0.3.2 (2026-11-08)

配置页 Obsidian 桥：在 GUI 里直接导入 / 导出 / 检查同步态。

### 新能力

- 配置页新增 **Obsidian 桥** 分组：vault 路径、project、writeId、dry-run、导出目录、overwrite
- 三个精确路由（`connection.fetch`，经浏览器认证与 Host/Origin 信任栅栏）：
  - `POST /api/memlite/obsidian/import`
  - `POST /api/memlite/obsidian/export`
  - `POST /api/memlite/obsidian/status`
- 路径守卫与报告格式化与 `/memlite-import`、`/memlite-export`、`/memlite-vault-status` 命令同源；
  支持 `~` 展开、空串/不存在目录/非法 JSON/超长请求体拒绝
- 同一时刻只允许一个导入/导出任务（409），避免并发写库冲突
- 配置页记住最近使用的 vault / 导出 / 项目路径（localStorage），并给出预览、导入、导出、同步检查按钮
- `/memlite` 概览新增「自动召回」「自动记录」说明：每轮开始自动召回；前缀消息自动写入并读回；收尾提醒 AI 补记可复用结论

### 质量

- 新增 `tests/obsidian-routes.test.ts`（注册契约、dry-run、导入→status、导出/覆盖、路径与 JSON 守卫）
- 新增配置页 SSR 渲染测试（Obsidian 分组与操作可见）
- 测试 75 → 81 例；客户端 bundle 仍只外部依赖 react / react/jsx-runtime

### 文档

- 介绍页对比表改为与 respire-dsh 对比，移除 plur-ai/dsh 参照

## 0.3.1 (2026-11-08)

本地化展示名称：插件页卡片与 memlite 行的标题不再显示完整包名。

### 新能力

- 新增 `locale/zh.json` / `locale/en.json`（`meta.title` / `meta.description`）：
  「Memlite 记忆」/「Memlite Memory」及本地化描述
- `exports` 增加 `./locale/*.json`，`files` 收录 `locale/*.json`，供 Host 的 `readPluginMeta` 解析
- 标题/描述的解析顺序：locale `meta` → package.json `name`/`description` → 完整包名/模块名；
  bundle 卡片与行共用同一份元数据，子路径插件不读 package.json

## 0.3.0 (2026-11-07)

Web GUI 配置页：在侧栏「插件」页的 memlite 行里可视化编辑配置（明确触发的 settings 写入）。

### 新能力

- 浏览器半区（`dist/client.js` + `dsh.client`）：注册 `plugins.row.config`，键 `@rsrsai/dsh-memlite#memlite`
  ——行详情里出现「配置」页，字段只读生效值，保存才写入 profile 的 `cordis.patch.yml`
- 配置表单：总开关、记忆目录、召回条数/阈值/预算/最短提示词/收尾频率、
  嵌入档（none/openai-compatible/host）与服务地址/模型/凭据引用/超时、git 自动同步与 remote、敏感闸
- 每个字段带「已覆盖」标记与「恢复默认」（`unset` 回到 bundle/默认层）
- `Config` 根对象改为 `.volatile()`：settings 写入只更新运行中的配置引用，不重挂插件；
  插件按次读取快照，`dataDir` / `embedding` / `sync` / `sensitiveGate` 变化时自动重建引擎
- 关闭 `enabled` 即时生效：规则注入返回空、pre-step 不召回、收尾不提醒、工具与命令回执拒绝
- 浏览器侧校验与草稿：数字范围/空值恢复默认，保存失败（并发修改/被拒）保留草稿并提示

### 质量

- 新增 `tests/client-form.test.ts`（草稿/差集/校验）、`tests/client-page.test.ts`（注册契约 + bundle 形状）
- 测试 57 → 73 例；`pnpm build` 同时产出宿主与浏览器 bundle
- 测试宿主隔离 `HOME`/`USERPROFILE`，避免召回回退打到真实用户记忆库

## 0.2.0 (2026-11-07)

插件逻辑按 `@rsrsai/dsh`（respire-dsh）重写；保留进程内引擎与 16 个斜杠命令。

### 破坏性变更

- 注入 section 从 `memlite:context`（off-turn 缓存）改为 `memlite:rules`（静态规则，order 850，恒定注入）
- 召回从 `agent/inbox/inserted` 异步预取改为 `agent/pre-step` 同步召回，以 `source=memlite` 的 user 消息追加
- 召回注入只给标题 + 分数 + id8；正文改用模型工具 `memlite_show` 展开
- 配置字段变更：新增 `enabled` / `recallThreshold` / `budgetChars` / `minPromptChars` / `storeNudgeEvery`；
  移除 `autoInject` / `autoCapture`；`recallLimit` 默认 10 → 5
- 删除 `cache.ts` / `prompt.ts`；新增 `rules.ts` / `messages.ts` / `state.ts` / `tools.ts`

### 新能力

- 静态 9 条行为规则（先召回、写前查重、因果三段式、不存密钥、信任回执、`/nomem` 等）
- 每 agent 一次 `status` 体检（空库/条数少/坏行/引擎异常提示）
- 敏感闸前置（与引擎同一套 `scanOrReject`）
- 显式「记：/存：/remember:」存储 + `mem.show` 读回校验（verified/mismatch/unavailable）
- `agent/turn-stopping` 一次性收尾 steer（`storeNudgeEvery` 控制，0=关闭）
- 模型工具：`memlite_recall` / `memlite_show` / `memlite_remember` / `memlite_update` / `memlite_attach`
- 失败一律转成模型可见回执，不阻塞任务；每 agent / 每 turn 状态机

### 质量

- 测试 44 → 57 例；真 cordis 核 + pre-step waterfall 派发 + tools 服务替身
- 文档新增 [respire 对齐说明](./docs/respire-alignment.md)

## 0.1.0 (2026-11-07)

首版。M0-M5 全量实现（npm 发布动作待定；M7 autoCapture 下一阶段）。

### 核心机制

- **系统提示注入**：单 section（`memlite:context`, order 120），text 同步读缓存；
  off-turn 双点刷新（`agent/inbox/inserted` recall + `agent/turn-stopping` 保底）；
  按 `assembly.agent.id` 隔离缓存（多 agent 不串味；诊断拼装无 agent 返回空）
- **命令面**：13 个扁平单 token 命令（COMMAND_NAME 正则约束，M0 漂移四），
  CommandResult `{kind, text}` 联合类型
- **生命周期**：`ctx.effect` 装配/卸载；命令与 section 卸载器随 apply 返回句柄级联

### 与 memlite-js 集成

- 逐字段配置映射到 `MemliteConfig`；凭据适配 `credentials.resolve(ref) → {value, source}`（M0 漂移一）
- 命令调用面全部经 Memlite 主类（integration.md §四约束，不绕底层模块）
- host 嵌入档：DSH 0.2.x 无 embeddings API（M0 漂移三）——加载告警 + dim-0 占位回退 BM25

### 质量与实测

- 34 测试全绿：真 cordis 核（@deepseek-ai/cordis 4.1.0）+ 形状忠实宿主服务替身
  （命令名强校验复刻 dsh COMMAND_NAME、CommandResult 联合、assemble 形状含运行时 agent）
- 真机装载验证（dsh 0.2.2-rc.1）：`dsh.bundle.patch` + cordis.patch.yml insert 行 +
  link 安装；apply→配置覆盖→13 命令注册→section 注册全链路实测
- M0 四漂移实测坐实并回写方案（credentials.resolve / AssembleContext 运行时 agent /
  无 providers-embeddings / 命令名单 token）

### 待办（0.1.0 发布门槛之外）

- npm 发布 `@rsrsai/dsh-memlite@0.1.0`（依赖 `@rsrsai/memlite` 先发 npm，当前 file: 链接）
- DSH Plugin Hub 提交（topic `dsh-plugin` + publish checklist）
- Web UI 端到端会话验证（须配 DeepSeek API key，用户侧）

### M5 Obsidian 整合（2026-11-07 追加，plan 修订新增）

- 三命令：`/memlite-import <vault-path> [--project P] [--write-id] [--dry-run]` /
  `/memlite-export <output-path> [--overwrite]` / `/memlite-vault-status <vault-path>`
- 经 `@rsrsai/memlite-obsidian@*With` 共享实例重载复用插件常驻 Memlite（无双实例写冲突）
- 路径守卫：空串/不存在目录即拒（memlite-obsidian fb8a0c73 事故教训）
- dry-run 预览（wouldCreate/wouldUpdate），description 写明建议先预览
- 配套上游修复：memlite-obsidian dry-run 目录子条误报 parent-failed 的真 bug（43 测试绿）
- 测试 44 全绿（新增 10 例：三命令真核 + 空串守卫 + dry-run 不写库 + 三方互通幂等）
