import { describe, expect, it } from 'vitest'
import type { ActivityItem } from '@evaos/chat-core/activity'
import type { Assistants, CanvasRoom } from '@evaos/contract'
import {
  FRESH_MS,
  REPLY_FRESH_MS,
  chatAlertEvent,
  repliesSince as repliesAt,
  roomsSince,
  updateEvent,
  waitingSince,
} from './events'

const agent = (
  id: string,
  over: Partial<Assistants['agents'][number]> = {},
): Assistants['agents'][number] => ({
  id,
  title: id[0]!.toUpperCase() + id.slice(1),
  scope: '',
  avatar: { style: 'notionists', seed: id },
  status: 'idle',
  tool: null,
  file: `/s/${id}.jsonl`,
  reply: null,
  ...over,
})
const list = (...agents: Assistants['agents']): Assistants => ({ agents, relayUp: true })
const reply = (text: string, at: number) => ({ text, at })
/** Heard 10 ms after epoch: the test replies (at 1, 2, 3) are all fresh. */
const repliesSince = (seen: Parameters<typeof repliesAt>[0], l: Assistants) =>
  repliesAt(seen, l, 10)

describe('repliesSince', () => {
  it('remembers the first list and tells nothing', () => {
    const out = repliesSince(null, list(agent('nova', { reply: reply('Hi', 1) })))
    expect(out.events).toEqual([])
    expect([...out.next.keys()]).toEqual(['nova'])
  })

  it('tells a new reply once, grouped under its assistant, clicking into its page', () => {
    const first = repliesSince(null, list(agent('nova', { reply: reply('Hi', 1) }))).next
    const out = repliesSince(first, list(agent('nova', { reply: reply('Booked it.', 2) })))
    expect(out.events).toEqual([
      expect.objectContaining({
        kind: 'reply',
        assistant: 'nova',
        thread: 'assistant:nova',
        title: 'Nova',
        body: 'Booked it.',
        silent: false,
        click: { link: 'relay://assistant/nova' },
      }),
    ])
    expect(
      repliesSince(out.next, list(agent('nova', { reply: reply('Booked it.', 2) }))).events,
    ).toEqual([])
  })

  it('never tells the assistant\'s own "(nothing to report)" reply', () => {
    const first = repliesSince(null, list(agent('nova', { reply: reply('Hi', 1) }))).next
    const out = repliesSince(first, list(agent('nova', { reply: reply('(nothing to report)', 2) })))
    expect(out.events).toEqual([])
    // ... and it is remembered, so it is not told when the thread next changes either.
    expect(out.next.get('nova')).toContain('(nothing to report)')
  })

  it('holds a reply back while the thread is still working, then tells the last one', () => {
    const first = repliesSince(null, list(agent('nova', { reply: reply('Hi', 1) }))).next
    const mid = repliesSince(
      first,
      list(agent('nova', { status: 'working', reply: reply('Let me look.', 2) })),
    )
    expect(mid.events).toEqual([])
    const end = repliesSince(
      mid.next,
      list(agent('nova', { status: 'idle', reply: reply('Found it: Friday.', 3) })),
    )
    expect(end.events.map((e) => e.body)).toEqual(['Found it: Friday.'])
  })

  it('tells the first reply of an assistant that had none, not one that appears with a reply', () => {
    const first = repliesSince(null, list(agent('astra'))).next
    const out = repliesSince(
      first,
      list(
        agent('astra', { reply: reply('Hello.', 1) }),
        agent('polaris', { reply: reply('Old', 1) }),
      ),
    )
    expect(out.events.map((e) => e.assistant)).toEqual(['astra'])
  })

  it('shortens a long reply to one line', () => {
    const first = repliesSince(null, list(agent('nova', { reply: reply('a', 1) }))).next
    const long = `${'word '.repeat(80)}end`
    const [e] = repliesSince(first, list(agent('nova', { reply: reply(long, 2) }))).events
    expect(e!.body.length).toBeLessThanOrEqual(160)
    expect(e!.body.endsWith('…')).toBe(true)
  })

  it('does not tell a reply omp wrote long before it was heard (a mirror catching up)', () => {
    const first = repliesSince(null, list(agent('nova'))).next
    const old = reply('Written this morning.', 1)
    expect(
      repliesAt(first, list(agent('nova', { reply: old })), 1 + REPLY_FRESH_MS + 1).events,
    ).toEqual([])
    expect(
      repliesAt(first, list(agent('nova', { reply: old })), 1 + REPLY_FRESH_MS).events,
    ).toHaveLength(1)
  })

  it('takes a thread file that appears already holding a reply as the baseline', () => {
    // Relay connects after launch, or a thin client mirrors the host's files: no file, then one.
    const first = repliesSince(null, list(agent('nova', { file: null }))).next
    const filed = repliesSince(first, list(agent('nova', { reply: reply('Old news.', 2) })))
    expect(filed.events).toEqual([])
    const next = repliesSince(filed.next, list(agent('nova', { reply: reply('New.', 3) })))
    expect(next.events.map((e) => e.body)).toEqual(['New.'])
  })
})

const item = (over: Partial<ActivityItem> = {}): ActivityItem => ({
  id: 'session:abc:ask',
  kind: 'session',
  owner: 'assistant:astra',
  title: 'Astra',
  status: 'waiting',
  intent: 'Merge the PR?',
  startedAt: 1_000,
  updatedAt: 1_000,
  open: { to: 'chat', thread: 'assistant:astra' },
  ...over,
})

describe('waitingSince', () => {
  it('tells an item that started waiting on Isaac, once', () => {
    const out = waitingSince(new Set(), [item()], 1_000 + 5_000)
    expect(out.events).toEqual([
      expect.objectContaining({
        kind: 'waiting',
        assistant: 'astra',
        thread: 'assistant:astra',
        key: 'waiting:assistant:astra',
        body: 'Merge the PR?',
        click: { link: 'relay://assistant/astra' },
      }),
    ])
    expect(waitingSince(out.next, [item()], 1_000 + 6_000).events).toEqual([])
  })

  it('tells it again once it waited again after being answered', () => {
    const asked = waitingSince(new Set(), [item()], 2_000).next
    const answered = waitingSince(asked, [item({ status: 'working' })], 3_000).next
    expect(waitingSince(answered, [item()], 4_000).events).toHaveLength(1)
  })

  it('does not announce items that were already stale when first heard', () => {
    const out = waitingSince(new Set(), [item({ updatedAt: 1_000 })], 1_000 + FRESH_MS + 1)
    expect(out.events).toEqual([])
    expect(out.next.has('session:abc:ask')).toBe(true)
  })

  it('sends a canvas item to its board and a plain session to the chat page', () => {
    const [canvas] = waitingSince(
      new Set(),
      [item({ id: 'c', owner: 'other', open: { to: 'canvas', slug: 'plan' } })],
      2_000,
    ).events
    expect(canvas!.click).toEqual({ link: 'relay://open/canvas?canvas=plan' })
    const [session] = waitingSince(
      new Set(),
      [item({ id: 's', owner: 'session:x', open: { to: 'chat', thread: 'session:x' } })],
      2_000,
    ).events
    expect(session).toMatchObject({ assistant: null, thread: 'session:x' })
  })
})

describe('chatAlertEvent', () => {
  const alert = (
    kind: 'needs-approval' | 'has-question' | 'finished',
    file = '/s/1_abc.jsonl',
  ) => ({
    id: 'abc',
    file,
    kind,
    title: 'Fix the build',
    body: kind === 'finished' ? 'Finished' : 'Needs your approval',
  })

  it('names a waiting chat so the Working list tells it as the same event', () => {
    const e = chatAlertEvent(alert('needs-approval'), undefined, () => 'astra')
    expect(e).toMatchObject({
      key: 'waiting:assistant:astra',
      assistant: 'astra',
      thread: 'assistant:astra',
      click: { chat: '/s/1_abc.jsonl' },
    })
  })

  it("keeps a chat of Isaac's own as its session, with no assistant to mute", () => {
    const e = chatAlertEvent(alert('has-question'), undefined, () => null)
    expect(e).toMatchObject({
      key: 'waiting:session:abc',
      assistant: null,
      thread: 'chat:/s/1_abc.jsonl',
    })
  })

  it('finishes quietly, and only for chats that are not an assistant thread', () => {
    expect(chatAlertEvent(alert('finished'), undefined, () => null)).toMatchObject({
      kind: 'finished',
      silent: true,
    })
    expect(chatAlertEvent(alert('finished'), undefined, () => 'nova')).toBeNull()
  })

  it('credits a chat an assistant started to that assistant', () => {
    const e = chatAlertEvent(
      alert('finished'),
      { owner: { agent: 'astra', closed: false } },
      () => null,
    )
    expect(e).toMatchObject({ assistant: 'astra', thread: 'assistant:astra' })
  })
})

const room = (over: Partial<CanvasRoom> = {}): CanvasRoom => ({
  id: 'r1',
  slug: 'plan',
  board: 'Launch plan',
  live: true,
  agent: { name: 'Nova', color: '#336699' },
  chat: { assistant: 'nova', title: 'Plan the launch' },
  humans: [],
  startedAt: 1,
  ...over,
})

describe('roomsSince', () => {
  it('tells a live room that appeared (the Join card), and not the first list', () => {
    expect(roomsSince(null, [room()]).events).toEqual([])
    const out = roomsSince(new Set(), [room()])
    expect(out.events).toEqual([
      expect.objectContaining({
        kind: 'canvas',
        assistant: 'nova',
        title: 'Join Nova on Launch plan',
        click: { link: 'relay://open/canvas?canvas=plan' },
      }),
    ])
    expect(roomsSince(out.next, [room()]).events).toEqual([])
  })

  it('ignores a room that already ended, and keeps its memory while Relay is down', () => {
    expect(roomsSince(new Set(), [room({ live: false })]).events).toEqual([])
    const down = roomsSince(new Set(['r1']), null)
    expect([...(down.next ?? [])]).toEqual(['r1'])
    expect(roomsSince(down.next, [room()]).events).toEqual([])
  })
})

describe('updateEvent', () => {
  it('announces a pending build once, then not again', () => {
    const state = { pending: true, build: 'abc123', summary: 'Notifications.' }
    expect(updateEvent(state, null)).toMatchObject({
      kind: 'update',
      key: 'update:abc123',
      body: 'Notifications.',
      click: { link: 'relay://open/settings/about' },
    })
    expect(updateEvent(state, 'abc123')).toBeNull()
    expect(updateEvent({ ...state, build: 'def456' }, 'abc123')).not.toBeNull()
    expect(updateEvent({ pending: false, build: null, summary: null }, null)).toBeNull()
  })
})
