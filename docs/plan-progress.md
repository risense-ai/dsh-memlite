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
| M5 | 文档 + 发布 | 1 天 | ✅ 文档/CI 完成；**npm 发布与 Hub 提交待定**（依赖 @rsrsai/memlite 先上 npm） |
| M6 | 自动捕获 | 后续 | 不在 0.1.0 范围 |

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
