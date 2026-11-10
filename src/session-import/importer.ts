/**
 * DSH 会话 → memlite 的导入流水线（契约第七节）。
 *
 * 流程：collectSessions（过滤 + 解析）→ extractCandidates → 逐候选三级去重写库：
 *   1. `extra.dsh_anchor` 命中（本插件导入过的同一条）；
 *   2. `extra.source_hash` 命中（宿主当年自动存过、或其它来源的等价内容）；
 *   3. 都没有 → 新建。
 *
 * 幂等：同一批会话连导两次，第二次应全部 unchanged（摘要也算）。
 * 因果：同一会话的显式记忆与用户事实挂到该会话摘要之下，摘要为根。
 * dry-run 只统计 writeCount，不写库、不比较 parent。
 */
import { createHash } from 'node:crypto'
import { parentId as recordParentId } from '@rsrsai/memlite'
import type { Memlite } from '@rsrsai/memlite'
import { extractCandidates } from './extract'
import { collectSessions } from './reader'
import type {
  DshSession,
  SessionCandidate,
  SessionImportOptions,
  SessionImportReport,
} from './types'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

/** 已落库记录的只读镜像：内容用于 hash 比较，parent 用于幂等地挂因果父。 */
interface KnownRecord {
  id: string
  title: string
  content: string
  parentId: string
}

interface ExistingIndex {
  records: Map<string, KnownRecord>
  byAnchor: Map<string, string>
  byHash: Map<string, string>
}

/** 一次导入开始时的库快照索引（导入期间新建/更新的记录同步回索引，避免批内重复）。 */
function buildIndex(mem: Memlite): ExistingIndex {
  const records = new Map<string, KnownRecord>()
  const byAnchor = new Map<string, string>()
  const byHash = new Map<string, string>()
  for (const record of mem.snapshot().all()) {
    records.set(record.id, {
      id: record.id,
      title: record.title,
      content: record.content,
      parentId: recordParentId(record),
    })
    const hash = sha1(`${record.title}\n${record.content}`)
    if (!byHash.has(hash)) byHash.set(hash, record.id)
    const anchor = record.extra['dsh_anchor']
    if (record.extra['source'] === 'dsh-session' && typeof anchor === 'string' && anchor !== '') {
      if (!byAnchor.has(anchor)) byAnchor.set(anchor, record.id)
    }
  }
  return { records, byAnchor, byHash }
}

function candidateHash(candidate: SessionCandidate): string {
  const value = candidate.extra['source_hash']
  return typeof value === 'string' && value !== '' ? value : sha1(`${candidate.title}\n${candidate.content}`)
}

/** 补锚/改挂后同步索引。 */
function rememberInIndex(
  index: ExistingIndex,
  id: string,
  candidate: SessionCandidate,
  parent: string | undefined,
): void {
  const hash = candidateHash(candidate)
  index.records.set(id, {
    id,
    title: candidate.title,
    content: candidate.content,
    parentId: parent ?? '',
  })
  index.byAnchor.set(candidate.anchor, id)
  index.byHash.set(hash, id)
}

function rehashInIndex(index: ExistingIndex, id: string, candidate: SessionCandidate): void {
  const old = index.records.get(id)
  if (old !== undefined) {
    for (const [hash, hit] of index.byHash) {
      if (hit === id) index.byHash.delete(hash)
    }
  }
  rememberInIndex(index, id, candidate, old?.parentId === '' ? undefined : old?.parentId)
}

function skipped(
  report: SessionImportReport,
  candidate: SessionCandidate,
  reason: 'sensitive' | 'empty' | 'write-error',
  detail?: string,
): void {
  const item: { anchor: string; reason: typeof reason; detail?: string } = {
    anchor: candidate.anchor,
    reason,
  }
  if (detail !== undefined) item.detail = detail
  report.skipped.push(item)
}

/**
 * 单候选写入。返回真实 id（用于同会话后续候选的 parent）；
 * dry-run、跳过或失败时返回 undefined。
 */
async function writeCandidate(
  mem: Memlite,
  candidate: SessionCandidate,
  parent: string | undefined,
  dryRun: boolean,
  index: ExistingIndex,
  report: SessionImportReport,
): Promise<string | undefined> {
  const content = candidate.content.trim()
  if (content === '') {
    skipped(report, candidate, 'empty')
    return undefined
  }
  const probe = `${candidate.title}\n${content}`
  const hash = candidateHash(candidate)

  const anchorHit = index.byAnchor.get(candidate.anchor)
  const hashHit = index.byHash.get(hash)
  const hitId = anchorHit ?? hashHit
  if (hitId !== undefined) {
    const known = index.records.get(hitId)
    const same = known !== undefined && sha1(`${known.title}\n${known.content}`) === hash
    if (same) {
      // 内容不变：只补导入元数据与因果父（都是幂等操作，不计入 updated）
      if (!dryRun && known !== undefined) {
        if (!index.byAnchor.has(candidate.anchor)) {
          try {
            await mem.update(hitId, { extra: candidate.extra })
            index.byAnchor.set(candidate.anchor, hitId)
            known.title = candidate.title
            known.content = content
          } catch {
            // 补锚失败不影响“内容未变”的事实；下次导入会再试
          }
        }
        if (parent !== undefined && known.parentId !== parent) {
          try {
            mem.attach(hitId, parent)
            known.parentId = parent
          } catch {
            // 改挂失败保持原父指针；不阻断导入
          }
        }
      }
      report.unchanged++
      return hitId
    }

    // 敏感闸先于分叉：dry-run 也要如实报告“这条会被敏感闸拒绝”，预览才有意义。
    try {
      mem.scanOrReject(probe)
    } catch (error) {
      skipped(report, candidate, 'sensitive', errorText(error))
      return undefined
    }
    if (dryRun) {
      report.wouldUpdate++
      return undefined
    }
    try {
      await mem.update(hitId, {
        title: candidate.title,
        content,
        tags: candidate.tags,
        project: candidate.project,
        extra: candidate.extra,
      })
      rehashInIndex(index, hitId, candidate)
      if (parent !== undefined && index.records.get(hitId)?.parentId !== parent) {
        try {
          mem.attach(hitId, parent)
          const record = index.records.get(hitId)
          if (record !== undefined) record.parentId = parent
        } catch {
          // 改挂失败不阻断导入
        }
      }
      report.updated.push(hitId)
      return hitId
    } catch (error) {
      skipped(report, candidate, 'write-error', errorText(error))
      return undefined
    }
  }

  try {
    mem.scanOrReject(probe)
  } catch (error) {
    skipped(report, candidate, 'sensitive', errorText(error))
    return undefined
  }
  if (dryRun) {
    report.wouldCreate++
    return undefined
  }
  try {
    const id = await mem.remember(content, {
      title: candidate.title,
      tags: candidate.tags,
      project: candidate.project,
      ts: candidate.ts,
      extra: candidate.extra,
      ...(parent !== undefined ? { parent } : {}),
    })
    report.created.push(id)
    rememberInIndex(index, id, candidate, parent)
    return id
  } catch (error) {
    skipped(report, candidate, 'write-error', errorText(error))
    return undefined
  }
}

/** 逐会话导入；单条失败不阻塞整批。 */
async function importSession(
  mem: Memlite,
  session: DshSession,
  options: SessionImportOptions,
  dryRun: boolean,
  index: ExistingIndex,
  report: SessionImportReport,
): Promise<void> {
  const candidates = extractCandidates(session, {
    explicit: options.explicit ?? true,
    summary: options.summary ?? true,
    facts: options.facts ?? false,
    project: options.project,
  })
  report.sessionsScanned++
  report.candidates += candidates.length
  report.events += session.stats.events
  for (const warning of session.warnings) {
    if (!report.warnings.includes(warning)) report.warnings.push(warning)
  }

  let summaryId: string | undefined
  for (const candidate of candidates) {
    if (candidate.kind === 'session-summary') {
      const id = await writeCandidate(mem, candidate, undefined, dryRun, index, report)
      if (id !== undefined) summaryId = id
      continue
    }
    await writeCandidate(mem, candidate, summaryId, dryRun, index, report)
  }
}

/**
 * 从 DSH 会话历史导入记忆。复用调用方的常驻 Memlite（不 open/close、不动生命周期），
 * 写前走同一套敏感闸；dry-run 只报告。
 */
export async function importDshSessionsWith(
  mem: Memlite,
  options: SessionImportOptions = {},
): Promise<SessionImportReport> {
  const dryRun = options.dryRun === true
  const report: SessionImportReport = {
    sessionsScanned: 0,
    sessionsSkipped: 0,
    events: 0,
    candidates: 0,
    created: [],
    updated: [],
    unchanged: 0,
    skipped: [],
    warnings: [],
    wouldCreate: 0,
    wouldUpdate: 0,
  }

  const collected = collectSessions({
    root: options.root,
    cwd: options.cwd,
    sessionId: options.sessionId,
    limit: options.limit,
    since: options.since,
  })
  report.sessionsSkipped = collected.skipped
  for (const warning of collected.warnings) {
    if (!report.warnings.includes(warning)) report.warnings.push(warning)
  }

  const index = buildIndex(mem)
  const total = collected.sessions.length
  let done = 0
  for (const session of collected.sessions) {
    await importSession(mem, session, options, dryRun, index, report)
    done++
    options.onProgress?.(done, total, session.file.dirName)
  }

  if (!dryRun) {
    report.wouldCreate = report.created.length
    report.wouldUpdate = report.updated.length
  }
  return report
}
