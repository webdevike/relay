import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseJournal } from './journal'
import { workspaceFiles } from './read-eva'
import {
  EVA_BUILTIN_TEXT,
  dailyActivity,
  sortWorkspaces,
  timeline,
  withBuiltIn,
  workspaceFrom,
  type Workspace,
} from './workspaces'

const DASH = '—'
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'evaos-ws-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function put(rel: string, text: string): void {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
}

describe('workspace discovery', () => {
  it('counts flat files and nested <id>/<id>.md only', () => {
    put('workspaces/flo.md', '# Flo\n')
    put('workspaces/bambee/bambee.md', '# Bambee\n')
    put('workspaces/hexagon/notes.md', '# nope\n')
    put('workspaces/ecardsystems/roadmap.md', '# nope\n')
    put('workspaces/readme.txt', 'x')
    const files = workspaceFiles(root)
    expect(files.map((f) => [f.id, f.path])).toEqual([
      ['bambee', 'workspaces/bambee/bambee.md'],
      ['flo', 'workspaces/flo.md'],
    ])
  })
  it('adds the built-in Eva workspace only when absent', () => {
    const only = withBuiltIn([{ id: 'flo', path: 'workspaces/flo.md', text: '# Flo' }])
    expect(only.map((f) => f.id)).toEqual(['flo', 'eva'])
    expect(only[1]).toEqual({ id: 'eva', path: null, text: EVA_BUILTIN_TEXT })
    const has = withBuiltIn([{ id: 'eva', path: 'workspaces/eva.md', text: '# Eva' }])
    expect(has).toHaveLength(1)
  })
})

const WS_TEXT = `# Flo ${DASH} Field ops (beta)

Status: Live and shipping. More.

## Overview

First line.

## Threads

- 2026-10-12 ${DASH} Shipped the thing
- 2026-10-14: **Fixed** [bug](http://x) now
- not a date line
### 2026-10-15 ${DASH} heading threads are ignored

## Notes
- trailing
`

describe('workspaceFrom', () => {
  const journal = parseJournal(
    `## 2026-10-14 ${DASH} [flo] Journal title\n- b1\n\n## 2026-10-10 [relay] Other\n\n## 2026-10-12 [flo] Older\n`,
    'memory/journal.md',
  )
  const ws = workspaceFrom(
    { id: 'flo', path: 'workspaces/flo.md', text: WS_TEXT },
    journal,
    ['flo', 'flo', 'relay'],
  )

  it('extracts names, tagline, sections and bodies', () => {
    expect(ws.name).toBe(`Flo ${DASH} Field ops (beta)`)
    expect(ws.displayName).toBe('Flo')
    expect(ws.tagline).toBe('Live and shipping.')
    expect(ws.sections.map((s) => s.title)).toEqual(['Overview', 'Threads', 'Notes'])
    expect(ws.sections[0]!.body).toBe('\nFirst line.')
    expect(ws.sections[2]!.body).toBe('- trailing')
    expect(ws.builtIn).toBe(false)
    expect(ws.path).toBe('workspaces/flo.md')
  })
  it('reads dated thread bullets only', () => {
    expect(ws.notes).toEqual([
      { date: '2026-10-14', text: 'Fixed bug now' },
      { date: '2026-10-12', text: 'Shipped the thing' },
    ])
  })
  it('merges activity and picks latest by the tie rule', () => {
    expect(ws.activity).toEqual(['2026-10-14', '2026-10-14', '2026-10-12', '2026-10-12'])
    expect(ws.lastActive).toBe('2026-10-14')
    expect(ws.latest).toBe('Journal title')
    expect(ws.openTodos).toBe(2)
  })
  it('prefers the newer thread note over an older journal entry', () => {
    const w = workspaceFrom(
      { id: 'flo', path: null, text: '# Flo\n\n## Threads\n- 2026-10-15 note text\n' },
      journal,
      [],
    )
    expect(w.latest).toBe('note text')
    const none = workspaceFrom({ id: 'x', path: null, text: 'no heading' }, [], [])
    expect([none.name, none.latest, none.lastActive]).toEqual(['x', null, null])
  })
})

describe('sortWorkspaces', () => {
  const mk = (displayName: string, lastActive: string | null): Workspace =>
    ({ id: displayName, name: displayName, displayName, lastActive }) as Workspace
  it('orders by lastActive desc, none last, then name', () => {
    const list = [mk('b', null), mk('z', '2026-10-01'), mk('a', null), mk('m', '2026-10-09')]
    expect(sortWorkspaces(list).map((w) => w.id)).toEqual(['m', 'z', 'a', 'b'])
  })
})

describe('dailyActivity', () => {
  it('buckets oldest first and drops future dates', () => {
    const a = ['2026-10-15', '2026-10-15', '2026-10-09', '2026-10-16']
    expect(dailyActivity(a, '2026-10-15', 7)).toEqual([1, 0, 0, 0, 0, 0, 2])
    expect(dailyActivity([], '2026-10-15', 30)).toHaveLength(30)
    expect(dailyActivity([], '2026-10-15', 90)).toHaveLength(90)
    const rust = ['2026-10-02', '2026-10-02', '2026-09-30', '2026-08-01']
    expect(dailyActivity(rust, '2026-10-02', 3)).toEqual([1, 0, 2])
  })
})

describe('timeline', () => {
  it('merges journal and thread notes, newest first, journal first within a day', () => {
    const journal = parseJournal(
      '## 2026-10-14 [flo] J1\n\n## 2026-10-12 [flo] J2\n\n## 2026-10-13 [relay] other\n',
      'memory/archive/old.md',
    )
    const ws = workspaceFrom(
      { id: 'flo', path: null, text: '# Flo\n\n## Threads\n- 2026-10-14 T1\n- 2026-10-11 T2\n' },
      journal,
      [],
    )
    expect(timeline(ws, journal)).toEqual([
      { date: '2026-10-14', kind: 'journal', title: 'J1', source: 'memory/archive/old.md' },
      { date: '2026-10-14', kind: 'thread', title: 'T1', source: 'Threads' },
      { date: '2026-10-12', kind: 'journal', title: 'J2', source: 'memory/archive/old.md' },
      { date: '2026-10-11', kind: 'thread', title: 'T2', source: 'Threads' },
    ])
  })
})
