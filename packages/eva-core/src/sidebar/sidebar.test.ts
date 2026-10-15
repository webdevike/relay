import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { countOpenTodos } from './todos'
import { jobScheduled, parseDurationMs } from './jobs'
import { recentJournal } from './journal'
import { readSidebar } from './read'

const root = join(__dirname, '../../../../fixtures/eva-root')

describe('countOpenTodos', () => {
  it('counts fixture rows', () => {
    expect(countOpenTodos(readFileSync(join(root, 'memory/todos.md'), 'utf8'))).toBe(2)
  })
  it('filters bad rows', () => {
    const t =
      '## Open\n- [x] T3 [a] done\n- [ ] note without id\n- [ ] X9 [a] y\n- [ ] T4 [a] ok\n## Other\n- [ ] T5 [a] no\n'
    expect(countOpenTodos(t)).toBe(1)
    expect(countOpenTodos('- [ ] T1 [a] outside\n')).toBe(0)
  })
})

describe('parseDurationMs', () => {
  it('parses units', () => {
    expect(parseDurationMs('20m')).toBe(1_200_000)
    expect(parseDurationMs('10')).toBe(600_000)
    expect(parseDurationMs('5 s')).toBe(5000)
    expect(parseDurationMs('0m')).toBe(0)
  })
  it('rejects invalid', () => {
    expect(parseDurationMs('soon')).toBeNull()
    expect(parseDurationMs('')).toBeNull()
    expect(parseDurationMs('3w')).toBeNull()
  })
})

describe('jobScheduled', () => {
  it('follows enabled and every', () => {
    expect(jobScheduled('---\nevery: 20m\nenabled: true\n---\nbody')).toBe(true)
    expect(jobScheduled('---\nevery: 20m\nenabled: false\n---\n')).toBe(false)
    expect(jobScheduled('---\nevery: 20m\nenabled: "false"\n---\n')).toBe(false)
    expect(jobScheduled('---\nowner: x\n---\n')).toBe(false)
    expect(jobScheduled('---\nevery: 0m\n---\n')).toBe(false)
    expect(jobScheduled('no frontmatter')).toBe(false)
  })
})

describe('recentJournal', () => {
  it('returns newest first without digest', () => {
    const r = recentJournal(readFileSync(join(root, 'memory/journal.md'), 'utf8'))
    expect(r.map((e) => e.date)).toEqual(['2026-10-03', '2026-10-02', '2026-10-01'])
    expect(r[0]).toEqual({ date: '2026-10-03', tag: 'alpha', title: 'third fixture entry' })
  })
  it('caps at 8 and allows missing tag', () => {
    const t = Array.from(
      { length: 10 },
      (_, i) => `## 2026-10-${String(i + 1).padStart(2, '0')} t${i}`,
    ).join('\n')
    const r = recentJournal(t)
    expect(r).toHaveLength(8)
    expect(r[0]!.tag).toBeNull()
  })
})

describe('readSidebar', () => {
  it('reads the fixture', () => {
    const s = readSidebar(root)
    expect(s.openTodos).toBe(2)
    expect(s.scheduledJobs).toBe(1)
    expect(s.recent).toHaveLength(3)
  })
  it('tolerates a missing root', () => {
    expect(readSidebar('/nonexistent-eva-root')).toEqual({
      openTodos: 0,
      scheduledJobs: 0,
      recent: [],
    })
  })
})
