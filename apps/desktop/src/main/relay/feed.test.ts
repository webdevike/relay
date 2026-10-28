import { describe, expect, it } from 'vitest'
import {
  DEVICE_ID,
  Feed,
  RelayRefused,
  hello,
  parseApproval,
  parseAsk,
  parseBoard,
  parseSession,
  proof,
} from './feed'

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
  feed
    .receive(frame)
    .events.flatMap((e) => (e.kind === 'sessions' ? e.sessions : []))
    .map((s) => `${s.id}:${s.status}`)

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
      { t: 'agent.messages', sessionId: 'a', append: [] },
      'not an object',
      null,
    ]) {
      expect(feed.receive(frame)).toEqual({ replies: [], events: [] })
    }
  })

  it('subscribes to boards on welcome, keeps them by title and asks again after a gap', () => {
    const feed = new Feed(Buffer.alloc(32))
    expect(
      feed.receive({ t: 'welcome', state: { agents: { rev: 0, sessions: [] } } }).replies,
    ).toEqual([{ t: 'board.subscribe' }])
    const board = (slug: string, title: string, widgets: unknown[] = []) => ({
      slug,
      title,
      widgets,
      updatedAt: '2026-10-23T10:00:00.000Z',
    })
    const titles = (frame: unknown) =>
      feed
        .receive(frame)
        .events.flatMap((e) => (e.kind === 'boards' ? e.boards : []))
        .map((b) => b.title)
    expect(
      titles({ t: 'board.snapshot', rev: 2, boards: [board('z', 'Office'), board('a', 'Today')] }),
    ).toEqual(['Office', 'Today'])
    expect(titles({ t: 'board.delta', rev: 3, board: board('m', 'GoodOps') })).toEqual([
      'GoodOps',
      'Office',
      'Today',
    ])
    expect(titles({ t: 'board.delta', rev: 4, removed: 'z' })).toEqual(['GoodOps', 'Today'])
    expect(feed.receive({ t: 'board.delta', rev: 6, removed: 'a' })).toEqual({
      replies: [{ t: 'board.get' }],
      events: [],
    })
    expect(titles({ t: 'board.snapshot', rev: 6, boards: [board('a', 'Today')] })).toEqual([
      'Today',
    ])
  })

  it('reads a board leniently: clamps spans, drops tiles without an id or a spec', () => {
    expect(
      parseBoard({
        slug: 'ops',
        title: 'Ops',
        workspace: 'Relay',
        updatedAt: 'x',
        widgets: [
          { id: 'a', span: 4, spec: { widget: 'stat', label: 'Up', value: '1' } },
          { id: 'b', spec: { widget: 'divider' } },
          { id: 'c', span: 40, spec: { widget: 'divider' } },
          { span: 3, spec: { widget: 'divider' } },
          { id: 'd', span: 3 },
        ],
      }),
    ).toEqual({
      slug: 'ops',
      title: 'Ops',
      workspace: 'Relay',
      icon: null,
      updatedAt: 'x',
      widgets: [
        { id: 'a', span: 4, spec: { widget: 'stat', label: 'Up', value: '1' } },
        { id: 'b', span: 12, spec: { widget: 'divider' } },
        { id: 'c', span: 12, spec: { widget: 'divider' } },
      ],
    })
    expect(parseBoard({ slug: 'ops', widgets: [] })).toBeNull()
  })

  it('hears a subscribed reply as it streams: the conversation, appends and updates', () => {
    const feed = authenticated()
    const msg = (id: string, role: string, text: string, streaming?: boolean) => ({
      id,
      role,
      text,
      at: 1,
      ...(streaming === undefined ? {} : { streaming }),
    })
    // Settled messages and anything but the assistant are the file's business.
    expect(
      feed.receive({
        t: 'agent.conversation',
        sessionId: 's',
        rev: 0,
        messages: [
          msg('u', 'user', 'hi'),
          msg('a1', 'assistant', 'done'),
          msg('a2', 'assistant', 'Wor', true),
        ],
      }).events,
    ).toEqual([{ kind: 'stream', session: 's', id: 'a2', text: 'Wor', streaming: true }])
    expect(
      feed.receive({
        t: 'agent.messages',
        sessionId: 's',
        rev: 1,
        append: [msg('a3', 'assistant', '', true)],
      }).events,
    ).toEqual([{ kind: 'stream', session: 's', id: 'a3', text: '', streaming: true }])
    expect(
      feed.receive({
        t: 'agent.message.update',
        sessionId: 's',
        id: 'a3',
        text: 'Working on it',
        streaming: false,
      }).events,
    ).toEqual([{ kind: 'stream', session: 's', id: 'a3', text: 'Working on it', streaming: false }])
  })

  it('reads asks and approvals and their resolution', () => {
    const feed = authenticated()
    const ask = {
      id: 'k1',
      questions: [
        {
          id: 'q1',
          question: 'Ship it?',
          header: 'Deploy',
          options: [{ label: 'Yes', description: 'now' }, { label: '' }, { label: 'No' }],
          multi: false,
          recommended: 1,
        },
        { id: 'q2', question: 'Nothing to pick', options: [] },
      ],
    }
    expect(feed.receive({ t: 'agent.ask', sessionId: 's', ask }).events).toEqual([
      {
        kind: 'ask',
        session: 's',
        ask: {
          id: 'k1',
          questions: [
            {
              id: 'q1',
              question: 'Ship it?',
              header: 'Deploy',
              options: [
                { label: 'Yes', description: 'now' },
                { label: 'No', description: null },
              ],
              multi: false,
              recommended: 1,
            },
          ],
        },
      },
    ])
    expect(feed.receive({ t: 'agent.ask.resolved', sessionId: 's', id: 'k1' }).events).toEqual([
      { kind: 'askResolved', session: 's', id: 'k1' },
    ])
    const approval = {
      id: 'call-1',
      toolName: 'bash',
      command: 'rm -rf build',
      destructive: 'rm -rf',
      requiresBiometric: true,
    }
    expect(feed.receive({ t: 'agent.approval', sessionId: 's', approval }).events).toEqual([
      {
        kind: 'approval',
        session: 's',
        approval: {
          id: 'call-1',
          tool: 'bash',
          command: 'rm -rf build',
          reason: null,
          destructive: 'rm -rf',
        },
      },
    ])
    expect(
      feed.receive({ t: 'agent.approval.resolved', sessionId: 's', id: 'call-1' }).events,
    ).toEqual([{ kind: 'approvalResolved', session: 's', id: 'call-1' }])
    // Nothing to answer: no event.
    expect(parseAsk({ id: 'k2', questions: [{ id: 'q', question: 'x', options: [] }] })).toBeNull()
    expect(parseAsk({ questions: [] })).toBeNull()
    expect(parseApproval({ id: 'c', command: 'ls' })).toBeNull()
    expect(feed.receive({ t: 'agent.ask', sessionId: 's', ask: { id: 'x' } }).events).toEqual([])
  })

  it('hears acks and nacks with Relay error code and message', () => {
    const feed = authenticated()
    expect(feed.receive({ t: 'ack', id: 'c1' }).events).toEqual([{ kind: 'ack', id: 'c1' }])
    expect(
      feed.receive({
        t: 'nack',
        id: 'c2',
        error: { code: 'agent_cannot_respond', message: 'session is gone' },
      }).events,
    ).toEqual([
      { kind: 'nack', id: 'c2', code: 'agent_cannot_respond', message: 'session is gone' },
    ])
    expect(feed.receive({ t: 'nack', id: 'c3' }).events).toEqual([
      { kind: 'nack', id: 'c3', code: 'internal', message: "Relay couldn't do that." },
    ])
  })

  it("hears a thread's reactions by reactor, dropping a bad key, reactor or reaction", () => {
    const feed = authenticated()
    const heart = { emoji: '❤️', excerpt: 'Fixed it.', at: 1700 }
    const eyes = { emoji: '👀', excerpt: 'Look at this', at: 1800 }
    expect(
      feed.receive({
        t: 'reactions.snapshot',
        thread: 'assistant:astra',
        reactions: {
          'assistant@1792486874000': { isaac: heart },
          'user@1792486870000': { isaac: heart, astra: eyes, Astra: eyes, 'x y': eyes },
          'tool@1': { isaac: heart },
          'user@2': { isaac: { emoji: 'ok', excerpt: '', at: 1 } },
          'user@3': { isaac: { emoji: '👍', excerpt: 'x'.repeat(201), at: 1 } },
          // The old flat shape: a reaction where a reactor's record goes.
          'user@4': heart,
          'user@5': 'x',
        },
      }).events,
    ).toEqual([
      {
        kind: 'reactions',
        thread: 'assistant:astra',
        reactions: {
          'assistant@1792486874000': { isaac: heart },
          'user@1792486870000': { isaac: heart, astra: eyes },
        },
      },
    ])
    // A thread name the protocol does not allow, or no record at all.
    expect(
      feed.receive({ t: 'reactions.snapshot', thread: 'room:x', reactions: {} }).events,
    ).toEqual([])
    expect(feed.receive({ t: 'reactions.snapshot', thread: 'session:s1' }).events).toEqual([
      { kind: 'reactions', thread: 'session:s1', reactions: {} },
    ])
  })

  it("reads a hand-started session listed under its folder's name as not named yet", () => {
    const s = (title: string, kind = 'manual') =>
      parseSession(session('a', 'idle', { title, kind, projectPath: '/Users/i/Eva' }))?.title
    expect(s('Eva')).toBe('')
    expect(s('Relay desktop check')).toBe('Relay desktop check')
    // A job's default title (`<job> · HH:MM`) and an assistant's are names.
    expect(s('Eva', 'job')).toBe('Eva')
  })
})
