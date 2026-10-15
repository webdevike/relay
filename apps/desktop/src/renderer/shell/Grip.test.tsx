import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: () => () => {},
}))
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }))

import { Grip } from './Grip'
import { layoutStore, resetLayoutStoreForTests, setWindowWidth } from './layout-store'
import { overlayStore } from '../overlay/overlay-store'

const saves = (): unknown[][] => invoke.mock.calls.filter((c) => c[0] === 'layout.save')
const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue({ ok: true, value: {} })
  resetLayoutStoreForTests()
  setWindowWidth(1280)
})

describe('Grip', () => {
  it('previews during a drag, commits once on pointerup and restores user-select', async () => {
    render(<Grip edge="sidebar" />)
    const grip = screen.getByTestId('grip-sidebar')
    fireEvent.pointerDown(grip, { clientX: 272, button: 0 })
    expect(document.body.style.userSelect).toBe('none')
    expect(overlayStore.getState().ids.size).toBe(1)
    await act(async () => {
      fireEvent.pointerMove(window, { clientX: 332 })
      await frame()
    })
    expect(layoutStore.getState().sidebarPx).toBe(332)
    expect(saves()).toHaveLength(0)
    await act(async () => {
      fireEvent.pointerUp(window, { clientX: 332 })
    })
    expect(saves()).toEqual([['layout.save', { sidebarWidth: 332 }]])
    expect(document.body.style.userSelect).toBe('')
    expect(overlayStore.getState().ids.size).toBe(0)
  })

  it('negates dx for the panel', async () => {
    render(<Grip edge="panel" />)
    fireEvent.pointerDown(screen.getByTestId('grip-panel'), { clientX: 800, button: 0 })
    await act(async () => {
      fireEvent.pointerMove(window, { clientX: 740 })
      fireEvent.pointerUp(window)
    })
    expect(layoutStore.getState().panelPx).toBe(480)
  })

  it('double-click resets once; keyboard steps and aria', () => {
    render(<Grip edge="sidebar" />)
    const grip = screen.getByRole('separator', { name: 'Resize sidebar' })
    expect(grip).toHaveAttribute('aria-orientation', 'vertical')
    expect(grip).toHaveAttribute('aria-valuenow', '272')
    fireEvent.keyDown(grip, { key: 'ArrowRight' })
    expect(layoutStore.getState().sidebarPx).toBe(288)
    fireEvent.keyDown(grip, { key: 'ArrowLeft', shiftKey: true })
    expect(layoutStore.getState().sidebarPx).toBe(240)
    expect(invoke).toHaveBeenCalledTimes(2)
    invoke.mockClear()
    fireEvent.doubleClick(grip)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(layoutStore.getState().sidebarPx).toBe(272)
    fireEvent.keyDown(grip, { key: 'ArrowRight' })
    invoke.mockClear()
    fireEvent.keyDown(grip, { key: 'Home' })
    expect(layoutStore.getState().sidebarPx).toBe(272)
    expect(invoke).toHaveBeenCalledWith('layout.save', { sidebarWidth: 272 })
  })
})
