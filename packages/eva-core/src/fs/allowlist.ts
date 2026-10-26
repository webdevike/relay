import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * The closed set of writes EvaOS performs inside the Eva checkout: the Rust set plus
 * `room-record`, the Rooms tab's saved thread.
 */
export const WRITE_KINDS = [
  'todo-append',
  'file-save',
  'job-md',
  'job-delete',
  'meeting-status',
  'room-record',
] as const
export type WriteKind = (typeof WRITE_KINDS)[number]

export type MatchResult = { ok: true; abs: string } | { ok: false; reason: string }

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/
const STEM_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Realpath of the nearest existing ancestor of `abs`, with the missing tail re-appended. */
export function realpathLoose(abs: string): string {
  let cur = abs
  const tail: string[] = []
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse())
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return abs
      tail.push(path.basename(cur))
      cur = parent
    }
  }
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function contain(root: string, rel: string): MatchResult {
  if (typeof rel !== 'string' || rel === '') return { ok: false, reason: 'empty path' }
  if (path.isAbsolute(rel)) return { ok: false, reason: 'absolute path' }
  if (rel.split(/[\\/]+/).includes('..')) return { ok: false, reason: 'parent segment' }
  const abs = path.resolve(root, rel)
  let realRoot: string
  try {
    realRoot = fs.realpathSync(root)
  } catch {
    return { ok: false, reason: 'root does not exist' }
  }
  if (!isInside(realpathLoose(abs), realRoot)) {
    return { ok: false, reason: 'escapes the root (symlink)' }
  }
  return { ok: true, abs }
}

function norm(rel: string): string {
  return rel.split(/[\\/]+/).join('/')
}

/** Returns the contained absolute path when `rel` is allowed for `kind`. */
export function matchWrite(kind: string, root: string, rel: string): MatchResult {
  if (!(WRITE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: `unknown write kind ${kind}` }
  }
  const contained = contain(root, rel)
  if (!contained.ok) return contained
  const parts = norm(rel).split('/')
  switch (kind as WriteKind) {
    case 'todo-append':
      return norm(rel) === 'memory/todos.md'
        ? contained
        : { ok: false, reason: 'todo-append only targets memory/todos.md' }
    case 'job-md':
      return parts.length === 3 &&
        parts[0] === 'jobs' &&
        NAME_RE.test(parts[1] ?? '') &&
        parts[2] === 'job.md'
        ? contained
        : { ok: false, reason: 'job-md only targets jobs/<name>/job.md' }
    case 'job-delete':
      return parts.length === 2 && parts[0] === 'jobs' && NAME_RE.test(parts[1] ?? '')
        ? contained
        : { ok: false, reason: 'job-delete only targets jobs/<name>' }
    case 'meeting-status': {
      const file = parts[2] ?? ''
      return parts.length === 3 &&
        parts[0] === 'work' &&
        parts[1] === 'meetings' &&
        file.endsWith('.json') &&
        STEM_RE.test(file.slice(0, -5))
        ? contained
        : { ok: false, reason: 'meeting-status only targets work/meetings/<stem>.json' }
    }
    case 'room-record': {
      const file = parts[2] ?? ''
      return parts.length === 3 &&
        parts[0] === 'memory' &&
        parts[1] === 'rooms' &&
        file.endsWith('.md') &&
        STEM_RE.test(file.slice(0, -3))
        ? contained
        : { ok: false, reason: 'room-record only targets memory/rooms/<stem>.md' }
    }
    case 'file-save': {
      try {
        const st = fs.lstatSync(contained.abs)
        if (!st.isFile()) return { ok: false, reason: 'file-save target is not a regular file' }
      } catch {
        /* new file is fine */
      }
      return contained
    }
  }
}
