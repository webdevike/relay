import * as fs from 'node:fs'
import * as path from 'node:path'
import { CodedError } from '../chat/session-ops'

/** Text files above this are not opened or searched. */
export const MAX_TEXT_BYTES = 5 * 1024 * 1024
/** Quick open and the scan walk stop here. */
export const MAX_FILES = 50_000
/** How far into a file a NUL byte marks it binary. */
const BINARY_SNIFF_BYTES = 8000

/** Never listed. */
const GIT_DIR = '.git'
/** Listed, never opened. */
const SECRETS_DIR = 'secrets'
/** Folders the walk (quick open and search outside git) never enters. */
const WALK_SKIP: Record<string, true> = { [GIT_DIR]: true, node_modules: true, [SECRETS_DIR]: true }

/** The temp sibling a save writes before renaming over the target: `.<name>.<pid>.<rand>.tmp`. */
export const SAVE_TEMP_RE = /^\.[^/]*\.tmp$/

/** True when a `/`-separated path has a `.git` or `secrets` segment. */
export function hasLockedSegment(rel: string): boolean {
  return rel.split('/').some((s) => s === GIT_DIR || s === SECRETS_DIR)
}

/** `real` is `root` itself or below it (both real paths). */
export function isInsideRoot(root: string, real: string): boolean {
  if (real === root) return true
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  return real.startsWith(prefix)
}

/**
 * The lexical checks every channel shares: no NUL, not absolute, no `..` segment, no `.git` or
 * `secrets` segment. Returns the normalized `/`-separated path ('' for the root).
 */
export function checkRel(rel: string): string {
  if (rel.includes('\0')) throw new CodedError('invalid-path', 'The path is not valid.')
  if (path.isAbsolute(rel) || rel.startsWith('/')) {
    throw new CodedError('outside-root', 'The path is outside this folder.')
  }
  const segs = rel.split('/').filter((s) => s !== '' && s !== '.')
  if (segs.includes('..')) throw new CodedError('outside-root', 'The path is outside this folder.')
  const norm = segs.join('/')
  if (hasLockedSegment(norm)) throw new CodedError('locked', 'This path is locked.')
  return norm
}

export interface Resolved {
  /** Normalized root-relative path. */
  rel: string
  /** Lexical absolute path (root + rel). */
  abs: string
  /** Real path of the existing target, inside the root. */
  real: string
}

/**
 * Resolves an existing path under `root` (a real path): lexical checks, then the real path must
 * stay inside the root and must not land in `.git` or `secrets`. Symlinks inside the root are
 * followed; one that leaves it fails with `outside-root`.
 */
export async function resolveInRoot(root: string, rel: string): Promise<Resolved> {
  const norm = checkRel(rel)
  const abs = norm === '' ? root : path.join(root, ...norm.split('/'))
  let real: string
  try {
    real = await fs.promises.realpath(abs)
  } catch {
    throw new CodedError('not-found', 'The file no longer exists.')
  }
  if (!isInsideRoot(root, real)) {
    throw new CodedError('outside-root', 'The path is outside this folder.')
  }
  if (hasLockedSegment(path.relative(root, real).split(path.sep).join('/'))) {
    throw new CodedError('locked', 'This path is locked.')
  }
  return { rel: norm, abs, real }
}

/** UTF-8 text, or null for binary bytes (a NUL early on, or invalid UTF-8). A BOM is kept. */
export function decodeText(buf: Buffer): string | null {
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf)
  } catch {
    return null
  }
}

/**
 * Walks `root` breadth first (no `.git`, `node_modules`, `secrets`, symlinked folders), calling
 * `onFile` with each regular file's root-relative path. Symlinked files count when they resolve
 * to a file inside the root. Stops when `onFile` returns false or `signal` aborts.
 */
export async function walkFiles(
  root: string,
  onFile: (rel: string) => boolean | Promise<boolean>,
  signal?: AbortSignal,
): Promise<void> {
  const queue: string[] = ['']
  for (let i = 0; i < queue.length; i++) {
    if (signal?.aborted) return
    const dir = queue[i]!
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir === '' ? root : path.join(root, dir), {
        withFileTypes: true,
      })
    } catch {
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      if (signal?.aborted) return
      // `.git` is a file in a worktree; `secrets` is skipped whatever it is.
      if (WALK_SKIP[e.name] === true) continue
      const rel = dir === '' ? e.name : `${dir}/${e.name}`
      if (e.isDirectory()) {
        queue.push(rel)
        continue
      }
      if (e.isSymbolicLink()) {
        try {
          const real = await fs.promises.realpath(path.join(root, rel))
          if (!isInsideRoot(root, real) || !(await fs.promises.stat(real)).isFile()) continue
          if (hasLockedSegment(path.relative(root, real).split(path.sep).join('/'))) continue
        } catch {
          continue
        }
      } else if (!e.isFile()) continue
      if (!(await onFile(rel))) return
    }
  }
}
