import { describe, expect, it } from 'vitest'
import type { FileEntry, GitStatus } from '@evaos/contract'
import { Decorator, ancestorsOf, visibleRows } from './tree-model'

const e = (path: string, kind: 'file' | 'dir' = 'file'): FileEntry => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  kind,
  symlink: false,
  locked: false,
})

const status: GitStatus = {
  repo: true,
  branch: 'main',
  changes: { 'src/a.ts': 'M', 'src/deep/b.ts': 'A', fresh: 'U', 'src/c.ts': 'C' },
  ignored: ['dist/', 'debug.log'],
}

describe('Decorator', () => {
  const d = new Decorator(status)

  it('codes a changed file and colors its folders by the strongest change below', () => {
    expect(d.decorate('src/a.ts', 'file')).toEqual({ code: 'M', inherited: false })
    expect(d.decorate('src', 'dir')).toEqual({ code: 'C', inherited: true })
    expect(d.decorate('src/deep', 'dir')).toEqual({ code: 'A', inherited: true })
    expect(d.decorate('src/clean.ts', 'file')).toBeNull()
  })

  it('an untracked folder covers everything inside it', () => {
    expect(d.decorate('fresh', 'dir')).toEqual({ code: 'U', inherited: false })
    expect(d.decorate('fresh/x/y.ts', 'file')).toEqual({ code: 'U', inherited: false })
  })

  it('ignores folders (with everything below) and single files', () => {
    expect(d.isIgnored('dist', 'dir')).toBe(true)
    expect(d.isIgnored('dist/out/main.js', 'file')).toBe(true)
    expect(d.isIgnored('debug.log', 'file')).toBe(true)
    expect(d.isIgnored('src/a.ts', 'file')).toBe(false)
  })

  it('outside git hides node_modules and .DS_Store only', () => {
    const plain = new Decorator({ repo: false, branch: null, changes: {}, ignored: [] })
    expect(plain.isIgnored('node_modules', 'dir')).toBe(true)
    expect(plain.isIgnored('a/.DS_Store', 'file')).toBe(true)
    expect(plain.isIgnored('dist', 'dir')).toBe(false)
  })
})

describe('visibleRows', () => {
  const children = {
    '': [e('dist', 'dir'), e('src', 'dir'), e('debug.log'), e('README.md')],
    src: [e('src/deep', 'dir'), e('src/a.ts')],
  }
  const d = new Decorator(status)

  it('walks expanded folders depth-first and hides ignored entries', () => {
    const rows = visibleRows(children, new Set(['src', 'src/deep']), d, false)
    expect(rows.map((r) => [r.entry.path, r.depth])).toEqual([
      ['src', 0],
      ['src/deep', 1],
      ['src/a.ts', 1],
      ['README.md', 0],
    ])
    expect(rows[1]!.loading).toBe(true)
    expect(rows[0]!.expanded).toBe(true)
  })

  it('shows ignored entries, flagged, when asked', () => {
    const rows = visibleRows(children, new Set(), d, true)
    expect(rows.filter((r) => r.ignored).map((r) => r.entry.path)).toEqual(['dist', 'debug.log'])
  })
})

describe('ancestorsOf', () => {
  it('lists the folders above a path, outermost first', () => {
    expect(ancestorsOf('a/b/c.ts')).toEqual(['a', 'a/b'])
    expect(ancestorsOf('top.ts')).toEqual([])
  })
})
