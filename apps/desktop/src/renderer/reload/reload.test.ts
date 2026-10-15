import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const handlers: Array<() => void> = []
const unsub = vi.fn()
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: (_c: string, fn: () => void) => {
    handlers.push(fn)
    return unsub
  },
}))

import { runAction } from '../hotkeys/router'
import { refreshSidebar, resetSidebarForTests } from '../sidebar/sidebar-store'
import {
  registerReloader,
  reloadAll,
  reloadPages,
  resetReloadForTests,
  startReload,
} from './reload'

beforeEach(() => {
  invoke.mockReset()
  handlers.length = 0
  unsub.mockReset()
  invoke.mockResolvedValue({ ok: true, value: { openTodos: 1, scheduledJobs: 0, recent: [] } })
  resetSidebarForTests()
  resetReloadForTests()
})

describe('reload seam', () => {
  it('reloadAll refreshes the sidebar once and every reloader once', async () => {
    const a = vi.fn(async () => {})
    const b = vi.fn(async () => {})
    registerReloader('a', a)
    const offB = registerReloader('b', b)
    offB()
    await reloadAll()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
  })

  it('reloadPages skips the sidebar', async () => {
    const a = vi.fn(async () => {})
    registerReloader('a', a)
    await reloadPages()
    expect(a).toHaveBeenCalledTimes(1)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('startReload registers one reload action reaching sidebar and pages; focus reloads pages only', async () => {
    const a = vi.fn(async () => {})
    registerReloader('a', a)
    const stop = startReload()
    expect(startReload()).toBe(stop)
    runAction('reload')
    await refreshSidebar()
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('focus'))
    expect(a).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenCalledTimes(1)
    stop()
    window.dispatchEvent(new Event('focus'))
    expect(a).toHaveBeenCalledTimes(2)
  })
})

describe('eva.changed', () => {
  it('reloads once per event and unsubscribes on dispose', async () => {
    const a = vi.fn(async () => {})
    registerReloader('a', a)
    const stop = startReload()
    expect(handlers).toHaveLength(1)
    handlers[0]!()
    await Promise.resolve()
    expect(a).toHaveBeenCalledTimes(1)
    stop()
    expect(unsub).toHaveBeenCalledTimes(1)
  })

  it('two events while in flight stay bounded by the stores single flight', async () => {
    let n = 0
    registerReloader('a', async () => {
      n++
    })
    const stop = startReload()
    handlers[0]!()
    handlers[0]!()
    await new Promise((r) => setTimeout(r, 10))
    expect(n).toBeLessThanOrEqual(2)
    stop()
  })
})
