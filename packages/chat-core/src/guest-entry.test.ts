import { describe, expect, it } from 'vitest'
import { foldGuestWork, guestTyping, workLink, type GuestEntry } from './guest-entry'
import { makeMessage, type ChatMessage } from './message'
import { parseSession } from './session'

const penny = { id: 'penny', title: 'Penny', color: '#22aa66' }
const j = (o: unknown) => JSON.stringify(o)
const entry = (id: string, parentId: string | null, details: unknown, customType = 'relay-guest') =>
  j({
    type: 'custom_message',
    customType,
    content: `guest ${id}`,
    display: true,
    details,
    id,
    parentId,
    timestamp: '2026-11-11T10:00:00.000Z',
  })
const work = (state: 'working' | 'done' | 'failed', extra: Partial<GuestEntry> = {}): GuestEntry => ({
  kind: 'work',
  agent: penny,
  work: { id: 'w1', title: 'Find a 2TB USB4 SSD', state, startedAt: 1_000, ...(state === 'working' ? {} : { endedAt: 135_000 }) },
  ...extra,
})
const row = (id: string, guest: GuestEntry): ChatMessage => makeMessage(id, 'guest', '', { guest })

describe('relay-guest rows', () => {
  it('reads join, say, leave and work rows from the session file and skips broken ones', () => {
    const text = [
      j({ type: 'message', id: 'u', parentId: null, message: { role: 'user', content: '@Penny find an SSD' } }),
      entry('g1', 'u', { kind: 'join', agent: penny }),
      entry('g2', 'g1', { kind: 'say', agent: penny, text: "On it, I'll report back in my chat." }),
      entry('g3', 'g2', { kind: 'leave', agent: penny }),
      entry('g4', 'g3', work('working')),
      // A work row without its work, and an agent with no title, are not rows.
      entry('x1', 'g4', { kind: 'work', agent: penny }),
      entry('x2', 'x1', { kind: 'join', agent: { id: 'penny', title: '' } }),
      entry('c', 'x2', { kind: 'join', agent: penny }, 'relay-other'),
      entry('g5', 'c', work('done', { text: 'Acasis 40Gbps + WD SN7100 2TB · $189' })),
    ].join('\n')
    const rows = parseSession(text).messages
    expect(rows.map((m) => [m.id, m.role, m.guest?.kind ?? null])).toEqual([
      ['u', 'user', null],
      ['g1', 'guest', 'join'],
      ['g2', 'guest', 'say'],
      ['g3', 'guest', 'leave'],
      ['g4', 'guest', 'work'],
      ['g5', 'guest', 'work'],
    ])
    expect(rows[2]).toMatchObject({ text: 'guest g2', guest: { agent: penny, text: "On it, I'll report back in my chat." } })
  })

  it('folds a piece of work into one row: its latest state, where it started', () => {
    const list = [
      row('g4', work('working')),
      makeMessage('a', 'assistant', 'Penny has it.'),
      row('g5', work('done', { text: '$189' })),
    ]
    const folded = foldGuestWork(list)
    expect(folded.map((m) => [m.id, m.guest?.work?.state ?? m.role])).toEqual([
      ['g4', 'done'],
      ['a', 'assistant'],
    ])
    expect(folded[0]?.guest?.text).toBe('$189')
  })

  it('keeps separate pieces of work apart, and a failed state wins when it is the latest', () => {
    const other = (state: 'working' | 'failed'): GuestEntry => ({
      ...work(state),
      work: { id: 'w2', title: 'Book the flight', state, startedAt: 5_000 },
      ...(state === 'failed' ? { text: "Penny's session ended" } : {}),
    })
    const folded = foldGuestWork([row('a', work('working')), row('b', other('working')), row('c', other('failed'))])
    expect(folded.map((m) => [m.id, m.guest?.work?.id, m.guest?.work?.state])).toEqual([
      ['a', 'w1', 'working'],
      ['b', 'w2', 'failed'],
    ])
  })

  it('opens the guest chat unless the work names its own link', () => {
    expect(workLink(work('working'))).toBe('agent:penny')
    const linked = work('working')
    linked.work!.link = 'web:tab-7'
    expect(workLink(linked)).toBe('web:tab-7')
  })

  it('shows the guest typing between its join and what it says, within the turn', () => {
    const join = row('j', { kind: 'join', agent: penny })
    const say = row('s', { kind: 'say', agent: penny, text: 'Hi' })
    expect(guestTyping([makeMessage('u', 'user', '@Penny'), join])).toEqual(penny)
    expect(guestTyping([join, say])).toBeNull()
    expect(guestTyping([join, makeMessage('u', 'user', 'later')])).toBeNull()
  })
})
