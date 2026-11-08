/**
 * 状态视图投影（M11）：只暴露可行动、无敏感信息的运行状态。
 *
 * 红线：不返回完整 dataDir、repo 路径、remote URL、凭据引用、正文或向量；
 * sync 状态按 available / hasRemote / dirty / localSha 四类分开，未配置不显示“已同步”。
 */
import * as path from 'node:path'
import type { Memlite } from '@rsrsai/memlite'
import type {
  MemoryDataScope,
  MemoryStatusResponse,
  MemoryWriteReceipt,
  MemoryWriteScope,
} from './browser-contract'
import type { WriteReceiptStore } from './memory-write-service'

export interface ObsidianSnapshot {
  state: 'unchecked' | 'busy' | 'ok' | 'error'
  lastOperation?: 'status' | 'preview' | 'import' | 'export'
  timestamp?: number
}

/** 最近一次显式同步的核验状态（内存态，重载清空）。 */
export class SyncActivity {
  private verified = false
  private timestamp: number | undefined

  record(verified: boolean): void {
    this.verified = verified
    this.timestamp = Math.floor(Date.now() / 1000)
  }

  get isVerified(): boolean {
    return this.verified
  }

  get at(): number | undefined {
    return this.timestamp
  }
}

/** Obsidian 最近一次操作的轻量状态（不保存路径与报告正文）。 */
export class ObsidianActivity {
  private state: ObsidianSnapshot['state'] = 'unchecked'
  private lastOperation: ObsidianSnapshot['lastOperation']
  private timestamp: number | undefined

  begin(operation: NonNullable<ObsidianSnapshot['lastOperation']>): void {
    this.state = 'busy'
    this.lastOperation = operation
    this.timestamp = Math.floor(Date.now() / 1000)
  }

  finish(operation: NonNullable<ObsidianSnapshot['lastOperation']>, ok: boolean): void {
    this.state = ok ? 'ok' : 'error'
    this.lastOperation = operation
    this.timestamp = Math.floor(Date.now() / 1000)
  }

  snapshot(): ObsidianSnapshot {
    return {
      state: this.state,
      ...(this.lastOperation !== undefined ? { lastOperation: this.lastOperation } : {}),
      ...(this.timestamp !== undefined ? { timestamp: this.timestamp } : {}),
    }
  }
}

export interface StatusDeps {
  getMem(): Memlite
  getGeneration(): number
  isEnabled(): boolean
  receipts: WriteReceiptStore
  obsidian: ObsidianActivity
  syncActivity: SyncActivity
}

function dataScope(mem: Memlite): MemoryDataScope {
  if (mem.config.dataDir !== undefined && mem.config.dataDir !== '') return 'custom'
  return path.basename(mem.dataDir) === '.memlite' ? 'project' : 'user'
}

function shortSha(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 12) : ''
}

export async function buildMemoryStatus(
  deps: StatusDeps,
  scope: MemoryWriteScope = {},
): Promise<MemoryStatusResponse> {
  const mem = deps.getMem()
  const [status, sync] = await Promise.all([
    mem.status(),
    mem.syncStatus().catch(() => undefined),
  ])
  const files = Array.isArray(status['files']) ? status['files'].length : 0
  const embedding = status['embedding'] as
    | { provider?: unknown; configured?: unknown }
    | undefined
  const provider =
    embedding?.provider === 'host' || embedding?.provider === 'openai-compatible'
      ? embedding.provider
      : 'none'
  const rawConcurrency = status['concurrency'] as Record<string, unknown> | undefined
  const concurrency = {
    mode: rawConcurrency?.['mode'] === 'multi-process' ? ('multi-process' as const) : ('single-writer' as const),
    lockBackend: rawConcurrency?.['lock_backend'] === 'flock' ? ('flock' as const) : ('in-process' as const),
    crossProcess: rawConcurrency?.['cross_process'] === true,
    storageProtocol: Number(rawConcurrency?.['storage_protocol'] ?? 0),
  }
  const receipts: MemoryWriteReceipt[] = deps.receipts.list(scope, 50)
  return {
    engine: deps.getGeneration(),
    concurrency,
    library: {
      enabled: deps.isEnabled(),
      records: Number(status['records'] ?? 0),
      badLines: Number(status['bad_lines'] ?? 0),
      vectors: Number(status['vectors'] ?? 0),
      dataScope: dataScope(mem),
      files,
    },
    search: {
      backend: provider === 'none' || provider === 'host' ? 'bm25' : 'semantic+bm25',
      embeddingProvider: provider,
      embeddingConfigured: provider !== 'none',
      fallbacks: 0,
    },
    sync: sync === undefined
      ? { available: false, hasRemote: false, dirty: false, verified: false, localSha: '' }
      : {
          available: sync.repo !== null,
          hasRemote: sync.has_remote === true,
          dirty: sync.dirty === true,
          verified: deps.syncActivity.isVerified,
          localSha: shortSha(sync.local_sha),
        },
    obsidian: deps.obsidian.snapshot(),
    receipts,
  }
}
