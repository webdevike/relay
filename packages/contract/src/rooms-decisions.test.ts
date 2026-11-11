import { describe, expect, it } from 'vitest'
import type { Room, RoomMessage } from './rooms'
import {
  applyDecisionMarkers,
  callPoll,
  decide,
  matchOption,
  pollLeader,
  pollTally,
  reopenPoll,
  splitDecisionMarkers,
  voteOn,
  answerQuestion,
  type DecisionCard,
  type DecisionKindCard,
  type PollCard,
  type ProsConsCard,
  type QuestionCard,
} from './rooms-decisions'

const agent = (id: string, name: string) => ({
  id,
  name,
  title: '',
  role: '',
  brief: '',
  model: 'm',
  tools: 'full' as const,
  color: 'blue',
})

/** A room the markers act on: cards land on messages as the engine would put them. */
function roomOf(): Pick<Room, 'messages' | 'agents'> & { say: (who: string, raw: string) => DecisionKindCard[] } {
  const room = {
    agents: [agent('astra', 'Astra'), agent('polaris', 'Polaris Vale'), agent('nova', 'Nova')],
    messages: [] as RoomMessage[],
    say(who: string, raw: string): DecisionKindCard[] {
      const { text, markers } = splitDecisionMarkers(raw)
      const cards = applyDecisionMarkers(room, who, markers)
      const add = (t: string): RoomMessage => {
        const m: RoomMessage = {
          id: `m${room.messages.length + 1}`,
          author: who,
          text: t,
          ts: 0,
          reactions: [],
          kind: 'message',
          mentions: [],
        }
        room.messages.push(m)
        return m
      }
      const first = add(text)
      cards.forEach((c, i) => {
        const holder = i === 0 ? first : add('')
        c.id = holder.id
        holder.card = c
      })
      return cards
    },
  }
  return room
}

const OPTS = '[[poll: Which store? | SQLite now, Postgres later | Stay on SQLite | Move to Postgres now]]'

describe('splitDecisionMarkers', () => {
  it('reads each kind and cuts it from the text', () => {
    const r = splitDecisionMarkers(
      [
        'Three positions. Voting.',
        OPTS,
        '[[vote: 2]]',
        '[[pros: Staying on SQLite | Zero ops | Fast tests]]',
        '[[cons: Staying on SQLite | One writer]]',
        '[[dispute: Fast tests]]',
        '[[ask-isaac: Second host this quarter? | Yes | No | Not sure | note: Yes flips it]]',
        '[[decision: Stay on SQLite | 40 writes/s is nothing | Polaris: add Litestream]]',
        '[[agree]] [[dissent: too early]]',
      ].join('\n'),
    )
    expect(r.text).toBe('Three positions. Voting.')
    expect(r.markers).toEqual([
      {
        kind: 'poll',
        question: 'Which store?',
        options: ['SQLite now, Postgres later', 'Stay on SQLite', 'Move to Postgres now'],
      },
      { kind: 'vote', option: '2' },
      { kind: 'pros', subject: 'Staying on SQLite', points: ['Zero ops', 'Fast tests'] },
      { kind: 'cons', subject: 'Staying on SQLite', points: ['One writer'] },
      { kind: 'dispute', point: 'Fast tests' },
      {
        kind: 'ask',
        text: 'Second host this quarter?',
        sub: 'Yes flips it',
        answers: ['Yes', 'No', 'Not sure'],
      },
      {
        kind: 'decision',
        title: 'Stay on SQLite',
        why: '40 writes/s is nothing',
        next: 'Polaris: add Litestream',
      },
      { kind: 'agree' },
      { kind: 'dissent', note: 'too early' },
    ])
  })

  it('takes a marker inline and is case-insensitive', () => {
    expect(splitDecisionMarkers('Postgres, it scales. [[VOTE: 3]]')).toEqual({
      text: 'Postgres, it scales.',
      markers: [{ kind: 'vote', option: '3' }],
    })
  })

  it('cuts malformed markers but makes nothing of them', () => {
    for (const bad of [
      '[[poll: only a question]]',
      '[[poll: q | same | Same]]',
      '[[poll: | a | b]]',
      '[[vote:]]',
      '[[pros: subject only]]',
      '[[ask-isaac: question | Yes]]',
      '[[decision:   ]]',
    ]) {
      expect(splitDecisionMarkers(`Hi.\n${bad}`)).toEqual({ text: 'Hi.', markers: [] })
    }
  })

  it('leaves unknown markers, code fences and plain text alone', () => {
    for (const t of ['plain', 'a [[pin: x | 1]] b', '```\n[[vote: 1]]\n```', 'Use array[[0]]']) {
      expect(splitDecisionMarkers(t)).toEqual({ text: t, markers: [] })
    }
  })

  it('never shows a marker that is still arriving', () => {
    for (const tail of ['[', '[[', '[[po', '[[poll', '[[poll: Which', '[[ask-isaac: q | Ye']) {
      expect(splitDecisionMarkers(`Voting.\n${tail}`, true).text).toBe('Voting.')
    }
    expect(splitDecisionMarkers('Use array[[0', true).text).toBe('Use array[[0')
    expect(splitDecisionMarkers('Voting.\n[[po', false).text).toBe('Voting.\n[[po')
  })
})

describe('applyDecisionMarkers', () => {
  it('opens a poll and later votes update its tally', () => {
    const room = roomOf()
    const [poll] = room.say('nova', `Voting.\n${OPTS}\n[[vote: SQLite now, Postgres later]]`) as [
      PollCard,
    ]
    expect(poll.id).toBe('m1')
    expect(poll.options.map((o) => o.id)).toEqual(['o1', 'o2', 'o3'])
    room.say('polaris', 'SQLite. [[vote: Stay on SQLite]]')
    room.say('astra', 'Postgres. [[vote: 3]]')
    room.say('polaris', 'Switching. [[vote: SQLite now]]')
    expect(pollTally(poll)).toEqual({ o1: ['nova', 'polaris'], o2: [], o3: ['astra'] })
    expect(pollLeader(poll)).toBe('o1')
    // A vote nobody can place changes nothing; a reply that only votes still lands.
    room.say('astra', '[[vote: MongoDB]]')
    expect(poll.votes.astra).toBe('o3')
  })

  it('collects pros and cons by subject, backs repeated points and marks disputes', () => {
    const room = roomOf()
    const [pc] = room.say('astra', '[[pros: Staying on SQLite | Zero ops]]\n[[cons: Staying on SQLite | One writer]]') as [
      ProsConsCard,
    ]
    expect(room.messages).toHaveLength(1)
    room.say('polaris', '[[pros: staying on sqlite | zero ops | A migration later is one day]]')
    room.say('astra', '[[dispute: migration later]]')
    expect(pc.pros).toEqual([
      { text: 'Zero ops', by: ['astra', 'polaris'], state: 'agreed' },
      {
        text: 'A migration later is one day',
        by: ['polaris'],
        state: 'disputed',
        against: ['astra'],
      },
    ])
    expect(pc.cons).toEqual([{ text: 'One writer', by: ['astra'], state: 'agreed' }])
  })

  it('puts each new card on its own message and a decision calls its poll', () => {
    const room = roomOf()
    room.say('nova', `${OPTS}\n[[vote: 1]]`)
    room.say('polaris', '[[vote: 2]]')
    const cards = room.say(
      'nova',
      'Calling it.\n[[ask-isaac: Second host? | Yes | No]]\n[[decision: SQLite now, Postgres later | Peak is 40 writes/s | Polaris: add Litestream to R2]]',
    )
    expect(cards.map((c) => [c.type, c.id])).toEqual([
      ['question', 'm3'],
      ['decision', 'm4'],
    ])
    const d = cards[1] as DecisionCard
    expect(d).toMatchObject({
      title: 'SQLite now, Postgres later',
      option: 'o1',
      poll: 'm1',
      agree: ['nova'],
      dissent: [{ by: 'polaris', note: 'Voted Stay on SQLite' }],
      next: { who: 'polaris', text: 'add Litestream to R2' },
      alternatives: [
        { id: 'o2', label: 'Stay on SQLite' },
        { id: 'o3', label: 'Move to Postgres now' },
      ],
      state: 'proposed',
    })
    const poll = room.messages[0]!.card as PollCard
    expect(poll.state).toBe('called')
    expect(poll.called).toEqual({ option: 'o1', by: 'nova' })
    // A called poll takes no more votes; agree and dissent move members on the proposed call.
    room.say('astra', '[[vote: 3]] [[dissent: migrate while it is small]]')
    expect(poll.votes.astra).toBeUndefined()
    room.say('polaris', '[[agree]]')
    expect(d.agree).toEqual(['nova', 'polaris'])
    expect(d.dissent).toEqual([{ by: 'astra', note: 'migrate while it is small' }])
  })

  it('matches options by number, letter, label or a unique part of one', () => {
    const o = [
      { id: 'o1', label: 'SQLite now, Postgres later' },
      { id: 'o2', label: 'Stay on SQLite' },
    ]
    expect(matchOption(o, '2')).toBe('o2')
    expect(matchOption(o, 'b')).toBe('o2')
    expect(matchOption(o, 'stay on sqlite.')).toBe('o2')
    expect(matchOption(o, 'Postgres later')).toBe('o1')
    expect(matchOption(o, 'SQLite')).toBeNull()
    expect(matchOption(o, '9')).toBeNull()
  })
})

describe("Isaac's actions", () => {
  const poll = (): PollCard => ({
    type: 'poll',
    id: 'm1',
    by: 'nova',
    question: 'Which?',
    options: [
      { id: 'o1', label: 'A' },
      { id: 'o2', label: 'B' },
    ],
    votes: { nova: 'o1', astra: 'o2' },
    state: 'open',
  })

  it('votes, takes the vote back, calls and reopens', () => {
    const p = poll()
    expect(pollLeader(p)).toBeNull()
    voteOn(p, 'o2')
    expect(pollLeader(p)).toBe('o2')
    voteOn(p, 'o2')
    expect(p.votes.isaac).toBeUndefined()
    voteOn(p, 'o1')
    expect(callPoll(p)).toBe('o1')
    expect(p).toMatchObject({ state: 'called', called: { option: 'o1', by: 'isaac' } })
    expect(() => voteOn(p, 'o2')).toThrow(/called/)
    reopenPoll(p)
    expect(p.state).toBe('reopened')
    expect(p.called).toBeUndefined()
    voteOn(p, null)
    expect(() => callPoll(p)).toThrow(/Pick an option/)
  })

  it('answers a question with one of its answers, once', () => {
    const q: QuestionCard = {
      type: 'question',
      id: 'm2',
      by: 'polaris',
      text: 'Second host?',
      answers: ['Yes', 'No'],
    }
    expect(() => answerQuestion(q, 'Maybe')).toThrow(/Not one/)
    expect(answerQuestion(q, 'no')).toBe('No')
    expect(() => answerQuestion(q, 'Yes')).toThrow(/answered/)
  })

  const record = (): DecisionCard => ({
    type: 'decision',
    id: 'm3',
    by: 'nova',
    title: 'A',
    why: 'Because.',
    agree: ['nova'],
    dissent: [{ by: 'astra', note: 'Voted B' }],
    alternatives: [{ id: 'o2', label: 'B' }],
    poll: 'm1',
    option: 'o1',
    state: 'proposed',
  })

  it('accepts a proposed call and calls its open poll', () => {
    const p = poll()
    const d = record()
    decide(d, 'accept', undefined, p)
    expect(d.state).toBe('accepted')
    expect(d.agree).toEqual(['nova', 'isaac'])
    expect(p.called).toEqual({ option: 'o1', by: 'isaac' })
    expect(() => decide(d, 'accept', undefined, p)).toThrow(/proposed/)
  })

  it('overrides with an alternative: sides read again from the votes', () => {
    const p = poll()
    const d = record()
    expect(() => decide(d, 'override', 'o9', p)).toThrow(/alternatives/)
    decide(d, 'override', 'o2', p)
    expect(d).toMatchObject({
      state: 'overridden',
      title: 'B',
      option: 'o2',
      previous: 'A',
      alternatives: [{ id: 'o1', label: 'A' }],
      agree: ['isaac', 'astra'],
      dissent: [{ by: 'nova', note: 'Voted A' }],
    })
    expect(p.called).toEqual({ option: 'o2', by: 'isaac' })
  })

  it('reopens the decision and its poll', () => {
    const p = poll()
    const d = record()
    decide(d, 'accept', undefined, p)
    decide(d, 'reopen', undefined, p)
    expect(d.state).toBe('reopened')
    expect(p.state).toBe('reopened')
    expect(() => decide(d, 'reopen', undefined, p)).toThrow(/already/)
  })
})
