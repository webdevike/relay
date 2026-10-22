// The chat row's third line: work item key, branch and PR. Pure string logic ported from the
// native app's inbox/links.rs (ledgers, ticket keys, PR URLs) and chat_view/look.rs (WorkLine,
// resolve). Paths are absolute POSIX strings; main reads the files and git HEADs.

/** The ticket prefix of Isaac's Linear team. Other `WORD-123` shapes (UTF-8, SHA-256) are not tickets. */
const TICKET_PREFIX = 'ENG'
/** Branches every ledger might name that say nothing about one piece of work. */
const SHARED_BRANCHES = ['main', 'master', 'develop', 'dev']
/** Branches a checkout sits on when no piece of work is checked out. */
const DEFAULT_BRANCHES = ['main', 'master']

/** What one ledger (`work/items/<key>.md`) says about its work. */
export interface WorkLink {
  key: string
  linear: string | null
  pr: { repo: string; number: number } | null
  branch: string | null
  /** The worktree, absolute. */
  worktree: string | null
  title: string | null
}

/** A chat's work line: the work item's key, its branch and its PR number. */
export interface WorkLine {
  key: string | null
  branch: string | null
  pr: number | null
}

/** The `key: value` fields of a `---` frontmatter block; nested (indented) keys are skipped, first wins. */
export function frontmatter(text: string): Map<string, string> {
  const fields = new Map<string, string>()
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return fields
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break
    const at = line.indexOf(':')
    if (at < 0) continue
    const key = line.slice(0, at)
    if (/^\s/.test(key)) continue
    const name = key.trim()
    if (!fields.has(name)) fields.set(name, line.slice(at + 1).trim())
  }
  return fields
}

/** The ticket keys (`ENG-6227`) in `text`, in order, without repeats. */
export function keysIn(text: string): string[] {
  const keys: string[] = []
  let at = 0
  for (;;) {
    const start = text.indexOf(TICKET_PREFIX, at)
    if (start < 0) return keys
    const digits = start + TICKET_PREFIX.length + 1
    at = start + TICKET_PREFIX.length
    const boundary = start === 0 || !/[A-Za-z0-9]/.test(text[start - 1] ?? '')
    if (!boundary || text[digits - 1] !== '-') continue
    let end = digits
    while (/[0-9]/.test(text[end] ?? '')) end++
    if (end > digits) {
      const key = text.slice(start, end)
      if (!keys.includes(key)) keys.push(key)
      at = end
    }
  }
}

/** Whether `text` is exactly a ticket key. */
export function isTicket(text: string): boolean {
  return keysIn(text)[0] === text
}

/** `owner/repo` and the number of a GitHub pull request URL. */
export function prFromUrl(url: string): { repo: string; number: number } | null {
  const at = url.indexOf('github.com/')
  if (at < 0) return null
  const [owner, repo, kind, num] = url.slice(at + 'github.com/'.length).split('/')
  if (owner === undefined || repo === undefined || kind === undefined || num === undefined) {
    return null
  }
  if (kind !== 'pull' || owner === '' || repo === '') return null
  const digits = /^\d+/.exec(num)?.[0]
  if (digits === undefined) return null
  const number = Number(digits)
  return number > 0 && number <= 0xffff_ffff ? { repo: `${owner}/${repo}`, number } : null
}

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p)

/** `rel` from `root` (an absolute `rel` stands alone), like Rust `Path::join`. */
export function joinPath(root: string, rel: string): string {
  if (rel.startsWith('/')) return trimSlash(rel)
  return `${trimSlash(root)}/${rel}`.replace(/\/+$/, '')
}

/** Whether `p` is `dir` or inside it, whole components only. */
export function pathWithin(p: string, dir: string): boolean {
  const a = trimSlash(p)
  const b = trimSlash(dir)
  return a === b || a.startsWith(b === '/' ? '/' : `${b}/`)
}

/** The ledger `text` named `stem` (under the Eva `root`), or null when it names nothing to fold with. */
export function parseWorkLink(stem: string, text: string, root: string): WorkLink | null {
  const fields = frontmatter(text)
  const field = (name: string): string | null => {
    const v = fields.get(name)
    return v === undefined || v === '' ? null : v
  }
  const key = field('key') ?? stem
  const linearField = field('linear')
  const branch = field('branch')
  const worktree = field('worktree')
  const title = field('title')
  const pr = field('pr')
  const link: WorkLink = {
    key,
    linear:
      (linearField === null ? undefined : keysIn(linearField)[0]) ?? (isTicket(key) ? key : null),
    pr: pr === null ? null : prFromUrl(pr),
    branch: branch !== null && !SHARED_BRANCHES.includes(branch) ? branch : null,
    worktree: worktree === null ? null : joinPath(root, worktree),
    title: title === null ? null : stripTag(title),
  }
  return link.linear !== null || link.pr !== null || link.branch !== null || link.worktree !== null
    ? link
    : null
}

function stripTag(title: string): string {
  if (!title.startsWith('[')) return title
  const end = title.indexOf(']')
  return end < 0 ? title : title.slice(end + 1).trim()
}

/**
 * The ledger a session belongs to: the one whose worktree holds `cwd`, else the first whose key
 * (or Linear ticket) a ticket key in the title, then the cwd, names.
 */
export function ledgerFor(
  work: readonly WorkLink[],
  cwd: string | null,
  title: string,
): WorkLink | null {
  if (cwd !== null) {
    const owner = work.find((l) => l.worktree !== null && pathWithin(cwd, l.worktree))
    if (owner) return owner
  }
  const keys = [...keysIn(title), ...(cwd === null ? [] : keysIn(cwd))]
  for (const key of keys) {
    const lower = key.toLowerCase()
    const hit = work.find((l) => l.key.toLowerCase() === lower || l.linear === key)
    if (hit) return hit
  }
  return null
}

/**
 * The work line from a ledger (its branch falls back to `git`), else a ticket key in `title` and
 * the folder's git branch; null when nothing is known.
 */
export function workLineOf(
  ledger: WorkLink | null,
  title: string,
  git: string | null,
): WorkLine | null {
  const line: WorkLine = ledger
    ? { key: ledger.key, branch: ledger.branch ?? git, pr: ledger.pr?.number ?? null }
    : { key: keysIn(title)[0] ?? null, branch: git, pr: null }
  return line.key === null && line.branch === null && line.pr === null ? null : line
}

/** The text before the PR: the branch, led by the key unless the branch names it. */
export function workLabel(line: Pick<WorkLine, 'key' | 'branch'>): string | null {
  const { key, branch } = line
  if (key !== null && branch !== null) return branch.includes(key) ? branch : `${key} · ${branch}`
  return key ?? branch
}

/** Where a session works: its folder, the worktree its tool calls last touched, and their branches. */
export interface Place {
  cwd: string | null
  active: string | null
  activeBranch: string | null
  cwdBranch: string | null
  /** The folder is the Eva checkout itself (it holds `work/items`). */
  eva: boolean
}

/**
 * The third line of a chat at `place` titled `title` (native look.rs resolve): (1) the active
 * worktree's ledger, else its branch and a key from its folder name; (2) else the session's
 * ledger; (3) else a key in the title and the folder's branch, which says nothing when it is the
 * Eva checkout's default branch. A ledger with no branch of its own does not claim a checkout on
 * its default branch.
 */
export function resolveWorkLine(
  place: Place,
  title: string,
  work: readonly WorkLink[],
): WorkLine | null {
  if (place.active !== null) {
    const branch = place.activeBranch
    const shared = branch !== null && DEFAULT_BRANCHES.includes(branch)
    const ledger = ledgerFor(work, place.active, '')
    if (ledger && (ledger.branch !== null || !shared)) return workLineOf(ledger, '', branch)
    const line = workLineOf(null, trimSlash(place.active).split('/').pop() ?? '', branch)
    if (line) return line
  }
  const branch =
    place.cwdBranch !== null && !(place.eva && DEFAULT_BRANCHES.includes(place.cwdBranch))
      ? place.cwdBranch
      : null
  return workLineOf(ledgerFor(work, place.cwd, title), title, branch)
}
