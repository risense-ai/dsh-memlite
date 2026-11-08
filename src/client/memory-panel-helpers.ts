/**
 * 记忆面板状态机的小工具：宿主 tabInfo 防御式读取、错误投影、防抖常量。
 */
import { MemoryApiError } from './memory-api'
import type { MemoryErrorInfo } from './memory-view-types'

/** 防御式读取 slot 框架的 tabInfo：拿不到 `tab.visible` 就按可见处理。 */
export function readTabVisible(info: unknown): boolean {
  if (typeof info !== 'object' || info === null) return true
  const tab = (info as { tab?: unknown }).tab
  if (typeof tab !== 'object' || tab === null) return true
  const visible = (tab as { visible?: unknown }).visible
  return typeof visible === 'boolean' ? visible : true
}

/** SSR / 未注入 useTabInfo 时的占位 hook。 */
export function useNoTabInfo(): unknown {
  return undefined
}

export function toErrorInfo(error: unknown): MemoryErrorInfo {
  if (error instanceof MemoryApiError) {
    return {
      code: error.code === 'disabled' ? 'http' : error.code,
      ...(error.status === undefined ? {} : { status: error.status }),
    }
  }
  return { code: 'unknown' }
}

export function isDisabledError(error: unknown): boolean {
  return error instanceof MemoryApiError && error.disabled
}

export const ALL_DEBOUNCE_MS = 200
