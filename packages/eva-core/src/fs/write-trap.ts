import * as fsNs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import * as path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { fileURLToPath } from 'node:url'
import { isInside, realpathLoose } from './allowlist'

// The default export is the real CJS module object that patches must target.
const fs = ((fsNs as unknown as { default?: typeof fsNs }).default ?? fsNs) as typeof fsNs

const evaFsScope = new AsyncLocalStorage<boolean>()

/** Marks writes that originate from EvaFs so they pass the trap. */
export function withEvaFsWrite<T>(fn: () => Promise<T>): Promise<T> {
  return evaFsScope.run(true, fn)
}

export interface WriteTrapOptions {
  /** Real paths under which unmarked writes throw. */
  protectedRoots: string[]
  /** Real paths that stay writable even when inside a protected root. */
  allowRoots: string[]
  onBlock?: (blockedPath: string) => void
}

/** Which argument positions of each API name a filesystem path (a write target or removal). */
const PATH_ARGS: Record<string, number[]> = {
  writeFile: [0],
  writeFileSync: [0],
  appendFile: [0],
  appendFileSync: [0],
  rename: [0, 1],
  renameSync: [0, 1],
  rm: [0],
  rmSync: [0],
  rmdir: [0],
  rmdirSync: [0],
  unlink: [0],
  unlinkSync: [0],
  mkdir: [0],
  mkdirSync: [0],
  mkdtemp: [0],
  mkdtempSync: [0],
  copyFile: [1],
  copyFileSync: [1],
  cp: [1],
  cpSync: [1],
  createWriteStream: [0],
  truncate: [0],
  truncateSync: [0],
  symlink: [1],
  symlinkSync: [1],
  link: [1],
  linkSync: [1],
  chmod: [0],
  chmodSync: [0],
  utimes: [0],
  utimesSync: [0],
}
/** APIs that only write when opened with a write flag (argument 1). */
const OPEN_APIS = ['open', 'openSync']

function isWriteFlag(flags: unknown): boolean {
  if (flags === undefined || flags === null) return false
  if (typeof flags === 'number') {
    const c = fs.constants
    return (flags & (c.O_WRONLY | c.O_RDWR | c.O_APPEND | c.O_CREAT | c.O_TRUNC)) !== 0
  }
  return typeof flags === 'string' && /[wa+]/.test(flags)
}

function toPath(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (v instanceof URL) return fileURLToPath(v)
  if (Buffer.isBuffer(v)) return v.toString()
  return null
}

export function installWriteTrap(opts: WriteTrapOptions): () => void {
  const protectedRoots = opts.protectedRoots
  const allowRoots = opts.allowRoots

  const check = (name: string, args: unknown[]): void => {
    if (evaFsScope.getStore()) return
    const idx = OPEN_APIS.includes(name)
      ? isWriteFlag(args[1])
        ? [0]
        : []
      : (PATH_ARGS[name] ?? [])
    for (const i of idx) {
      const raw = toPath(args[i])
      if (raw === null) continue
      const abs = realpathLoose(path.resolve(raw))
      if (!protectedRoots.some((r) => isInside(abs, r))) continue
      if (allowRoots.some((r) => isInside(abs, r))) continue
      opts.onBlock?.(abs)
      throw Object.assign(new Error(`EvaOS write trap: ${abs} is inside the protected Eva root`), {
        code: 'EVAOS_WRITE_TRAP',
      })
    }
  }

  const restores: Array<() => void> = []
  const patch = (target: Record<string, unknown>, isPromises: boolean): void => {
    for (const name of [...Object.keys(PATH_ARGS), ...OPEN_APIS]) {
      const orig = target[name]
      if (typeof orig !== 'function') continue
      const wrapped = function (this: unknown, ...args: unknown[]): unknown {
        try {
          check(name, args)
        } catch (err) {
          if (isPromises) return Promise.reject(err)
          throw err
        }
        return (orig as (...a: unknown[]) => unknown).apply(this, args)
      }
      target[name] = wrapped
      restores.push(() => {
        target[name] = orig
      })
    }
  }
  patch(fs as unknown as Record<string, unknown>, false)
  patch(fs.promises as unknown as Record<string, unknown>, true)
  syncBuiltinESMExports()

  return () => {
    for (const r of restores.reverse()) r()
    syncBuiltinESMExports()
  }
}
