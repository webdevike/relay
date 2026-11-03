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

/**
 * Every omp store under the omp home (native chat.rs omp_agent_dirs_from): `defaultDir` first,
 * then the Current one (`<home>/agent`) when `defaultDir` is a profile's, then each named
 * profile's `<home>/profiles/<name>/agent`. A thread on another profile stays findable.
 */
export function ompAgentDirsFrom(defaultDir: string): string[] {
  const dirs = [defaultDir]
  let home = path.dirname(defaultDir)
  const isDir = (p: string): boolean => {
    try {
      return fs.statSync(p).isDirectory()
    } catch {
      return false
    }
  }
  const parent = path.dirname(home)
  if (path.basename(parent) === 'profiles') {
    home = path.dirname(parent)
    const current = path.join(home, 'agent')
    if (isDir(current)) dirs.push(current)
  }
  let names: string[] = []
  try {
    names = fs.readdirSync(path.join(home, 'profiles')).sort()
  } catch {
    // no profiles
  }
  for (const name of names) {
    const dir = path.join(home, 'profiles', name, 'agent')
    if (dir !== defaultDir && !dirs.includes(dir) && isDir(dir)) dirs.push(dir)
  }
  return dirs
}

/**
 * The `sessions/*` dir of one omp store whose newest file records `root` as its cwd (native
 * omp_sessions_dir_in), or null.
 */
export function ompSessionsDirIn(agentDir: string, root: string): string | null {
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p)
    } catch {
      return p
    }
  }
  const want = real(root)
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
    if (cwd !== null && real(cwd) === want) return dir
  }
  return null
}

/** Every omp sessions dir for chats started in `root`, across all stores (native sessions_dirs). */
export function sessionsDirs(root: string, defaultAgentDir: string): string[] {
  return ompAgentDirsFrom(defaultAgentDir)
    .map((agent) => ompSessionsDirIn(agent, root))
    .filter((dir): dir is string => dir !== null)
}
