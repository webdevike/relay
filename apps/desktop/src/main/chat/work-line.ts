// Where a chat works, for its third line: the ledgers under `<evaRoot>/work/items`, the git
// branch of a folder (read from `.git/HEAD`, never the git CLI) and the worktree folders its tool
// calls touched. Ported from the native app's inbox/links.rs scan and chat_view/look.rs.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ledgerFor, parseWorkLink, pathWithin, type WorkLink } from '@evaos/chat-core/work'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Every ledger under `root/work/items` (companions like `ENG-1.pr.md` are not ledgers), by key.
 * Each file is parsed again only when its mtime or size changes.
 */
export class WorkLedgers {
  private readonly seen = new Map<
    string,
    { mtimeMs: number; size: number; link: WorkLink | null }
  >()

  constructor(private readonly root: string) {}

  current(): WorkLink[] {
    const dir = path.join(this.root, 'work/items')
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      this.seen.clear()
      return []
    }
    const present = new Set<string>()
    const links: WorkLink[] = []
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      const stem = name.slice(0, -'.md'.length)
      if (stem === '' || stem.includes('.')) continue
      const file = path.join(dir, name)
      let st: fs.Stats
      try {
        st = fs.statSync(file)
      } catch {
        continue
      }
      if (!st.isFile()) continue
      present.add(file)
      let hit = this.seen.get(file)
      if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
        let link: WorkLink | null = null
        try {
          link = parseWorkLink(stem, fs.readFileSync(file, 'utf8'), this.root)
        } catch {
          // unreadable ledger: skipped
        }
        hit = { mtimeMs: st.mtimeMs, size: st.size, link }
        this.seen.set(file, hit)
      }
      if (hit.link) links.push(hit.link)
    }
    for (const file of [...this.seen.keys()]) if (!present.has(file)) this.seen.delete(file)
    return links.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  }
}

/**
 * The branch checked out in the git repo or worktree holding `dir`: its `HEAD`, through a
 * worktree's `gitdir:` file. Null when detached or not in a repo.
 */
export function gitBranch(dir: string): string | null {
  let at = dir
  let dotGit: string | null = null
  for (;;) {
    const candidate = path.join(at, '.git')
    if (fs.existsSync(candidate)) {
      dotGit = candidate
      break
    }
    const up = path.dirname(at)
    if (up === at) return null
    at = up
  }
  try {
    let gitDir = dotGit
    if (!fs.statSync(dotGit).isDirectory()) {
      const text = fs.readFileSync(dotGit, 'utf8').trim()
      if (!text.startsWith('gitdir:')) return null
      gitDir = path.resolve(path.dirname(dotGit), text.slice('gitdir:'.length).trim())
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : null
  } catch {
    return null
  }
}

/** The Eva root a session folder belongs to: the folder holding the `work` it is in, else the folder itself. */
export function evaRootOf(cwd: string): string {
  for (let at = cwd; ;) {
    if (path.basename(at) === 'work') return path.dirname(at)
    const up = path.dirname(at)
    if (up === at) return cwd
    at = up
  }
}

/** `raw` as an absolute path from `base`: `~/` is `home`, relative paths join `base`, `.` and `..` fold. */
export function resolvePath(raw: string, base: string, home: string | null): string {
  const p = raw.replace(/^["']+|["']+$/g, '')
  if (p.startsWith('~/') && home !== null) return path.resolve(home, p.slice(2))
  if (p === '~') return home ?? base
  return path.resolve(base, p)
}

/** The folder directly under `root/work` that holds `p`, else null. */
export function worktreeOf(p: string, root: string): string | null {
  const work = path.join(root, 'work')
  if (!pathWithin(p, work) || p === work) return null
  const name = p.slice(work.length + 1).split('/')[0]
  return name ? path.join(work, name) : null
}

/**
 * The folders one shell command works in, in order: `cd`/`pushd` targets and `git -C` folders,
 * each from the folder the previous `cd` left (`base` at first).
 */
export function commandDirs(command: string, base: string, home: string | null): string[] {
  const tokens = command
    .replace(/[;|&()\n]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  let dir = base
  const dirs: string[] = []
  tokens.forEach((token, ix) => {
    let target: string | undefined
    let moves = false
    if (token === 'cd' || token === 'pushd') {
      target = tokens[ix + 1]
      moves = true
    } else if (token === 'git' && tokens[ix + 1] === '-C') {
      target = tokens[ix + 2]
    } else return
    if (target === undefined || target.startsWith('-') || /[$`]/.test(target)) return
    const p = resolvePath(target, dir, home)
    if (moves) dir = p
    dirs.push(p)
  })
  return dirs
}

/**
 * The paths one tool call works on, in order: its `cwd`, its `path`/`file_path`/`paths`
 * (`;`-separated), the files an `edit` patch names (`[path#TAG]`) and the folders its shell
 * command enters. Relative paths start from its `cwd`, else `base`.
 */
export function callPaths(args: unknown, base: string, home: string | null): string[] {
  if (!isObj(args)) return []
  const paths: string[] = []
  let from = base
  if (typeof args.cwd === 'string') {
    from = resolvePath(args.cwd, base, home)
    paths.push(from)
  }
  for (const key of ['path', 'file_path', 'paths']) {
    const v = args[key]
    if (typeof v !== 'string') continue
    for (const raw of v.split(';')) {
      if (raw.trim() !== '' && !raw.includes('://')) paths.push(resolvePath(raw.trim(), from, home))
    }
  }
  if (typeof args.input === 'string') {
    for (const line of args.input.split(/\r?\n/)) {
      if (!line.startsWith('[') || !line.endsWith(']')) continue
      const inner = line.slice(1, -1)
      const hash = inner.lastIndexOf('#')
      paths.push(resolvePath(hash < 0 ? inner : inner.slice(0, hash), from, home))
    }
  }
  if (typeof args.command === 'string') paths.push(...commandDirs(args.command, from, home))
  return paths
}

/**
 * The worktree folders (directly under the Eva root's `work/`) one session record's tool calls
 * lead into, in order: omp `toolCall`s and Claude Code `tool_use`s; subagents' records aside.
 */
export function recordWorktrees(record: Json, cwd: string, home: string | null): string[] {
  if (record.isSidechain === true || !isObj(record.message)) return []
  const content = record.message.content
  if (!Array.isArray(content)) return []
  const root = evaRootOf(cwd)
  const out: string[] = []
  for (const call of content) {
    if (!isObj(call)) continue
    const args =
      call.type === 'toolCall' ? call.arguments : call.type === 'tool_use' ? call.input : null
    for (const p of callPaths(args, cwd, home)) {
      const dir = worktreeOf(p, root)
      if (dir !== null) out.push(dir)
    }
  }
  return out
}

/**
 * Whether a touched `work/<dir>` counts as a worktree: a git checkout, one a ledger names as its
 * worktree, or one that is gone but whose name carries a ledger's ticket key.
 */
export function keepsWorktree(dir: string, work: readonly WorkLink[]): boolean {
  if (fs.existsSync(path.join(dir, '.git'))) return true
  if (work.some((l) => l.worktree === dir)) return true
  return !fs.existsSync(dir) && ledgerFor(work, dir, '') !== null
}
