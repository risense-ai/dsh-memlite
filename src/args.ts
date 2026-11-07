/**
 * 命令行参数解析：`query --limit 5 --bm25 --project P` 的轻量切分。
 * 首个非 flag 词起为位置参数原文，flag 取 `--key value` 或 `--key=value` 或布尔。
 */
export interface ParsedArgs {
  /** 位置参数（flags 之前的原文，trim 过）。 */
  readonly rest: string
  readonly flags: Record<string, string | boolean>
}

export function parseArgs(rawInput: string): ParsedArgs {
  const flags: Record<string, string | boolean> = {}
  const rest: string[] = []
  const tokens = rawInput.trim().split(/\s+/).filter((t) => t !== '')
  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]!
    if (tok.startsWith('--')) {
      const body = tok.slice(2)
      const eq = body.indexOf('=')
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
        i++
        continue
      }
      const next = tokens[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[body] = next
        i += 2
      } else {
        flags[body] = true
        i++
      }
      continue
    }
    rest.push(tok)
    i++
  }
  return { rest: rest.join(' ').trim(), flags }
}

export function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key]
  return typeof v === 'string' && v !== '' ? v : undefined
}

export function flagNumber(flags: Record<string, string | boolean>, key: string): number | undefined {
  const v = flagString(flags, key)
  if (v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export function flagBool(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true
}
