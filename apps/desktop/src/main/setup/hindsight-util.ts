import * as fs from 'node:fs'
import * as path from 'node:path'

/** An error whose message is safe to show the user. */
export class HindsightError extends Error {}

/** First `base`, `base+1`, ... for which `free` says yes. Gives up after `tries`. */
export async function firstFreePort(
  base: number,
  free: (port: number) => Promise<boolean>,
  taken: ReadonlySet<number> = new Set(),
  tries = 100,
): Promise<number> {
  for (let p = base; p < base + tries; p++) {
    if (!taken.has(p) && (await free(p))) return p
  }
  throw new Error(`No free port found from ${base}.`)
}

export function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

export function writeAtomic(p: string, text: string, mode?: number): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, mode !== undefined ? { mode } : undefined)
  fs.renameSync(tmp, p)
}

export function lastLine(s: string): string {
  return s.trim().split('\n').pop()?.trim() || 'no details'
}

/** 1536 -> "1.5 KB", 2.1e9 -> "2.1 GB". Decimal units, like Finder. */
export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`
  return `${n} B`
}
