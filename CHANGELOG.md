# Changelog

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

### 质量

- 新增 `tests/obsidian-routes.test.ts`（注册契约、dry-run、导入→status、导出/覆盖、路径与 JSON 守卫）
- 新增配置页 SSR 渲染测试（Obsidian 分组与操作可见）
- 测试 75 → 81 例；客户端 bundle 仍只外部依赖 react / react/jsx-runtime

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
