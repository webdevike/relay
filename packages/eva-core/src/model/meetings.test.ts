import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { localDate } from './dates'
import { readMeetingFile, readMeetings, readNotes } from './meetings-read'
import {
  dayKey,
  dayLabel,
  digest,
  digestLine,
  displayTitle,
  filterByTitle,
  groupByDay,
  isSkipped,
  memoryDate,
  memoryText,
  parseMeeting,
  pendingProposals,
  setProposalStatus,
  sortMeetings,
  todoText,
  type Meeting,
  type Proposal,
} from './meetings'

const STEM = '20261007_1130_scrum_bc1956e2'

function record(stem: string, start: string): string {
  return `{
  "stem": "${stem}",
  "title": "Team Daily Standup",
  "start": "${start}",
  "notes": "/tmp/${stem}.md",
  "processed": "2026-10-07T16:40:00.000Z",
  "extra": { "keep": [1, 2] },
  "memorized": [
    { "kind": "availability", "text": "Steve: out until the 18th", "where": ["journal"], "p": 0.93 }
  ],
  "proposals": [
    { "id": "${stem}#1", "kind": "todo", "text": "Discuss i18n with Ted", "workspace": "ecardsystems", "item": "ENG-2075", "p": 0.81, "source": "Tasks table", "status": "proposed" },
    { "id": "${stem}#2", "kind": "ticket", "text": "Partner API rate limits", "item": null, "status": "proposed" }
  ]
}`
}

function mk(stem: string, start: string | null, over: Partial<Meeting> = {}): Meeting {
  return {
    stem,
    title: '',
    start,
    notes: null,
    skipped: false,
    skippedReason: null,
    proposals: [],
    memorized: [],
    ...over,
  }
}
function prop(
  id: string,
  status: Proposal['status'] = 'proposed',
  over: Partial<Proposal> = {},
): Proposal {
  return {
    id,
    kind: 'todo',
    text: 't',
    workspace: null,
    item: null,
    p: null,
    source: null,
    status,
    ...over,
  }
}

describe('parse and sort', () => {
  it('sorts newest first, undated last, ties by stem desc; stem from filename', () => {
    const a = parseMeeting('older', record('x', '2026-10-06T15:30:00.000Z'))!
    const b = parseMeeting('newer', record('y', '2026-10-07T15:30:00.000Z'))!
    const c = parseMeeting('undated-a', record('z', 'soon'))!
    const d = parseMeeting('undated-b', record('z', 'soon'))!
    expect(a.stem).toBe('older')
    expect(sortMeetings([c, a, d, b]).map((m) => m.stem)).toEqual([
      'newer',
      'older',
      'undated-b',
      'undated-a',
    ])
    expect(parseMeeting('bad', '{ nope')).toBeNull()
    expect(parseMeeting('arr', '[]')).toBeNull()
    expect(b.proposals[0]!.item).toBe('ENG-2075')
    expect(b.proposals[1]!.item).toBeNull()
    expect(b.memorized[0]!.where).toEqual(['journal'])
  })
})

describe('skipped, title, pending', () => {
  it('reads skipped values like Rust', () => {
    for (const v of [undefined, null, false, '', '  ']) expect(isSkipped(v)).toBe(false)
    for (const v of ['test call', true, 1, {}]) expect(isSkipped(v)).toBe(true)
    const m = parseMeeting('s', '{"skipped":"test call (real meeting p=0.02)"}')!
    expect(m.skipped).toBe(true)
    expect(m.skippedReason).toContain('test call')
  })
  it('falls back to the stem and counts pending', () => {
    expect(displayTitle(mk('abc', null))).toBe('abc')
    expect(displayTitle(mk('abc', null, { title: 'Hi' }))).toBe('Hi')
    const m = parseMeeting(
      'p',
      '{"proposals":[{"id":"1","status":"weird"},{"id":"2"},{"id":"3","status":"accepted"}]}',
    )!
    expect(pendingProposals(m)).toBe(2)
  })
})

describe('day labels and grouping', () => {
  it('dayKey uses local getters', () => {
    const iso = '2026-10-07T23:30:00.000Z'
    expect(dayKey(iso)).toBe(localDate(new Date(iso)))
    expect(dayKey(null)).toBeNull()
    expect(dayKey('soon')).toBeNull()
  })
  it('labels', () => {
    expect(dayLabel('2026-10-07', '2026-10-07')).toBe('Today')
    expect(dayLabel('2026-10-06', '2026-10-07')).toBe('Yesterday')
    expect(dayLabel('2026-09-14', '2026-10-07')).toBe('Sep 14')
    expect(dayLabel('2026-10-05', '2026-10-07', 'rust')).toBe('Mon, Oct 5')
    expect(dayLabel(null, '2026-10-07')).toBe('Undated')
  })
  it('groups, folds test calls and filters', () => {
    const at = (d: number, h: number): string => new Date(2026, 9, d, h).toISOString()
    const list = sortMeetings([
      mk('a', at(7, 10), { title: 'Standup' }),
      mk('b', at(7, 9), { title: 'Retro' }),
      mk('c', at(5, 9), { title: 'Test Standup', skipped: true }),
      mk('d', null),
    ])
    const { groups, tests } = groupByDay(list, '2026-10-07')
    expect(groups.map((g) => [g.label, g.meetings.map((m) => m.stem)])).toEqual([
      ['Today', ['a', 'b']],
      ['Undated', ['d']],
    ])
    expect(tests.map((m) => m.stem)).toEqual(['c'])
    const f = filterByTitle(list, 'STAND')
    expect(f.meetings.map((m) => m.stem)).toEqual(['a', 'c'])
    expect(f.forceTestsOpen).toBe(true)
    expect(filterByTitle(list, '  ').forceTestsOpen).toBe(false)
  })
})

describe('digest', () => {
  it('skips test calls and stale items', () => {
    const now = new Date('2026-10-07T18:00:00Z')
    const newest = mk('newest', '2026-10-07T15:30:00Z', {
      memorized: [
        {
          kind: 'availability',
          text: 'Steve: out until the 18th. (2026-10-18)',
          where: [],
          p: null,
        },
        { kind: 'availability', text: 'Ann: out until the 2nd. (2026-10-02)', where: [], p: null },
        { kind: 'decision', text: 'Ship it.', where: [], p: null },
      ],
      proposals: [prop('a'), prop('b', 'accepted')],
    })
    const test = mk('test', '2026-10-07T14:00:00Z', { skipped: true, proposals: [prop('t')] })
    const older = mk('older', '2026-10-05T15:30:00Z', {
      proposals: [prop('c')],
      memorized: [{ kind: 'availability', text: 'Bob: away', where: [], p: null }],
    })
    const stale = mk('stale', '2026-09-01T15:30:00Z', {
      proposals: [prop('d')],
      memorized: [
        { kind: 'decision', text: 'Old.', where: [], p: null },
        { kind: 'availability', text: 'Cy: away', where: [], p: null },
      ],
    })
    const d = digest([newest, test, older, stale], now)
    expect(d.recent.map((m) => m.stem)).toEqual(['newest', 'older'])
    expect(d.waiting.map((w) => w.proposal.id)).toEqual(['a', 'c', 'd'])
    expect(d.out.map((o) => [o.meeting.stem, o.date, o.text])).toEqual([
      ['newest', '2026-10-18', 'Steve: out until the 18th.'],
      ['older', null, 'Bob: away'],
    ])
    expect(d.decisions.map((x) => [x.meeting.stem, x.text])).toEqual([['newest', 'Ship it.']])
    expect(digestLine(3, 7)).toBe('3 meetings this week. 7 action items waiting on you.')
    expect(digestLine(1, 0)).toBe('1 meeting this week. Nothing waiting on you.')
  })
  it('memory date and text', () => {
    const t = 'Steve: He is out until the 18th. (2026-10-18)'
    expect(memoryDate(t)).toBe('2026-10-18')
    expect(memoryText(t)).toBe('Steve: He is out until the 18th.')
    expect(memoryDate('Out next week (maybe)')).toBeNull()
    expect(memoryText('Out next week (maybe)')).toBe('Out next week (maybe)')
  })
})

describe('todoText', () => {
  it('prefixes tickets and tags', () => {
    expect(
      todoText(
        prop('1', 'proposed', { kind: 'ticket', text: ' Rate limits ' }),
        'Standup',
        '2026-10-07',
      ),
    ).toEqual({
      tag: 'eva',
      text: 'Draft ticket: Rate limits (from meeting Standup, 2026-10-07)',
    })
    expect(
      todoText(prop('1', 'proposed', { workspace: ' ecardsystems ' }), 'Standup', '').tag,
    ).toBe('ecardsystems')
    expect(todoText(prop('1'), 'Standup', '').text).toBe('t (from meeting Standup)')
  })
})

describe('setProposalStatus', () => {
  it('changes only the status, keeps fields and key order', () => {
    const src = record(STEM, '2026-10-07T15:30:00.000Z')
    const out = setProposalStatus(src, `${STEM}#2`, 'dismissed')
    expect(out.endsWith('}\n')).toBe(true)
    const expected = JSON.parse(src)
    expected.proposals[1].status = 'dismissed'
    expect(JSON.parse(out)).toEqual(expected)
    expect(Object.keys(JSON.parse(out))).toEqual(Object.keys(JSON.parse(src)))
    expect(Object.keys(JSON.parse(out).proposals[0])).toEqual(
      Object.keys(JSON.parse(src).proposals[0]),
    )
    expect(out).toBe(`${JSON.stringify(expected, null, 2)}\n`)
    expect(out.includes('\n  "extra"')).toBe(true)
  })
  it('refuses non-proposed and unknown', () => {
    const src = setProposalStatus(record(STEM, '2026-10-07T15:30:00.000Z'), `${STEM}#1`, 'accepted')
    expect(() => setProposalStatus(src, `${STEM}#1`, 'dismissed')).toThrow(
      expect.objectContaining({ code: 'not-proposed' }),
    )
    expect(() => setProposalStatus(src, 'nope', 'accepted')).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    )
  })
})

describe('readers', () => {
  it('reads a temp dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'evaos-meet-'))
    const dir = join(root, 'work', 'meetings')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'older.json'), record('older', '2026-10-06T15:30:00.000Z'))
    writeFileSync(join(dir, 'newer.json'), record('newer', '2026-10-07T15:30:00.000Z'))
    writeFileSync(join(dir, 'broken.json'), '{ nope')
    writeFileSync(join(dir, '.tmp.json'), record('x', ''))
    writeFileSync(join(dir, 'notes.md'), 'nope')
    writeFileSync(join(dir, 'Weekly sync.json'), record('w', '2026-10-08T15:30:00.000Z'))
    writeFileSync(join(dir, '_x.json'), record('x', '2026-10-08T15:30:00.000Z'))
    expect(readMeetings(root).map((m) => m.stem)).toEqual(['newer', 'older'])
    expect(readMeetings(join(root, 'missing'))).toEqual([])
    expect(readMeetingFile(root, 'newer')?.meeting.title).toBe('Team Daily Standup')
    expect(readMeetingFile(root, 'newer')?.text).toContain('"extra"')
    expect(readMeetingFile(root, '../x')).toBeNull()
    expect(readMeetingFile(root, '.tmp')).toBeNull()
    expect(readMeetingFile(root, 'missing')).toBeNull()

    writeFileSync(join(root, 'n.md'), '# notes')
    writeFileSync(join(root, 'n.txt'), 'x')
    mkdirSync(join(root, 'dir.md'))
    symlinkSync(join(root, 'n.md'), join(root, 'link.md'))
    expect(readNotes(join(root, 'n.md'), [root])).toBe('# notes')
    expect(readNotes('n.md', [root])).toBeNull()
    expect(readNotes(join(root, 'n.txt'), [root])).toBeNull()
    expect(readNotes(join(root, 'dir.md'), [root])).toBeNull()
    expect(readNotes(join(root, 'gone.md'), [root])).toBeNull()
    expect(readNotes(join(root, 'link.md'), [root])).toBe('# notes')
    expect(readNotes(join(root, 'n.md'), [join(root, 'work')])).toBeNull()
    const outside = mkdtempSync(join(tmpdir(), 'evaos-out-'))
    writeFileSync(join(outside, 'x.md'), 'secret')
    expect(readNotes(join(outside, 'x.md'), [root])).toBeNull()
    symlinkSync(join(outside, 'x.md'), join(root, 'escape.md'))
    expect(readNotes(join(root, 'escape.md'), [root])).toBeNull()
  })
})
