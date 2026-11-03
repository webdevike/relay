import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))

import { loadWorkspace, resetWorkspaceForTests, workspaceStore } from './workspace-store'

const detail = { today: '2026-10-15', workspace: null, timeline: [], todos: [], sections: [] }

beforeEach(() => {
  invoke.mockReset()
  resetWorkspaceForTests()
})

describe('workspace store', () => {
  it('loads detail for the id', async () => {
    invoke.mockResolvedValueOnce({ ok: true, value: detail })
    await loadWorkspace('flo')
    expect(invoke).toHaveBeenCalledWith('eva.workspace', { id: 'flo' })
    expect(workspaceStore.getState()).toMatchObject({
      id: 'flo',
      loading: false,
      error: false,
      data: detail,
    })
  })

  it('collapses triggers during flight into one follow-up', async () => {
    let release: (v: unknown) => void = () => {}
    invoke.mockImplementationOnce(() => new Promise((r) => (release = r)))
    invoke.mockResolvedValue({ ok: true, value: detail })
    const p = loadWorkspace('flo')
    void loadWorkspace('flo')
    void loadWorkspace('flo')
    release({ ok: true, value: detail })
    await p
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('sets error on failure', async () => {
    invoke.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'x' } })
    await loadWorkspace('flo')
    expect(workspaceStore.getState().error).toBe(true)
  })
})
