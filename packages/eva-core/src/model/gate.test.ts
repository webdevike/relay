import { describe, expect, it } from 'vitest'
import { localDate } from './dates'
import { gateArgs, GateArgError } from './gate-args'
import {
  formatCountdown,
  historyRows,
  nextBreakAt,
  pickItems,
  planSourceLabel,
  streak,
  todaysBreaks,
  type GateHistory,
} from './gate'

const h = (over: Partial<GateHistory>): GateHistory => ({
  kind: 'habit',
  id: 'walk',
  name: 'Walk',
  startedAt: null,
  doneAt: '2026-10-12T15:15:00.000Z',
  photo: null,
  override: null,
  ...over,
})
const HISTORY: GateHistory[] = [
  h({ doneAt: '2026-10-12T15:15:00.000Z', startedAt: '2026-10-12T15:00:00.000Z' }),
  h({ doneAt: '2026-10-11T15:15:00.000Z', startedAt: '2026-10-11T15:00:00.000Z' }),
  h({ doneAt: '2026-10-09T15:15:00.000Z', startedAt: '2026-10-09T15:00:00.000Z' }),
  h({ kind: 'override', doneAt: '2026-10-13T15:15:00.000Z', override: 'call' }),
  h({
    kind: 'override',
    id: '',
    name: 'Override',
    startedAt: '2026-10-13T16:00:00.000Z',
    doneAt: '2026-10-13T16:01:00.000Z',
    override: 'incident',
  }),
]
const day = (iso: string): string => localDate(new Date(iso))

describe('streak', () => {
  it('counts consecutive days, skips overrides (walk streak 2)', () => {
    const today = day('2026-10-13T15:15:00.000Z')
    expect(streak(HISTORY, 'walk', today)).toBe(2)
    expect(streak(HISTORY, 'walk', '2030-01-01')).toBe(0)
    expect(streak(HISTORY, 'draw', today)).toBe(0)
  })
  it('starts today when today has an entry', () => {
    const today = day('2026-10-12T15:15:00.000Z')
    expect(streak(HISTORY, 'walk', today)).toBe(2)
  })
})

describe('todaysBreaks', () => {
  const now = new Date(2026, 9, 13, 12, 0, 0)
  const at = (hh: number): string => new Date(2026, 9, 13, hh).toISOString()
  const plan = {
    date: '2026-10-13',
    source: 'calendar',
    breaks: [
      { at: at(9), done: true },
      { at: at(11), done: false },
      { at: at(15), done: false },
    ],
  }
  it('maps states and handles another day', () => {
    expect(todaysBreaks(plan, now).map((b) => b.state)).toEqual(['done', 'due', 'upcoming'])
    expect(todaysBreaks({ ...plan, date: '2026-10-12' }, now)).toEqual([])
    expect(todaysBreaks(null, now)).toEqual([])
    expect(nextBreakAt(plan, now)).toBe(at(15))
    expect(nextBreakAt({ ...plan, breaks: [] }, now)).toBeNull()
  })
  it('labels sources', () => {
    expect(planSourceLabel('calendar')).toBe('From your calendar')
    expect(planSourceLabel('fallback')).toBe('Evenly spaced (calendar unavailable)')
    expect(planSourceLabel('x')).toBe('Planned')
  })
})

describe('formatCountdown', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatCountdown(65)).toBe('1:05')
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(3725)).toBe('1:02:05')
    expect(formatCountdown(-4)).toBe('0:00')
  })
})

describe('historyRows', () => {
  it('sorts desc, caps at 30, labels', () => {
    const rows = historyRows(HISTORY)
    expect(rows[0]!.label).toBe('Overridden: incident')
    expect(rows[0]!.minutes).toBe(1)
    expect(rows[1]!.label).toBe('Overridden: call')
    expect(rows[1]!.minutes).toBeNull()
    expect(rows[2]!.label).toBe('15 min')
    expect(rows[0]!.name).toBe('Override')
    const many = Array.from({ length: 40 }, (_, i) =>
      h({ doneAt: new Date(2026, 0, 1, 0, i).toISOString() }),
    )
    expect(historyRows(many)).toHaveLength(30)
  })
})

describe('pickItems', () => {
  it('lists habits then open tasks', () => {
    const items = pickItems(
      [{ id: 'draw', name: 'Draw', minutes: 10, photo: true }],
      [
        { id: 'a', name: 'A', minutes: null, done: false },
        { id: 'b', name: 'B', minutes: 5, done: false },
        { id: 'c', name: 'C', minutes: 5, done: true },
      ],
    )
    expect(items.map((i) => [i.id, i.meta, i.photo])).toEqual([
      ['draw', '10 min', true],
      ['a', 'Task', false],
      ['b', 'Task, 5 min', false],
    ])
  })
})

describe('gateArgs', () => {
  it('builds every subcommand', () => {
    expect(gateArgs({ action: 'status' })).toEqual(['status'])
    expect(gateArgs({ action: 'start', id: 'walk' })).toEqual(['start', 'walk'])
    expect(gateArgs({ action: 'done', id: 'walk', photo: '/tmp/p.jpg' })).toEqual([
      'done',
      'walk',
      '--photo',
      '/tmp/p.jpg',
    ])
    expect(gateArgs({ action: 'done', id: 'walk', photo: null })).toEqual(['done', 'walk'])
    expect(gateArgs({ action: 'override', reason: ' fire ' })).toEqual(['override', 'fire'])
    expect(gateArgs({ action: 'habit-add', name: 'Draw', minutes: 10, photo: true })).toEqual([
      'habit',
      'add',
      'Draw',
      '--minutes',
      '10',
      '--photo',
    ])
    expect(gateArgs({ action: 'habit-add', name: 'Draw', minutes: 10, photo: false })).toEqual([
      'habit',
      'add',
      'Draw',
      '--minutes',
      '10',
    ])
    expect(
      gateArgs({ action: 'habit-edit', id: 'draw', name: 'Draw 2', minutes: 10, photo: true }),
    ).toEqual(['habit', 'edit', 'draw', '--name=Draw 2', '--minutes', '10', '--photo'])
    expect(
      gateArgs({ action: 'habit-edit', id: 'draw', name: 'Draw', minutes: 10, photo: false }),
    ).toEqual(['habit', 'edit', 'draw', '--name=Draw', '--minutes', '10', '--no-photo'])
    expect(gateArgs({ action: 'habit-rm', id: 'draw' })).toEqual(['habit', 'rm', 'draw'])
    expect(gateArgs({ action: 'task-add', name: 'Taxes', minutes: null })).toEqual([
      'task',
      'add',
      'Taxes',
    ])
    expect(gateArgs({ action: 'task-add', name: 'Taxes', minutes: 30 })).toEqual([
      'task',
      'add',
      'Taxes',
      '--minutes',
      '30',
    ])
    expect(gateArgs({ action: 'task-rm', id: 'taxes' })).toEqual(['task', 'rm', 'taxes'])
  })
  it('rejects unsafe input', () => {
    const bad = (a: Parameters<typeof gateArgs>[0]): void => {
      try {
        gateArgs(a)
      } catch (e) {
        expect(e).toBeInstanceOf(GateArgError)
        expect((e as GateArgError).code).toBe('invalid-input')
        return
      }
      throw new Error('expected throw')
    }
    bad({ action: 'override', reason: '' })
    bad({ action: 'override', reason: '--json' })
    bad({ action: 'override', reason: '-x' })
    bad({ action: 'override', reason: 'a\0b' })
    bad({ action: 'override', reason: 'x'.repeat(201) })
    bad({ action: 'habit-add', name: '--minutes', minutes: 5, photo: false })
    bad({ action: 'habit-add', name: 'A', minutes: 0, photo: false })
    bad({ action: 'habit-add', name: 'A', minutes: 601, photo: false })
    bad({ action: 'habit-add', name: 'A', minutes: 1.5, photo: false })
    bad({ action: 'task-add', name: 'A', minutes: 700 })
    bad({ action: 'start', id: 'Bad Id' })
    bad({ action: 'start', id: '-x' })
    bad({ action: 'done', id: 'walk', photo: 'rel/p.jpg' })
  })
})
