// A worktree's git state for the context popover: branch, upstream, ahead/behind, uncommitted
// files, an operation in progress, and the diff against the PR's base. Read only (status, rev-list,
// diff); run in the background through a BackgroundCache.
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface GitFacts {
  /** Null when HEAD is detached. */
  branch: string | null
  /** `origin/<branch>` or the configured upstream; null when the branch was never pushed. */
  upstream: string | null
  ahead: number
  behind: number
  /** Changed, added, deleted or untracked paths. */
  dirty: number
  conflicted: boolean
  /** A merge, rebase or cherry-pick is in progress. */
  busy: boolean
  /** Lines added and removed against `base` (merge-base diff), when a base was given and exists. */
  diff: { add: number; del: number } | null
}

export type GitRun = (
  args: string[],
  cwd: string,
) => Promise<{ code: number | null; stdout: string }>

export function parseStatus(stdout: string): {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  dirty: number
  conflicted: boolean
} {
  let branch: string | null = null
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  let dirty = 0
  let conflicted = false
  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim()
      branch = head === '(detached)' ? null : head
    } else if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim()
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      if (m) {
        ahead = Number(m[1])
        behind = Number(m[2])
      }
    } else if (line.startsWith('u ')) {
      conflicted = true
      dirty++
    } else if (/^[12?] /.test(line)) dirty++
  }
  return { branch, upstream, ahead, behind, dirty, conflicted }
}

/** `N files changed, A insertions(+), D deletions(-)` → { add, del }. */
export function parseShortstat(stdout: string): { add: number; del: number } {
  const add = /(\d+) insertions?\(\+\)/.exec(stdout)
  const del = /(\d+) deletions?\(-\)/.exec(stdout)
  return { add: add ? Number(add[1]) : 0, del: del ? Number(del[1]) : 0 }
}

/** The facts for the checkout at `dir`; null when it is not a git checkout. */
export async function readGit(
  run: GitRun,
  dir: string,
  base: string | null,
): Promise<GitFacts | null> {
  const status = await run(
    ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'],
    dir,
  )
  if (status.code !== 0) return null
  const s = parseStatus(status.stdout)
  let { upstream, ahead, behind } = s
  // Isaac's worktrees often push without tracking: compare with origin/<branch> when it exists.
  if (upstream === null && s.branch !== null) {
    const counts = await run(
      ['rev-list', '--left-right', '--count', `origin/${s.branch}...HEAD`],
      dir,
    )
    if (counts.code === 0) {
      const [b, a] = counts.stdout.trim().split(/\s+/).map(Number)
      upstream = `origin/${s.branch}`
      behind = b ?? 0
      ahead = a ?? 0
    }
  }
  let busy = false
  const gitDir = await run(['rev-parse', '--absolute-git-dir'], dir)
  if (gitDir.code === 0) {
    const g = gitDir.stdout.trim()
    busy = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].some(
      (name) => fs.existsSync(path.join(g, name)),
    )
  }
  let diff: GitFacts['diff'] = null
  if (base !== null) {
    const d = await run(['diff', '--shortstat', `origin/${base}...HEAD`], dir)
    if (d.code === 0) diff = parseShortstat(d.stdout)
  }
  return {
    branch: s.branch,
    upstream,
    ahead,
    behind,
    dirty: s.dirty,
    conflicted: s.conflicted,
    busy,
    diff,
  }
}

/** Branches nobody commits feature work to. */
const SHARED = ['main', 'master', 'develop', 'dev']

/**
 * Whether Commit & push is safe to offer: a feature branch with something to commit or push,
 * nothing to pull first, no conflict or operation in progress, and a PR that is still open.
 */
export function canCommitPush(g: GitFacts, prOpen: boolean | null): boolean {
  if (g.branch === null || SHARED.includes(g.branch)) return false
  if (g.conflicted || g.busy || g.behind > 0) return false
  if (prOpen === false) return false
  return g.dirty > 0 || g.ahead > 0
}
