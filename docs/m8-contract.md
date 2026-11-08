# 聊天记忆浏览器（M8–M11）实现契约

> 对应 [proposal.md §十四](./proposal.md#十四聊天记忆浏览器m8-设计2026-11-08) 与
> [plan.md §M8](./plan.md#m8-聊天记忆浏览器5-天后续阶段)。
> 权威类型见 `src/browser-contract.ts`（本文只补行为约定）。宿主版本：**DSH 0.2.2-alpha.2**。

## 一、范围

- M8a：右侧 Memory 页签、全部记忆、搜索/筛选、游标分页、详情、复制。
- M8b：可折叠因果树（逐层加载）、因果邻居与完整链跳转。
- M8c：本次对话召回视图、注入状态、会话隔离、错误/空/中止态。
- M9a/M9b（0.5.0）：`revision` 条件写、统一回执、存入/编辑/续写/改挂/忘记、响应式列表—详情。
- M10（0.5.0）：实际注入原文、阈值/预算逐条解释、显式反馈；聊天回复内嵌入口因宿主无稳定 slot 未挂载。
- M11（0.5.0）：状态视图、同步四字段、reembed 计数、Obsidian 结构化 report。
- 不做：独立管理后台、pending 审批中心、撤销删除、永久审计、自动反馈调权、力导向图；
  不新增模型请求；不持久化检索历史；不向 UI 暴露向量、凭据、querylog、完整路径。

## 二、浏览器注册（`src/client/index.tsx`，由 Lead 集成）

```ts
// 1) 页类型（tab type）：guide 入口 + 页签标题
ctx.sidebarRightTabs.register({
  id: '@rsrsai/dsh-memlite/memory',
  kind: 'memlite-memory',
  priority: 'extension',
  title: () => t('tab.title'),
  guide: [{
    id: 'memory',
    order: 40,
    title: () => t('guide.title'),
    description: () => t('guide.description'),
    icon: MemoryGlyph,   // 本包内联 SVG 组件，不 import ui-primitives
  }],
})

// 2) 页体（body）：键=页类型 id；slot 框架把 sessionId 与 useTabInfo 等 hooks 作为 props 注入
ctx.slots.inject('sidebar.right.pane.tab', () =>
  ctx.slots.register(
    {
      name: 'sidebar.right.pane.tab',
      key: '@rsrsai/dsh-memlite/memory',
      locale: 'memliteMemory',
      inject: (sessionId: string) => ({ sessionId }),
    },
    MemliteMemoryPanel,
  ),
)
```

约束：

- 浏览器 bundle 仍只外部依赖 `react` / `react/jsx-runtime`；**不得** import
  `@deepseek-ai/*` 运行时包（`useTabInfo` 由 slot 框架作 prop 传入）。
- `sidebarRightTabs` 用 `ctx.inject(['sidebarRightTabs'], scoped => ...)` 可选注入，
  老宿主缺少该服务时配置页照常工作（导出的 `inject` 数组保持现状）。
- `package.json` 的 `dsh.client.inject` 增加 `@deepseek-ai/dsh-client-ui-sidebar-right`。

## 三、HTTP 路由（Host 半区，`src/memory-routes.ts`）

全部 `POST` + `application/json`，document-relative 路径（见 `MEMORY_BROWSER_PATHS`），
经 DSH `connection.fetch` 注册，认证/Host-Origin 信任栅栏/owner Peer 由宿主负责。
请求体 ≤ 64 KiB；所有入参做形状、长度、上限校验；响应只含白名单字段。

| 路径 | 请求 | 数据来源 | 上限 |
|---|---|---|---|
| `api/memlite/browser/list` | `MemoryListRequest` | `mem.store.all()`（主类公开 getter）+ 内存投影 | limit 1..50，游标 keyset |
| `api/memlite/browser/search` | `MemorySearchRequest` | `mem.recall`（项目「（无）」时内部过采样 `limit×4`≤100，再按 `project===''` 后置过滤） | limit 1..20，query 1..500 |
| `api/memlite/browser/show` | `MemoryShowRequest` | `mem.show(id)` + `mem.chain(id, depth)` | 正文 20k 字符，链深 ≤ 8/节点 ≤ 200 |
| `api/memlite/browser/tree` | `MemoryTreeRequest` | 内存投影（`parent_id` 逐层） | limit 1..200，单层 |
| `api/memlite/browser/session-recalls` | `MemorySessionRecallsRequest` | 插件内召回账本 | limit 1..100，账本有界 |
| `api/memlite/browser/status` | `{sessionId?,agentId?}` | `mem.status()` + `syncStatus()` + 内存回执/Obsidian 状态 | 回执 ≤50 |
| `api/memlite/browser/remember` | `MemoryRememberRequest` | `Memlite.remember` + 读回 | content 20k 字符；父存在 |
| `api/memlite/browser/update` | `MemoryUpdateRequest` | `expectedRevision` 条件写 + 读回 | 冲突 409 |
| `api/memlite/browser/attach` | `MemoryAttachRequest` | 条件改挂 + 防环 + 父链读回 | 冲突 409 |
| `api/memlite/browser/forget` | `MemoryForgetRequest` | 标题确认 + 条件删除 + 读回不存在 | 冲突 409 |
| `api/memlite/browser/recall-feedback` | `MemoryRecallFeedbackRequest` | 会话账本 feedback | 只接受账本已有 id |
| `api/memlite/browser/sync` | `{operationId?}` | `mem.sync()` | 单任务互斥；返回四字段 |
| `api/memlite/browser/reembed` | `{operationId?}` | `mem.reembed()` | 单任务互斥；只回计数 |

- 响应外壳 `MemoryApiResponse<T>`：`{ok:true,data}` / `{ok:false,error,disabled?,code?,receipt?}`。
- 写操作：成功 200；冲突 409 + `code=STALE_VERSION` + 当前安全投影；拒绝 400；失败/未确认 500。
- 写回执 `MemoryWriteReceipt`：operationId 幂等，状态 saved/saved-degraded/skipped/partial/rejected/conflict/failed/unconfirmed；
  成功后读回（id/标题/正文、父链或删除后不存在）；不虚构 pending。
- `enabled=false`：HTTP 503 + `{ok:false,error:'memlite 已禁用',disabled:true}`。
- `engine`：`MemoryRuntime` 的代次（结构性配置重建引擎后 +1），客户端据此清理失效详情。
- 不读 JSONL、不碰 `mem.store` 内部文件；所有过滤/投影在 Host 内存里完成。
- 错误文案不含路径/密钥/原始请求内容（`id` 回显除外，且截断）。

## 四、召回账本（`src/recall-ledger.ts` + `src/index.ts`）

- 结构：`MemorySessionRecall`（见 contract，含 injectedText/threshold/budgetChars/usedChars/limit/elapsedMs/feedback）；
  按 `sessionId`（取不到时按 `agentId` 明示降级）
  分桶，内存常驻、插件重载即清空。
- 注入状态与 `selectRecallTitles()` **同一份结果**：该函数同时返回渲染文本与
  `hits[].exclusion`（`threshold`/`budget`），`index.ts` 在 `decision.messages` 成功追加
  （或确认本轮无需追加）后写账本；中止/`reject` 不写成功记录。
- `status`：`ok`（召回成功且**有命中**；是否真正注入看 `hits[].injected`/`exclusion`，
  因此「有命中但全部低于阈值」也是 `ok` + 逐条 `threshold`，UI 用徽章区分而不冒充已注入）、
  `empty`（召回零命中）、`skipped`（/nomem、短提示词、敏感闸、显式存储、disabled）、`error`（recall 抛错）。
- 容量：单会话 ≤ 100 条、全局 ≤ 500 条（LRU 淘汰最旧）；单条 hits ≤ 50。
- `agent/disposed` 清理该 agent/会话的账本。
- 不保存原始提示词、不保存 querylog。

## 五、前端组件（`src/client/`）

| 文件 | 归属 | 内容 |
|---|---|---|
| `src/client/memory-api.ts` | client-ui | 路由客户端：`fetch` + 响应形状校验 + AbortSignal |
| `src/client/MemliteMemory.tsx` | client-ui | 面板：三视图 + 列表/详情/树 + 状态机 |
| `src/client/memory-locales.ts` | client-ui | `memliteMemory` zh/en 字典 |
| `src/client/index.tsx` | Lead | 注册页类型/页体/locale 命名空间 |
| `src/client/locales.ts` | Lead | 配置页字典，不动 |

组件 props（Lead 的注册代码与 client-ui 约定）：

```ts
export interface MemoryPanelProps {
  t: (key: string, params?: Record<string, unknown>) => string
  /** 当前会话 id（slot inject 注入；缺省时“本次对话”显示不可用） */
  sessionId?: string
  /** slot 框架注入的 hooks（防御式读取，不依赖其内部形状） */
  useTabInfo?: () => unknown
  /** 测试注入；缺省用 document-relative fetch */
  api?: MemoryApi
}
```

视图与状态要求：

1. **本次对话**：按 `turn` 分组（回合倒序）；每条记忆显示标题、注入状态徽章
   （已注入/低于阈值/预算截断）、分数、后端与时间；`status=error` 显示失败回执；
   `exists=false` 显示“原记忆已删除”；无活动时简洁空态；刷新按钮。
2. **全部记忆**：搜索框（标题/正文/标签，走 search 路由）、项目/标签/重要性筛选、
   最近排序、游标“加载更多”；列表只显示标题 + 两行摘要 + 必要徽章；
   选中后读 `show` 显示全文（纯文本 `white-space: pre-wrap`，**禁止 dangerouslySetInnerHTML**）、
   元数据、因果邻居（可点）、复制正文 / 复制 id。
3. **因果树**：根层开始，逐层展开（点击展开子层，走 tree 路由 parentId），
   可折叠缩进树；点击节点打开详情；显示断链/环截断提示（节点 childCount/leaf）；
   首版不做力导向图；窄栏不得横向溢出（`overflow-wrap:anywhere`、文本截断）。
4. 公共：加载中、空库、无命中、禁用（503/`disabled`）、失败、请求中止（AbortController）、
   记忆已删除；刷新；页头只读状态；不用红色（仅删除类才红）。
5. 主题：只用 `var(--dsw-*)` 变量 + `font: inherit`，不引入样式表；与配置页视觉一致。
6. 请求生命周期：切换视图/会话/刷新时 abort 旧请求；卸载 abort；引擎代次变化清详情。

## 六、测试要求

- `tests/memory-routes.test.ts`：只读路由注册（5 条）、list 筛选/分页/上限、
  search、show（含 deleted）、tree 逐层与上限、session-recalls 隔离/上限/注入状态、
  入参守卫、禁用 503、响应不含 content（列表）与敏感字段。
- `tests/recall-ledger.test.ts`（Lead）：容量、LRU、drop、注入状态与 render 一致。
- `tests/client-memory.test.ts`（client-ui）：api 形状校验；面板 SSR：
  加载/空/错误/列表/详情/树/本次对话徽章；注册契约（kind/key/guide/locale）。
- 全量 `pnpm typecheck`、`pnpm test`、`pnpm build` 由 Lead 收口。

## 七、验收对照（proposal §14.6）

- [x] 右侧 Memory：浏览/筛选/检索/翻页/全文/复制均无需命令
- [x] 空库/无命中/禁用/引擎失败/中止/已删除均有可理解状态，无无限加载
- [x] 项目/会话/agent 不串数据；配置切换后不读旧引擎/旧正文
- [x] 树展开/收起/父子跳转/断链环截断；窄栏无横向溢出
- [x] 已注入/未注入有测试对照，候选不得显示为已使用
- [x] 响应不含向量/凭据/querylog/完整路径；未认证沿用宿主拒绝
- [x] 既有召回/命令/配置/Obsidian 不回归；浏览不新增模型请求
- [x] `pnpm typecheck`、`pnpm test`、`pnpm build`；真机验收另行记录

## 八、实现偏差与真机实测记录（2026-11-08）

### 与初版契约的偏差（已落地，均以代码 + 测试固化）

| 项 | 初版 | 最终实现 | 原因 |
|---|---|---|---|
| `MemorySessionRecall.timestamp` | 未注明单位 | **秒级**（`Math.floor(Date.now()/1000)`），UI ×1000 渲染 | 与 `MemRecord.ts` 同口径；曾按毫秒存导致界面显示 `58822-11-28`（真机 UI 验收发现，已修） |
| `MemorySearchItem.score` / `MemorySessionHit.score` | 0..1 | **召回原始分数**（BM25 可 >1，如 5.473），仅非负截断 | 上限截断会把 5.47 与 1.0 都显示成 1.000，失去区分度；`injected` 判定走 `exclusion`，不依赖分数比较 |
| 引擎异常状态码 | 503 | **500**；503 仅用于 `enabled=false` + `disabled:true` | 客户端把 503 一律当「已禁用」，引擎临时故障会被误判成禁用且不给重试 |
| `search` 的项目「（无）」 | 与「全部项目」同义 | **后置过滤**：内部过采样 `limit×4`（≤100）后只留 `project===''` | memlite 的 `project:''` 语义是不过滤，无法表达「只要无项目」 |
| 项目筛选下的树 `childCount` | 回退全库计数 | 只用**筛选集内**子条数 | 否则父节点显示有子条、展开为空（假断链） |
| 时间显示时区 | 未定 | **浏览器本地时区**（`formatTimestamp(ts, 'local')`；测试可传 `'utc'`） | UTC 与旁边聊天时间差 8 小时，用户易误读 |
| 请求体上限 | 字符数 | **UTF-8 字节数**（`Buffer.byteLength`） | 按 UTF-16 码元会低估中文 3 倍 |

### 测试有效性（避免假绿）

- `threshold` 用例改为**双种对照**：强命中（BM25≈2.95）+ 弱命中（≈0.18），断言「至少一条注入、至少一条 `exclusion=threshold` 且未注入」。
- `budget` 用例：`budgetChars=200` + 超长标题，断言出现 `exclusion=budget`。
- 时间戳回归：断言量级为秒（`<4e9`）且 ×1000 后年份在 2024–2100。
- 客户端状态判别：503 无 `disabled` → 可重试失败；非 JSON → 非禁用。

### 真机实测（DSH Web 0.2.2-alpha.2，隔离实例）

- 隔离实例：`DSH_HOME=/tmp/dsh-m8-home` + `MEMLITE_DATA=/tmp/m8-data`（种子 11 条，含因果链/多项目/无项目），`dsh plugin add .` link 本地构建。
- 登录态 `POST api/memlite/browser/{list,search,show,tree,session-recalls}` 全部 200；未认证 401；跨站 Origin 403；`plugins/??@rsrsai/dsh-memlite/client.js` 200 且为 ModuleLoader factory。
- headless Chrome + CDP 驱动：Guide 卡片「记忆浏览器」→ 页签「记忆」→ 三视图；发一条 `nginx 504` 消息后「本次对话」出现「已召回 / 已注入 / 分数 5.473·2.056·2.013 / 后端 bm25 / 2026-11-08 02:37」；
  「全部记忆」项目筛选「（无）」得 2 条；详情显示全文/元数据/子条/完整链/复制按钮；因果树根层 7 节点、展开后加载子层；页面无异常。
- 截图：`docs/images/memory-session.png`、`memory-all.png`、`memory-tree.png`。
- 未覆盖：Desktop 载体的手动交互（与 Web 共用 bundle）；真实模型凭据下的正常完成回合（本轮 LLM 仍会先召回再因缺凭据失败，不影响面板链路）。
