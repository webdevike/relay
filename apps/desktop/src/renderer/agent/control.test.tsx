import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { pageOpen, filesOpen } = vi.hoisted(() => ({
  pageOpen: vi.fn(() => ({ page: 'jobs' })),
  filesOpen: vi.fn(() => ({ kind: 'dir' })),
}))
vi.mock('./actions', () => ({
  rendererActions: { 'page.open': pageOpen, 'files.open': filesOpen },
  readState: vi.fn(async () => ({ page: { key: 'chat' } })),
}))
vi.mock('../ipc', () => ({
  invoke: vi.fn(async () => ({ ok: true, value: {} })),
  on: vi.fn(() => () => {}),
}))
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn(), hide: vi.fn() } }))

import { dispatch, startAgentControl } from './control'

let stop: () => void
beforeEach(() => {
  stop = startAgentControl()
})
afterEach(() => {
  stop()
  vi.restoreAllMocks()
  pageOpen.mockClear()
  filesOpen.mockClear()
  document.body.innerHTML = ''
})

describe('dispatch', () => {
  it('queues a page change while Isaac types, and runs it once the composer loses focus', async () => {
    const composer = document.createElement('textarea')
    document.body.append(composer)
    composer.focus()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)

    const r = await dispatch('page.open', { page: 'jobs' })
    expect(r).toMatchObject({ ok: true, queued: true })
    expect(pageOpen).not.toHaveBeenCalled()

    // A panel action still runs at once and leaves the composer focused.
    expect(await dispatch('files.open', { path: '.omp/skills' })).toMatchObject({ ok: true })
    expect(filesOpen).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(composer)

    composer.blur()
    await vi.waitFor(() => expect(pageOpen).toHaveBeenCalledOnce())
  })

  it("queues a panel action while Isaac types in a tool pane's address field", async () => {
    const panel = document.createElement('section')
    panel.dataset.paneKind = 'tool'
    const address = document.createElement('input')
    panel.append(address)
    document.body.append(panel)
    address.focus()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)

    expect(await dispatch('files.open', { path: 'a.ts' })).toMatchObject({ queued: true })
    expect(filesOpen).not.toHaveBeenCalled()
    address.blur()
    await vi.waitFor(() => expect(filesOpen).toHaveBeenCalledOnce())
  })

  it('runs a panel action for a page not in front at once: nothing Isaac types in changes', async () => {
    const panel = document.createElement('section')
    panel.dataset.paneKind = 'tool'
    const address = document.createElement('input')
    panel.append(address)
    document.body.append(panel)
    address.focus()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)

    const r = await dispatch('files.open', { path: 'a.ts', scope: 'agent:nova' })
    expect(r).toMatchObject({ ok: true })
    expect(r).not.toHaveProperty('queued')
    expect(filesOpen).toHaveBeenCalledWith({ path: 'a.ts', scope: 'agent:nova' })
    expect(document.activeElement).toBe(address)
  })

  it('runs at once when the window is in the background', async () => {
    const composer = document.createElement('textarea')
    document.body.append(composer)
    composer.focus()
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    expect(await dispatch('page.open', { page: 'jobs' })).toEqual({
      ok: true,
      value: { page: 'jobs' },
    })
  })

  it('rejects unknown actions and invalid params, and answers @state', async () => {
    expect(await dispatch('nope', {})).toMatchObject({ ok: false, code: 'unknown-action' })
    expect(await dispatch('page.open', { page: 'nope' })).toMatchObject({
      ok: false,
      code: 'invalid-params',
    })
    expect(await dispatch('@state', {})).toEqual({ ok: true, value: { page: { key: 'chat' } } })
  })
})
