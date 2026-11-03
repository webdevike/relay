import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  activityRows,
  buildDashboard,
  filterCounts,
  matchesFilter,
  splitRecent,
  summaryLine,
  toSummary,
} from './dashboard'
import { parseJournal } from './journal'
import { readDashboard, readTodoTexts, readWorkspaceDetail } from './read-eva'
import { workspaceFrom } from './workspaces'

const TODAY = '2026-10-15'
const f = { lastActive: null as string | null, openTodos: 0 }

describe('filters', () => {
  it('matches Active, Quiet, Has Todos and All', () => {
    const at = (d: string | null, t = 0) => ({ lastActive: d, openTodos: t })
    expect(matchesFilter(at('2026-10-01'), 'active', TODAY)).toBe(true) // 14 days
    expect(matchesFilter(at('2026-09-30'), 'active', TODAY)).toBe(false) // 15 days
    expect(matchesFilter(at(null), 'active', TODAY)).toBe(false)
    expect(matchesFilter(at(null), 'quiet', TODAY)).toBe(true)
    expect(matchesFilter(at('2026-09-15'), 'quiet', TODAY)).toBe(false) // 30 days
    expect(matchesFilter(at('2026-09-14'), 'quiet', TODAY)).toBe(true) // 31 days
    expect(matchesFilter(at('2026-09-30'), 'quiet', TODAY)).toBe(false) // 15: neither
    expect(matchesFilter(at('2026-10-15', 0), 'todos', TODAY)).toBe(false)
    expect(matchesFilter(at(null, 2), 'todos', TODAY)).toBe(true)
    expect(matchesFilter(f, 'all', TODAY)).toBe(true)
  })
  it('counts over all workspaces and splits the recent two', () => {
    const list = [
      { lastActive: '2026-10-14', openTodos: 1 },
      { lastActive: '2026-10-01', openTodos: 0 },
      { lastActive: '2026-09-30', openTodos: 0 },
      { lastActive: null, openTodos: 3 },
    ]
    expect(filterCounts(list, TODAY)).toEqual({ all: 4, active: 2, todos: 2, quiet: 1 })
    const { recent, rest } = splitRecent([1, 2, 3, 4])
    expect(recent).toEqual([1, 2])
    expect(rest).toEqual([3, 4])
    expect(splitRecent([1])).toEqual({ recent: [1], rest: [] })
  })
  it('builds the summary line', () => {
    expect(summaryLine(7, 5, 4)).toBe('7 workspaces, 5 open todos, 4 updates this week')
    expect(summaryLine(1, 1, 1)).toBe('1 workspace, 1 open todo, 1 update this week')
    expect(summaryLine(0, 0, 0)).toBe('0 workspaces, 0 open todos, 0 updates this week')
  })
})

describe('activityRows', () => {
  const daily = Array.from({ length: 90 }, (_, i) => i)
  it('labels a 7 day range with weekday initials', () => {
    const rows = activityRows(daily, 7, TODAY)
    expect(rows.map((r) => r.date)).toEqual([
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
    ])
    expect(rows.map((r) => r.count)).toEqual([83, 84, 85, 86, 87, 88, 89])
    expect(rows.map((r) => r.tick)).toEqual(['F', 'S', 'S', 'M', 'T', 'W', 'T'])
    expect(rows.map((r) => r.inWeek)).toEqual([false, false, false, true, true, true, true])
    expect(rows.map((r) => r.isToday)).toEqual([false, false, false, false, false, false, true])
  })
  it('labels Mondays on longer ranges', () => {
    for (const range of [30, 90] as const) {
      const rows = activityRows(daily, range, TODAY)
      expect(rows).toHaveLength(range)
      const monday = rows.find((r) => r.date === '2026-10-12')!
      expect(monday.tick).toBe('Oct 12')
      expect(rows.find((r) => r.date === '2026-10-13')!.tick).toBe('')
    }
  })
})

describe('buildDashboard', () => {
  it('counts only recent journal entries as updates and ships all todos', () => {
    const journal = parseJournal(
      '## 2026-10-14 [flo] A\n\n## 2026-10-08 [flo] B\n\n## 2026-10-07 [flo] C\n\n## 2026-10-01 [eva] D\n',
      'memory/journal.md',
    )
    const files = [
      { id: 'flo', path: 'workspaces/flo.md', text: '# Flo\n\n## Threads\n- 2026-10-15 thread\n' },
    ]
    const todos = [
      { id: 'T1', tag: 'flo', text: 'a', added: null },
      { id: 'T2', tag: 'eva', text: 'b', added: null },
    ]
    const p = buildDashboard(files, journal, todos, TODAY, 123)
    expect(p.updates7d).toBe(2)
    expect(p.generatedAt).toBe(123)
    expect(p.todos.map((t) => t.id)).toEqual(['T1', 'T2'])
    expect(p.workspaces.map((w) => w.id)).toEqual(['flo', 'eva'])
    expect(p.workspaces.every((w) => w.daily.length === 90)).toBe(true)
    const flo = p.workspaces[0]!
    expect(flo.openTodos).toBe(1)
    expect(flo.daily[89]).toBe(1)
    expect(toSummary(workspaceFrom(files[0]!, journal, []), TODAY).hasFile).toBe(true)
  })
})

describe('readers', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'evaos-dash-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  const put = (rel: string, text: string): void => {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, text)
  }

  it('reads a tree', () => {
    put('workspaces/goodops.md', '# GoodOps (formerly GoodWord)\n\nTagline here.\n')
    put('memory/journal.md', '## 2026-10-14 [goodword] Alias entry\n- x\n')
    put('memory/archive/2026-09.md', '## 2026-09-01 [eva] Old one\n')
    put(
      'memory/todos.md',
      '# Todos\n\n## Open\n\n- [ ] T2 [eva-app] second\n- [ ] T1 [goodword] first\n',
    )
    const p = readDashboard(root, TODAY, 5)
    expect(p.today).toBe(TODAY)
    expect(p.workspaces.map((w) => w.id).sort()).toEqual(['eva', 'goodops'])
    const goodops = p.workspaces.find((w) => w.id === 'goodops')!
    expect(goodops.aliases).toEqual(['goodword'])
    expect(goodops.openTodos).toBe(1)
    expect(goodops.lastActive).toBe('2026-10-14')
    expect(goodops.hasFile).toBe(true)
    const eva = p.workspaces.find((w) => w.id === 'eva')!
    expect(eva.hasFile).toBe(false)
    expect(eva.builtIn).toBe(true)
    expect(eva.lastActive).toBe('2026-09-01')
    expect(p.todos.map((t) => t.id)).toEqual(['T2', 'T1'])
    const d = readWorkspaceDetail(root, 'goodops', TODAY)
    expect(d.workspace?.id).toBe('goodops')
    expect(d.timeline[0]).toMatchObject({ title: 'Alias entry', source: 'memory/journal.md' })
    expect(d.todos.map((t) => t.id)).toEqual(['T1'])
    expect(readWorkspaceDetail(root, 'nope', TODAY).workspace).toBeNull()
    const texts = readTodoTexts(root)
    expect(texts.done).toBe('')
    expect(texts.todos).toContain('T2')
  })

  it('tolerates a missing tree', () => {
    const p = readDashboard(root, TODAY, 5)
    expect(p.workspaces.map((w) => w.id)).toEqual(['eva'])
    expect(p.todos).toEqual([])
    expect(p.updates7d).toBe(0)
    expect(readTodoTexts(root)).toEqual({ todos: null, done: '' })
  })
})
