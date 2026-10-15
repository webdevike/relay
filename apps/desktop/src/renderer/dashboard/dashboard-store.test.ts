import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))

import {
  dashboardStore,
  loadDashboard,
  resetDashboardForTests,
  setFilter,
  setRange,
  workspaceName,
} from './dashboard-store'

const payload = {
  today: '2026-10-15',
  generatedAt: 1,
  workspaces: [
    {
      id: 'flo',
      name: 'Flo',
      displayName: 'Flo',
      tagline: null,
      latest: null,
      lastActive: null,
      openTodos: 0,
      builtIn: false,
      hasFile: true,
      aliases: [],
      daily: new Array(90).fill(0),
    },
  ],
  todos: [],
  updates7d: 0,
}

beforeEach(() => {
  invoke.mockReset()
  resetDashboardForTests()
})

describe('dashboard store', () => {
  it('loads, then keeps previous data on failure and sets error', async () => {
    invoke.mockResolvedValueOnce({ ok: true, value: payload })
    expect(dashboardStore.getState().loading).toBe(true)
    await loadDashboard()
    expect(dashboardStore.getState()).toMatchObject({ loading: false, error: false, data: payload })
    invoke.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'x' } })
    await loadDashboard()
    expect(dashboardStore.getState()).toMatchObject({ error: true, data: payload })
    invoke.mockRejectedValueOnce(new Error('boom'))
    await loadDashboard()
    expect(dashboardStore.getState().error).toBe(true)
    expect(dashboardStore.getState().reloading).toBe(false)
  })

  it('three calls during one flight make exactly two invokes', async () => {
    let release: (v: unknown) => void = () => {}
    invoke.mockImplementationOnce(() => new Promise((r) => (release = r)))
    invoke.mockResolvedValue({ ok: true, value: payload })
    const a = loadDashboard()
    const b = loadDashboard()
    const c = loadDashboard()
    release({ ok: true, value: payload })
    await Promise.all([a, b, c])
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('filter, range and workspaceName', async () => {
    invoke.mockResolvedValue({ ok: true, value: payload })
    await loadDashboard()
    setFilter('quiet')
    setRange(30)
    expect(dashboardStore.getState()).toMatchObject({ filter: 'quiet', range: 30 })
    expect(workspaceName('flo')).toBe('Flo')
    expect(workspaceName('nope')).toBeNull()
  })
})
