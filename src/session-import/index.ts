/**
 * DSH 会话历史导入：模块 barrel（公开面锁定在 docs/session-import-contract.md）。
 *
 * 服务端（命令/HTTP 路由/测试）只从这里取符号；浏览器半区不得 import 本目录。
 * 类型集中在 ./types，实现文件由 session-core 提供：
 * - reader.ts   ：根目录解析、文件发现、解压解行、会话解析、会话清单
 * - extract.ts  ：显式记忆 / 会话摘要 / 用户事实 → SessionCandidate
 * - importer.ts ：去重 + 写库（dry-run 只报告）
 * - report.ts   ：命令与配置页共用的中文报告文本
 */
export {
  listDshSessions,
  listSessionFiles,
  parseSession,
  readSessionEvents,
  resolveSessionsRoot,
} from './reader'
export { extractCandidates } from './extract'
export { importDshSessionsWith } from './importer'
export { formatSessionImportReport, formatSessionList } from './report'
export type {
  DshSession,
  DshSessionEvent,
  DshSessionExplicit,
  DshSessionFile,
  DshSessionOverview,
  DshSessionParseStats,
  DshSessionText,
  SessionCandidate,
  SessionCandidateKind,
  SessionImportOptions,
  SessionImportReport,
  SessionImportSkip,
  SessionListOptions,
} from './types'
