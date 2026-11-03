import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ROOM_PEOPLE, type Room } from '@evaos/contract'
import {
  CIRCLING_INSTRUCTIONS,
  CONVERGED_INSTRUCTIONS,
  JEV_MODEL,
  JEV_URL,
  JevClient,
  convergenceState,
  gateState,
  readJevKey,
} from './jev'

const KEY = 'test-key-not-real'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('readJevKey', () => {
  it('prefers the environment, then secrets/jev.env, else null', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-'))
    dirs.push(root)
    expect(readJevKey(root, {})).toBeNull()
    expect(readJevKey(root, { TYPESAFE_API_KEY: ` ${KEY} ` })).toBe(KEY)
    fs.mkdirSync(path.join(root, 'secrets'))
    fs.writeFileSync(
      path.join(root, 'secrets/jev.env'),
      `# jev\nTYPESAFE_API_KEY=${KEY}\nOTHER=1\n`,
    )
    expect(readJevKey(root, {})).toBe(KEY)
    fs.writeFileSync(path.join(root, 'secrets/jev.env'), 'OTHER=1\n')
    expect(readJevKey(root, {})).toBeNull()
  })
})

const agents = ROOM_PEOPLE.slice(0, 2)
const room: Room = {
  id: 'r',
  title: 'q',
  prompt: 'Should we fold?',
  agents: agents.slice(),
  messages: [
    {
      id: 'm1',
      author: 'skeptic',
      text: 'No.',
      ts: 1,
      reactions: [],
      kind: 'message',
      mentions: [],
    },
    {
      id: 'm2',
      author: 'isaac',
      text: '@Theo?',
      ts: 2,
      reactions: [],
      kind: 'message',
      mentions: ['builder'],
    },
  ],
  presence: {},
  phase: 'open',
  rounds: 2,
  startedAt: 0,
}

describe('JevClient', () => {
  it('asks speak_<id> noul questions with the room state; the key is only in the header', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! })
      return new Response(
        JSON.stringify({ answers: { speak_skeptic: { noul: 0.2 }, speak_builder: { noul: 0.9 } } }),
      )
    }) as typeof fetch
    const jev = new JevClient(KEY, fetchImpl)
    const seen = new Map([['skeptic', 1]])
    const state = gateState(room, agents, seen, ['builder'])
    const p = await jev.gate(state, agents)
    expect(p).toEqual({ skeptic: 0.2, builder: 0.9 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(JEV_URL)
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${KEY}`)
    const body = JSON.parse(String(calls[0]!.init.body))
    expect(JSON.stringify(body)).not.toContain(KEY)
    expect(body.model).toBe(JEV_MODEL)
    expect(body.state).toEqual({
      question: 'Should we fold?',
      people: [
        {
          id: 'skeptic',
          name: 'Mara Voss',
          role: 'Skeptic',
          brief: agents[0]!.brief,
          tools: 'none',
        },
        {
          id: 'builder',
          name: 'Theo Lindqvist',
          role: 'Builder',
          brief: agents[1]!.brief,
          tools: 'read-only',
        },
      ],
      transcript: [
        { id: 'm1', author: 'Mara', text: 'No.' },
        { id: 'm2', author: 'Isaac', text: '@Theo?' },
      ],
      unseen: { skeptic: 1, builder: 2 },
      mentioned: ['builder'],
      round: 2,
    })
    expect(body.questions).toEqual({
      speak_skeptic: {
        type: 'noul',
        instructions:
          'Would Mara Voss, the Skeptic, add something the room does not already have if they spoke now? Answer yes only if their angle is missing or they were addressed.',
      },
      speak_builder: {
        type: 'noul',
        instructions:
          'Would Theo Lindqvist, the Builder, add something the room does not already have if they spoke now? Answer yes only if their angle is missing or they were addressed.',
      },
    })
  })

  it('asks converged and circling; HTTP errors and bad answers throw', async () => {
    let body: unknown
    const ok = (async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init!.body))
      return new Response(
        JSON.stringify({ answers: { converged: { noul: 0.82 }, circling: { noul: 0.31 } } }),
      )
    }) as typeof fetch
    const r = await new JevClient(KEY, ok).convergence(
      convergenceState(room, room.messages.slice(1)),
    )
    expect(r).toEqual({ converged: 0.82, circling: 0.31 })
    expect(body).toMatchObject({
      state: {
        question: 'Should we fold?',
        lastRound: [{ id: 'm2', author: 'Isaac', text: '@Theo?' }],
        round: 2,
      },
      questions: {
        converged: { type: 'noul', instructions: CONVERGED_INSTRUCTIONS },
        circling: { type: 'noul', instructions: CIRCLING_INSTRUCTIONS },
      },
    })
    const bad = (async () => new Response('nope', { status: 500 })) as typeof fetch
    await expect(new JevClient(KEY, bad).convergence(convergenceState(room, []))).rejects.toThrow(
      'jev 500',
    )
    const empty = (async () => new Response(JSON.stringify({ answers: {} }))) as typeof fetch
    await expect(
      new JevClient(KEY, empty).gate(gateState(room, agents, new Map(), []), agents),
    ).rejects.toThrow('no noul')
  })
})
