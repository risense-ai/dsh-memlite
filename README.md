# dsh-memlite

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的持久本地记忆插件。
> 基于 [`@rsrsai/memlite`](https://github.com/risense-ai/memlite-js)，与 [respire-memlite](https://github.com/risense-ai/respire-memlite)（Rust）数据互通。

## 状态

🚧 **方案阶段**。M0（技术验证 spike）尚未启动。

## 文档

- [方案](./docs/proposal.md)——定位、配置、装配、风险
- [计划](./docs/plan.md)——M0–M5 里程碑（8 工作日）
- [集成契约](./docs/integration.md)——与 memlite-js 的依赖接口

## 特性（目标）

- 🧠 **本地记忆**：纯 BM25 / 语义嵌入 / RRF 融合三档可选
- 🌳 **因果树**：parent_id 父子链，命中即见前因后果
- 🔌 **零 tool 调用**：通过 system prompt section 在每轮拼装时注入，不占上下文
- 🔐 **密钥安全**：走 DSH credentials，永不入 cordis.yml / 数据仓
- 📦 **项目级隔离**：工作区 `.memlite/` 优先，用户级回退
- 🔄 **git 同步**：白名单 + 双通道 sha 核验，多设备/工作区共享
- 🛡️ **敏感闸**：写前扫描密码/密钥/身份证/银行卡/手机号/JWT/PEM

## 安装（待发布）

```bash
dsh plugin --profile web add @rsrsai/dsh-memlite
```

## 协议

MIT。
