import { describe, expect, it } from 'vitest'
import { DEVICE_ID, Feed, RelayRefused, hello, parseSession, proof } from './feed'

const session = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  provider: 'omp',
  title: 'A session',
  projectPath: '/Eva',
  status,
  lastActivity: '',
  lastActivityAt: 0,
  canRespond: true,
  ...extra,
})

const ids = (feed: Feed, frame: unknown) =>
  feed.receive(frame).events.flatMap((e) => e.sessions.map((s) => `${s.id}:${s.status}`))

function authenticated(): Feed {
  const feed = new Feed(Buffer.alloc(32, 7))
  feed.receive({ t: 'welcome', state: { agents: { rev: 4, sessions: [session('a', 'idle')] } } })
  return feed
}

describe('Relay feed', () => {
  it('proves with hex HMAC-SHA256 (RFC 4231 case 2, what Relay computes)', () => {
    expect(proof(Buffer.from('Jefe'), 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    )
  })

  it('says hello as a phone and answers the challenge with its proof', () => {
    expect(hello()).toEqual({
      t: 'hello',
      v: 1,
      deviceId: DEVICE_ID,
      deviceName: 'Relay Desktop',
      platform: 'ios',
    })
    const secret = Buffer.alloc(32, 1)
    const feed = new Feed(secret)
    const out = feed.receive({ t: 'challenge', nonce: 'n1' })
    expect(out).toEqual({ replies: [{ t: 'auth', proof: proof(secret, 'n1') }], events: [] })
    expect(feed.authenticated).toBe(false)
  })

  it('welcome authenticates and lists sessions, leaving out a status it does not know', () => {
    const feed = new Feed(Buffer.alloc(32))
    const welcome = {
      t: 'welcome',
      state: {
        agents: { rev: 4, sessions: [session('a', 'needs_permission'), session('b', 'bogus')] },
      },
    }
    expect(ids(feed, welcome)).toEqual(['a:needs_permission'])
    expect(feed.authenticated).toBe(true)
  })

  it('applies deltas in order and asks for the full list after a gap', () => {
    const feed = authenticated()
    const next = {
      t: 'agents.delta',
      rev: 5,
      upsert: [session('a', 'working'), session('c', 'idle')],
      remove: [],
    }
    expect(ids(feed, next)).toEqual(['a:working', 'c:idle'])
    const skipped = { t: 'agents.delta', rev: 7, remove: ['a'] }
    expect(feed.receive(skipped)).toEqual({ replies: [{ t: 'agents.get' }], events: [] })
    // The snapshot it asked for starts over.
    const snapshot = { t: 'agents.snapshot', rev: 7, sessions: [session('c', 'waiting')] }
    expect(ids(feed, snapshot)).toEqual(['c:waiting'])
    expect(ids(feed, { t: 'agents.delta', rev: 8, remove: ['c'] })).toEqual([])
  })

  it('reads kind, detail and assistant leniently', () => {
    expect(parseSession(session('j', 'working', { kind: 'job', statusDetail: 'bash' }))).toEqual({
      id: 'j',
      status: 'working',
      detail: 'bash',
      canRespond: true,
      kind: 'job',
      title: 'A session',
      assistant: null,
    })
    const astra = parseSession(session('s', 'idle', { kind: 'assistant', assistant: 'astra' }))
    expect([astra?.kind, astra?.assistant]).toEqual(['assistant', 'astra'])
    // A field of the wrong type reads as absent; an empty detail is none.
    const odd = parseSession({
      id: 'x',
      status: 'idle',
      statusDetail: '',
      kind: 7,
      canRespond: 'y',
    })
    expect(odd).toMatchObject({ detail: null, kind: 'manual', canRespond: false, title: '' })
    expect(parseSession({ status: 'idle' })).toBeNull()
  })

  it('ends the connection on unpaired and error, and ignores frames it does not use', () => {
    expect(() => new Feed(Buffer.alloc(32)).receive({ t: 'unpaired' })).toThrow(RelayRefused)
    expect(() => authenticated().receive({ t: 'error', message: 'bad' })).toThrow('Relay: bad')
    const feed = authenticated()
    for (const frame of [
      { t: 'pong', ts: 1, serverTs: 2 },
      { t: 'board.snapshot', rev: 1, boards: [] },
      { t: 'agent.messages', sessionId: 'a', append: [] },
      { t: 'nack', id: 'c', error: { message: 'no' } },
      'not an object',
      null,
    ]) {
      expect(feed.receive(frame)).toEqual({ replies: [], events: [] })
    }
  })
})
