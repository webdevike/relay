import { describe, expect, it } from 'vitest'
import type { KeyMoment, LiveLine } from '@relay/protocol'
import {
  endedSections,
  jumpTop,
  meetingSpan,
  meetingWhen,
  momentLabel,
  nearBottom,
  openAsks,
} from './meeting-panel'

const at = (h: number, m: number, day = 12): number => new Date(2026, 10, day, h, m).getTime()
const moment = (over: Partial<KeyMoment>): KeyMoment => ({
  id: 'km0',
  kind: 'action',
  atMs: 35 * 60_000,
  lineId: 'l0',
  speaker: 'Todd',
  text: 'Ship it.',
  shot: null,
  ...over,
})
const mic = (startMs: number, over: Partial<LiveLine> = {}): LiveLine => ({
  id: `m${startMs}`,
  track: 'mic',
  speaker: 'Isaac',
  startMs,
  endMs: startMs + 2000,
  text: 'Sure.',
  final: true,
  ...over,
})

describe('meeting panel wording', () => {
  it('spans an ended call, naming the half of the day once and the day when not today', () => {
    expect(meetingSpan(at(14, 51), at(15, 33), at(16, 0))).toBe('2:51 – 3:33 PM')
    expect(meetingSpan(at(11, 40), at(12, 20), at(16, 0))).toBe('11:40 AM – 12:20 PM')
    expect(meetingSpan(at(14, 51), at(15, 33, 10), at(16, 0))).toBe('2:51 – 3:33 PM')
    expect(meetingSpan(at(9, 5, 10), at(9, 50, 10), at(16, 0))).toBe('Nov 10, 9:05 – 9:50 AM')
  })

  it('shows elapsed minutes on the call and span plus length after it', () => {
    const r = { startedAt: at(14, 51), endedAt: null }
    expect(meetingWhen(r, true, at(15, 46) + 30_000)).toBe('55 min')
    expect(meetingWhen({ ...r, endedAt: at(15, 33) }, false, at(16, 0))).toBe(
      '2:51 – 3:33 PM · 42 min',
    )
  })

  it('labels key moments by kind and speaker, and an open ask as still waiting', () => {
    expect(momentLabel(moment({ kind: 'action', speaker: 'Priya' }), false)).toBe('Action · Priya')
    expect(momentLabel(moment({ kind: 'decision' }), false)).toBe('Decision · Todd')
    expect(momentLabel(moment({ kind: 'claim' }), false)).toBe('Claim · Todd')
    expect(momentLabel(moment({ kind: 'ask' }), true)).toBe('Asks you · Todd · no reply yet')
    expect(momentLabel(moment({ kind: 'ask' }), false)).toBe('Asks you · Todd')
  })

  it("leads the ended view with Isaac's open asks, then actions, then decisions", () => {
    const ms = [
      moment({ id: 'a', kind: 'action', text: 'Dry run.' }),
      moment({ id: 'b', kind: 'ask', text: 'Isaac, the dashboard?', atMs: 40 * 60_000 }),
      moment({ id: 'c', kind: 'ask', text: 'Isaac, seen it?', atMs: 10 * 60_000 }),
      moment({ id: 'd', kind: 'decision', text: 'Ship Thursday.' }),
    ]
    // Isaac spoke at 20 min (answering c); his echoed line at 45 min does not count.
    const lines = [mic(20 * 60_000), mic(45 * 60_000, { echo: true })]
    const open = openAsks(ms, lines)
    expect([...open]).toEqual(['b'])
    const s = endedSections(ms, open, [])
    expect(s.forYou.map((m) => m.id)).toEqual(['b'])
    expect(s.actions.map((m) => m.id)).toEqual(['a'])
    expect(s.decided).toEqual(['Ship Thursday.'])
    // The written notes' decisions win over the key moments'.
    expect(endedSections(ms, open, ['MFA by month end.']).decided).toEqual(['MFA by month end.'])
  })

  it('follows within 24px of the end and jumps a row to a third of the view', () => {
    expect(nearBottom({ scrollHeight: 1000, clientHeight: 300, scrollTop: 680 })).toBe(true)
    expect(nearBottom({ scrollHeight: 1000, clientHeight: 300, scrollTop: 600 })).toBe(false)
    expect(jumpTop(500, 300)).toBe(400)
    expect(jumpTop(40, 300)).toBe(0)
  })
})
