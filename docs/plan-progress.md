# dsh-memlite 实施进度

> 从 [plan.md](./plan.md) 复制，逐项打勾追踪。开工日 2026-11-07。

## 里程碑总览

| 阶段 | 范围 | 估算 | 状态 |
|---|---|---|---|
| M0 | 技术验证 spike | 1 天 | ✅ 完成（dsh 0.2.2-rc.1 真机 + 权威类型，四漂移坐实） |
| M1 | 插件骨架 | 1 天 | ✅ 完成（真机装载验证全链路） |
| M2 | 命令面 | 2 天 | ✅ 完成（13 命令 + 真核测试） |
| M3 | 系统提示注入 | 2 天 | ✅ 完成（双点刷新 + 多 agent 隔离 + 60 轮稳定） |
| M4 | 嵌入档接入 | 1 天 | ✅ 完成（openai-compatible + credentials.resolve；host 档当前版本不可用已明示） |
| M5 | Obsidian 整合（plan 修订新增） | 1 天 | ✅ 完成：三命令 + 空串守卫 + dry-run + *With 共享实例重载（上游 43 绿） |
| M6 | 文档 + 发布 | 1 天 | ✅ 文档/CI 完成；**npm 发布与 Hub 提交待定**（依赖 @rsrsai/memlite 先上 npm） |
| M7 | 自动捕获 | 后续 | 不在 0.1.0 范围 |
| **M8a–M8c** | **聊天记忆浏览器（只读）** | **5 天** | **✅ 完成（2026-11-08，0.4.0）：右侧 Memory 页签 + 5 只读路由 + 召回账本；真机 UI 验收通过** |

---

## M0 技术验证 spike

- [x] 临时 spike 目录 + 最小 package.json + `dsh.bundle.patch` 装载协议实测
- [x] `apply(ctx, config)` 双参真机实跑
- [x] `ctx.effect(fn, label)` setup + cleanup 真机实跑（无 dispose 事件，effect 是唯一通路）
- [x] `commands.register` / `systemPrompt.section` 真机注册成功
- [x] 权威类型全读（0.2.2-rc.1 .d.ts）：CommandResult / CommandInvocation / PromptSection /
      AssembleContext / CredentialProvider / turn-stopping payload / SkillRegistration
- [x] **四漂移坐实并回写 proposal.md §十三**：
  1. `credentials.get` → `credentials.resolve(ref) → {value, source}`
  2. `AssembleContext` 类型无 agent，运行时 `assembleContextFor` 实传 `{agent, scope, signal}`
  3. 无 providers 服务 / dsh-llm 无 embeddings → host 档不可用
  4. `COMMAND_NAME = /^[a-z][a-z0-9_-]*$/` 单 token 强校验 → 命令面改扁平 dash 名
- [x] 激活时序读定（dsh-agent-loop 源码）：claim → assemble → pre-step → LLM
- [x] 装载协议：`dsh.bundle.patch` 指向 cordis.patch.yml 的 `- insert:` 行；
  cordis/schemastery 必须 external（宿主 `isNativeConfigSchema` 校验 Config 的
  `~standard.vendor`——bundle 副本会拒激活；依赖由插件自身 node_modules 经 link realpath 解析）

---

## M1 插件骨架

- [x] package.json（@rsrsai/dsh-memlite，dsh.bundle.patch）+ cordis.patch.yml（insert 行）
- [x] tsup/tsconfig/vitest/.gitignore（与 memlite-js 同套）
- [x] src/index.ts（apply + Config + inject）+ src/schema.ts（Schemastery 全字段含 description）
- [x] src/lifecycle.ts（ctx.effect 装配/卸载 + credentials.resolve 适配 + host 档告警回退）
- [x] `/memlite` 概览命令 + registerCommands 编排
- [x] 真机装载验证：apply→配置覆盖（dataDir 注入）→13 命令注册→section 注册全链路

---

## M2 命令面

- [x] 13 命令全实现（含 `/memlite` 概览）：recall/remember/show/forget/update/attach/tree/chain/sync/status/reembed/bench
- [x] src/format.ts 渲染器（hits/全文/树/链/状态）+ CommandResult 适配（ok/fail/guard）
- [x] src/args.ts flag 解析（--k v / --k=v / 布尔 / 位置原文保留）
- [x] 真核测试：13 命令注册校验 + 全命令成功/错误路径（缺参、未知 id、防环、敏感闸、无仓 sync、未开档 reembed）
- [x] bench 命令端到端（纯 BM25 档 hit@3 达标）

---

## M3 系统提示注入

- [x] src/cache.ts：byAgent Map + refresh（并发去重）+ read（同步 <1ms）+ refreshLast + drop
- [x] 双点刷新：inbox/inserted（最早）+ turn-stopping（保底复用 lastQuery）+ disposed 清缓存
- [x] src/prompt.ts：单 section 按 assembly.agent.id 取缓存（防御性读取运行时 agent）；无 agent 返回空
- [x] src/render.ts：markdown 块 + maxMemories/maxChars 截断 + 尾部引导
- [x] 测试：多 agent 不串味 / 诊断拼装空 / 开关关空 / maxChars 截断 / 60 轮 prompt 长度稳定

---

## M4 嵌入档接入

- [x] openai-compatible：makeOpenAIEmbedder + credentials.resolve 适配（解析 `.value`）
- [x] 凭据缺失：初始化不炸，recall 回退 BM25（告警走宿主 logger）
- [x] host 档：dim-0 占位 Embedder + 加载告警，recall 纯 BM25（当前 DSH 无 embeddings API）
- [x] 切档：apply 重跑天然生效（memlite-js 语义不变）
- [x] 敏感闸关闭放行 / 开启拒绝 测试

---

## M5 文档 + 发布

- [x] README（安装/配置表/特性/互通/开发）
- [x] CHANGELOG（0.1.0 条目，含实测记录与待办）
- [x] GitHub Actions（typecheck/build/test + tag 发布任务，NPM_TOKEN 缺省跳过）
- [ ] npm 发布——**待解锁**：@rsrsai/memlite 先上 npm，包内 file: 依赖换 `^0.1.0`
- [ ] DSH Plugin Hub 提交（topic `dsh-plugin` + publish checklist + 截图）
- [ ] Web UI 端到端会话验证（须 DeepSeek API key，用户侧；LLM 前置链路已真机验证）

---

## 验收清单对照（plan.md）

- [x] M0 spike 全部 API 实测通过
- [x] M1 本地装载 + 最小命令工作
- [x] M2 全命令实现 + 真核测试绿（34 例）
- [x] M3 系统提示注入工作 + 60 轮会话无累积
- [x] M4 嵌入档三档行为正常（host 档按实测降级为「明示不支持」）
- [ ] M5 npm 发布 + Hub 提交（待解锁，见上）
- [x] 与 Rust memlite 库互通（memlite-js 层已互通实测；插件经主类同源）
- [x] 多 agent 不串味（测试覆盖）
- [x] 密钥全程不出现在配置/数据仓/日志（resolver 仅内存持有 value；EmbedError 无 Authorization）

## 关键度量

- 首装到首次 recall 命中：`dsh plugin add` + `/memlite-remember` + `/memlite-recall` ≤ 2 分钟
- 召回延迟（warm cache）：section text 同步 Map 读，<0.1ms
- 记忆库互通：memlite-js 0.1.0 已双向互通实测（Rust 写↔JS 读）

---

## M5 Obsidian 整合（2026-11-07，plan 修订新增后执行）

- [x] 依赖 `@rsrsai/memlite-obsidian`（file: 链接，`*With` 共享实例重载由上游新增——方案 A 落地，提交 658169a/3b1a1c2）
- [x] `src/commands/obsidian.ts` 三命令：import（--project/--write-id/--dry-run）/ export（--overwrite）/ vault-status
- [x] 路径守卫：空串（含 `""` 字面量）/不存在目录即拒；绝对化前置
- [x] dry-run 预览（wouldCreate/wouldUpdate + 「去掉 --dry-run」引导），description 写明建议先预览
- [x] 进度回调接收（DSH 命令面无流式通道，聚合进最终 ImportReport 摘要）
- [x] **上游真 bug 修复**：memlite-obsidian dry-run 目录子条误报 parent-failed（目录条不回填 pathIds）——上游 43 绿、dsh 侧 44 绿
- [x] tests/commands/obsidian.test.ts 10 例：注册计数 16 / 幂等导入 / dry-run 不写库 / 空串与不存在路径 / --write-id 回填 / export 覆盖守卫 / vault-status 三态迁移 / 三方互通（导入→召回→导出→再导入零变更）
- [x] 真机装载复验：16 命令、零激活告警
- [x] README/CHANGELOG/介绍页同步（16 命令、Obsidian 卡片）

**遗留**：memlite-obsidian 上 npm 后两处 file: 依赖换 `^0.1.0`；介绍页部署的 Pages 已上线。

---

## M7 架构对齐 respire-dsh（2026-11-07，0.2.0）

- [x] 静态规则 section `memlite:rules`（order 850，9 条行为契约）
- [x] `agent/pre-step` 同步召回（人类消息过滤 + message.id 去重 + 标题档 + threshold/budget）
- [x] 每 agent 一次 status 体检（空库/条数少/坏行/引擎异常回执）
- [x] 敏感闸前置（`mem.scanOrReject`，与写库同一套规则）
- [x] 显式「记：/存：/remember:」存储 + `mem.show` 读回校验 + 模型可见回执
- [x] `agent/turn-stopping` 一次性收尾 steer（ready/hadUser/stored/reminded/nudge 闸）
- [x] 每 agent / 每 turn 状态机（WeakMap：checked/ready/rounds/turn）
- [x] 模型工具 `memlite_recall/show/remember/update/attach`（`ctx.tools`，无宿主包运行时依赖）
- [x] 删除 off-turn 缓存与 `memlite:context`；删除 `cache.ts` / `prompt.ts`
- [x] 配置改为 `enabled/recallLimit/recallThreshold/budgetChars/minPromptChars/storeNudgeEvery`
- [x] 测试 44 → 57 全绿；`pnpm build`（ESM + d.ts）通过
- [ ] 真机重载回归（desktop profile：显式存储回执 + 召回注入 + 收尾 steer）
  —— M8 真机验收已在隔离 web profile 覆盖召回注入与面板链路；desktop profile 的显式存储回执仍未复验


---

## M8 聊天记忆浏览器（2026-11-08，0.4.0，只读）

设计见 [proposal.md §十四](./proposal.md#十四聊天记忆浏览器m8-设计2026-11-08)，实现契约见 [m8-contract.md](./m8-contract.md)。

### M8a 记忆浏览 MVP

- [x] 宿主 API 按 **DSH 0.2.2-alpha.2** 核实：`ctx.sidebarRightTabs.register({id,kind,priority,title,guide})` + `sidebar.right.pane.tab` 键ed slot（`key`=页类型 id，`inject(sessionId)`）；`dsh.client.inject` 增列 `@deepseek-ai/dsh-client-ui-sidebar-right`
- [x] 页类型 `@rsrsai/dsh-memlite/memory`（kind `memlite-memory`，priority `extension`）+ Guide 入口「记忆浏览器」；页体随插件 effect 卸载
- [x] 面板三分层：`MemliteMemory.tsx`（视图/状态）、`memory-api.ts`（形状校验 + abort）、`memory-locales.ts`（zh/en）
- [x] `src/browse.ts`：内存投影 / 项目·标签·重要性筛选 / keyset 游标（`ts:id`）/ 树逐层 / 字段白名单 / 摘要与正文限长
- [x] `src/memory-routes.ts`：`list`、`search`、`show`、`tree`、`session-recalls` 五条 buffered POST；入参守卫 + 禁用 503 + 引擎异常 500 + `engine` 代次
- [x] 列表仅摘要与元数据；详情纯文本（禁 `dangerouslySetInnerHTML`）+ 因果邻居 + 复制正文/id
- [x] loading / 空库 / 无命中 / 禁用 / 失败 / 中止 / 已删除 状态；切换视图·会话·刷新·卸载 abort 在途请求
- [x] 测试：路由注册与守卫、白名单、分页上限、筛选语义（含「（无）」）、客户端形状校验与状态判别、SSR 渲染

### M8b 因果树浏览

- [x] 有界 tree 路由（`parentId` 逐层，limit ≤200，`trimmed` 标记），不返回全深树
- [x] 可折叠缩进树、节点选中、父子跳转；链视图复用 `mem.chain()`（深度 3、节点 ≤200）
- [x] 空树 / 断链 / 环截断 / 大量子节点 / 窄栏不横向溢出；投影筛选下 `childCount` 与可展开子层一致
- [x] 测试：根层/子层、limit 截断、未知父节点 400、项目筛选一致性

### M8c 会话召回与验收

- [x] `src/recall-ledger.ts`：有界内存账本，按 `sessionId` 隔离（`agent.session.id`），取不到时 `scope:'agent'` 明示降级；单会话 ≤100 / 全局 ≤500 / hits ≤50；`agent/disposed` 清理；插件重载清空
- [x] `selectRecallTitles()`：阈值/预算筛选与注入文本**同一份结果**，账本 `injected/exclusion` 直接来自它；中止/reject 不落账
- [x] 区分 injected / threshold / budget / empty / skipped（nomem·short·sensitive·store）/ error；不保存提示词
- [x] 本次对话视图：回合倒序分组、注入徽章、分数、后端、时间、原记忆已删除（`exists:false`）、手动刷新
- [x] `engine` 代次：结构性配置重建引擎后 +1，面板清详情并重载，避免读旧引擎
- [x] `pnpm typecheck` / `pnpm test` / `pnpm build` 全绿；既有命令、召回、配置页、Obsidian 无回归
- [x] 真机验收（隔离实例 `DSH_HOME=/tmp/dsh-m8-home` + `MEMLITE_DATA` 种子库 + headless Chrome/CDP）：
      插件行激活、Guide 卡片、页签 chip「记忆」、三视图、空态/列表/详情/树展开、`已注入` 徽章、
      `api/memlite/browser/*` 全 200、未认证 401、跨站 Origin 403、`plugins/??@rsrsai/dsh-memlite/client.js` 200
- [x] 修复验收发现的缺陷：会话召回时间戳按秒存（界面曾显示 58822 年）、搜索「（无）」项目退化、
      项目筛选下树 `childCount` 与实际子层不一致、503 被误判为「已禁用」、threshold 用例假绿、
      分数上限截断（改为召回原始分）、面板时间显示 UTC（改为浏览器本地时区）
- [ ] 发布（npm + Hub）单列，未随实现执行
- [ ] Desktop 载体的人工交互复验（与 Web 共用 bundle，本轮仅 Web 覆盖）

---

## M9–M12 完整 UI（2026-11-08，0.5.0）

- [x] `@rsrsai/memlite@0.2.0`：`extra.revision` + `update/attach/forget` 条件写 + 外部文件签名刷新；5 例条件写测试
- [x] `src/memory-write-service.ts`：remember/update/attach/forget 统一读回回执、operationId 幂等、稳定错误码
- [x] 8 条新路由：`status/remember/update/attach/forget/recall-feedback/sync/reembed`；冲突 409 + `STALE_VERSION`
- [x] 四视图：本次对话/全部记忆/因果树/状态；本次对话逐条解释与实际注入原文
- [x] 存入/编辑/续写/改挂/忘记；冲突草稿保留；替换/清除父条；忘记标题确认
- [x] 全部记忆响应式列表—详情；因果树围绕检索/定位/改挂；状态页库/检索/同步/Obsidian/回执
- [x] 反馈按会话账本记录，不自动调权；同步/回填单任务互斥；诊断摘要脱敏
- [x] 组件拆分 `memory-editor/memory-receipt/memory-status-view/memory-ui`，共享主题变量
- [x] 本地预览 `preview/`：真实浏览器验证四视图、存入/编辑/改挂/忘记/同步、320px 无横向溢出
- [x] `pnpm typecheck` / `pnpm test`（197 例）/ `pnpm build` 全绿
- [x] README/CHANGELOG/contract/integration/plan 更新
- [ ] 聊天回复内嵌折叠条：宿主无稳定 reply-action slot，未挂载（不伪造宿主挂载点）
- [ ] Desktop 载体人工复验（Web/Desktop 共用 bundle，本地预览覆盖交互）
