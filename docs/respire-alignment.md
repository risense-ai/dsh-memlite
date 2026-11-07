# 插件逻辑对齐 respire-dsh（0.2.0）

> 目标：把 `@rsrsai/dsh-memlite` 的**插件逻辑**改成 `@rsrsai/dsh`（respire-dsh）同构，
> 只保留两个 memlite 自己的面：**进程内引擎**（不起子进程）与**16 个斜杠命令**。
> 本文是这次重写的设计记录与对照表；代码在 `src/`，测试在 `tests/`。

---

## 一、一句话结构

respire-dsh 的模型侧读写靠“模型用 shell 跑 `rsrs` CLI”；memlite 没有子进程，
所以等价通道换成五个 `ctx.tools` 工具。除此之外的时序、规则、状态机、失败语义全部照搬。

```
系统提示：memlite:rules（静态 9 条）
      │
      ▼
agent/pre-step（waterfall）
  1. await next() → 拿下游决策
  2. 只挑 source.kind === 'user' 的新消息（按 message.id 去重）
  3. 每 agent 一次 status 体检
  4. 敏感闸（引擎同一套 scanOrReject）
  5. 记：/存：/记住：/remember: → mem.remember + mem.show 读回 + 回执
     否则 → mem.recall（标题档）→ 追加 source=memlite 的 user 消息
      │
      ▼
agent/turn-stopping（每轮最多一次）
  → agent.steer(收尾自查)  （不查库、不写库）
      │
      ▼
模型工具：memlite_recall / show / remember / update / attach
```

---

## 二、逐项对照

| respire-dsh 的行为 | respire 的实现 | memlite 0.2.0 的实现 |
|---|---|---|
| 静态规则 | `systemPrompt.section({name:'respire:rules', order:850})` | `memlite:rules`，order 850，`interpolate:false` |
| 召回时机 | `agent/pre-step` 里 `await next()` 后处理人类消息 | 同左（真正 waterfall，不是旁路事件） |
| 注入形态 | `createUserMessage({source:{kind:'respire'}})` 追加到本步 messages | `contextMessage()` 生成同形消息，`source.kind='memlite'` |
| 召回内容 | 标题 + 分数 + id8，`budgetChars` 截断，`recallThreshold` 过滤 | 同左（`src/render.ts` `renderRecallTitles`） |
| 状态体检 | 每 agent 一次 `rsrs status`：未登录/库锁/库空/引擎不可用 | 每 agent 一次 `mem.status()`：库空/条数少/坏行/引擎异常 |
| 敏感闸 | 召回/存储前 `containsSecret(prompt)`，命中则跳过并回执 | 召回/存储前 `mem.scanOrReject(prompt)`（与写库同一套规则） |
| 显式存储 | `rsrs remember` → `rsrs show` 读回（id/标题/全文全等） | `mem.remember` → `mem.show` 读回（同三项全等） |
| 存储回执 | stored / warn / pending / failed / unconfirmed | 成功回执 verified/mismatch/unavailable；失败即“未写入” |
| 收尾提醒 | `agent/turn-stopping` 里 `agent.steer` 一次性提示 | 同左（`storeNudgeEvery` 控制频率，0=关闭） |
| 状态机 | `WeakMap<agent,{checked,ready,rounds,turn{processed,hadUser,stored,reminded}}>` | 同结构（`src/state.ts`） |
| 去重 | `message.id` 每 turn 的 `processed` 集合 | 同左（无 id 的测试消息用对象身份 `WeakSet`） |
| 失败语义 | 失败变成模型可见回执，不阻塞任务 | 同左（状态/召回/存储三类回执） |
| 模型读写通道 | 模型跑 `rsrs --client-only …` | `memlite_*` 五个工具（进程内调用） |
| 子进程 | `runRsrs()`（Windows 走 powershell 编码命令） | **无**（`Memlite` 常驻内存） |
| 命令面 | 无 | **保留** 16 个 `/memlite-*` |
| 配置默认 | recallLimit 5 / threshold 0 / budget 1500 / minPrompt 2 / nudge 1 | 同左 |
| 每次召回延迟 | CLI 50ms 级 + 子进程开销 | 进程内 1ms 级 |

### 没有搬过来的部分（引擎差异决定）

| respire 概念 | memlite 的处理 |
|---|---|
| `warn`（写完但有告警）/ `pending`（候选待决策） | 引擎没有这些状态：`remember` 要么返回 id，要么抛错（敏感闸/父不存在）；回执相应简化 |
| `superseded_by`（被新记录取代） | memlite 数据模型没有该字段 |
| `retitle` 命令 | 用 `memlite_update` 改标题 |
| 登录/库锁/运行时 | 本地 JSONL 库没有这些概念，status 只报目录/条数/坏行 |
| 自动总结/自动捕获 | 两边都不做：respire 是 steer 让模型写，memlite 同左；`autoCapture` 仍属下一阶段 |

---

## 三、时序细节

### pre-step

```ts
onWaterfall('agent/pre-step', async ({agent, turn, signal}, next) => {
  const decision = await next()
  if (decision.kind === 'reject' || aborted) return decision
  const humans = decision.messages.filter(m => m.source?.kind === 'user')
  // 新 turn → rounds++，重置 processed/hadUser/stored/reminded
  // 每 agent 首次：mem.status() 体检
  // 敏感闸 → 显式存储 → 否则 recall
  return { ...decision, messages: [...decision.messages, ...additions] }
})
```

要点：

- **先 `next()` 再追加**：下游 waterfall 的否决/改写优先；被 reject 时插件不做事。
- **只认人类消息**：插件自己的 `source.kind='memlite'` 不会被二次召回。
- **同步召回**：进程内 BM25 是毫秒级，await 的代价可忽略；换来首轮必有结果。
- **失败回执**：任何异常都转成一条 `【memlite · …】` 消息，任务继续。

### 显式存储

前缀集合与 respire 相同：`记：`、`存：`、`记录：`、`记住：`、`remember:`（大小写不敏感）。

1. 内容为空 → `【memlite · 未存】`；
2. `title = titleOf(content)`（首句、≤70 字）；
3. `mem.remember(content, {title, extra:{importance:'important'}})`；
4. `mem.show(id)` 读回：`id`、`title`、`content.trim()` 三项全等才算 verified；
5. 回执写明 verified / mismatch / unavailable，并明确“不要重复写”。

### 收尾 steer

条件（全部满足才提醒）：引擎已确认可用（`ready`）、同一 turn、有用户消息、
本 turn 未显式存过（`stored`）、未提醒过（`reminded`）、`storeNudgeEvery != 0`
且 `rounds % storeNudgeEvery == 0`。

提醒文案要求模型“查同主题候选 → 读正文 → update/attach → 需要时 remember”，
没有新东西就直接结束。插件本身不写库、不查库。

### 模型工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `memlite_recall` | query, limit?, project? | 标题 + 因果邻居；无命中返回“（无命中）” |
| `memlite_show` | id | 全文 + 标记 + 因果视界（复用命令面 `formatShow`） |
| `memlite_remember` | content, title?, tags?, parent?, project?, importance? | 写 + 读回校验，返回回执 |
| `memlite_update` | id, title?, content? | 同 id 追加新版本 |
| `memlite_attach` | child, parent | 挂因果链（防环） |

工具 schema 用宿主支持的 JSON Schema 子集手写（object/string/integer/array/enum），
不引入 `@deepseek-ai/dsh-tools` 运行时依赖——注册面只要求 `{name,description,parameters,output:{schema,render},execute}`。

---

## 四、状态机

```
AgentState (WeakMap key = agent 对象)
  checked   每 agent 一生一次的 status 体检
  ready     引擎是否确认可用（status/recall/remember 成功）
  rounds    第几个 turn（收尾提醒取模用）
  turn      TurnState
      turn        当前 turn 号
      processed   本 turn 已处理的 message.id
      seen        无 id 消息的对象身份去重
      hadUser     本 turn 是否出现过人类消息
      stored      本 turn 是否显式存过（存过则不再提醒）
      reminded    本 turn 是否已提醒（每轮最多一次）
```

agent 销毁（`agent/disposed`）时从 WeakMap 删除。

---

## 五、与 0.1.x 的差异（破坏性）

| 项 | 0.1.x | 0.2.0 |
|---|---|---|
| 注入 section | `memlite:context`，off-turn 缓存，命中才出现 | `memlite:rules`，静态规则，恒定出现 |
| 召回时机 | `agent/inbox/inserted` 异步预取 + `turn-stopping` 兜底刷新 | `agent/pre-step` 同步召回并注入消息 |
| 召回形态 | 80 字摘要 + 标题 | 标题 + 分数 + id8（正文用工具/命令展开） |
| 写入 | 只靠用户命令 | 显式前缀 + 模型工具 + 收尾 steer |
| 配置 | `autoInject{enabled,maxMemories,maxChars}` / `autoCapture` | `enabled` / `recallLimit` / `recallThreshold` / `budgetChars` / `minPromptChars` / `storeNudgeEvery` |
| 文件 | `cache.ts` / `prompt.ts` | 删除；新增 `rules.ts` / `messages.ts` / `state.ts` / `tools.ts` |

旧配置里的 `autoInject`、`autoCapture` 不再被读取；`recallLimit` 默认从 10 改为 5。

---

## 六、验证

- `pnpm build`：tsup ESM + d.ts 通过。
- `pnpm test`：57 例全绿，覆盖
  规则 section、pre-step 召回/去重、`/nomem`、敏感闸、显式存储 + 读回、
  状态体检、收尾 steer（含 stored / nudge=0）、五个模型工具、命令面 16 个、Obsidian、配置校验。
- 真机回归待做：在 desktop profile 里重载插件后，发一条带 `记：` 的消息确认回执，
  再用一个历史问题确认 `memlite:rules` 与召回消息进入上下文。
