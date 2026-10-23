import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn(async () => ({ ok: true, value: {} }))
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...a),
  on: () => () => {},
}))

import { createTabs, placeOf, type Tab } from '@evaos/shell-core'
import {
  layoutStore,
  resetLayoutStoreForTests,
  setWindowWidth,
  togglePanel,
} from '../shell/layout-store'
import { overlayStore } from '../overlay/overlay-store'
import { FOLDED_LABEL, TabBar } from './TabBar'
import { MainHeader } from '../shell/MainHeader'
import { activePlace, navigateTo, tabsStore } from './tabs-store'

const tab = (id: number, page: string, pinned = false): Tab => ({
  id,
  here: placeOf(page as never),
  back: [],
  forward: [],
  pinned,
})

function seed(list: Tab[], active = 0): void {
  tabsStore.setState({ tabs: createTabs(list, active), loaded: true }, true)
}

const ui = () =>
  render(
    <MantineProvider>
      <TabBar />
    </MantineProvider>,
  )

beforeEach(() => {
  invoke.mockClear()
  resetLayoutStoreForTests()
  togglePanel(true)
  setWindowWidth(1280)
})

describe('TabBar', () => {
  it('renders tablist, tabs, pinned icons', () => {
    seed([tab(0, 'dashboard', true), tab(1, 'habits'), tab(2, 'jobs')], 1)
    ui()
    expect(screen.getByRole('tablist', { name: 'Open pages' })).toBeInTheDocument()
    expect(screen.getByTestId('tab-1')).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId('tab-1')).toHaveTextContent('Habits')
    expect(screen.getByTestId('tab-close-1')).toHaveAttribute('aria-label', 'Close tab')
    const pinned = screen.getByTestId('tab-pinned-0')
    expect(pinned).not.toHaveTextContent('Dashboard')
    expect(screen.queryByTestId('tab-close-0')).toBeNull()
  })

  it('click, middle click, close button and plus', () => {
    seed([tab(0, 'dashboard', true), tab(1, 'habits'), tab(2, 'jobs')], 0)
    ui()
    fireEvent.click(screen.getByTestId('tab-2'))
    expect(tabsStore.getState().tabs.list[tabsStore.getState().tabs.active]!.id).toBe(2)
    fireEvent(
      screen.getByTestId('tab-pinned-0'),
      new MouseEvent('auxclick', { button: 1, bubbles: true }),
    )
    expect(tabsStore.getState().tabs.list).toHaveLength(3)
    fireEvent(screen.getByTestId('tab-1'), new MouseEvent('auxclick', { button: 1, bubbles: true }))
    expect(tabsStore.getState().tabs.list).toHaveLength(2)
    fireEvent.click(screen.getByTestId('tab-close-2'))
    expect(tabsStore.getState().tabs.list).toHaveLength(1)
    fireEvent.click(screen.getByTestId('tab-new'))
    const l = tabsStore.getState().tabs.list
    expect(l).toHaveLength(2)
    expect(l[1]!.here.page).toBe('chat')
    expect(screen.getByText('New chat')).toBeInTheDocument()
  })

  it('context menu pins, disables Close others, occludes the browser', async () => {
    seed([tab(0, 'habits'), tab(1, 'jobs')], 0)
    ui()
    fireEvent.contextMenu(screen.getByTestId('tab-1'), { clientX: 50, clientY: 20 })
    expect(await screen.findByTestId('tab-menu')).toBeInTheDocument()
    expect(screen.getByTestId('tab-menu-pin')).toHaveTextContent('Pin tab')
    expect(screen.getByTestId('tab-menu-close')).toBeInTheDocument()
    expect(screen.getByTestId('tab-menu-close-others')).not.toBeDisabled()
    expect(overlayStore.getState().ids.size).toBe(1)
    fireEvent.click(screen.getByTestId('tab-menu-pin'))
    expect(screen.getByTestId('tab-pinned-1')).toBeInTheDocument()
    expect(tabsStore.getState().tabs.list[0]!.id).toBe(1)
    fireEvent.contextMenu(screen.getByTestId('tab-pinned-1'))
    await screen.findByText('Unpin tab')
    expect(screen.getByTestId('tab-menu-pin')).toHaveTextContent('Unpin tab')
    expect(screen.getByTestId('tab-menu-close-others')).not.toHaveAttribute('data-disabled')
  })

  it('Close tab is disabled for a pinned tab', async () => {
    seed([tab(0, 'habits', true), tab(1, 'jobs')], 1)
    ui()
    fireEvent.contextMenu(screen.getByTestId('tab-pinned-0'))
    await screen.findByTestId('tab-menu')
    expect(screen.getByTestId('tab-menu-close')).toHaveAttribute('data-disabled', 'true')
    fireEvent.click(screen.getByTestId('tab-menu-close'))
    expect(tabsStore.getState().tabs.list).toHaveLength(2)
  })

  it('Close others is disabled when no other unpinned tab exists', async () => {
    seed([tab(0, 'habits', true), tab(1, 'jobs')], 1)
    ui()
    fireEvent.contextMenu(screen.getByTestId('tab-1'))
    await screen.findByTestId('tab-menu')
    expect(screen.getByTestId('tab-menu-close-others')).toHaveAttribute('data-disabled', 'true')
  })

  it('arrow keys move focus and Enter activates', () => {
    seed([tab(0, 'habits'), tab(1, 'jobs')], 0)
    ui()
    const a = screen.getByTestId('tab-0')
    const b = screen.getByTestId('tab-1')
    a.focus()
    fireEvent.keyDown(a, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(b)
    fireEvent.keyDown(b, { key: 'Enter' })
    expect(tabsStore.getState().tabs.active).toBe(1)
    fireEvent.keyDown(b, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(a)
  })

  it('toggles reflect layout state', () => {
    seed([tab(0, 'habits')])
    render(
      <MantineProvider>
        <TabBar />
        <MainHeader />
      </MantineProvider>,
    )
    const sb = screen.getByTestId('sidebar-toggle')
    expect(sb).toHaveAttribute('aria-label', 'Hide sidebar')
    expect(sb).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('tabbar')).toHaveAttribute('data-lead-in', 'false')
    fireEvent.click(sb)
    expect(sb).toHaveAttribute('aria-label', 'Show sidebar')
    expect(sb).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('tabbar')).toHaveAttribute('data-lead-in', 'true')
    fireEvent.click(sb)
    act(() => setWindowWidth(760))
    expect(sb).toHaveAttribute('aria-label', FOLDED_LABEL)
    const pt = screen.getByTestId('panel-toggle')
    expect(pt).toHaveAttribute('aria-pressed', 'true')
    expect(pt).toHaveAttribute('aria-label', 'Close panel')
    fireEvent.click(pt)
    expect(layoutStore.getState().panelOpen).toBe(false)
    expect(pt).toHaveAttribute('aria-pressed', 'false')
    expect(pt).toHaveAttribute('aria-label', 'Open panel')
  })

  it('navigates the active tab history and disables unavailable directions', () => {
    seed([tab(0, 'habits'), tab(1, 'jobs')])
    ui()
    const back = screen.getByRole('button', { name: 'Back' })
    const forward = screen.getByRole('button', { name: 'Forward' })
    expect(back).toBeDisabled()
    expect(forward).toBeDisabled()
    act(() => navigateTo(placeOf('dashboard')))
    expect(back).not.toBeDisabled()
    fireEvent.click(back)
    expect(activePlace(tabsStore.getState()).page).toBe('habits')
    expect(back).toBeDisabled()
    expect(forward).not.toBeDisabled()
    fireEvent.click(forward)
    expect(activePlace(tabsStore.getState()).page).toBe('dashboard')
    expect(forward).toBeDisabled()
    fireEvent.click(screen.getByTestId('tab-1'))
    expect(back).toBeDisabled()
    expect(forward).toBeDisabled()
  })
})
