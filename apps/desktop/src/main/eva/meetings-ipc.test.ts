import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { makeEvaFixture } from '../../../e2e/helpers/eva-fixture'
import { meetingsGet, meetingsList, meetingsOpenNotes } from './meetings-ipc'

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
    expect(r.meetings.map((m) => m.stem)).toEqual(['test-call', 'standup', 'planning', 'retro', 'undated'])
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

describe('meetings.openNotes', () => {
  it('opens the resolved .md path with the checked options', async () => {
    const root = tmpRoot()
    const open = vi.fn(async () => {})
    await expect(meetingsOpenNotes(root, 'standup', ['/h', root], open)).resolves.toEqual({ opened: true })
    expect(open).toHaveBeenCalledWith(path.join(root, 'work/meetings/notes/standup.md'), {
      allowRoots: ['/h', root],
      requireExt: '.md',
    })
  })

  it('refuses a missing, relative or non-md notes value', async () => {
    const root = tmpRoot()
    const open = vi.fn(async () => {})
    await expect(meetingsOpenNotes(root, 'planning', [root], open)).rejects.toMatchObject({ code: 'no-notes' })
    const file = path.join(root, 'work/meetings/standup.json')
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const bad of ['notes/standup.md', '/etc/passwd']) {
      rec.notes = bad
      fs.writeFileSync(file, JSON.stringify(rec))
      await expect(meetingsOpenNotes(root, 'standup', [root], open)).rejects.toMatchObject({ code: 'no-notes' })
    }
    expect(open).not.toHaveBeenCalled()
  })
})
