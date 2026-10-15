import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))

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
