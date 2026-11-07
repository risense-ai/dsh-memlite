# dsh-memlite 实施计划

> 与 [proposal.md](./proposal.md) 配套。
> 总估算：**8 + 1 = 9 个工作日**（不含 dsh 生态调研缓冲）。

---

## 里程碑总览

| 阶段 | 范围 | 估算 | 状态 | 产出 |
|---|---|---|---|---|
| M0 | 技术验证 spike | 1 天 | ✅ 已完成 | DSH API 实测，确认 host provider / credentials / systemPrompt 可用性 |
| M1 | 插件骨架 | 1 天 | ✅ 已完成 | package.json + apply + 最小命令注册 + 本地 link 装载 |
| M2 | 命令面 | 2 天 | ✅ 已完成 | recall/remember/show/forget/update/attach/tree/chain/sync/status 全命令 |
| M3 | 系统提示注入 | 2 天 | ✅ 已完成 | MemliteCache + section 注册 + off-turn 刷新 |
| M4 | 嵌入档接入 | 1 天 | ✅ 已完成 | host + openai-compatible 装配，credentials 集成 |
| **M5** | **Obsidian 整合** | **1 天** | **✅ 已完成（2026-11-07）** | `/memlite-import` `/memlite-export` `/memlite-vault-status` 三命令 |
| M6 | 文档 + 发布 | 1 天 | 待启动 | README + CHANGELOG + npm 发布 + Hub 提交 |

M7（自动捕获 autoCapture）放到下一阶段，**不在 0.1.0 范围**。

**说明**：原 M5（文档+发布）顺延为 M6。Obsidian 整合作为 M5 提前到发布前——让用户开箱即可把已有 vault 转成本插件的记忆库，**这是拉新入口**。

---

## M0 技术验证 spike（1 天）

**目的**：用最小代码验证 DSH 提供的关键 API 真实形状。这是参考 [plur-ai 实战教训](https://plur.ai/blog/deepseek-harness-memory-plugin/)——他们 9 个坑全是 mock 测试通过但真机失败的例子。

### 任务

- [ ] 创建 `/tmp/dsh-memlite-spike/` 临时插件目录
- [ ] 写最小 `package.json`：`name=dsh-memlite-spike`、`dsh.bundle=true`、main 指向 index.ts
- [ ] 在 index.ts 里：
  - [ ] `console.log(typeof ctx.credentials)`——确认存在
  - [ ] `console.log(typeof ctx.providers)`——确认存在
  - [ ] `ctx.commands.register({name:'spike', description:'...', handler:()=>({kind:'success',text:'ok'})})`——确认注册
  - [ ] `ctx.systemPrompt.section({name:'spike:test', order:120, text:()=>'hello'})`——确认注册
  - [ ] `ctx.effect(() => {...return cleanup}, 'spike')`——确认 dispose 通路
- [ ] `dsh plugin --profile web add ./` 装载
- [ ] `dsh --profile web --dump-config` 看插件配置层
- [ ] 在 dsh web UI 里发一条消息，看 console 输出

### 验收

- [ ] 五个 API 全部确认存在且签名与预期一致
- [ ] 若有不符，回到 proposal.md 修订方案

### 关键 trap（plur-ai 警告）

- **`ctx.xxx` 属性访问会 throw**——未声明的服务不能用 `typeof ctx.xxx?.foo`，要用 `ctx.inject(['xxx'], scoped => ...)` 隔离
- **命令字段是 `handler`**，写错在 contained fiber 里 throw，**无任何日志**

---

## M1 插件骨架（1 天）

### 仓库初始化
- [ ] `package.json`：name=`@rsrsai/dsh-memlite`、type=module、dsh.bundle=true
- [ ] `tsup.config.ts`、`tsconfig.json`（与 memlite-js 同套）
- [ ] `vitest.config.ts`
- [ ] `.gitignore`

### 入口
- [ ] `src/index.ts`：export `apply` + `Config` + `inject`
- [ ] `src/schema.ts`：完整 Schemastery schema（含 description）
- [ ] `src/lifecycle.ts`：`ctx.effect` 装配/卸载 Memlite

### 最小命令
- [ ] `src/commands/status.ts`：`/memlite status`——返回库路径/条数/git 状态
- [ ] `registerCommands` 编排

### 本地装载验证
- [ ] `npm run build`
- [ ] `dsh plugin --profile web add ./` 链接装载
- [ ] 在 dsh web UI 里 `/memlite status` 返回真实数据
- [ ] 改 cordis.yml 加 `config:` 字段，确认热重载生效

---

## M2 命令面（2 天）

### 命令实现（每个 ~30-50 行）

- [ ] `recall.ts`：query + limit + project + bm25 flag → `mem.recall()` → 格式化 hits
- [ ] `remember.ts`：content + title + tags + parent → `mem.remember()` → 返回 id
- [ ] `show.ts`：id → `mem.show()` + 因果视界渲染
- [ ] `forget.ts`：id → `mem.forget()` → 确认
- [ ] `update.ts`：id + title/content → `mem.update()`
- [ ] `attach.ts`：child + parent → `mem.attach()`（含防环）
- [ ] `tree.ts`：from/depth/outline → `mem.tree()` → 渲染
- [ ] `chain.ts`：id/depth → `mem.chain()` → 渲染
- [ ] `sync.ts`：→ `mem.sync()` → 返回 SyncReport
- [ ] `reembed.ts`：→ `mem.reembed()` → 进度报告
- [ ] `bench.ts`：→ `mem.bench()` → hit@1/hit@3

### 格式化

- [ ] `src/format.ts`：hits/table/tree 三种渲染器
- [ ] CommandResult 适配器（kind/text/data）

### 测试

- [ ] `tests/commands/` 每个命令一个测试文件
- [ ] 用真实 `dsh-commands` 注册器跑集成测试（参考 plur-ai 的"最高价值测试"）
- [ ] 命令错误路径：参数缺失、id 不存在、防环触发

---

## M3 系统提示注入（2 天）

### MemliteCache

- [ ] `src/cache.ts`：
  - `byAgent: Map<agentId, {text, ts}>`
  - `refresh(agent)`：取 lastUserMessage → recall → 渲染 → 写缓存
  - `read(agentId)`：读缓存（同步，< 1ms）
  - TTL：可选，默认永不失效（每次 turn-stopping 刷新）

### Off-turn 刷新

- [ ] `ctx.on('agent/turn-stopping', ({agent}) => cache.refresh(agent))`
- [ ] 注意事件 payload 是 `{agent, turn, signal}`，**不是 agent 本身**（plur-ai 实战）

### Section 注册

- [ ] `src/prompt.ts`：`registerPromptSection(ctx, cache, config)`
- [ ] 单一 section，按 `assembly.agent?.id` 取缓存
- [ ] 无 agent 返回空字符串

### 渲染

- [ ] `src/render.ts`：把 hits 渲染成 markdown 块
- [ ] 应用 `maxMemories` / `maxChars` 截断
- [ ] 加尾部说明"使用 /memlite show <id> 查看完整记忆"

### 测试

- [ ] 真实 `dsh-system-prompt` 注册器集成测试
- [ ] 多 agent 场景（两个 agent 并发，缓存不串味）
- [ ] 诊断拼装（assembly.agent 为 undefined）返回空
- [ ] 60 轮会话：prompt 长度稳定

---

## M4 嵌入档接入（1 天）

### host provider 装配

- [ ] `src/host-embedder.ts`：
  ```ts
  export function makeDshHostEmbedder(ctx: Context) {
    return makeHostEmbedder(async (text, opts) => {
      const current = ctx.providers.current()
      if (!current?.supportsEmbeddings) {
        throw new Error('当前宿主 provider 不支持 /embeddings')
      }
      return ctx.providers.embed(current.id, text, opts)
    })
  }
  ```

### openai-compatible 装配

- [ ] 直接调用 memlite-js 的 `makeOpenAIEmbedder`
- [ ] `credentialResolver: (ref) => ctx.credentials.get(ref)`

### 切档生效

- [ ] DSH 热重载天然保证：`apply` 重跑 → 新 Memlite 实例 → 新 embedder
- [ ] 验证：改 cordis.yml 的 `embedding.provider` 字段，下次 recall 立即换档

### 失败回退

- [ ] 测试嵌入 API 失败场景：recall 应回退 BM25，不 throw
- [ ] 测试 credentials 缺失：插件加载时报清晰错（"MEMLITE_EMBED_API_KEY 未配置"），不静默

---

## M5 Obsidian 整合（1 天）

**目标**：让用户在 DSH 会话里直接用 `/memlite-import` 把 Obsidian vault 灌进 memlite，用 `/memlite-export` 把 memlite 库导成 vault。**这是拉新入口**——已有大量 Obsidian 笔记的用户一键转成 AI 记忆。

### 依赖

新增对 `@rsrsai/memlite-obsidian@^0.1.0` 的依赖（已实现完成，37 测试绿，互通幂等验证通过）。

```json
{
  "dependencies": {
    "@rsrsai/memlite": "^0.1.0",
    "@rsrsai/memlite-obsidian": "^0.1.0"
  }
}
```

### 命令实现

- [ ] `src/commands/obsidian.ts`：三个新命令
  - [ ] `/memlite-import <vault-path> [--project P] [--write-id] [--dry-run]`
  - [ ] `/memlite-export <output-path> [--overwrite]`
  - [ ] `/memlite-vault-status <vault-path>`——列出 synced/outdated/missing 行
- [ ] `src/commands/index.ts`：注册三个新 def

### 参数解析与守卫

**关键陷阱**（核自 memlite-obsidian `fb8a0c73` 已修事故）：

- ❌ **绝不接受空串 path**：`memlite-import ""` 会落 cwd 并污染 114 文件
- ❌ **绝不接受空串 dataDir**：会误入 `~/memlite-data` 写 312 条
- ✅ 入参前用 `requireRest` 校验非空 + 路径绝对化 + 存在性检查
- ✅ `--dry-run` 默认强烈建议先跑一遍（在命令 description 里写明）

### 进度报告

memlite-obsidian 提供 `onProgress(done, total, path)` 回调。命令处理器把它转成 DSH 的进度显示：

- [ ] 大 vault（>100 条）显示进度
- [ ] 完成后输出 ImportReport/ExportReport 摘要（created/updated/unchanged/skipped/warnings）

### 与 Memlite 实例的协作

memlite-obsidian 的 `importVault`/`exportVault` 内部会 open/close 自己的 Memlite。但 dsh-memlite 已有一个常驻实例——两者写同一 dataDir 会**冲突**。

**两种方案**：

| 方案 | 做法 | 代价 |
|---|---|---|
| A. 共享实例 | 把 dsh-memlite 的 `mem` 传给 obsidian 函数（需 obsidian 仓加接受 Memlite 实例的重载） | 需 obsidian 仓改 API |
| B. 隔离调用 | obsidian 函数自开自关；调用前 dsh-memlite 暂停 recall cache 刷新，调用后触发刷新 | 不改 obsidian 仓，但需注意缓存一致性 |

**推荐方案 A**——一次性在 obsidian 仓加 `importVaultWith(mem, vaultPath, opts)` / `exportVaultWith(mem, outputPath, opts)` 重载，让 dsh-memlite 复用自己的 Memlite 实例。

- [ ] 给 memlite-obsidian 提 PR：加 `*With` 重载
- [ ] dsh-memlite 侧调用 `*With` 版本

### 测试

- [ ] `tests/commands/obsidian.test.ts`：三个命令的真实注册器测试
- [ ] 边界：空串 path、不存在路径、缺权限路径
- [ ] dry-run 不写库
- [ ] 大 vault 进度回调被调用
- [ ] 与 memlite-js / memlite-obsidian 三方互通：导入→召回→导出→幂等

---

## M6 文档 + 发布（1 天）

### 文档

- [ ] `README.md`：安装/配置/命令/嵌入档/互通/协议（中英双语）
- [ ] `CHANGELOG.md`：0.1.0 条目
- [ ] `docs/integration.md`：与 memlite-js 的依赖与版本对齐策略

### CI

- [ ] GitHub Actions：lint + typecheck + test + build
- [ ] npm publish on `v*` tag
- [ ] **npm scope**：`@rsrsai/dsh-memlite`

### 发布

- [ ] `npm pack` 验证
- [ ] 打 tag `v0.1.0`
- [ ] CI 自动 publish
- [ ] 提交到 [DSH Plugin Hub](https://dsh-plugin.org/plugins/dshplugin/dsh-plugin-hub)（GitHub repo + `dsh-plugin` topic + PR）

### Hub 提交材料

- [ ] GitHub 仓库加 topic `dsh-plugin`
- [ ] README 中英双语（含截图/GIF）
- [ ] 描述含类别（memory / local-first）
- [ ] 兼容版本声明
- [ ] 参考 [publish checklist](https://dsh-plugin.org/tutorials/publish-plugin-pr-checklist)

---

## M7 自动捕获（后续阶段，不在 0.1.0）

- autoCapture 默认关闭
- 监听 turn-stopping，按启发式（决策/错误修复/重要结论）自动 remember
- 重要性分级（important/trivial）
- 风险：垃圾记忆污染库；需要充分的启发式测试

---

## 验收清单

### 0.1.0 发布前必须满足

- [x] M0 spike 全部 API 实测通过
- [x] M1 本地装载 + 最小命令工作
- [x] M2 全命令实现 + 真实注册器测试绿
- [x] M3 系统提示注入工作 + 60 轮会话无累积
- [x] M4 嵌入档三档切换正常
- [x] M5 Obsidian 整合：三命令工作 + 空串守卫 + dry-run 提示
- [ ] M6 npm 发布 + Hub 提交
- [ ] 与 Rust memlite 库互通（插件能读 Rust 写的库）
- [ ] 多 agent 不串味
- [ ] 密钥全程不出现在 cordis.yml / 数据仓 / 日志

### 关键度量

- **首装到首次 recall 命中**：≤ 5 分钟（含 read README）
- **首装到首次 vault 导入完成**（1000 条）：≤ 5 分钟（含 dry-run + 实导入）
- **召回延迟**（warm cache）：< 1ms（系统提示注入零延迟）
- **记忆库互通**：JS 写入的库，Rust CLI 读出并命中

---

## 进度追踪

每完成一项打 `[x]`。M0 启动时把本文件复制为 `docs/plan-progress.md`，逐日更新。
