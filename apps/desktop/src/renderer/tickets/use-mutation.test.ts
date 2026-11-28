import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TicketMutation } from '@relay/protocol'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

import { CHECKING, useTicketMutation } from './use-mutation'

const comment: TicketMutation = { kind: 'comment', issueId: 'issue-1', body: 'Looks good' }
const react: TicketMutation = { kind: 'react', commentId: 'c-1', emoji: '+1', on: true }

const host = (v: object) => Promise.resolve({ ok: true, value: { source: 'host', ...v } })
const approval = {
  id: 'appr-1',
  expiresAt: Date.now() + 120_000,
  summary: 'Post a comment on ENG-1',
}
const outcome = (opId: string, state = 'done') => ({ outcome: { opId, state } })

type Commit = { opId: string; approvalId?: string; mutation: TicketMutation }
const calls = (channel: string) => invoke.mock.calls.filter(([c]) => c === channel)
const commits = () => calls('tickets.commit').map(([, input]) => input as Commit)

/** prepare approves; each commit answers the next of `answers` (the last repeats). */
function gate(answers: Array<(input: Commit) => unknown>): void {
  let n = 0
  invoke.mockImplementation((channel: string, input: Commit) => {
    if (channel === 'tickets.prepare') return host({ approval })
    const answer = answers[Math.min(n, answers.length - 1)]!
    n += 1
    return answer(input)
  })
}

afterEach(() => invoke.mockReset())

describe('useTicketMutation', () => {
  it('confirms a confirmed kind before it commits, with the approval', async () => {
    gate([(i) => host(outcome(i.opId))])
    const onDone = vi.fn()
    const { result } = renderHook(() => useTicketMutation(onDone))
    act(() => result.current.run(comment))
    await waitFor(() =>
      expect(result.current.view).toEqual({ kind: 'confirming', summary: approval.summary }),
    )
    expect(commits()).toHaveLength(0)
    act(() => result.current.confirm())
    await waitFor(() => expect(result.current.view).toEqual({ kind: 'done' }))
    expect(commits()).toEqual([
      { opId: expect.any(String), approvalId: 'appr-1', mutation: comment },
    ])
    expect(onDone).toHaveBeenCalledWith({ opId: commits()[0]!.opId, state: 'done' })
  })

  it('commits an unconfirmed kind at once, without prepare', async () => {
    gate([(i) => host(outcome(i.opId))])
    const { result } = renderHook(() => useTicketMutation())
    act(() => result.current.run(react))
    await waitFor(() => expect(result.current.view).toEqual({ kind: 'done' }))
    expect(calls('tickets.prepare')).toHaveLength(0)
    expect(commits()[0]).not.toHaveProperty('approvalId')
  })

  it('confirm: true makes an unconfirmed kind confirm too', async () => {
    gate([(i) => host(outcome(i.opId))])
    const { result } = renderHook(() => useTicketMutation())
    const move: TicketMutation = {
      kind: 'setState',
      issueId: 'i',
      fromStateId: 'a',
      toStateId: 'b',
    }
    act(() => result.current.run(move, { confirm: true }))
    await waitFor(() => expect(result.current.view.kind).toBe('confirming'))
    expect(calls('tickets.prepare')).toHaveLength(1)
  })

  it('a lost answer is unknown, and retry asks again with the same opId and approval', async () => {
    gate([
      () =>
        Promise.resolve({
          ok: true,
          value: { source: 'fallback', reason: 'disconnected', message: 'x' },
        }),
      (i) => host(outcome(i.opId, 'unknown')),
      (i) => host(outcome(i.opId)),
    ])
    const { result } = renderHook(() => useTicketMutation())
    act(() => result.current.run(comment))
    await waitFor(() => expect(result.current.view.kind).toBe('confirming'))
    act(() => result.current.confirm())
    await waitFor(() => expect(result.current.view).toEqual({ kind: 'unknown', message: CHECKING }))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.view).toEqual({ kind: 'unknown', message: CHECKING }))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.view).toEqual({ kind: 'done' }))
    const ops = commits()
    expect(ops).toHaveLength(3)
    expect(new Set(ops.map((o) => o.opId)).size).toBe(1)
    expect(ops.every((o) => o.approvalId === 'appr-1')).toBe(true)
    expect(calls('tickets.prepare')).toHaveLength(1)
  })

  it('a refusal shows its message; retry prepares again with the same opId', async () => {
    gate([
      () => host({ refused: { code: 'conflict', message: 'Changed in Linear since you looked' } }),
      (i) => host(outcome(i.opId)),
    ])
    const { result } = renderHook(() => useTicketMutation())
    act(() => result.current.run(comment))
    await waitFor(() => expect(result.current.view.kind).toBe('confirming'))
    act(() => result.current.confirm())
    await waitFor(() =>
      expect(result.current.view).toEqual({
        kind: 'refused',
        message: 'Changed in Linear since you looked',
      }),
    )
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.view.kind).toBe('confirming'))
    expect(calls('tickets.prepare')).toHaveLength(2)
    act(() => result.current.confirm())
    await waitFor(() => expect(result.current.view).toEqual({ kind: 'done' }))
    expect(new Set(commits().map((o) => o.opId)).size).toBe(1)
  })

  it('a failed write says why', async () => {
    gate([
      (i) => host({ outcome: { opId: i.opId, state: 'failed', result: { error: 'No access' } } }),
    ])
    const { result } = renderHook(() => useTicketMutation())
    act(() => result.current.run(react))
    await waitFor(() =>
      expect(result.current.view).toEqual({ kind: 'failed', message: 'No access' }),
    )
  })

  it('cancel drops the confirm and nothing is committed; a new run mints a new opId', async () => {
    gate([(i) => host(outcome(i.opId))])
    const { result } = renderHook(() => useTicketMutation())
    act(() => result.current.run(comment))
    await waitFor(() => expect(result.current.view.kind).toBe('confirming'))
    act(() => result.current.cancel())
    expect(result.current.view).toEqual({ kind: 'idle' })
    act(() => result.current.confirm())
    expect(commits()).toHaveLength(0)
    act(() => result.current.run(react))
    act(() => result.current.run(react))
    await waitFor(() => expect(commits()).toHaveLength(2))
    expect(commits()[0]!.opId).not.toBe(commits()[1]!.opId)
  })
})
