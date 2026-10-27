import * as fs from 'node:fs'
import * as path from 'node:path'
import type { SearchMatch, SearchResult } from '@evaos/contract'
import { CodedError } from '../chat/session-ops'
import { MAX_FILES, MAX_TEXT_BYTES, decodeText, hasLockedSegment, walkFiles } from './files-fs'
import { repoOf, streamRecords, type ChildEnv, type StreamResult } from './files-git'

/** Matches across all files before a search stops (truncated). */
export const MAX_MATCHES = 2000
/** Matches kept per file (truncated past it). */
export const MAX_PER_FILE = 200
const SEARCH_TIMEOUT_MS = 20_000
const LIST_TIMEOUT_MS = 20_000
const PREVIEW_CHARS = 120
/** How much of the line before a match its preview keeps, when the line is long. */
const PREVIEW_LEAD = 40

export interface SearchQuery {
  query: string
  regex: boolean
  caseSensitive: boolean
  wholeWord: boolean
}

/** `rg` on `pathEnv`, else in the Homebrew prefixes, else null. */
export function findRg(pathEnv: string): string | null {
  const dirs = [...pathEnv.split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin']
  for (const d of dirs) {
    if (d === '') continue
    const candidate = path.join(d, 'rg')
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // not here
    }
  }
  return null
}

/**
 * Every non-ignored file under `root` for quick open: `git ls-files` inside a checkout, else a
 * walk. `.git` and `secrets` paths never appear; at most MAX_FILES.
 */
export async function allFiles(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = []
  let truncated = false
  if ((await repoOf(root, env)) !== null) {
    const r = await streamRecords(
      'git',
      ['--no-optional-locks', 'ls-files', '-co', '--exclude-standard', '-z'],
      { cwd: root, env, sep: '\0', timeoutMs: LIST_TIMEOUT_MS },
      (rel) => {
        // A nested checkout is listed as `dir/`.
        if (rel === '' || rel.endsWith('/') || hasLockedSegment(rel)) return true
        if (files.length >= MAX_FILES) {
          truncated = true
          return false
        }
        files.push(rel)
        return true
      },
    )
    if (r.timedOut) truncated = true
    if (r.code === 0 || r.stopped || r.timedOut) return { files, truncated }
    // git failed after all: fall through to the walk.
    files.length = 0
  }
  await walkFiles(root, (rel) => {
    if (files.length >= MAX_FILES) {
      truncated = true
      return false
    }
    files.push(rel)
    return true
  })
  return { files, truncated }
}

/** The JS form of a query: a global regex, escaped unless `regex`, in `\b` for whole words. */
export function matcherFor(q: SearchQuery): RegExp {
  const body = q.regex ? q.query : q.query.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const source = q.wholeWord ? `\\b(?:${body})\\b` : body
  const flags = q.caseSensitive ? 'g' : 'gi'
  try {
    return new RegExp(source, `${flags}u`)
  } catch {
    try {
      return new RegExp(source, flags)
    } catch (e) {
      throw new CodedError('invalid-query', e instanceof Error ? e.message : String(e))
    }
  }
}

/** Every non-empty match of `re` in `line` as UTF-16 [start, length]. */
function lineMatches(line: string, re: RegExp): Array<[number, number]> {
  const out: Array<[number, number]> = []
  re.lastIndex = 0
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    if (m[0].length === 0) {
      re.lastIndex++
      continue
    }
    out.push([m.index, m[0].length])
  }
  return out
}

/** UTF-16 index of byte offset `byte` in the UTF-8 encoding of `line`. */
function utf16At(lineBytes: Buffer, byte: number): number {
  return lineBytes.toString('utf8', 0, Math.min(byte, lineBytes.length)).length
}

function matchAt(line: string, lineNo: number, start: number, length: number): SearchMatch {
  let from = 0
  let to = line.length
  if (line.length > PREVIEW_CHARS) {
    from = Math.max(0, Math.min(start - PREVIEW_LEAD, line.length - PREVIEW_CHARS))
    to = from + PREVIEW_CHARS
  }
  while (from < start && /\s/.test(line[from]!)) from++
  return {
    line: lineNo,
    column: start + 1,
    length,
    preview: line.slice(from, to),
    previewStart: start - from,
  }
}

/** Collects matches by file in arrival order, with the total and per-file caps. */
class Collector {
  private readonly byPath = new Map<string, SearchMatch[]>()
  private total = 0
  truncated = false

  /** False once the total cap is reached (stop searching). */
  add(rel: string, m: SearchMatch): boolean {
    if (this.total >= MAX_MATCHES) {
      this.truncated = true
      return false
    }
    let list = this.byPath.get(rel)
    if (!list) {
      list = []
      this.byPath.set(rel, list)
    }
    if (list.length >= MAX_PER_FILE) {
      this.truncated = true
      return true
    }
    list.push(m)
    this.total++
    return true
  }

  result(engine: SearchResult['engine']): SearchResult {
    const results = [...this.byPath].map(([p, matches]) => ({ path: p, matches }))
    return { results, truncated: this.truncated, engine }
  }
}

interface EngineRun {
  root: string
  q: SearchQuery
  env: NodeJS.ProcessEnv
  signal: AbortSignal
  out: Collector
}

async function runRg(rg: string, r: EngineRun): Promise<void> {
  const { q, out } = r
  const args = [
    '--json',
    '--hidden',
    '--glob',
    '!.git',
    '--glob',
    '!secrets',
    '--max-columns',
    '400',
    '--max-filesize',
    '5M',
    q.caseSensitive ? '--case-sensitive' : '-i',
    ...(q.regex ? [] : ['-F']),
    ...(q.wholeWord ? ['-w'] : []),
    '-e',
    q.query,
    '--',
    '.',
  ]
  const res = await streamRecords(
    rg,
    args,
    { cwd: r.root, env: r.env, sep: '\n', timeoutMs: SEARCH_TIMEOUT_MS, signal: r.signal },
    (record) => {
      if (!record.startsWith('{"type":"match"')) return true
      const msg = JSON.parse(record) as {
        data: {
          path: { text?: string }
          lines: { text?: string }
          line_number: number | null
          submatches: Array<{ start: number; end: number }>
        }
      }
      const d = msg.data
      if (d.path.text === undefined || d.lines.text === undefined || d.line_number === null) {
        return true
      }
      const rel = d.path.text.startsWith('./') ? d.path.text.slice(2) : d.path.text
      if (hasLockedSegment(rel)) return true
      const line = d.lines.text.replace(/\r?\n$/, '')
      const bytes = Buffer.from(line, 'utf8')
      for (const s of d.submatches) {
        const start = utf16At(bytes, s.start)
        const m = matchAt(line, d.line_number, start, utf16At(bytes, s.end) - start)
        if (!out.add(rel, m)) return false
      }
      return true
    },
  )
  finish('rg', q, res, out)
}

async function runGitGrep(r: EngineRun): Promise<void> {
  const { q, out } = r
  let re: RegExp | null
  try {
    re = matcherFor(q)
  } catch {
    // An ERE JS cannot read: matches fall back to git's own column.
    re = null
  }
  const args = [
    '--no-optional-locks',
    'grep',
    '-n',
    '-I',
    '--column',
    '-z',
    '--untracked',
    '--exclude-standard',
    q.regex ? '-E' : '-F',
    ...(q.caseSensitive ? [] : ['-i']),
    ...(q.wholeWord ? ['-w'] : []),
    '-e',
    q.query,
    '--',
    '.',
  ]
  const res = await streamRecords(
    'git',
    args,
    { cwd: r.root, env: r.env, sep: '\n', timeoutMs: SEARCH_TIMEOUT_MS, signal: r.signal },
    (record) => {
      // path \0 line \0 byte column \0 text
      const a = record.indexOf('\0')
      const b = record.indexOf('\0', a + 1)
      const c = record.indexOf('\0', b + 1)
      if (a < 0 || b < 0 || c < 0) return true
      const rel = record.slice(0, a)
      if (hasLockedSegment(rel)) return true
      const lineNo = Number(record.slice(a + 1, b))
      const line = record.slice(c + 1).replace(/\r$/, '')
      const found = re ? lineMatches(line, re) : []
      if (found.length === 0) {
        const byteCol = Number(record.slice(b + 1, c))
        found.push([utf16At(Buffer.from(line, 'utf8'), byteCol - 1), 0])
      }
      for (const [start, length] of found) {
        if (!out.add(rel, matchAt(line, lineNo, start, length))) return false
      }
      return true
    },
  )
  finish('git', q, res, out)
}

/** Exit handling for rg and git grep: 0 matches, 1 none, else an error unless we stopped it. */
function finish(engine: 'rg' | 'git', q: SearchQuery, res: StreamResult, out: Collector): void {
  if (res.aborted) throw new CodedError('cancelled', 'A newer search replaced this one.')
  if (res.timedOut) out.truncated = true
  if (res.stopped || res.timedOut || res.code === 0 || res.code === 1) return
  const detail = res.stderr.trim().split('\n')[0] ?? ''
  // rg also exits 2 when some files could not be read; what it found still stands.
  if (engine === 'rg' && res.code === 2 && !/regex/i.test(res.stderr)) return
  if (q.regex && (res.code === 2 || res.code === 128)) throw new CodedError('invalid-query', detail)
  throw new CodedError('search-failed', `${engine} failed: ${detail}`)
}

async function runScan(r: EngineRun): Promise<void> {
  const re = matcherFor(r.q)
  const started = Date.now()
  await walkFiles(
    r.root,
    async (rel) => {
      if (Date.now() - started > SEARCH_TIMEOUT_MS) {
        r.out.truncated = true
        return false
      }
      const abs = path.join(r.root, rel)
      let text: string | null
      try {
        if ((await fs.promises.stat(abs)).size > MAX_TEXT_BYTES) return true
        text = decodeText(await fs.promises.readFile(abs))
      } catch {
        return true
      }
      if (text === null) return true
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.replace(/\r$/, '')
        for (const [start, length] of lineMatches(line, re)) {
          if (!r.out.add(rel, matchAt(line, i + 1, start, length))) return false
        }
      }
      return true
    },
    r.signal,
  )
  if (r.signal.aborted) throw new CodedError('cancelled', 'A newer search replaced this one.')
}

export interface FilesSearch {
  search(root: string, q: SearchQuery): Promise<SearchResult>
  /** Kills every running search (quit). */
  cancelAll(): void
}

/**
 * Text search under one root: rg when installed, else `git grep` inside a checkout, else a JS
 * scan. A newer search on the same root cancels the one still running (it fails `cancelled`).
 */
export function createSearch(env: ChildEnv, rgPath: () => Promise<string | null>): FilesSearch {
  const running = new Map<string, AbortController>()
  return {
    async search(root, q) {
      running.get(root)?.abort()
      const ac = new AbortController()
      running.set(root, ac)
      try {
        const run: EngineRun = {
          root,
          q,
          env: await env(),
          signal: ac.signal,
          out: new Collector(),
        }
        const rg = await rgPath()
        if (rg !== null) {
          await runRg(rg, run)
          return run.out.result('rg')
        }
        if ((await repoOf(root, run.env)) !== null) {
          await runGitGrep(run)
          return run.out.result('git')
        }
        await runScan(run)
        return run.out.result('scan')
      } finally {
        if (running.get(root) === ac) running.delete(root)
      }
    },
    cancelAll() {
      for (const ac of running.values()) ac.abort()
      running.clear()
    },
  }
}
