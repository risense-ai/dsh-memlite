# Changelog

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
