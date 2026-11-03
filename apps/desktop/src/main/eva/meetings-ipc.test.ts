import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { makeEvaFixture } from '../../../e2e/helpers/eva-fixture'
import { createEvaFs, type EvaFs } from '@evaos/eva-core'
import {
  meetingsAccept,
  meetingsDismiss,
  meetingsGet,
  meetingsList,
  meetingsOpenNotes,
} from './meetings-ipc'

const fixtures: Array<{ cleanup(): void }> = []
const NOW = new Date(2026, 9, 15, 12, 0, 0)
const clock = { now: () => NOW }

function tmpRoot(): string {
  const fx = makeEvaFixture({ now: NOW })
  fixtures.push(fx)
  return fx.root
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup()
})

describe('meetings.list', () => {
  it('lists, sorts and digests the fixture meetings', () => {
    const r = meetingsList(tmpRoot(), clock)
    expect(r.meetings.map((m) => m.stem)).toEqual([
      'test-call',
      'standup',
      'planning',
      'retro',
      'undated',
    ])
    const by = (s: string) => r.meetings.find((m) => m.stem === s)!
    expect(by('test-call').skipped).toBe(true)
    expect(by('standup').pending).toBe(2)
    expect(by('planning').pending).toBe(1)
    expect(r.digest.recentCount).toBe(2)
    expect(r.digest.waiting).toHaveLength(3)
    expect(r.digest.out.map((o) => o.text)).toContain('Sam is out')
    expect(r.digest.out[0]!.date).toBe('2026-10-18')
    expect(r.digest.decisions.map((d) => d.text)).toContain('Ship the beta Friday')
  })
})

describe('meetings.get', () => {
  it('returns proposals, memorized and parsed notes', () => {
    const r = meetingsGet(tmpRoot(), 'standup')
    expect(r.notes).toBe('ok')
    expect(r.meeting!.proposals).toHaveLength(3)
    expect(r.meeting!.memorized).toHaveLength(2)
    expect(r.protocol!.attendees).toEqual(['Isaac', 'Sam', 'Priya'])
    expect(r.protocol!.transcript).toHaveLength(4)
  })

  it('reports missing, none and unknown', () => {
    const root = tmpRoot()
    const file = path.join(root, 'work/meetings/standup.json')
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
    rec.notes = path.join(root, 'work/meetings/notes/gone.md')
    fs.writeFileSync(file, JSON.stringify(rec))
    expect(meetingsGet(root, 'standup')).toMatchObject({ notes: 'missing', protocol: null })
    expect(meetingsGet(root, 'planning')).toMatchObject({ notes: 'none', protocol: null })
    expect(meetingsGet(root, 'nope').meeting).toBeNull()
  })
})

describe('meetings.get notes confinement', () => {
  it('does not read an .md outside the roots', () => {
    const root = tmpRoot()
    const file = path.join(root, 'work/meetings/standup.json')
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
    rec.notes = '/etc/hosts.md'
    fs.writeFileSync(file, JSON.stringify(rec))
    expect(meetingsGet(root, 'standup', [root])).toMatchObject({ notes: 'missing', protocol: null })
  })
})

describe('meetings.openNotes', () => {
  it('opens the resolved .md path with the checked options', async () => {
    const root = tmpRoot()
    const open = vi.fn(async () => {})
    await expect(meetingsOpenNotes(root, 'standup', ['/h', root], open)).resolves.toEqual({
      opened: true,
    })
    expect(open).toHaveBeenCalledWith(path.join(root, 'work/meetings/notes/standup.md'), {
      allowRoots: ['/h', root],
      requireExt: '.md',
    })
  })

  it('refuses a missing, relative or non-md notes value', async () => {
    const root = tmpRoot()
    const open = vi.fn(async () => {})
    await expect(meetingsOpenNotes(root, 'planning', [root], open)).rejects.toMatchObject({
      code: 'no-notes',
    })
    const file = path.join(root, 'work/meetings/standup.json')
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const bad of ['notes/standup.md', '/etc/passwd']) {
      rec.notes = bad
      fs.writeFileSync(file, JSON.stringify(rec))
      await expect(meetingsOpenNotes(root, 'standup', [root], open)).rejects.toMatchObject({
        code: 'no-notes',
      })
    }
    expect(open).not.toHaveBeenCalled()
  })
})

describe('meetings.accept and meetings.dismiss', () => {
  const clk = { today: () => '2026-10-15' }
  const rd = (root: string, rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')

  it('accepts a todo proposal: row after T11, status accepted, fields kept', async () => {
    const root = tmpRoot()
    const before = JSON.parse(rd(root, 'work/meetings/standup.json'))
    const r = await meetingsAccept(root, createEvaFs({ root }), clk, 'standup', 'standup#1')
    expect(r).toEqual({ todoId: 'T16', tag: 'flo' })
    const lines = rd(root, 'memory/todos.md').split('\n')
    const i = lines.findIndex((l) => l.includes('T11 [flo]'))
    expect(lines[i + 1]).toBe(
      '- [ ] T16 [flo] Send the beta build to Sam (from meeting Daily standup, 2026-10-15) (added 2026-10-15)',
    )
    const after = JSON.parse(rd(root, 'work/meetings/standup.json'))
    expect(after.proposals[0].status).toBe('accepted')
    before.proposals[0].status = 'accepted'
    expect(after).toEqual(before)
    expect(Object.keys(after)).toEqual(Object.keys(before))
  })

  it('accepts a ticket without workspace as an eva Draft ticket', async () => {
    const root = tmpRoot()
    const r = await meetingsAccept(root, createEvaFs({ root }), clk, 'standup', 'standup#2')
    expect(r.tag).toBe('eva')
    expect(rd(root, 'memory/todos.md')).toContain(
      '[eva] Draft ticket: Crash on login (from meeting',
    )
  })

  it('refuses a second accept and never duplicates under concurrency', async () => {
    const root = tmpRoot()
    const evaFs = createEvaFs({ root })
    await meetingsAccept(root, evaFs, clk, 'standup', 'standup#1')
    const todos = rd(root, 'memory/todos.md')
    await expect(meetingsAccept(root, evaFs, clk, 'standup', 'standup#1')).rejects.toMatchObject({
      code: 'not-proposed',
    })
    expect(rd(root, 'memory/todos.md')).toBe(todos)
    const root2 = tmpRoot()
    const fs2 = createEvaFs({ root: root2 })
    const rs = await Promise.allSettled([
      meetingsAccept(root2, fs2, clk, 'standup', 'standup#2'),
      meetingsAccept(root2, fs2, clk, 'standup', 'standup#2'),
    ])
    expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
    expect(rd(root2, 'memory/todos.md').match(/Crash on login/g)).toHaveLength(1)
  })

  it('falls back to eva for an unsafe workspace id', async () => {
    const root = tmpRoot()
    const file = path.join(root, 'work/meetings/standup.json')
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
    rec.proposals[0].workspace = 'a/b'
    fs.writeFileSync(file, JSON.stringify(rec, null, 2))
    const r = await meetingsAccept(root, createEvaFs({ root }), clk, 'standup', 'standup#1')
    expect(r.tag).toBe('eva')
  })

  it('reports partial-accept naming the todo when the status edit fails', async () => {
    const root = tmpRoot()
    const real = createEvaFs({ root })
    const flaky: EvaFs = {
      ...real,
      edit: (kind, rel, fn, o) =>
        kind === 'meeting-status' ? Promise.reject(new Error('disk')) : real.edit(kind, rel, fn, o),
    }
    await expect(meetingsAccept(root, flaky, clk, 'standup', 'standup#1')).rejects.toMatchObject({
      code: 'partial-accept',
      message: expect.stringContaining('T16'),
    })
  })

  it('retries the status edit once and treats not-proposed after the append as success', async () => {
    const root = tmpRoot()
    const real = createEvaFs({ root })
    const seen: Array<{ retryOnChange?: boolean } | undefined> = []
    const spy: EvaFs = {
      ...real,
      edit: (kind, rel, fn, o) => {
        if (kind === 'meeting-status') {
          seen.push(o)
          return Promise.reject(Object.assign(new Error('x'), { code: 'not-proposed' }))
        }
        return real.edit(kind, rel, fn, o)
      },
    }
    await expect(meetingsAccept(root, spy, clk, 'standup', 'standup#1')).resolves.toEqual({
      todoId: 'T16',
      tag: 'flo',
    })
    expect(seen[0]?.retryOnChange).toBe(true)
  })

  it('dismisses without touching todos and refuses bad targets', async () => {
    const root = tmpRoot()
    const evaFs = createEvaFs({ root })
    const todos = rd(root, 'memory/todos.md')
    await expect(meetingsDismiss(root, evaFs, 'planning', 'planning#2')).resolves.toEqual({
      status: 'dismissed',
    })
    const rec = JSON.parse(rd(root, 'work/meetings/planning.json'))
    expect(rec.proposals.map((p: { status: string }) => p.status)).toEqual([
      'dismissed',
      'dismissed',
    ])
    expect(rd(root, 'memory/todos.md')).toBe(todos)
    await expect(meetingsDismiss(root, evaFs, 'planning', 'planning#2')).rejects.toMatchObject({
      code: 'not-proposed',
    })
    await expect(meetingsDismiss(root, evaFs, 'nope', 'x#1')).rejects.toMatchObject({
      code: 'not-found',
    })
  })
})
