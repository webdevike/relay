// The Meeting tab's wording and arithmetic, kept out of the component so it is tested on its own.
import type { MeetingMoment } from '@relay/protocol'

/** Within this many px of the end, the transcript counts as at the bottom (following live). */
export const FOLLOW_SLACK_PX = 24

export function nearBottom(el: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX
}

/** Whole minutes from `from` to `to`, never negative. */
export const minutesBetween = (from: number, to: number): number =>
  Math.max(0, Math.floor((to - from) / 60_000))

function clock(at: number): { time: string; half: 'AM' | 'PM' } {
  const d = new Date(at)
  const h = d.getHours()
  return {
    time: `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`,
    half: h < 12 ? 'AM' : 'PM',
  }
}

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

/**
 * When an ended call ran: "2:51 – 3:33 PM", "11:40 AM – 12:20 PM" across noon, with its day in
 * front ("Oct 26, 2:51 – 3:33 PM") when that was not today.
 */
export function meetingSpan(startedAt: number, endedAt: number, now: number): string {
  const a = clock(startedAt)
  const b = clock(endedAt)
  const span =
    a.half === b.half
      ? `${a.time} – ${b.time} ${b.half}`
      : `${a.time} ${a.half} – ${b.time} ${b.half}`
  const today = new Date(startedAt).toDateString() === new Date(now).toDateString()
  return today ? span : `${DAY.format(startedAt)}, ${span}`
}

/** The header's time: elapsed minutes on the call ("55 min"), else the span and length. */
export function meetingWhen(
  r: { startedAt: number; endedAt: number | null },
  live: boolean,
  now: number,
): string {
  if (live) return `${minutesBetween(r.startedAt, now)} min`
  const end = r.endedAt ?? r.startedAt
  // Rounded, at least 1: the length the chat's "Meeting ended" card shows.
  const min = Math.max(1, Math.round((end - r.startedAt) / 60_000))
  return `${meetingSpan(r.startedAt, end, now)} · ${min} min`
}

const KIND: Record<'decision' | 'action', string> = { decision: 'Decision', action: 'Action' }

/**
 * The quiet line under a moment: "Action · Priya", "Decision · Todd"; for a question to Isaac who
 * asked and, while nobody heard back, how long ago ("Todd · 20 min ago, no reply yet").
 */
export function momentLabel(
  m: MeetingMoment,
  live: boolean,
  startedAt: number,
  now: number,
): string {
  if (m.kind !== 'you') return `${KIND[m.kind]} · ${m.speaker}`
  if (m.answered) return `${m.speaker} asked you`
  if (!live) return `${m.speaker} · no reply yet`
  const ago = minutesBetween(startedAt + m.startMs, now)
  return `${m.speaker} · ${ago < 1 ? 'just now' : `${ago} min ago`}, no reply yet`
}

/** What still needs Isaac once the call is over, then what was taken on and what was settled. */
export function endedSections(
  moments: readonly MeetingMoment[],
  noteDecisions: readonly string[],
): { forYou: MeetingMoment[]; actions: MeetingMoment[]; decided: string[] } {
  return {
    forYou: moments.filter((m) => m.kind === 'you' && !m.answered),
    actions: moments.filter((m) => m.kind === 'action'),
    decided:
      noteDecisions.length > 0
        ? [...noteDecisions]
        : moments.filter((m) => m.kind === 'decision').map((m) => m.text),
  }
}

/** Where the transcript scrolls to put a row about a third of the way down its view. */
export const jumpTop = (rowTop: number, viewHeight: number): number =>
  Math.max(0, Math.round(rowTop - viewHeight / 3))
