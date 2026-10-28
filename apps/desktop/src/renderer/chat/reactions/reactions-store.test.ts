import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (payload: unknown) => void>(),
}))
vi.mock('../../ipc', () => ({
  invoke: ipc.invoke,
  on: (channel: string, cb: (payload: unknown) => void) => {
    ipc.listeners.set(channel, cb)
    return () => ipc.listeners.delete(channel)
  },
}))

import { reactionsStore, startReactions, useReactionThread } from './reactions-store'

const heart = { emoji: '❤️', excerpt: 'Done.', at: 1 }

beforeEach(() => {
  ipc.invoke.mockReset()
  ipc.listeners.clear()
  reactionsStore.setState({ up: false, threads: {} })
})

describe('reactions store', () => {
  it("watches the chat's thread while mounted, and lets it go", async () => {
    ipc.invoke.mockResolvedValue({
      ok: true,
      value: { thread: 'assistant:astra', up: true, reactions: { 'assistant@2': heart } },
    })
    const { result, unmount } = renderHook(() => useReactionThread('/s/a_s1.jsonl', 'astra'))
    await waitFor(() => expect(result.current).toBe('assistant:astra'))
    expect(ipc.invoke).toHaveBeenCalledWith('reactions.watch', {
      file: '/s/a_s1.jsonl',
      agent: 'astra',
    })
    expect(reactionsStore.getState()).toEqual({
      up: true,
      threads: { 'assistant:astra': { 'assistant@2': heart } },
    })
    unmount()
    expect(ipc.invoke).toHaveBeenLastCalledWith('reactions.unwatch', { thread: 'assistant:astra' })
  })

  it("follows main's snapshots and Relay's status", () => {
    const stop = startReactions()
    act(() =>
      ipc.listeners.get('reactions.changed')!({
        thread: 'session:s1',
        up: true,
        reactions: { 'user@1': heart },
      }),
    )
    expect(reactionsStore.getState().threads['session:s1']).toEqual({ 'user@1': heart })
    act(() => ipc.listeners.get('reactions.status')!({ up: false }))
    expect(reactionsStore.getState().up).toBe(false)
    stop()
    expect(ipc.listeners.size).toBe(0)
  })
})
