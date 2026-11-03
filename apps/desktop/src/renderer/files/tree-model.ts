import type { FileEntry, GitCode, GitStatus } from '@evaos/contract'

/** Hidden like VS Code's files.exclude when the root is not a git checkout. */
const DEFAULT_IGNORED = new Set(['node_modules', '.DS_Store'])

/** Which change a folder shows when several sit below it: conflicts first, then edits. */
const RANK: Record<GitCode, number> = { C: 6, M: 5, D: 4, A: 3, R: 2, U: 1 }

export function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** `a/b/c` gives `['a', 'a/b']`: the folders to expand to show it. */
export function ancestorsOf(path: string): string[] {
  const out: string[] = []
  let i = path.indexOf('/')
  while (i >= 0) {
    out.push(path.slice(0, i))
    i = path.indexOf('/', i + 1)
  }
  return out
}

export interface Decoration {
  code: GitCode
  /** True on a folder colored by a change somewhere below it. */
  inherited: boolean
}

/** Git colors and ignore rules for tree rows, built once per status. */
export class Decorator {
  private readonly changes: Record<string, GitCode>
  private readonly folders = new Map<string, GitCode>()
  private readonly ignored: Set<string>
  private readonly repo: boolean

  constructor(status: GitStatus | null) {
    this.repo = status?.repo === true
    this.changes = status?.changes ?? {}
    this.ignored = new Set(status?.ignored ?? [])
    for (const [path, code] of Object.entries(this.changes)) {
      for (const dir of ancestorsOf(path)) {
        const had = this.folders.get(dir)
        if (had === undefined || RANK[code] > RANK[had]) this.folders.set(dir, code)
      }
    }
  }

  decorate(path: string, kind: 'file' | 'dir'): Decoration | null {
    const own = this.changes[path]
    if (own) return { code: own, inherited: false }
    // Inside an untracked folder (git reports the folder alone).
    for (const dir of ancestorsOf(path))
      if (this.changes[dir] === 'U') return { code: 'U', inherited: false }
    if (kind === 'dir') {
      const below = this.folders.get(path)
      if (below) return { code: below, inherited: true }
    }
    return null
  }

  isIgnored(path: string, kind: 'file' | 'dir'): boolean {
    if (!this.repo) return DEFAULT_IGNORED.has(nameOf(path))
    if (this.ignored.has(kind === 'dir' ? `${path}/` : path)) return true
    for (const dir of ancestorsOf(path)) if (this.ignored.has(`${dir}/`)) return true
    return false
  }
}

export interface TreeRow {
  entry: FileEntry
  depth: number
  expanded: boolean
  /** Children requested but not listed yet. */
  loading: boolean
  ignored: boolean
  decoration: Decoration | null
}

/** The rows the tree shows, in order: every listed entry under an expanded folder chain. */
export function visibleRows(
  children: Readonly<Record<string, readonly FileEntry[]>>,
  expanded: ReadonlySet<string>,
  decorator: Decorator,
  showIgnored: boolean,
): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (dir: string, depth: number): void => {
    for (const entry of children[dir] ?? []) {
      const ignored = decorator.isIgnored(entry.path, entry.kind)
      if (ignored && !showIgnored) continue
      const open = entry.kind === 'dir' && expanded.has(entry.path)
      rows.push({
        entry,
        depth,
        expanded: open,
        loading: open && children[entry.path] === undefined,
        ignored,
        decoration: decorator.decorate(entry.path, entry.kind),
      })
      if (open) walk(entry.path, depth + 1)
    }
  }
  walk('', 0)
  return rows
}
