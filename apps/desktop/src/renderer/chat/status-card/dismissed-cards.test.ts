import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

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

import {
  DISMISSED_CARDS_KEY,
  dismissCard,
  reloadDismissedForTests,
  startDismissedCards,
  useDismissed,
  useDismissedIds,
} from './dismissed-cards'

const host = (ids: string[] | null, up = true) =>
  act(() => ipc.listeners.get('cards.dismissed.changed')!({ up, ids }))

beforeEach(() => {
  localStorage.clear()
  ipc.invoke.mockReset()
  ipc.invoke.mockResolvedValue({ ok: true, value: { up: false, ids: null } })
  ipc.listeners.clear()
  reloadDismissedForTests()
})

describe('dismissed cards without a host that keeps them', () => {
  it('stay on this device and send nothing', () => {
    const { result } = renderHook(() => useDismissedIds())
    act(() => dismissCard('a'))
    expect(result.current).toEqual(['a'])
    expect(JSON.parse(localStorage.getItem(DISMISSED_CARDS_KEY)!)).toEqual(['a'])
    expect(ipc.invoke).not.toHaveBeenCalled()
  })
})

describe('dismissed cards on the host', () => {
  it("shows the host's set, keeps phone ids, and a local dismissal shows at once and goes up", () => {
    const stop = startDismissedCards()
    expect(ipc.invoke).toHaveBeenCalledWith('cards.dismissed.get', {})
    const { result } = renderHook(() => ({ ids: useDismissedIds(), b: useDismissed('b') }))
    host(['a', 'p#running'])
    expect(result.current.ids).toEqual(['a', 'p#running'])
    act(() => dismissCard('b'))
    expect(result.current.b).toBe(true)
    expect(ipc.invoke).toHaveBeenLastCalledWith('cards.dismiss', { id: 'b', on: true })
    expect(JSON.parse(localStorage.getItem(DISMISSED_CARDS_KEY)!)).toEqual(['b'])
    host(['a', 'p#running', 'b'])
    expect(result.current.ids).toEqual(['a', 'p#running', 'b'])
    host(null, false)
    expect(result.current.ids).toEqual(['b'])
    stop()
    expect(ipc.listeners.size).toBe(0)
  })

  it('sends local ids the host lacks up once, on its first snapshot', () => {
    localStorage.setItem(DISMISSED_CARDS_KEY, JSON.stringify(['x', 'y']))
    reloadDismissedForTests()
    startDismissedCards()
    ipc.invoke.mockClear()
    host(['x'])
    expect(ipc.invoke.mock.calls).toEqual([['cards.dismiss', { id: 'y', on: true }]])
    ipc.invoke.mockClear()
    host(['x'])
    expect(ipc.invoke).not.toHaveBeenCalled()
  })
})
