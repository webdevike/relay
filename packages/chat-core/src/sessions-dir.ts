import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseSession } from './session'

export interface SessionFile {
  file: string
  title: string
  mtimeMs: number
}

/** First `maxBytes` of a file's lines: enough for the header records without reading a whole session. */
function headLines(file: string, count: number): string[] {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(64 * 1024)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    return buf.toString('utf8', 0, n).split('\n').slice(0, count)
  } finally {
    fs.closeSync(fd)
  }
}

export interface Header {
  title: string | null
  cwd: string | null
}

export function readHeader(file: string): Header {
  const header: Header = { title: null, cwd: null }
  let lines: string[]
  try {
    lines = headLines(file, 4)
  } catch {
    return header
  }
  for (const line of lines) {
    let rec: unknown
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof rec !== 'object' || rec === null) continue
    const r = rec as Record<string, unknown>
    const title = typeof r.title === 'string' && r.title !== '' ? r.title : null
    if (r.type === 'title') header.title = title
    else if (r.type === 'session') {
      header.cwd = typeof r.cwd === 'string' ? r.cwd : null
      if (header.title === null) header.title = title
    }
  }
  return header
}

function jsonlFiles(dir: string): { file: string; mtimeMs: number }[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: { file: string; mtimeMs: number }[] = []
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const file = path.join(dir, name)
    try {
      out.push({ file, mtimeMs: fs.statSync(file).mtimeMs })
    } catch {
      // vanished between readdir and stat
    }
  }
  return out
}

/** `.jsonl` sessions newest first; the title comes from the header, else the first prompt. */
export function listSessionFiles(dir: string, limit = 50): SessionFile[] {
  return jsonlFiles(dir)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file))
    .slice(0, limit)
    .map(({ file, mtimeMs }) => {
      let title = readHeader(file).title
      if (title === null) {
        try {
          title = parseSession(fs.readFileSync(file, 'utf8')).title
        } catch {
          title = ''
        }
      }
      return { file, title: title || path.basename(file, '.jsonl'), mtimeMs }
    })
}

/** Port of Rust `omp_sessions_dir`: the `sessions/*` dir whose newest file records the Eva root as cwd. */
export function resolveLiveSessionsDir(evaRoot: string, agentDir: string): string | null {
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p)
    } catch {
      return p
    }
  }
  const root = real(evaRoot)
  const base = path.join(agentDir, 'sessions')
  let entries: string[]
  try {
    entries = fs.readdirSync(base)
  } catch {
    return null
  }
  for (const name of entries.sort()) {
    const dir = path.join(base, name)
    const newest = jsonlFiles(dir).sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
    if (!newest) continue
    const cwd = readHeader(newest.file).cwd
    if (cwd !== null && real(cwd) === root) return dir
  }
  return null
}
