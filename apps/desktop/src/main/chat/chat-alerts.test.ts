import { describe, expect, it } from 'vitest'
import type { ChatList, ChatRow } from '@evaos/contract'
import { ChatAlertTracker } from './chat-alerts'

const row = (id: string, status: ChatRow['status'], extra: Partial<ChatRow> = {}): ChatRow =>
  ({
    id,
    file: `/s/${id}.jsonl`,
    title: `Chat ${id}`,
    status,
    archived: false,
    failed: false,
    ...extra,
  }) as ChatRow
const list = (...rows: ChatRow[]): ChatList => ({ rows, prefs: {} }) as ChatList

describe('ChatAlertTracker', () => {
  it('stays quiet on the first list, then reports blocking and finishing', () => {
    const t = new ChatAlertTracker()
    expect(t.update(list(row('a', 'needs-approval'), row('b', 'working')))).toEqual([])
    const out = t.update(
      list(row('a', 'needs-approval'), row('b', 'has-question'), row('c', 'working')),
    )
    expect(out.map((a) => [a.id, a.kind])).toEqual([['b', 'has-question']])
    expect(
      t.update(list(row('b', 'has-question'), row('c', null))).map((a) => [a.id, a.kind]),
    ).toEqual([['c', 'finished']])
  })

  it('skips failed runs, archived chats, and a failed scan', () => {
    const t = new ChatAlertTracker()
    t.update(list(row('a', 'working'), row('b', 'working')))
    expect(
      t.update(
        list(row('a', null, { failed: true }), row('b', 'needs-approval', { archived: true })),
      ),
    ).toEqual([])
    t.update(list(row('c', 'working')))
    expect(t.update({ rows: [], prefs: {}, error: 'x' } as unknown as ChatList)).toEqual([])
    expect(t.update(list(row('c', null)))[0]?.kind).toBe('finished')
  })
})
