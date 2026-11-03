import { describe, expect, it } from 'vitest'
import { fuzzyScore, parseQuery, rankPaths } from './fuzzy'

const PATHS = [
  'apps/desktop/src/renderer/files/FileTree.tsx',
  'apps/desktop/src/renderer/files/files-store.ts',
  'apps/desktop/src/main/files/files-service.ts',
  'apps/desktop/src/renderer/shell/PanelCard.tsx',
  'packages/contract/src/files.ts',
  'docs/fast-tree-notes.md',
  'README.md',
]

const top = (q: string, n = 3): string[] => rankPaths(q, PATHS, n).map((r) => r.path)

describe('fuzzyScore', () => {
  it('matches a subsequence case-insensitively and rejects missing letters', () => {
    expect(fuzzyScore('ftree', 'src/FileTree.tsx')).not.toBeNull()
    expect(fuzzyScore('xyz', 'src/FileTree.tsx')).toBeNull()
  })

  it('returns the matched positions in the path', () => {
    const m = fuzzyScore('pc', 'shell/PanelCard.tsx')!
    expect(m.positions.map((i) => 'shell/PanelCard.tsx'[i])).toEqual(['P', 'C'])
  })

  it('every space-separated piece must match', () => {
    expect(fuzzyScore('main serv', 'apps/desktop/src/main/files/files-service.ts')).not.toBeNull()
    expect(fuzzyScore('main zzz', 'apps/desktop/src/main/files/files-service.ts')).toBeNull()
  })

  it('a consecutive run beats scattered letters', () => {
    const run = fuzzyScore('tree', 'a/tree.ts')!.score
    const spread = fuzzyScore('tree', 'a/t_r_e_e.ts')!.score
    expect(run).toBeGreaterThan(spread)
  })
})

describe('rankPaths', () => {
  it('ranks a file-name match above the same letters spread over folders', () => {
    expect(top('filetree')[0]).toBe('apps/desktop/src/renderer/files/FileTree.tsx')
    const names = rankPaths('tree', ['tree/a/x.ts', 'a/tree.ts'], 2).map((r) => r.path)
    expect(names).toEqual(['a/tree.ts', 'tree/a/x.ts'])
  })

  it('ranks word starts: "fs" finds files-store and files-service first', () => {
    expect(top('fs', 2).sort()).toEqual([
      'apps/desktop/src/main/files/files-service.ts',
      'apps/desktop/src/renderer/files/files-store.ts',
    ])
  })

  it('a folder piece narrows to that folder', () => {
    expect(top('main files', 1)).toEqual(['apps/desktop/src/main/files/files-service.ts'])
  })

  it('an exact name wins and shorter paths break ties', () => {
    expect(top('readme', 1)).toEqual(['README.md'])
    expect(top('files.ts', 1)).toEqual(['packages/contract/src/files.ts'])
  })

  it('the recency boost lifts a recently opened file', () => {
    const boosted = rankPaths('files', PATHS, 1, (p) => (p.endsWith('files-service.ts') ? 5 : 0))
    expect(boosted[0]!.path).toBe('apps/desktop/src/main/files/files-service.ts')
  })
})

describe('parseQuery', () => {
  it('splits a :line and :column suffix off the path query', () => {
    expect(parseQuery('store.ts:42')).toEqual({ query: 'store.ts', line: 42, column: undefined })
    expect(parseQuery('store.ts:42:7')).toEqual({ query: 'store.ts', line: 42, column: 7 })
    expect(parseQuery(' tree ')).toEqual({ query: 'tree', line: undefined, column: undefined })
  })
})
