import { describe, expect, it } from 'vitest'
import type { ChatRoomMember } from '@evaos/contract'
import { MAX_BURST_TURNS, afterTurn, burstFor, nextSpeaker, type Burst } from './chat-turns'

const m = (id: string, role = ''): ChatRoomMember => ({
  id,
  name: id,
  model: 'anthropic/claude-opus-5-5',
  thinking: 'medium',
  role,
})
const ROOM = [m('astra', 'Argue for'), m('polaris', 'Argue against'), m('nova', 'Judge')]

/** Runs a whole burst: each speaker's reply hands off to `replies[speaker][n]`. */
function run(
  burst: Burst,
  replies: Record<string, string[][]> = {},
  isaac: string[] = [],
): string[] {
  const out: string[] = []
  let b = burst
  for (let id = nextSpeaker(b, ROOM); id !== null; id = nextSpeaker(b, ROOM)) {
    const n = out.filter((x) => x === id).length
    out.push(id)
    b = afterTurn(b, id, replies[id]?.[n] ?? [], isaac.includes(`${id}:${n}`))
  }
  return out
}

describe('chat turns', () => {
  it('setup order, the judge last, effort turns per member', () => {
    expect(burstFor(ROOM, [], 1)).toEqual({ queue: ['astra', 'polaris'], left: 3, last: null })
    expect(run(burstFor(ROOM, [], 1))).toEqual(['astra', 'polaris', 'nova'])
    expect(burstFor(ROOM, [], 5).left).toBe(15)
    expect(burstFor([...ROOM, ...ROOM.map((x) => m(`${x.id}2`))], [], 5).left).toBe(MAX_BURST_TURNS)
  })

  it('mentioned members speak first, in the order Isaac named them; everyone keeps setup order', () => {
    expect(burstFor(ROOM, ['polaris'], 2).queue).toEqual(['polaris', 'astra'])
    expect(burstFor(ROOM, ['nova', 'polaris'], 2).queue).toEqual(['nova', 'polaris', 'astra'])
    expect(burstFor(ROOM, ['everyone'], 2).queue).toEqual(['astra', 'polaris'])
  })

  it('a reply that @mentions a member hands it the next turn, until the effort runs out', () => {
    // Effort 2: six turns. Astra and Polaris pass it back and forth; the judge closes.
    const replies = { astra: [['polaris'], ['polaris']], polaris: [['astra'], ['astra']] }
    expect(run(burstFor(ROOM, [], 2), replies)).toEqual([
      'astra',
      'polaris',
      'astra',
      'polaris',
      'astra',
      'nova',
    ])
  })

  it('a handoff to the judge mid-burst still leaves it the last word', () => {
    expect(run(burstFor(ROOM, [], 2), { astra: [['nova']] })).toEqual([
      'astra',
      'nova',
      'polaris',
      'nova',
    ])
  })

  it('asking Isaac with no handoff ends the burst; a self-mention is no handoff', () => {
    expect(run(burstFor(ROOM, [], 2), {}, ['astra:0'])).toEqual(['astra'])
    expect(afterTurn(burstFor(ROOM, [], 2), 'astra', ['astra'], false).queue).toEqual(['polaris'])
  })

  it('members who left are skipped; a room without a judge just runs out', () => {
    const b: Burst = { queue: ['gone', 'astra'], left: 3, last: null }
    expect(nextSpeaker(b, ROOM)).toBe('astra')
    expect(nextSpeaker({ queue: [], left: 3, last: 'astra' }, ROOM.slice(0, 2))).toBeNull()
    expect(nextSpeaker({ queue: ['astra'], left: 0, last: null }, ROOM)).toBeNull()
  })
})
