// The Diff tab's file rail as data: the PR's files filtered (path query, viewed state) and folded
// into a folder tree for Mantine's Tree, single-child folders compacted (`src/main/reviews`), each
// folder carrying its files' +/- and viewed counts. Pure: no React, no prefs.
import type { TreeNodeData } from '@mantine/core'

export interface PrFile {
  path: string
  additions: number
  deletions: number
  /** ADDED, MODIFIED, DELETED, RENAMED, ... as GitHub reports it. */
  change: string
}

export type FileFilter = 'all' | 'unviewed' | 'viewed'

/** What a row shows besides its label. */
export interface FileFacts {
  kind: 'dir' | 'file'
  /** A file's path, or a folder's full path (no trailing slash). */
  path: string
  additions: number
  deletions: number
  /** Files under it (1 for a file). */
  files: number
  /** Of those, how many are marked Viewed. */
  viewed: number
  /** A file's change (null for a folder). */
  change: string | null
}

export interface FileTreeNode extends TreeNodeData {
  label: string
  nodeProps: FileFacts
  children?: FileTreeNode[]
}

/** Rail width bounds and step (px). */
export const RAIL_MIN = 200
export const RAIL_MAX = 480
export const RAIL_STEP = 16

export const clampRail = (w: number): number =>
  Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(w)))

/**
 * The files the rail and the diff list show: the query matches anywhere in the path (any case), the
 * filter by Viewed. `reveal` (a file the Guide pointed at) always stays, whatever the filter says.
 */
export function visibleFiles<F extends PrFile>(
  files: readonly F[],
  opts: { query: string; filter: FileFilter; viewed: ReadonlySet<string>; reveal: string | null },
): F[] {
  const q = opts.query.trim().toLowerCase()
  return files.filter((f) => {
    if (f.path === opts.reveal) return true
    if (q && !f.path.toLowerCase().includes(q)) return false
    return opts.filter === 'all' || (opts.filter === 'viewed') === opts.viewed.has(f.path)
  })
}

interface Dir {
  dirs: Map<string, Dir>
  files: PrFile[]
}

function dirOf(files: readonly PrFile[]): Dir {
  const root: Dir = { dirs: new Map(), files: [] }
  for (const f of files) {
    const parts = f.path.split('/')
    let at = root
    for (const p of parts.slice(0, -1)) {
      let next = at.dirs.get(p)
      if (!next) {
        next = { dirs: new Map(), files: [] }
        at.dirs.set(p, next)
      }
      at = next
    }
    at.files.push(f)
  }
  return root
}

const byLabel = (a: FileTreeNode, b: FileTreeNode): number =>
  a.label.localeCompare(b.label, undefined, { numeric: true })

function fileNode(f: PrFile, viewed: ReadonlySet<string>): FileTreeNode {
  const on = viewed.has(f.path)
  return {
    value: f.path,
    label: f.path.slice(f.path.lastIndexOf('/') + 1),
    nodeProps: {
      kind: 'file',
      path: f.path,
      additions: f.additions,
      deletions: f.deletions,
      files: 1,
      viewed: on ? 1 : 0,
      change: f.change,
    },
  }
}

function dirNode(name: string, base: string, dir: Dir, viewed: ReadonlySet<string>): FileTreeNode {
  // Compact a chain of folders that each hold only one folder: `src/main/reviews` is one row.
  let label = name
  let path = base ? `${base}/${name}` : name
  let at = dir
  while (at.files.length === 0 && at.dirs.size === 1) {
    const [[next, sub]] = [...at.dirs] as [[string, Dir]]
    label = `${label}/${next}`
    path = `${path}/${next}`
    at = sub
  }
  const children = childrenOf(at, path, viewed)
  const sum = (k: 'additions' | 'deletions' | 'files' | 'viewed'): number =>
    children.reduce((n, c) => n + c.nodeProps[k], 0)
  return {
    value: path,
    label,
    nodeProps: {
      kind: 'dir',
      path,
      additions: sum('additions'),
      deletions: sum('deletions'),
      files: sum('files'),
      viewed: sum('viewed'),
      change: null,
    },
    children,
  }
}

function childrenOf(dir: Dir, base: string, viewed: ReadonlySet<string>): FileTreeNode[] {
  const dirs = [...dir.dirs].map(([name, d]) => dirNode(name, base, d, viewed)).sort(byLabel)
  const files = dir.files.map((f) => fileNode(f, viewed)).sort(byLabel)
  return [...dirs, ...files]
}

/** Folders first, then files, each by name; single-child folders compacted. */
export function buildFileTree(
  files: readonly PrFile[],
  viewed: ReadonlySet<string>,
): FileTreeNode[] {
  return childrenOf(dirOf(files), '', viewed)
}

/** The file paths in the order the tree shows them (the diff list follows it). */
export function treeOrder(nodes: readonly FileTreeNode[]): string[] {
  return nodes.flatMap((n) => (n.children ? treeOrder(n.children) : [n.value]))
}

/** The folder values that hold `path`, outermost first (expand them to reveal it); [] when absent. */
export function ancestorsOf(nodes: readonly FileTreeNode[], path: string): string[] {
  for (const n of nodes) {
    if (!n.children) continue
    if (!path.startsWith(`${n.value}/`)) continue
    return [n.value, ...ancestorsOf(n.children, path)]
  }
  return []
}

/** Every folder's value (the tree opens fully by default). */
export function folderValues(nodes: readonly FileTreeNode[]): string[] {
  return nodes.flatMap((n) => (n.children ? [n.value, ...folderValues(n.children)] : []))
}
