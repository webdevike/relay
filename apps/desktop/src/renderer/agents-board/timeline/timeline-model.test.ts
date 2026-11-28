import { describe, expect, it } from 'vitest'
import { dateOfDay, editRows, type PlanTicket } from './plan-rules'
import { buildTimeline, ghostsOf } from './timeline-model'

const T0 = Date.UTC(2026, 10, 20, 12)
const TODAY = '2026-11-27'
const P1 = { id: 'p1', name: 'Relay Board', targetDate: null }
const P2 = { id: 'p2', name: 'Reviews', targetDate: null }
const BOARD = { id: 'm1', name: 'Board v1', targetDate: '2026-12-11', sortOrder: 1 }
const LATER = { id: 'm2', name: 'Timeline', targetDate: '2027-01-15', sortOrder: 2 }

function t(key: string, over: Partial<PlanTicket> = {}): PlanTicket {
  return {
    key,
    id: `issue-${key}`,
    title: `Ticket ${key}`,
    state: { id: 's', name: 'Todo', type: 'unstarted', color: '#fff' },
    priority: 3,
    prioritySortOrder: 0,
    dueDate: '2026-12-05',
    plannedStart: null,
    startedAt: null,
    updatedAt: T0,
    project: P1,
    milestone: BOARD,
    ...over,
  }
}

const done = { id: 'd', name: 'Done', type: 'completed' as const, color: '#0f0' }
const canceled = { id: 'c', name: 'Canceled', type: 'canceled' as const, color: '#999' }

const TICKETS = [
  t('ENG-3', { priority: 0, dueDate: '2026-12-10' }),
  t('ENG-1', { priority: 2, prioritySortOrder: 2, dueDate: '2026-12-03' }),
  t('ENG-2', {
    priority: 2,
    prioritySortOrder: 1,
    dueDate: '2026-12-01',
    plannedStart: '2026-11-25',
  }),
  t('ENG-4', { dueDate: null }),
  t('ENG-5', { state: done }),
  t('ENG-6', { state: canceled }),
  t('ENG-7', { milestone: LATER, dueDate: '2027-01-10' }),
  t('ENG-8', { project: P2, milestone: null, dueDate: '2026-12-20' }),
]

describe('buildTimeline', () => {
  const m = buildTimeline(TICKETS, TODAY)

  it('groups project > milestone > open tickets by priority then order; done/canceled left out', () => {
    expect(m.tasks.map((x) => `${x.type === 'summary' ? '#' : ''}${x.id}`)).toEqual([
      '#p:p1',
      '#m:p1:m1',
      'ENG-2',
      'ENG-1',
      'ENG-3',
      '#m:p1:m2',
      'ENG-7',
      '#p:p2',
      '#m:p2:',
      'ENG-8',
    ])
    expect(m.tasks.find((x) => x.id === 'm:p2:')?.text).toBe('No milestone')
    expect(m.tasks.find((x) => x.id === 'ENG-2')?.parent).toBe('m:p1:m1')
  })

  it('chains starts: plannedStart, then the previous row’s due, then the previous milestone target', () => {
    expect(m.bars['ENG-2']).toEqual({ start: '2026-11-25', end: '2026-12-01' })
    expect(m.bars['ENG-1']).toEqual({ start: '2026-12-01', end: '2026-12-03' })
    expect(m.bars['ENG-3']).toEqual({ start: '2026-12-03', end: '2026-12-10' })
    expect(m.bars['ENG-7']).toEqual({ start: '2026-12-11', end: '2027-01-10' })
    expect(m.bars['ENG-8']).toEqual({ start: TODAY, end: '2026-12-20' })
  })

  it('computes summaries from their children (exclusive end)', () => {
    const board = m.tasks.find((x) => x.id === 'm:p1:m1')!
    expect(board.start).toEqual(dateOfDay('2026-11-25'))
    expect(board.end).toEqual(dateOfDay('2026-12-11'))
    expect(board.text).toBe('Board v1 (2026-12-11)')
  })

  it('splits undated tickets into the No date list', () => {
    expect(m.noDate).toEqual([
      { key: 'ENG-4', title: 'Ticket ENG-4', group: 'Relay Board / Board v1' },
    ])
    expect(m.tasks.some((x) => x.id === 'ENG-4')).toBe(false)
    expect(m.milestones.find((x) => x.id === 'm:p1:m1')?.keys).toEqual([
      'ENG-2',
      'ENG-1',
      'ENG-4',
      'ENG-3',
    ])
  })

  it('draws today and each milestone target (at the end of its day)', () => {
    expect(m.lines).toEqual([
      { id: 'today', label: 'Today', kind: 'today', day: TODAY, at: TODAY },
      { id: 'm:p1:m1', label: 'Board v1', kind: 'release', day: '2026-12-11', at: '2026-12-12' },
      { id: 'm:p1:m2', label: 'Timeline', kind: 'release', day: '2027-01-15', at: '2027-01-16' },
    ])
  })

  it('ranges from a week before the earliest bar to two weeks after the latest', () => {
    expect(m.start).toEqual(dateOfDay('2026-11-06'))
    expect(m.end).toEqual(dateOfDay('2027-02-09'))
  })

  it('widens the range to every date line and every date the draft proposes', () => {
    const far = { ...LATER, id: 'm3', targetDate: '2027-04-30', sortOrder: 3 }
    const withMarker = buildTimeline(
      [...TICKETS, t('ENG-8', { milestone: far, dueDate: null })],
      TODAY,
    )
    expect(withMarker.end).toEqual(dateOfDay('2027-05-16'))
    const mint = (): string => '00000000-0000-4000-8000-000000000001'
    const rows = editRows(
      [],
      TICKETS[1]!,
      { dueDate: '2027-06-01', plannedStart: '2026-10-01' },
      mint,
    )
    const d = buildTimeline(TICKETS, TODAY, rows)
    expect(d.start).toEqual(dateOfDay('2026-09-24'))
    expect(d.end).toEqual(dateOfDay('2027-06-16'))
  })

  it('marks draft rows, order moves and ghost bars', () => {
    const mint = (): string => '00000000-0000-4000-8000-000000000001'
    const eng3 = TICKETS[0]!
    let rows = editRows([], eng3, { priority: 1, prioritySortOrder: 0 }, mint)
    rows = editRows(rows, TICKETS[1]!, { dueDate: '2026-12-06' }, mint)
    const d = buildTimeline(TICKETS, TODAY, rows)
    expect(d.tasks.find((x) => x.id === 'ENG-3')).toMatchObject({ draft: true, delta: 3 })
    expect(d.tasks.find((x) => x.id === 'ENG-2')).toMatchObject({ delta: -1 })
    expect(d.tasks.find((x) => x.id === 'ENG-1')).toMatchObject({ draft: true, delta: -1 })
    expect(ghostsOf(d, rows)).toEqual([
      { key: 'ENG-1', bar: { start: '2026-12-01', end: '2026-12-06' }, error: undefined },
    ])
  })
})
