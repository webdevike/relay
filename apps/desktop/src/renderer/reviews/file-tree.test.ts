import { describe, expect, it } from 'vitest'
import {
  ancestorsOf,
  buildFileTree,
  clampRail,
  folderValues,
  treeOrder,
  visibleFiles,
  type FileTreeNode,
  type PrFile,
} from './file-tree'

const f = (path: string, additions = 1, deletions = 0, change = 'MODIFIED'): PrFile => ({
  path,
  additions,
  deletions,
  change,
})

const FILES = [
  f('apps/desktop/src/renderer/reviews/DiffView.tsx', 10, 2),
  f('apps/desktop/src/renderer/reviews/FileTree.tsx', 40, 0, 'ADDED'),
  f('apps/desktop/src/main/ipc.ts', 3, 1),
  f('README.md', 1, 1),
  f('docs/a.md', 2, 0),
]

const shape = (nodes: readonly FileTreeNode[]): unknown =>
  nodes.map((n) => (n.children ? { [n.label]: shape(n.children) } : n.label))

describe('file tree', () => {
  it('compacts single-child folders and puts folders before files', () => {
    const tree = buildFileTree(FILES, new Set())
    expect(shape(tree)).toEqual([
      {
        'apps/desktop/src': [
          { main: ['ipc.ts'] },
          { 'renderer/reviews': ['DiffView.tsx', 'FileTree.tsx'] },
        ],
      },
      { docs: ['a.md'] },
      'README.md',
    ])
    expect(tree[0]!.value).toBe('apps/desktop/src')
    expect(tree[0]!.children![1]!.value).toBe('apps/desktop/src/renderer/reviews')
    expect(treeOrder(tree)).toEqual([
      'apps/desktop/src/main/ipc.ts',
      'apps/desktop/src/renderer/reviews/DiffView.tsx',
      'apps/desktop/src/renderer/reviews/FileTree.tsx',
      'docs/a.md',
      'README.md',
    ])
    expect(folderValues(tree)).toEqual([
      'apps/desktop/src',
      'apps/desktop/src/main',
      'apps/desktop/src/renderer/reviews',
      'docs',
    ])
  })

  it('sums +/- and files per folder, and counts viewed files', () => {
    const tree = buildFileTree(FILES, new Set(['apps/desktop/src/main/ipc.ts', 'README.md']))
    expect(tree[0]!.nodeProps).toMatchObject({
      kind: 'dir',
      additions: 53,
      deletions: 3,
      files: 3,
      viewed: 1,
      change: null,
    })
    expect(tree[2]!.nodeProps).toMatchObject({
      kind: 'file',
      files: 1,
      viewed: 1,
      change: 'MODIFIED',
    })
    const added = tree[0]!.children![1]!.children![1]!
    expect(added.nodeProps).toMatchObject({ change: 'ADDED', additions: 40, viewed: 0 })
  })

  it('filters by path (any case) and by viewed state', () => {
    const viewed = new Set(['README.md'])
    const paths = (query: string, filter: 'all' | 'viewed' | 'unviewed') =>
      visibleFiles(FILES, { query, filter, viewed, reveal: null }).map((x) => x.path)
    expect(paths('REVIEWS', 'all')).toEqual([
      'apps/desktop/src/renderer/reviews/DiffView.tsx',
      'apps/desktop/src/renderer/reviews/FileTree.tsx',
    ])
    expect(paths('', 'viewed')).toEqual(['README.md'])
    expect(paths('md', 'unviewed')).toEqual(['docs/a.md'])
    expect(paths('  ', 'all')).toHaveLength(FILES.length)
  })

  it('keeps a revealed file under any filter and finds the folders to open for it', () => {
    const viewed = new Set(['docs/a.md'])
    const shown = visibleFiles(FILES, {
      query: 'ipc',
      filter: 'unviewed',
      viewed,
      reveal: 'docs/a.md',
    })
    expect(shown.map((x) => x.path)).toEqual(['apps/desktop/src/main/ipc.ts', 'docs/a.md'])
    const tree = buildFileTree(shown, viewed)
    expect(ancestorsOf(tree, 'docs/a.md')).toEqual(['docs'])
    expect(ancestorsOf(tree, 'apps/desktop/src/main/ipc.ts')).toEqual(['apps/desktop/src/main'])
    expect(
      ancestorsOf(buildFileTree(FILES, viewed), 'apps/desktop/src/renderer/reviews/DiffView.tsx'),
    ).toEqual(['apps/desktop/src', 'apps/desktop/src/renderer/reviews'])
    expect(ancestorsOf(tree, 'nope.ts')).toEqual([])
  })

  it('bounds the rail width', () => {
    expect(clampRail(120)).toBe(200)
    expect(clampRail(333.4)).toBe(333)
    expect(clampRail(900)).toBe(480)
  })
})
