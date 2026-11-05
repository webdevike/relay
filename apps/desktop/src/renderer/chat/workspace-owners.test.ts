import { describe, expect, it } from 'vitest'
import type { ChatRow } from '@evaos/contract'
import type { ActivityItem } from '@evaos/chat-core/activity'
import { ownerChain } from './workspace-owners'

const row = (id: string, owner: string | null): ChatRow =>
  ({
    id,
    file: `/s/2026-11-05T10-00-00Z_${id}.jsonl`,
    title: id,
    owner: owner === null ? null : { agent: owner, closed: false },
  }) as unknown as ChatRow

const item = (session: string, owner: string): ActivityItem => ({
  id: `session:${session}`,
  kind: 'session',
  owner,
  title: session,
  status: 'working',
  intent: '',
  startedAt: 0,
  updatedAt: 0,
  open: { to: 'chat', thread: `session:${session}`, session },
})

describe('ownerChain', () => {
  it("follows a session's owners to the assistant at the end", () => {
    const rows = [row('a1', 'astra'), row('h1', null), row('h2', null), row('mine', null)]
    const items = [item('h1', 'session:a1'), item('h2', 'session:h1')]
    expect(ownerChain(rows[0]!.file, rows, items)).toBe('astra')
    // A helper of a helper of Astra's session is Astra's work too.
    expect(ownerChain(rows[2]!.file, rows, items)).toBe('astra')
    expect(ownerChain(rows[3]!.file, rows, items)).toBeNull()
  })

  it('takes an assistant owner from the activity feed, and stops on a loop', () => {
    const rows = [row('s1', null), row('x', null), row('y', null)]
    expect(ownerChain(rows[0]!.file, rows, [item('s1', 'assistant:polaris')])).toBe('polaris')
    const loop = [item('x', 'session:y'), item('y', 'session:x')]
    expect(ownerChain(rows[1]!.file, rows, loop)).toBeNull()
  })
})
