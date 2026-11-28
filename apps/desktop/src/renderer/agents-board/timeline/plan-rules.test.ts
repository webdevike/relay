import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addDays,
  barOf,
  barOfGantt,
  byPriority,
  changesOf,
  dateOfDay,
  dayOfMs,
  dragEdit,
  editRows,
  ganttDates,
  isDay,
  milestoneOf,
  NO_MILESTONE,
  placeAt,
  proposalRows,
  rebaseRows,
  rowDatesValid,
  staleKeys,
  startOf,
  toPlanRow,
  type PlanTicket,
} from './plan-rules'

const T0 = Date.UTC(2026, 10, 20, 12)
let ids = 0
const mint = (): string => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`

function planTicket(key: string, over: Partial<PlanTicket> = {}): PlanTicket {
  return {
    key,
    id: `issue-${key}`,
    title: `Ticket ${key}`,
    state: { id: 's', name: 'Todo', type: 'unstarted', color: '#fff' },
    priority: 3,
    prioritySortOrder: 0,
    dueDate: null,
    plannedStart: null,
    startedAt: null,
    updatedAt: T0,
    project: { id: 'p1', name: 'Relay Board', targetDate: null },
    milestone: { id: 'm1', name: 'Board v1', targetDate: '2026-12-11', sortOrder: 1 },
    ...over,
  }
}

const ctx = { previousDue: null, groupStart: null, today: '2026-11-27' }

describe('start', () => {
  it('prefers plannedStart, then startedAt, previous due, group start, today', () => {
    const started = Date.UTC(2026, 10, 18, 12)
    const full = { previousDue: '2026-11-10', groupStart: '2026-11-01', today: '2026-11-27' }
    expect(startOf({ plannedStart: '2026-11-15', startedAt: started }, full)).toBe('2026-11-15')
    expect(startOf({ plannedStart: null, startedAt: started }, full)).toBe(dayOfMs(started))
    expect(startOf({ plannedStart: null, startedAt: null }, full)).toBe('2026-11-10')
    expect(startOf({ plannedStart: null, startedAt: null }, { ...full, previousDue: null })).toBe(
      '2026-11-01',
    )
    expect(startOf({ plannedStart: null, startedAt: null }, ctx)).toBe('2026-11-27')
  })

  it('starts the first row of a milestone at the group start, or today', () => {
    const first = planTicket('ENG-1', { dueDate: '2026-12-20' })
    expect(barOf(first, { ...ctx, groupStart: '2026-12-01' })).toEqual({
      start: '2026-12-01',
      end: '2026-12-20',
    })
    expect(barOf(first, ctx)).toEqual({ start: '2026-11-27', end: '2026-12-20' })
  })

  it('puts an undated ticket in No date (no bar)', () => {
    expect(barOf(planTicket('ENG-1', { plannedStart: '2026-11-01' }), ctx)).toBeNull()
  })

  it('keeps end >= start: a start after the due date starts on the due date', () => {
    const t = planTicket('ENG-1', { plannedStart: '2026-12-10', dueDate: '2026-12-01' })
    expect(barOf(t, ctx)).toEqual({ start: '2026-12-01', end: '2026-12-01' })
  })

  it('groups an unmilestoned ticket under No milestone', () => {
    expect(milestoneOf(planTicket('ENG-1', { milestone: null }))).toEqual({
      id: null,
      name: NO_MILESTONE,
    })
  })
})

describe('priority order', () => {
  it('sorts Urgent first and None (0) last, then by prioritySortOrder', () => {
    const rows = [
      planTicket('ENG-1', { priority: 0, prioritySortOrder: -5 }),
      planTicket('ENG-2', { priority: 4 }),
      planTicket('ENG-3', { priority: 1, prioritySortOrder: 2 }),
      planTicket('ENG-4', { priority: 1, prioritySortOrder: 1 }),
    ]
    expect([...rows].sort(byPriority).map((t) => t.key)).toEqual([
      'ENG-4',
      'ENG-3',
      'ENG-2',
      'ENG-1',
    ])
  })

  const rest = [
    planTicket('ENG-1', { priority: 1, prioritySortOrder: 10 }),
    planTicket('ENG-2', { priority: 2, prioritySortOrder: 10 }),
    planTicket('ENG-3', { priority: 2, prioritySortOrder: 20 }),
    planTicket('ENG-4', { priority: 0, prioritySortOrder: 5 }),
  ]

  it('reorders within a priority to the midpoint of its neighbors (order only)', () => {
    const moved = planTicket('ENG-9', { priority: 2, prioritySortOrder: 30 })
    expect(placeAt(moved, rest, 2)).toEqual({ priority: 2, prioritySortOrder: 15 })
  })

  it('moving down across groups takes the group above and sits at its bottom boundary', () => {
    const moved = planTicket('ENG-9', { priority: 1, prioritySortOrder: 1 })
    expect(placeAt(moved, rest, 3)).toEqual({ priority: 2, prioritySortOrder: 21 })
  })

  it('moving up across groups takes the group below and sits at its top boundary', () => {
    const moved = planTicket('ENG-9', { priority: 0, prioritySortOrder: 50 })
    expect(placeAt(moved, rest, 1)).toEqual({ priority: 2, prioritySortOrder: 9 })
  })

  it('moving into None (0) at the end takes None after its last row', () => {
    const moved = planTicket('ENG-9', { priority: 2, prioritySortOrder: 15 })
    expect(placeAt(moved, rest, 4)).toEqual({ priority: 0, prioritySortOrder: 6 })
  })

  it('keeps its own priority where it still sorts between the groups', () => {
    const moved = planTicket('ENG-9', { priority: 3, prioritySortOrder: 7 })
    expect(placeAt(moved, rest, 3)).toEqual({ priority: 3, prioritySortOrder: 7 })
  })
})

describe('drag edits', () => {
  const before = { start: '2026-12-01', end: '2026-12-05' }

  it('a move shifts start and due', () => {
    expect(dragEdit(before, { start: '2026-12-03', end: '2026-12-07' })).toEqual({
      plannedStart: '2026-12-03',
      dueDate: '2026-12-07',
    })
  })

  it('a start-only resize is Relay-only (no Linear field) and still names its base start', () => {
    const patch = dragEdit(before, { start: '2026-11-28', end: '2026-12-05' })
    expect(patch).toEqual({ plannedStart: '2026-11-28' })
    const rows = editRows([], planTicket('ENG-1', { dueDate: '2026-12-05' }), patch, mint)
    expect(toPlanRow(rows[0]!)).toMatchObject({
      plannedStart: '2026-11-28',
      basePlannedStart: null,
    })
    expect(toPlanRow(rows[0]!)).not.toHaveProperty('dueDate')
  })

  it('an end resize changes the due date, never before the start', () => {
    expect(dragEdit(before, { start: '2026-12-01', end: '2026-12-09' })).toEqual({
      dueDate: '2026-12-09',
    })
    expect(dragEdit(before, { start: '2026-12-01', end: '2026-11-20' })).toEqual({
      dueDate: '2026-12-01',
    })
  })
})

describe('draft rows', () => {
  const t = planTicket('ENG-1', { dueDate: '2026-12-05', priority: 2, prioritySortOrder: 3 })

  it('mints one opId per row and keeps it across edits', () => {
    const one = editRows([], t, { dueDate: '2026-12-08' }, mint)
    const two = editRows(one, t, { priority: 1 }, mint)
    expect(two).toHaveLength(1)
    expect(two[0]!.opId).toBe(one[0]!.opId)
    expect(two[0]).toMatchObject({ dueDate: '2026-12-08', priority: 1, baseUpdatedAt: T0 })
  })

  it('drops fields back at their base value, and the row when nothing is left', () => {
    const one = editRows([], t, { dueDate: '2026-12-08' }, mint)
    expect(editRows(one, t, { dueDate: '2026-12-05' }, mint)).toEqual([])
  })

  it('writes only the changed fields to applyPlan', () => {
    const [row] = editRows([], t, { prioritySortOrder: 2.5, plannedStart: '2026-12-01' }, mint)
    expect(toPlanRow(row!)).toEqual({
      key: 'ENG-1',
      issueId: 'issue-ENG-1',
      opId: row!.opId,
      baseUpdatedAt: T0,
      basePlannedStart: null,
      prioritySortOrder: 2.5,
      plannedStart: '2026-12-01',
    })
  })

  it('lists every change for the confirm', () => {
    const rows = editRows([], t, { dueDate: '2026-12-08', priority: 1 }, mint)
    expect(changesOf(rows)).toEqual([
      { key: 'ENG-1', field: 'Due date', from: '2026-12-05', to: '2026-12-08' },
      { key: 'ENG-1', field: 'Priority', from: 'High', to: 'Urgent' },
    ])
  })

  it('flags rows whose ticket changed and re-bases them on reconfirm', () => {
    const rows = editRows([], t, { dueDate: '2026-12-08' }, mint)
    const now = [{ ...t, updatedAt: T0 + 1 }]
    expect(staleKeys(rows, now)).toEqual(['ENG-1'])
    const again = rebaseRows(rows, now)
    expect(again[0]).toMatchObject({ baseUpdatedAt: T0 + 1, opId: rows[0]!.opId })
    expect(staleKeys(again, now)).toEqual([])
    expect(rebaseRows(rows, [{ ...t, dueDate: '2026-12-08', updatedAt: T0 + 1 }])).toEqual([])
  })

  it('is stale when its Relay start moved (another device) or its key names another issue now', () => {
    const rows = editRows([], t, { dueDate: '2026-12-08' }, mint)
    expect(staleKeys(rows, [{ ...t, plannedStart: '2026-11-30' }])).toEqual(['ENG-1'])
    const replaced = { ...t, id: 'issue-other' }
    expect(staleKeys(rows, [replaced])).toEqual(['ENG-1'])
    expect(rebaseRows(rows, [replaced])).toEqual([])
  })

  it('checks the dates a row leaves: a start after the unchanged due date is invalid', () => {
    const [start] = editRows([], t, { plannedStart: '2026-12-06' }, mint)
    expect(rowDatesValid(start!)).toBe(false)
    const [both] = editRows([], t, { plannedStart: '2026-12-06', dueDate: '2026-12-09' }, mint)
    expect(rowDatesValid(both!)).toBe(true)
  })

  describe('a proposal against the host’s baseline', () => {
    const base = (key: string, over: Record<string, unknown> = {}) => ({
      key,
      issueId: `issue-${key}`,
      updatedAt: T0,
      dueDate: '2026-12-05',
      priority: 2,
      prioritySortOrder: 3,
      plannedStart: null,
      ...over,
    })
    const u = planTicket('ENG-2', { dueDate: '2026-12-05', priority: 2, prioritySortOrder: 3 })

    it('makes rows from the baseline, not this device’s copy; unknown, replaced and bad-date rows drop', () => {
      const rows = proposalRows(
        {
          summary: 's',
          changes: [
            { key: 'ENG-1', start: '2026-12-01', dueDate: '2026-12-09', reason: 'Shorter' },
            { key: 'ENG-3', dueDate: '2026-12-09', reason: 'No baseline' },
            { key: 'ENG-2', dueDate: '2026-12-09', reason: 'Replaced issue' },
            { key: 'ENG-1', dueDate: '2026-02-30', reason: 'No such day' },
            { key: 'ENG-1', start: '2026-12-12', reason: 'After the unchanged due' },
          ],
          baseline: [base('ENG-1'), base('ENG-2', { issueId: 'issue-old' })],
        },
        [t, u],
        mint,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        key: 'ENG-1',
        issueId: 'issue-ENG-1',
        baseUpdatedAt: T0,
        base: { dueDate: '2026-12-05', plannedStart: null },
        plannedStart: '2026-12-01',
        dueDate: '2026-12-09',
        reason: 'Shorter',
      })
      expect(rows[0]!.stale).toBeUndefined()
    })

    it('marks a row stale when the host says so or this board has a newer ticket or start', () => {
      const change = (key: string) => ({ key, dueDate: '2026-12-09', reason: 'r' })
      const rows = proposalRows(
        {
          summary: 's',
          changes: [change('ENG-1'), change('ENG-2'), change('ENG-4')],
          stale: ['ENG-1'],
          baseline: [base('ENG-1'), base('ENG-2'), base('ENG-4')],
        },
        [t, { ...u, plannedStart: '2026-12-01' }, planTicket('ENG-4', { dueDate: '2026-12-05' })],
        mint,
      )
      expect(rows.map((r) => [r.key, r.stale === true])).toEqual([
        ['ENG-1', true],
        ['ENG-2', true],
        ['ENG-4', false],
      ])
    })
  })
})

describe('date-only days', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('checks real calendar days', () => {
    expect(isDay('2026-02-28')).toBe(true)
    expect(isDay('2026-02-30')).toBe(false)
    expect(isDay('2026-2-3')).toBe(false)
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  function roundTrip(): void {
    for (const day of ['2026-03-08', '2026-03-29', '2026-11-01', '2026-12-31', '2027-01-01']) {
      expect(barOfGantt(dateOfDay(day), dateOfDay(addDays(day, 1)))).toEqual({
        start: day,
        end: day,
      })
      const bar = { start: day, end: addDays(day, 5) }
      const g = ganttDates(bar)
      expect(barOfGantt(g.start, g.end)).toEqual(bar)
      expect(addDays(addDays(day, 40), -40)).toBe(day)
    }
  }

  it('round-trips in America/Los_Angeles', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles')
    roundTrip()
    // 03:00 UTC on Nov 27 is still Nov 26 in Los Angeles.
    expect(dayOfMs(Date.UTC(2026, 10, 27, 3))).toBe('2026-11-26')
  })

  it('round-trips in Asia/Tokyo', () => {
    vi.stubEnv('TZ', 'Asia/Tokyo')
    roundTrip()
    // 20:00 UTC on Nov 26 is already Nov 27 in Tokyo.
    expect(dayOfMs(Date.UTC(2026, 10, 26, 20))).toBe('2026-11-27')
  })
})
