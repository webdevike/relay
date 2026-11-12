import { describe, expect, it } from 'vitest'
import type { MeetingMoment } from '@relay/protocol'
import {
  endedSections,
  jumpTop,
  meetingSpan,
  meetingWhen,
  momentLabel,
  nearBottom,
} from './meeting-panel'

const at = (h: number, m: number, day = 12): number => new Date(2026, 10, day, h, m).getTime()
const moment = (over: Partial<MeetingMoment>): MeetingMoment => ({
  id: 'r:0',
  kind: 'action',
  rowId: 'r',
  startMs: 35 * 60_000,
  speaker: 'Todd',
  text: 'Ship it.',
  answered: false,
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

  it('labels moments by kind, and questions to Isaac by who asked and whether he answered', () => {
    const start = at(14, 0)
    const now = start + 55 * 60_000
    expect(momentLabel(moment({ kind: 'action', speaker: 'Priya' }), true, start, now)).toBe(
      'Action · Priya',
    )
    expect(momentLabel(moment({ kind: 'decision' }), false, start, now)).toBe('Decision · Todd')
    expect(momentLabel(moment({ kind: 'you' }), true, start, now)).toBe(
      'Todd · 20 min ago, no reply yet',
    )
    expect(momentLabel(moment({ kind: 'you', startMs: 54.5 * 60_000 }), true, start, now)).toBe(
      'Todd · just now, no reply yet',
    )
    expect(momentLabel(moment({ kind: 'you' }), false, start, now)).toBe('Todd · no reply yet')
    expect(momentLabel(moment({ kind: 'you', answered: true }), true, start, now)).toBe(
      'Todd asked you',
    )
  })

  it("leads the ended view with Isaac's open questions, then actions, then decisions", () => {
    const ms = [
      moment({ id: 'a', kind: 'action', text: 'Dry run.' }),
      moment({ id: 'b', kind: 'you', text: 'Isaac, the dashboard?' }),
      moment({ id: 'c', kind: 'you', text: 'Isaac, seen it?', answered: true }),
      moment({ id: 'd', kind: 'decision', text: 'Ship Thursday.' }),
    ]
    const s = endedSections(ms, [])
    expect(s.forYou.map((m) => m.id)).toEqual(['b'])
    expect(s.actions.map((m) => m.id)).toEqual(['a'])
    expect(s.decided).toEqual(['Ship Thursday.'])
    // The written notes' decisions win over the detected ones.
    expect(endedSections(ms, ['MFA by month end.']).decided).toEqual(['MFA by month end.'])
  })

  it('follows within 24px of the end and jumps a row to a third of the view', () => {
    expect(nearBottom({ scrollHeight: 1000, clientHeight: 300, scrollTop: 680 })).toBe(true)
    expect(nearBottom({ scrollHeight: 1000, clientHeight: 300, scrollTop: 600 })).toBe(false)
    expect(jumpTop(500, 300)).toBe(400)
    expect(jumpTop(40, 300)).toBe(0)
  })
})
