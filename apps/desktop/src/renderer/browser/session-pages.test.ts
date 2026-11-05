import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatRow } from '@evaos/contract'
import type { ActivityItem } from '@evaos/chat-core/activity'
import { setOwnerResolver } from '../tabs/workspace-of'
import { endedSessions } from './session-pages'

const row = (id: string, extra: Partial<ChatRow> = {}): ChatRow => ({
  id,
  file: `/s/${id}.jsonl`,
  title: `Session ${id}`,
  mtimeMs: 0,
  archived: false,
  pinned: false,
  running: false,
  status: null,
  agent: 'Eva',
  workedIn: null,
  work: null,
  model: null,
  jobs: 0,
  failed: false,
  returnedMs: 0,
  openedMs: null,
  keptMs: null,
  snoozedUntilMs: null,
  wokeMs: null,
  startedMs: null,
  owner: { agent: 'nova', closed: false },
  ...extra,
})

const item = (id: string, status: ActivityItem['status'], session: string): ActivityItem => ({
  id,
  kind: 'session',
  owner: 'assistant:astra',
  title: `Item ${id}`,
  status,
  intent: '',
  startedAt: 0,
  updatedAt: 0,
  open: { to: 'chat', thread: `session:${session}`, session },
})

beforeEach(() => {
  setOwnerResolver((file) => (file.startsWith('/s/a') ? 'nova' : null))
})
afterEach(() => setOwnerResolver(() => null))

describe('endedSessions', () => {
  it("finds an owned session's row that stopped working, not one waiting on Isaac", () => {
    const before = [row('a1', { status: 'working' }), row('a2', { status: 'working' })]
    const after = [row('a1', { status: 'open' }), row('a2', { status: 'needs-approval' })]
    expect(endedSessions(before, after, [], [])).toEqual([
      { session: 'a1', title: 'Session a1', ws: 'page:agent:nova' },
    ])
  })

  it('finds a row its assistant closed, and skips chats nobody owns', () => {
    const before = [row('a1'), row('b1', { status: 'working', owner: null })]
    const after = [
      row('a1', { owner: { agent: 'nova', closed: true } }),
      row('b1', { owner: null }),
    ]
    expect(endedSessions(before, after, [], [])).toEqual([
      { session: 'a1', title: 'Session a1', ws: 'page:agent:nova' },
    ])
  })

  it("finds a session item that went done, named by its row's title when listed", () => {
    const rows = [row('a1')]
    const before = [
      item('i1', 'working', 'a1'),
      item('i2', 'waiting', 'x9'),
      item('i3', 'done', 'x8'),
    ]
    const after = [item('i1', 'done', 'a1'), item('i2', 'failed', 'x9'), item('i3', 'done', 'x8')]
    expect(endedSessions(rows, rows, before, after)).toEqual([
      { session: 'a1', title: 'Session a1', ws: 'page:agent:nova' },
      { session: 'x9', title: 'Item i2', ws: 'page:agent:astra' },
    ])
  })
})
