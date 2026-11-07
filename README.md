# dsh-memlite

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的持久本地记忆插件。
> 基于 [`@rsrsai/memlite`](https://github.com/risense-ai/memlite-js)，与 [respire-memlite](https://github.com/risense-ai/respire-memlite)（Rust）数据互通。

## 状态

✅ **0.1.0 实现完成**（M0-M4，2026-11-07）：真机装载验证通过（dsh 0.2.2-rc.1，13 命令 + section 注册 + 配置覆盖全链路）。npm 发布与 Hub 提交待定。

## 文档

- [方案](./docs/proposal.md)——定位、配置、装配、风险、**§十三 M0 实测修订（四漂移+激活时序）**
- [计划](./docs/plan.md)——M0–M5 里程碑
- [集成契约](./docs/integration.md)——与 memlite-js 的依赖接口
- [进度](./docs/plan-progress.md)——逐项打勾的实施记录

## 特性

- 🧠 **本地记忆**：纯 BM25（默认零配置）/ openai-compatible 嵌入 / RRF 融合
- 🌳 **因果树**：parent_id 父子链，命中即见前因后果（防环 64 层）
- 🔌 **零 tool 调用**：system prompt section 每轮拼装注入——off-turn 缓存双点刷新
  （`agent/inbox/inserted` 即 recall + `turn-stopping` 保底），text 同步读缓存，永不阻塞
- 🗂️ **13 个命令**：`/memlite` `/memlite-recall` `/memlite-remember` `/memlite-show`
  `/memlite-forget` `/memlite-update` `/memlite-attach` `/memlite-tree` `/memlite-chain`
  `/memlite-sync` `/memlite-status` `/memlite-reembed` `/memlite-bench`
- 🔐 **密钥安全**：`credentials.resolve(ref)` 注入，永不入配置/数据仓/日志
- 📦 **项目级隔离**：项目级 `.memlite/` 优先，用户级回退
- 🔄 **git 同步**：白名单 + pathspec commit（不卷走用户暂存）+ sha 双通道核验
- 🛡️ **敏感闸**：写前扫描密码/密钥/身份证/银行卡/手机号/JWT/PEM，命中即拒

## 安装（待发布）

```bash
dsh plugin --profile <profile> add @rsrsai/dsh-memlite
```

本地开发装载：

```bash
pnpm -C dsh-memlite build
dsh plugin --profile <profile> add ./dsh-memlite
```

## 测试

```bash
pnpm test   # 34 例：真 cordis 核 + 形状忠实宿主服务替身（0.2.2-rc.1 权威形状）
```

## 协议

MIT。
