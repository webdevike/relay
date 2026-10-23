import { act, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: () => () => {},
}))
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }))

import { Grip } from './Grip'
import { layoutStore, resetLayoutStoreForTests, setWindowWidth, togglePanel } from './layout-store'
import { overlayStore } from '../overlay/overlay-store'

const saves = (): unknown[][] => invoke.mock.calls.filter((c) => c[0] === 'layout.save')
const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue({ ok: true, value: {} })
  resetLayoutStoreForTests()
  togglePanel(true)
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
      fireEvent.pointerMove(window, { clientX: 332, buttons: 1 })
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

  it('unmounting mid-drag commits the pending position and restores drag state', () => {
    const { unmount } = render(<Grip edge="sidebar" />)
    fireEvent.pointerDown(screen.getByTestId('grip-sidebar'), { clientX: 272, button: 0 })
    expect(document.body.classList.contains('eva-resizing')).toBe(true)
    fireEvent.pointerMove(window, { clientX: 350, buttons: 1 })
    unmount()
    expect(document.body.style.userSelect).toBe('')
    expect(document.body.classList.contains('eva-resizing')).toBe(false)
    expect(layoutStore.getState().sidebarWidth).toBe(350)
    expect(saves()).toEqual([['layout.save', { sidebarWidth: 350 }]])
    expect(overlayStore.getState().ids.size).toBe(0)
  })
  it('negates dx for the panel', async () => {
    render(<Grip edge="panel" />)
    fireEvent.pointerDown(screen.getByTestId('grip-panel'), { clientX: 800, button: 0 })
    await act(async () => {
      fireEvent.pointerMove(window, { clientX: 740, buttons: 1 })
      fireEvent.pointerUp(window, { clientX: 740 })
    })
    expect(layoutStore.getState().panelPx).toBe(480)
  })

  it('tracks successive frames from the original grab without accumulating deltas', async () => {
    render(<Grip edge="sidebar" />)
    fireEvent.pointerDown(screen.getByTestId('grip-sidebar'), { clientX: 272, button: 0 })
    for (const clientX of [302, 332, 362]) {
      await act(async () => {
        fireEvent.pointerMove(window, { clientX, buttons: 1 })
        await frame()
      })
      expect(layoutStore.getState().sidebarPx).toBe(clientX)
    }
    fireEvent.pointerUp(window, { clientX: 362 })
    expect(saves()).toEqual([['layout.save', { sidebarWidth: 362 }]])
  })

  it('uses the release coordinate even before the next frame or any move event', () => {
    render(<Grip edge="sidebar" />)
    const grip = screen.getByTestId('grip-sidebar')
    fireEvent.pointerDown(grip, { clientX: 272, button: 0 })
    fireEvent.pointerMove(window, { clientX: 300, buttons: 1 })
    fireEvent.pointerUp(window, { clientX: 340 })
    expect(layoutStore.getState().sidebarPx).toBe(340)
    expect(saves()).toEqual([['layout.save', { sidebarWidth: 340 }]])
    fireEvent.pointerDown(grip, { clientX: 340, button: 0 })
    fireEvent.pointerUp(window, { clientX: 360 })
    expect(saves()).toHaveLength(2)
    expect(saves()[1]).toEqual(['layout.save', { sidebarWidth: 360 }])
  })

  it.each(['pointerCancel', 'blur', 'lostPointerCapture'] as const)(
    '%s flushes the pending frame, restores selection and commits only once',
    (event) => {
      document.body.style.userSelect = 'text'
      render(<Grip edge="sidebar" />)
      const grip = screen.getByTestId('grip-sidebar')
      fireEvent.pointerDown(grip, { clientX: 272, button: 0 })
      fireEvent.pointerMove(window, { clientX: 330, buttons: 1 })
      if (event === 'lostPointerCapture') fireEvent.lostPointerCapture(grip)
      else fireEvent[event](window)
      expect(layoutStore.getState().sidebarPx).toBe(330)
      expect(saves()).toEqual([['layout.save', { sidebarWidth: 330 }]])
      expect(document.body.style.userSelect).toBe('text')
      expect(document.body.classList.contains('eva-resizing')).toBe(false)
      expect(overlayStore.getState().ids.size).toBe(0)
      fireEvent.pointerUp(window, { clientX: 400 })
      fireEvent.pointerMove(window, { clientX: 400, buttons: 1 })
      expect(saves()).toHaveLength(1)
      expect(layoutStore.getState().sidebarPx).toBe(330)
      document.body.style.userSelect = ''
    },
  )

  it('ends a drag when pointer movement reports the button was released outside the window', () => {
    render(<Grip edge="sidebar" />)
    fireEvent.pointerDown(screen.getByTestId('grip-sidebar'), { clientX: 272, button: 0 })
    fireEvent.pointerMove(window, { clientX: 310, buttons: 1 })
    fireEvent.pointerMove(window, { clientX: 400, buttons: 0 })
    expect(saves()).toEqual([['layout.save', { sidebarWidth: 310 }]])
    expect(document.body.classList.contains('eva-resizing')).toBe(false)
    expect(overlayStore.getState().ids.size).toBe(0)
  })

  it('ignores another pointer moving or releasing while the grabbed pointer is active', () => {
    render(<Grip edge="sidebar" />)
    const grip = screen.getByTestId('grip-sidebar')
    const pointer = (
      type: 'pointerDown' | 'pointerMove' | 'pointerUp',
      target: HTMLElement | Window,
      pointerId: number,
      clientX: number,
    ): void => {
      const event = createEvent[type](target, { clientX, button: 0, buttons: 1 })
      Object.defineProperty(event, 'pointerId', { value: pointerId })
      fireEvent(target, event)
    }
    pointer('pointerDown', grip, 1, 272)
    pointer('pointerMove', window, 1, 330)
    pointer('pointerMove', window, 2, 410)
    pointer('pointerUp', window, 2, 410)
    expect(saves()).toHaveLength(0)
    expect(document.body.classList.contains('eva-resizing')).toBe(true)
    pointer('pointerUp', window, 1, 340)
    expect(saves()).toEqual([['layout.save', { sidebarWidth: 340 }]])
    expect(document.body.classList.contains('eva-resizing')).toBe(false)
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
