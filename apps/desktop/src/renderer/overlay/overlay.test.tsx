import { MantineProvider } from '@mantine/core'
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn(async () => ({ ok: true, value: {} }))
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...a),
  on: () => () => {},
}))

import { dismissTop } from '../hotkeys/dismiss'
import { EvaMenu, EvaModal, EvaPopover } from './index'
import { overlayStore } from './overlay-store'

const wrap = (ui: React.ReactNode) => <MantineProvider>{ui}</MantineProvider>

describe('overlay wrappers', () => {
  beforeEach(() => invoke.mockClear())

  it('EvaModal occludes the browser while open', () => {
    const r = render(
      wrap(
        <EvaModal opened onClose={() => {}} title="T">
          body
        </EvaModal>,
      ),
    )
    expect(overlayStore.getState().ids.size).toBe(1)
    expect(invoke).toHaveBeenCalledWith('browser.setOccluded', { occluded: true })
    r.rerender(
      wrap(
        <EvaModal opened={false} onClose={() => {}} title="T">
          body
        </EvaModal>,
      ),
    )
    expect(overlayStore.getState().ids.size).toBe(0)
    expect(invoke).toHaveBeenLastCalledWith('browser.setOccluded', { occluded: false })
  })

  it('EvaMenu closes through the dismiss stack', () => {
    const closeMenu = vi.fn()
    const r = render(
      wrap(
        <EvaMenu opened onChange={closeMenu}>
          <EvaMenu.Target>
            <button>m</button>
          </EvaMenu.Target>
          <EvaMenu.Dropdown>
            <EvaMenu.Item>x</EvaMenu.Item>
          </EvaMenu.Dropdown>
        </EvaMenu>,
      ),
    )
    act(() => void dismissTop())
    expect(closeMenu).toHaveBeenCalledWith(false)
    r.unmount()
  })

  it('EvaPopover closes through the dismiss stack', () => {
    const closePop = vi.fn()
    const r = render(
      wrap(
        <EvaPopover opened onChange={closePop}>
          <EvaPopover.Target>
            <button>p</button>
          </EvaPopover.Target>
          <EvaPopover.Dropdown>hi</EvaPopover.Dropdown>
        </EvaPopover>,
      ),
    )
    expect(screen.getByText('hi')).toBeTruthy()
    act(() => void dismissTop())
    expect(closePop).toHaveBeenCalledWith(false)
    r.unmount()
  })
})
