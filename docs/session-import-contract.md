# DSH 会话历史导入 — 实现契约（0.7.0）

> 本文件是 `dsh-memlite` 新增「从插件宿主的 DSH 导入历史会话」的唯一契约。
> 三个并行工作流的文件边界、函数签名、字符串格式、去重语义都在这里锁定；实现与测试以本文件为准。
> 契约变更必须先改本文件，再改代码。

---

## 一、目标与范围

把宿主 DSH 落盘的会话历史（`~/.dsh/sessions/<cwd 编码>/<session-id>/session.v4.jsonl.zstd`）
转成 memlite 记忆，供后续召回。与 Obsidian 桥同构：

- 读源：会话 zip（zstd）→ 逐行 JSON 事件流；
- 抽取候选：显式记忆（会话里真的存过的）、会话摘要（每个会话一条）、可选的用户事实；
- 去重：按稳定锚 + 内容 hash 幂等；dry-run 出报告；单条失败不阻塞整批；
- 写库：复用调用方的常驻 `Memlite` 实例与敏感闸，不另开实例。

非目标（本版不做）：实时同步、增量 tail、跨会话事实合并/改写、远端 DSH 会话。

## 二、文件边界（谁写谁的文件）

| 归属 | 文件 |
| --- | --- |
| Lead | `docs/session-import-contract.md`、`src/session-import/types.ts`、`src/session-import/index.ts` |
| session-core | `src/session-import/reader.ts`、`extract.ts`、`importer.ts`、`report.ts`、`tests/session-import-core.test.ts`、`tests/session-import.smoke.test.ts` |
| session-wiring | `src/session-import/routes.ts`、`src/commands/session.ts`、`src/commands/index.ts`、`src/index.ts`、`src/http.ts`、`src/obsidian.ts`、`tests/session-routes.test.ts`、`tests/commands/session.test.ts`，以及既有计数断言的更新（`tests/commands.test.ts`、`tests/commands/obsidian.test.ts`、`tests/obsidian-routes.test.ts`） |
| session-ui | `src/client/session-import-panel.tsx`、`src/client/MemliteSettings.tsx`、`src/client/locales.ts`、`tests/client-session-import.test.ts`、`README.md`、`CHANGELOG.md`、`package.json`、`docs/integration.md` |

不要碰别人的文件；需要契约外的改动先发消息给 Lead。

## 三、源格式（实测）

目录（实测两层）：`<sessionsRoot>/<cwd 编码>/<session-id>/session.v4.jsonl.zstd`，`sessionsRoot` 默认 `~/.dsh/sessions`。
也兼容更浅的一层 `<sessionsRoot>/<session-id>/session.v4.jsonl.zstd`（测试/旧布局）——扫描深度 ≤2。
文件名候选（同一目录按顺序取第一个存在的）：
`session.v4.jsonl.zstd`、`session.v4.jsonl.gz`、`session.v4.jsonl`、`session.jsonl.zstd`。

解压：按魔数判断 —— zstd `28 b5 2f fd`、gzip `1f 8b`，否则当明文 UTF-8。
zstd 用 `node:zlib.zstdDecompressSync`（Node ≥ 22.15/24）；运行时没有该函数时抛错：
`当前 Node 不支持 zstd 解压（需要 Node 22.15+）：<path>`。
读完按 `\n` 切行，空行跳过，`JSON.parse` 失败的行计入 `badLines`（不抛错）。

事件（逐行 JSON）关键字段：

- 首行 `{"type":"session","version":4,"id":"session-…","createdAt":<ms>,"cwd":"/abs/path"}`
  —— **元数据在事件顶层**（不在 `data` 里；实现两处都读，兼容测试夹具）；
- 人类消息：`{"type":"user/message","seq":N,"time":<ms>,"data":{"role":"user","source":{"kind":"user"},"id":"…","content":[{"type":"text","text":"…"}]}}`
  —— 只认 `data.role==='user'` 且 `data.source.kind==='user'`；`agent/inbox/spliced` 里的是同一批消息的副本，**忽略**；
- 会话标题：`{"type":"session/title","data":{"title":"…"}}`（可能多次，取最后一次非空）；
- 工具调用：`{"type":"tool/call","seq":N,"time":<ms>,"data":{"name":"memlite_remember","arguments":"<JSON 字符串>"}}`；
- 命令：`{"type":"command/run","data":{"name":"memlite-remember","args":"<rawInput>"}}`；
- 其余事件（system/assistant/tool/result/step/turn/job/approval/request…）一律不进候选。

## 四、公开模块面（`src/session-import/index.ts`）

Lead 已写好 `types.ts` 与 barrel；session-core 只实现下列函数，签名与类型不得改：

```ts
// reader.ts
export function resolveSessionsRoot(raw?: unknown): string
export function listSessionFiles(root: string): DshSessionFile[]          // mtime 降序
export function readSessionEvents(file: DshSessionFile): DshSessionEvent[]
export function parseSession(file: DshSessionFile): DshSession
export function listDshSessions(options?: SessionListOptions): DshSessionOverview[]

// extract.ts
export function extractCandidates(
  session: DshSession,
  options: { explicit: boolean; summary: boolean; facts: boolean; project?: string },
): SessionCandidate[]

// importer.ts
export function importDshSessionsWith(
  mem: import('@rsrsai/memlite').Memlite,
  options?: SessionImportOptions,
): Promise<SessionImportReport>

// report.ts
export function formatSessionImportReport(report: SessionImportReport, dryRun: boolean): string
export function formatSessionList(overviews: DshSessionOverview[], root: string): string
```

类型全部来自 `./types`（已存在）：`DshSessionFile`、`DshSessionEvent`、`DshSession`、
`DshSessionText`、`DshSessionExplicit`、`SessionCandidate`、`SessionCandidateKind`、
`SessionImportOptions`、`SessionListOptions`、`SessionImportReport`、`SessionImportSkip`、
`DshSessionOverview`。

## 五、校验与选择语义

`resolveSessionsRoot(raw)`：缺省 `path.join(os.homedir(), '.dsh', 'sessions')`；
支持 `~` / `~/` 展开；非字符串/空串/NUL/超长（>1000）→ `TypeError`；最后 `path.resolve`。
本函数**不**要求目录存在。

`listSessionFiles(root)`：目录不存在或不是目录 → `Error('会话目录不存在: ' + root)`。
扫描深度 ≤2（root 本身 / `root/<session>` / `root/<cwd 编码>/<session>`）；
返回按 `mtimeMs` 降序；`sessionId` 取文件所在目录名（`session-…` 或裸 uuid）。

会话过滤（`listDshSessions` 与 `importDshSessionsWith` 共用，建议放 reader 导出内部函数也行，
但公开面只以上述签名为准）：

- `sessionId`：等于全 id 或前缀匹配；
- `cwd`：`path.resolve(cwd)` 与 `session.cwd` 精确相等，**或**等于目录编码
  `'--' + cwd.slice(1).replace(/\//g, '-') + '--'`；
- `since`：ISO 字符串或数字；数字 > 1e12 当毫秒，否则当秒；比较 `max(createdAt, mtimeMs)`；
- `limit`：过滤后取**最新** N 个会话（默认 20，硬上限 200），再按 `createdAt` **升序**交给导入
  （摘要先写，保证因果父条先存在）。

`parseSession`：
- `id` = session 事件 `id`，缺失用 `file.sessionId`；
- `cwd` = session 事件 `cwd`，缺失 `''`；
- `createdAt` = session 事件 `createdAt`（ms），缺失第一行有效事件 `time`，再缺 `file.mtimeMs`；
- `updatedAt` = 最后一条带 `time` 的事件（ms）；
- `title` = 最后一条非空 `session/title`；`userTexts` 按 `messageId` 去重、保序；
- `explicit` 见第六节；`stats = { lines, badLines, events }`；`warnings` 放解析级告警
  （坏行数、无法解析的 explicit 参数等，一条会话最多 5 条）。

## 六、候选抽取

### 6.1 显式记忆（kind `explicit`，默认开）

三路来源，任一命中即候选，同会话内按 `title + '\n' + content` 去重（保留最早 seq）：

1. `tool/call`：`name === 'memlite_remember'`，`arguments` 解析 JSON 取 `content`（必需字符串）、
   `title`（可选）、`tags`（数组或逗号串，可选）；
2. `command/run`：`name === 'memlite-remember'`，用 `parseArgs`/`flagString`（从 `../args` 引）
   解析 `args`：`rest` 为 content，`--title`、`--tags`；
3. `user/message` 文本匹配 `STORE_PREFIX`（从 `../rules` 引）：剥前缀后为 content，标题用
   与插件 `titleOf` 等价的首句截断（≤ 60 字符）。

标题规则：显式 title 优先；否则 content 按 `[。！？!?\n]` 取首句，trim 后 ≤ 60 字符；
再空则 content 截 60。tags：`['dsh-session', 'explicit', ...显式 tags]` 去重去空。
`ts` = 事件 `time/1000`；缺失用 `session.createdAt/1000`；再缺 `file.mtimeMs/1000`（向下取整到秒）。

### 6.2 会话摘要（kind `session-summary`，默认开）

每个**至少有一条人类消息**的会话一条；无人类消息的会话跳过（不产生候选、不算错误）。
`title`：`DSH 会话：<session.title>`（截 60）；无标题用
`DSH 会话 <YYYY-MM-DD HH:mm>（<project 或 '未标注项目'>）`。`project` =
`options.project` 优先，否则 `path.basename(session.cwd)`，都空则 `''`。
`tags = ['dsh-session', 'session']`；`ts = session.createdAt/1000`（缺失回退规则同上）。
`content`（逐行，`<project>` 为 project 或 `未标注项目`，`<date>` 为本地 `YYYY-MM-DD`）：

```
【前因】DSH 历史会话：<project>，<date>，<N> 条人类消息。
【行为】主要请求：
- <前 8 条人类消息，各取首行并截 80 字符，前缀「- 」>
【后果】会话标题「<title>」；source=dsh-session（<sessionId 前 12>）。
```

标题缺失时 `【后果】` 写成 `source=dsh-session（<sessionId 前 12>）。`；人类消息 > 8 条时
在列表末尾补一行 `- …另 <k> 条`。

### 6.3 用户事实（kind `user-fact`，默认关，`--facts` 开）

从人类消息抽「看起来是可复用约定」的句子，供用户显式开启：
长度 10–800；不以 `/` 开头；不匹配 `STORE_PREFIX`；不以 `？`/`?` 结尾；
匹配 `/(决定|约定|以后|默认|必须|不要|别用|禁止|务必|记住|注意|要求|偏好|统一|只用|改用|优先|不能|应该)/u`。
`title` 同 6.1 首句规则；`content` 为原文（trim，最长 800）；
`tags = ['dsh-session', 'user-fact']`；`ts` = 消息时间/1000。

### 6.4 锚与元数据（所有候选）

- `anchor`：`dsh:<sessionId>:<kind>:<key>`，`kind ∈ {explicit,user-fact,summary}`；
  `key` = 事件 `seq`（有限数）否则 `data.id`（字符串）否则该来源内递增序号。
- `extra`（平铺进 memlite 记录，不要放绝对路径）：

```json
{
  "source": "dsh-session",
  "dsh_anchor": "<anchor>",
  "dsh_session_id": "<sessionId>",
  "dsh_kind": "explicit|session-summary|user-fact",
  "source_hash": "<sha1(title + '\\n' + content) 的 40 位小写 hex>",
  "dsh_project": "<project，可为空串>"
}
```

`dsh_kind` 取 `SessionCandidateKind` 原值（`session-summary` 不简写）。可选追加
`dsh_event_seq`（数字，seq 可用时）、`dsh_messages`（摘要候选 = 人类消息数）。

## 七、导入与去重（`importDshSessionsWith`）

流程：过滤会话 → 逐个 `parseSession` → `extractCandidates` → 逐候选写库。

去重顺序（`findExisting`）：

1. 同 `extra.source === 'dsh-session'` 且 `extra.dsh_anchor === anchor`；
2. `extra.source_hash === <候选 hash>`（不限 source；覆盖「宿主当年已自动存过、但没有导入元数据」）；
3. 都没有 → 新建。

命中处理：hash 相同 → `unchanged++`；hash 不同 → `mem.update(hit.id, { title, content, tags, project, extra })`
并 `updated.push(hit.id)`（extra 按键合并，锚不丢）。新建 → `mem.remember(title? 一并传, ...)`：

```ts
await mem.remember(candidate.content, {
  title: candidate.title,
  tags: candidate.tags,
  project: candidate.project,
  ts: candidate.ts,
  extra: candidate.extra,
  parent: <同会话摘要 id> | undefined,
})
```

父子：同一会话里若摘要候选已解析出真实 id（新建或命中），其 explicit/user-fact 候选
`parent` 指向该 id；摘要本身是根。dry-run 下没有真实 id，`parent` 一律不比较、不写入。

敏感闸：写前对 `title + '\n' + content` 调 `mem.scanOrReject`，抛错 → 记
`skipped: { anchor, reason: 'sensitive', detail }`（detail 用 `error.message`），继续下一条。
敏感闸检查在 dry-run 分支之前：预览也如实报告“这条会被拒绝”（会话摘要会摘录人类消息，
因此摘要可能因摘录中含敏感句而被整条跳过——安全优先）。
`mem.remember`/`update` 抛错 → `{ anchor, reason: 'write-error', detail }`，继续。
content 为空 → `{ anchor, reason: 'empty' }`。

`report` 汇总：`sessionsScanned`（实际解析的会话数）、`sessionsSkipped`（解析失败/坏文件）、
`events`（所有已解析会话的 `stats.events` 之和）、`candidates`（候选总数）、
`created`/`updated`（id 数组）、`unchanged`、`skipped`、`warnings`（会话级 + 解析级，去重后）、
`wouldCreate`/`wouldUpdate`（正式模式等于 created/updated 长度）。

dry-run：不写库；新建候选记 `wouldCreate++`；命中且 hash 不同记 `wouldUpdate++`；
摘要候选在 dry-run 时给子候选一个占位（不写库、也不参与 parent 比较）。
`onProgress(done, total, label)` 每处理完一个会话调用一次。

幂等：同一批会话连导两次，第二次应 `created=0, updated=0, unchanged=候选数`（summary 也算 unchanged）。

## 八、报告文本（`report.ts`，测试会断言中文子串）

`formatSessionImportReport(report, dryRun)`，逐行 join('\n')：

```
[dry-run] 扫描 <S> 个会话（跳过 <K>）/ <E> 条事件：候选 <C> 条 → 将新建 <WC>，将更新 <WU>，不变 <U>，跳过 <SK>
确认无误后去掉 --dry-run（配置页取消“仅预览”）再执行正式入库。
```

正式模式第一行去掉 `[dry-run] ` 前缀与确认行，`将新建/将更新` 换成 `新建/更新`，
数字取 `created.length` / `updated.length`。`skipped.length > 0` 时追加一行：
`跳过明细：sensitive <a> / empty <b> / write-error <c>`（只列非 0 项）。
`warnings.length > 0` 时追加 `警告 <N> 条：` + 最多 5 行 `  - <warning>` +（超出时）`  …另 <k> 条`。

`formatSessionList(overviews, root)`：

```
发现 <N> 个会话（根：<root>）：
- <YYYY-MM-DD HH:mm> · <project 或 未标注项目> · <messages> 条人类消息 / <explicit> 条显式记忆 · <title 或 无标题>
```

最多 30 行，超出追加 `…另 <k> 个会话`；空列表输出 `未发现会话（根：<root>）。`。
`project` 由 `cwd` basename 推导。

## 九、HTTP 路由（`src/session-import/routes.ts`，session-wiring 写）

- `POST /api/memlite/session/import`（buffered JSON）
- `POST /api/memlite/session/list`（buffered JSON）
- 与 Obsidian 桥同款：`connection.fetch.register`、`HttpError` 400/409/413、单任务互斥
  （两路由共享一个 busy 锁，冲突回 `HttpError(409, '另一个会话导入操作尚未完成，请稍后再试')`）；
  handler 内 `try/catch`：`HttpError` 原样，其余 Error → 400 安全文案；
  响应体 `{ ok: true, text, report? }`（失败 `{ ok: false, error }`）。
- `ConnectionService`/`FetchRoute` 两个类型从 `src/obsidian.ts` 提到 `src/http.ts`
  （obsidian.ts 改为从 http.ts 引入并 re-export，保持既有导入不破）。
- 请求体字段（全部可选，类型校验用 http.ts 的 `optionalString/optionalBoolean/optionalInteger`）：
  `root`、`cwd`、`project`、`sessionId`（字符串）；`limit`（整数）；`since`（字符串或数字）；
  `explicit`、`summary`、`facts`、`dryRun`（布尔）。
- `SESSION_CLIENT_PATHS = { import: 'api/memlite/session/import', list: 'api/memlite/session/list' }`
  （document-relative，浏览器半区用）。
- import 的 `report` 字段：`dryRun,sessionsScanned,sessionsSkipped,events,candidates,created,updated,unchanged,skipped,warnings,wouldCreate,wouldUpdate`（数字/数组）。
- list 的 `report`：`{ sessions: <N> }`。

## 十、命令面（`src/commands/session.ts`）

单 token 名（宿主正则 `/^[a-z][a-z0-9_-]*$/`）：

- `memlite-session-import`
  `用法：/memlite-session-import [--root P] [--cwd P] [--project P] [--session ID] [--limit N] [--since ISO] [--no-explicit] [--no-summary] [--facts] [--dry-run]`
- `memlite-session-list`
  `用法：/memlite-session-list [--root P] [--cwd P] [--session ID] [--limit N] [--since ISO]`

语义：`explicit = !flagBool('no-explicit')`、`summary = !flagBool('no-summary')`、
`facts = flagBool('facts')`；`--limit` 用 `flagNumber`；成功返回 `ok(format…)`，异常 `fail(message)`。
命令注册进 `src/commands/index.ts` 的 `commandDefinitions` 末尾（放在 `...obsidianCommandDefinitions(mem)` 之后）。

注册后总数：**18** 条命令；`connection.fetch` 路由总数：**18** 条（16 + 2）。
既有断言需同步更新：`tests/commands/obsidian.test.ts`（16→18）、
`tests/obsidian-routes.test.ts`（16→18）、`tests/commands.test.ts` 的 expected 列表加两条
（其 `expected.length` 断言自动生效）。

## 十一、配置页（session-ui 写）

- 新组件 `src/client/session-import-panel.tsx`：props `{ t: (key: string, params?: Record<string, unknown>) => string }`；
  视觉复用 `MemliteSettings.tsx` 里的卡片/输入/按钮样式常量（如需导出可把样式抽到新组件内联复制，
  不要大改既有样式导出面）。
- 字段（localStorage 记住，前缀 `memlite.sessionImport.`）：`root`、`cwd`、`project`；
  勾选项：`explicit`（默认开）、`summary`（默认开）、`facts`（默认关）、`dryRun`（默认关）。
  按钮：「列出会话」（POST list）、「预览导入」（import + dryRun:true）、「导入」。
  结果显示为等宽 pre-wrap 文本块，请求失败显示错误文案。
- 挂进 `MemliteSettings.tsx`：在 Obsidian 桥分组之后新增分组
  `groupSessionImport` / 标题与说明走 `t('…')`；组件放同一表单页。
- 字典 `src/client/locales.ts` 的 zh/en 各加键（键名固定，中英都必需）：
  `groupSessionImport`、`sessionImportIntro`、`sessionRoot`、`sessionRootHint`、`sessionCwd`、
  `sessionCwdHint`、`sessionProject`、`sessionProjectHint`、`sessionExplicit`、`sessionExplicitHint`、
  `sessionSummary`、`sessionSummaryHint`、`sessionFacts`、`sessionFactsHint`、`sessionDryRun`、
  `sessionDryRunHint`、`sessionList`、`sessionPreview`、`sessionRun`、`sessionBusy`、
  `sessionRequestFailed`。
- 客户端**不要** import 服务端模块（`session-import/` 会拉 `node:zlib`），路由字符串直接写字面量。
- 客户端 bundle 由 Lead 最后 `pnpm build` 统一产出；session-ui 不跑 build、不改 `dist/`。
- 测试 `tests/client-session-import.test.ts`：用 `renderToStaticMarkup` 渲染面板/页面，
  断言分组标题、按钮、勾选项存在；用假 `t` 或真字典均可（参考 `tests/client-page.test.ts`）。

## 十二、文档与发布（session-ui 写）

- `README.md`：在「Obsidian 桥（GUI）」之后加「DSH 会话历史导入（GUI）」小节：
  能力、三个来源、dry-run 与幂等、命令用法、隐私（只读本机会话、不写绝对路径进记忆、
  敏感内容被敏感闸跳过）、Node zstd 要求。
- `CHANGELOG.md`：新增 `## 0.7.0 (2026-11-10)` 条目（新增能力、命令、路由、UI、测试数）。
- `package.json`：`version` → `0.7.0`。
- `docs/integration.md`：补一节「DSH 会话导入：使用的宿主事件格式与 memlite 写入 API」
  （不新增依赖）。

## 十三、验证

每个工作流自测：

```bash
cd /Users/zhangwen/projects/risense/dsh-memlite
pnpm typecheck          # tsc --noEmit
pnpm vitest run tests/<本工作流测试>   # 单跑自己的测试
```

Lead 最终统一：`pnpm build && pnpm test`，并用真实 `~/.dsh/sessions` 跑一次
`MEMLITE_REAL_SESSIONS=1 pnpm vitest run tests/session-import.smoke.test.ts`（只读 dry-run，必须不写库）。
基线：14 个测试文件 / 198 例全绿。本次交付实测：19 个测试文件（含 1 个默认跳过的真机 smoke）/
256 例（255 绿 + 1 skipped）；`MEMLITE_REAL_SESSIONS=1` 时真机 smoke 亦绿。
