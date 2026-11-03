import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn(async () => ({ ok: true, value: { visible: true } }))
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...a),
}))

import { overlayStore, useOccludeBrowser } from './overlay-store'

function Probe({ open = true }: { open?: boolean }) {
  useOccludeBrowser(open)
  return null
}

describe('overlayStore', () => {
  beforeEach(() => invoke.mockClear())

  it('counts overlays and calls setOccluded only on transitions', () => {
    const a = render(<Probe />)
    const b = render(<Probe />)
    expect(overlayStore.getState().ids.size).toBe(2)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenLastCalledWith('browser.setOccluded', { occluded: true })

    a.unmount()
    expect(overlayStore.getState().ids.size).toBe(1)
    expect(invoke).toHaveBeenCalledTimes(1)

    b.unmount()
    expect(overlayStore.getState().ids.size).toBe(0)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenLastCalledWith('browser.setOccluded', { occluded: false })
  })

  it('registers nothing while closed', () => {
    const r = render(<Probe open={false} />)
    expect(overlayStore.getState().ids.size).toBe(0)
    act(() => r.rerender(<Probe open />))
    expect(overlayStore.getState().ids.size).toBe(1)
    r.unmount()
  })
})
