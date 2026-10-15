import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn(async (...a: unknown[]) =>
  a[0] === 'meetings.list'
    ? {
        ok: true,
        value: {
          now: Date.now(),
          meetings: [],
          digest: { recentCount: 0, waiting: [], out: [], decisions: [] },
        },
      }
    : { ok: true, value: { live: false } },
)
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: () => () => {},
}))
const openPlace = vi.fn()
vi.mock('../navigation/navigate', () => ({
  openPlace: (...a: unknown[]) => openPlace(...a),
  setNavigator: () => {},
}))

import { createTabs, placeOf, type Tab } from '@evaos/shell-core'
import { dismissTop } from '../hotkeys/dismiss'
import { tabsStore } from '../tabs/tabs-store'
import { SidebarColumn } from './SidebarColumn'
import { MainNav } from './MainNav'
import { RecentList } from './RecentList'
import { AccountMenu } from './AccountMenu'
import { SubPage } from './SubPages'
import { backToRoot, openSub, navLevelStore } from './nav-level'
import { resetSidebarForTests, sidebarStore } from './sidebar-store'

const tab = (page: string, extra = {}): Tab => ({
  id: 0,
  here: placeOf(page as never, extra),
  back: [],
  forward: [],
  pinned: false,
})
const seed = (page: string, extra = {}): void =>
  tabsStore.setState({ tabs: createTabs([tab(page, extra)], 0), loaded: true }, true)

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

const recent = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    date: `2026-01-0${i + 1}`,
    tag: null,
    title: `Entry ${i}`,
  }))

beforeEach(() => {
  invoke.mockClear()
  openPlace.mockClear()
  resetSidebarForTests()
  backToRoot()
  seed('dashboard')
})

describe('MainNav', () => {
  it('renders rows in order with the active row marked', () => {
    seed('inbox')
    wrap(<MainNav />)
    const ids = [...document.querySelectorAll('[data-testid^="nav-"]')].map((n) =>
      n.getAttribute('data-testid'),
    )
    expect(ids).toEqual([
      'nav-dashboard',
      'nav-inbox',
      'nav-chat',
      'nav-jobs',
      'nav-habits',
      'nav-meetings',
      'nav-calendar',
      'nav-tasks',
      'nav-memory',
      'nav-files',
      'nav-setting',
      'nav-help',
    ])
    expect(screen.getByText('Main')).toBeInTheDocument()
    expect(screen.getByTestId('nav-inbox')).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId('nav-inbox')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('nav-jobs')).not.toHaveAttribute('data-active')
  })

  it('click, cmd-click and drill-in rows', () => {
    wrap(<MainNav />)
    fireEvent.click(screen.getByTestId('nav-inbox'))
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('inbox'), { newTab: false })
    fireEvent.click(screen.getByTestId('nav-inbox'), { metaKey: true })
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('inbox'), { newTab: true })
    fireEvent.click(screen.getByTestId('nav-chat'))
    expect(navLevelStore.getState().level).toBe('chats')
    backToRoot()
    fireEvent.click(screen.getByTestId('nav-meetings'))
    expect(navLevelStore.getState().level).toBe('meetings')
    backToRoot()
    fireEvent.click(screen.getByTestId('nav-setting'))
    expect(navLevelStore.getState().level).toBe('settings')
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('settings', { settingsSection: 'Theme' }), {
      newTab: false,
    })
  })

  it('counts show above zero, cap at 99+ and hide on error', () => {
    sidebarStore.setState({ openTodos: 2, scheduledJobs: 150, loaded: true })
    const { unmount } = wrap(<MainNav />)
    expect(screen.getByTestId('count-tasks')).toHaveTextContent('2')
    expect(screen.getByTestId('count-jobs')).toHaveTextContent('99+')
    unmount()
    sidebarStore.setState({ openTodos: 0, scheduledJobs: 0 })
    wrap(<MainNav />)
    expect(screen.queryByTestId('count-tasks')).toBeNull()
    expect(screen.queryByTestId('count-jobs')).toBeNull()
    act(() => sidebarStore.setState({ error: true }))
    expect(
      screen.getByText(
        'Could not read counts or recent items. Press the refresh shortcut to try again.',
      ),
    ).toBeInTheDocument()
  })

  it('error hides counts even when numbers are set', () => {
    sidebarStore.setState({ openTodos: 5, scheduledJobs: 5, error: true })
    wrap(<MainNav />)
    expect(screen.queryByTestId('count-tasks')).toBeNull()
  })
})

describe('RecentList and search', () => {
  it('caps at 8, filters live, shows empty copy and collapses', () => {
    sidebarStore.setState({ recent: recent(8), loaded: true })
    wrap(<MainNav />)
    expect(screen.getAllByTestId('recent-item')).toHaveLength(8)
    expect(screen.getAllByTestId('recent-item')[0]).toHaveAttribute('title', 'Entry 0')
    fireEvent.change(screen.getByTestId('sidebar-search'), { target: { value: 'entry 3' } })
    expect(screen.getAllByTestId('recent-item')).toHaveLength(1)
    fireEvent.change(screen.getByTestId('sidebar-search'), { target: { value: 'zzz' } })
    expect(screen.getByText('No recent items match your search')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('recent-toggle'))
    expect(screen.queryByText('No recent items match your search')).toBeNull()
  })

  it('shows Nothing recent yet and accepts onOpen', () => {
    const { unmount } = wrap(<RecentList query="" />)
    expect(screen.getByText('Nothing recent yet')).toBeInTheDocument()
    unmount()
    sidebarStore.setState({ recent: recent(1) })
    const onOpen = vi.fn()
    wrap(<RecentList query="" onOpen={onOpen} />)
    fireEvent.click(screen.getByTestId('recent-item'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})

describe('sub-pages', () => {
  it('settings sub-page rows and navigation', () => {
    seed('settings', { settingsSection: 'Chat' })
    openSub('settings')
    wrap(<SidebarColumn />)
    expect(screen.getByTestId('sidebar')).toHaveAttribute('data-sidebar-level', 'settings')
    expect(screen.getByTestId('sidebar-back')).toBeInTheDocument()
    expect(screen.getByTestId('settings-item-theme')).toBeInTheDocument()
    expect(screen.getByTestId('settings-item-notifications')).toBeInTheDocument()
    expect(screen.getByTestId('settings-item-chat')).toHaveAttribute('data-active', 'true')
    fireEvent.click(screen.getByTestId('settings-item-chat'))
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('settings', { settingsSection: 'Chat' }), {
      newTab: false,
    })
    fireEvent.click(screen.getByTestId('settings-item-chat'), { metaKey: true })
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('settings', { settingsSection: 'Chat' }), {
      newTab: true,
    })
  })

  it('chats placeholder and the meetings body', () => {
    const { unmount } = wrap(<SubPage level="chats" />)
    expect(screen.getByTestId('chat-new')).toHaveAttribute('aria-label', 'New chat')
    expect(screen.getByPlaceholderText('Search chats')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-sub-empty')).toHaveTextContent(
      'Your chats arrive in a later update.',
    )
    unmount()
    wrap(<SubPage level="meetings" />)
    expect(screen.getByPlaceholderText('Search meetings')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-sub-empty')).toHaveTextContent('Loading meetings')
    expect(screen.getByTestId('meetings-home')).toHaveTextContent('Meetings')
  })

  it('Esc ordering: clear, blur, then pop the level', () => {
    openSub('chats')
    wrap(<SidebarColumn />)
    const input = screen.getByTestId('sidebar-sub-search') as HTMLInputElement
    input.focus()
    fireEvent.change(input, { target: { value: 'abc' } })
    act(() => void dismissTop())
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
    act(() => void dismissTop())
    expect(document.activeElement).not.toBe(input)
    expect(navLevelStore.getState().level).toBe('chats')
    act(() => void dismissTop())
    expect(navLevelStore.getState().level).toBe('root')
  })

  it('an open account menu takes Esc before the sub-page', async () => {
    openSub('chats')
    wrap(
      <>
        <SidebarColumn />
      </>,
    )
    fireEvent.click(screen.getByTestId('account-trigger'))
    expect(await screen.findByTestId('account-menu')).toBeInTheDocument()
    act(() => void dismissTop())
    expect(navLevelStore.getState().level).toBe('chats')
    act(() => void dismissTop())
    expect(navLevelStore.getState().level).toBe('root')
  })
})

describe('AccountMenu', () => {
  it('opens with Settings and Quit and Quit invokes app.quit', async () => {
    wrap(<AccountMenu />)
    fireEvent.click(screen.getByTestId('account-trigger'))
    const menu = await screen.findByTestId('account-menu')
    expect(within(menu).getByText('Settings')).toBeInTheDocument()
    fireEvent.click(within(menu).getByText('Quit'))
    expect(invoke).toHaveBeenCalledWith('app.quit', {})
  })
})
