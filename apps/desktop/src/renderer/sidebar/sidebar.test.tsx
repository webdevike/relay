import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    : a[0] === 'canvas.list'
      ? {
          ok: true,
          value: {
            entries: [
              { slug: 'b', title: 'Beta', nodes: 1, modifiedMs: 2, pinned: false },
              { slug: 'a', title: 'Alpha', nodes: 3, modifiedMs: 1, pinned: true },
            ],
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
import { SubPage } from './SubPages'
import { backToRoot, openSub, navLevelStore } from './nav-level'
import { resetListForTests } from '../chat/list/list-store'
import { resetSidebarForTests, sidebarStore } from './sidebar-store'
import { resetSidebarPrefsForTests, sidebarPrefsStore } from './sidebar-prefs'
import { boardsStore } from '../boards/boards-store'

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

beforeEach(() => {
  invoke.mockClear()
  openPlace.mockClear()
  resetSidebarForTests()
  resetSidebarPrefsForTests()
  resetListForTests()
  backToRoot()
  seed('dashboard')
})

describe('MainNav', () => {
  it('marks the active destination without marking unrelated pages', () => {
    seed('habits')
    wrap(<MainNav />)
    expect(screen.getByTestId('nav-habits')).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId('nav-habits')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('nav-jobs')).not.toHaveAttribute('data-active')
  })

  it('click, cmd-click and drill-in rows', () => {
    wrap(<MainNav />)
    fireEvent.click(screen.getByTestId('nav-habits'))
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('habits'), { newTab: false })
    fireEvent.click(screen.getByTestId('nav-habits'), { metaKey: true, shiftKey: true })
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('habits'), { newTab: true })
    // Cmd opens a side pane, not through openPlace; middle-click is a new tab.
    const calls = openPlace.mock.calls.length
    fireEvent.click(screen.getByTestId('nav-habits'), { metaKey: true })
    expect(openPlace.mock.calls).toHaveLength(calls)
    fireEvent(
      screen.getByTestId('nav-habits'),
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }),
    )
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('habits'), { newTab: true })
    fireEvent.click(screen.getByTestId('nav-chat'))
    expect(navLevelStore.getState().level).toBe('chats')
    backToRoot()
    fireEvent.click(screen.getByTestId('nav-meetings'))
    expect(navLevelStore.getState().level).toBe('meetings')
    backToRoot()
    fireEvent.click(screen.getByTestId('nav-canvas'))
    expect(navLevelStore.getState().level).toBe('canvas')
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('canvas'), { newTab: false })
  })

  it('counts show above zero, cap at 99+ and hide on error', () => {
    sidebarStore.setState({ openTodos: 2, scheduledJobs: 150, loaded: true })
    const { unmount } = wrap(<MainNav />)
    expect(screen.getByTestId('count-jobs')).toHaveTextContent('99+')
    unmount()
    sidebarStore.setState({ openTodos: 0, scheduledJobs: 0 })
    wrap(<MainNav />)
    expect(screen.queryByTestId('count-jobs')).toBeNull()
    act(() => sidebarStore.setState({ error: true }))
    expect(
      screen.getByText('Could not read counts. Press the refresh shortcut to try again.'),
    ).toBeInTheDocument()
  })

  it('error hides counts even when numbers are set', () => {
    sidebarStore.setState({ openTodos: 5, scheduledJobs: 5, error: true })
    wrap(<MainNav />)
    expect(screen.queryByTestId('count-jobs')).toBeNull()
  })

  it('lists Overview, then each Relay board, under Dashboards', () => {
    const board = (slug: string, title: string) => ({
      slug,
      title,
      workspace: null,
      icon: null,
      widgets: [],
      updatedAt: '',
    })
    boardsStore.setState({
      data: {
        boards: [board('eva-today', 'Eva today'), board('goodops', 'GoodOps live')],
        relayUp: true,
        queries: false,
      },
    })
    seed('board:goodops')
    wrap(<MainNav />)
    const group = screen.getByTestId('sidebar-dashboards')
    const rows = screen
      .getAllByTestId(/^nav-/)
      .filter((el) => group.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
      .map((el) => el.textContent)
    expect(rows.slice(0, 3)).toEqual(['Overview', 'Eva today', 'GoodOps live'])
    expect(screen.getByTestId('nav-board-goodops')).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId('nav-dashboard')).not.toHaveAttribute('data-active')
    fireEvent.click(screen.getByTestId('nav-board-eva-today'))
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('board:eva-today'), { newTab: false })
    fireEvent.click(screen.getByTestId('nav-dashboard'))
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('dashboard'), { newTab: false })
    boardsStore.setState({ data: null })
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
    expect(screen.getByTestId('settings-item-chat')).toHaveAttribute('data-active', 'true')
    fireEvent.click(screen.getByTestId('settings-item-chat'))
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('settings', { settingsSection: 'Chat' }), {
      newTab: false,
    })
    fireEvent.click(screen.getByTestId('settings-item-chat'), { metaKey: true, shiftKey: true })
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('settings', { settingsSection: 'Chat' }), {
      newTab: true,
    })
  })

  it('shows chat and meeting search with their loading states', () => {
    const { unmount } = wrap(<SubPage level="chats" />)
    expect(screen.getByTestId('chat-new')).toHaveAttribute('aria-label', 'New chat')
    expect(screen.getByPlaceholderText('Search chats')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-sub-empty')).toHaveTextContent('Loading chats')
    unmount()
    wrap(<SubPage level="meetings" />)
    expect(screen.getByPlaceholderText('Search meetings')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-sub-empty')).toHaveTextContent('Loading meetings')
    expect(screen.getByTestId('meetings-home')).toHaveTextContent('Meetings')
  })

  it('lists boards under Pinned and Recent with search and open', async () => {
    seed('canvas', { canvas: 'b' })
    wrap(<SubPage level="canvas" />)
    expect(screen.getByPlaceholderText('Search boards')).toBeInTheDocument()
    expect(screen.getByTestId('canvas-new')).toHaveAttribute('aria-label', 'New board')
    expect(await screen.findByTestId('canvas-row-a')).toHaveTextContent('Alpha')
    expect(screen.getAllByTestId('canvas-section-label').map((s) => s.textContent)).toEqual([
      'Pinned',
      'Recent',
    ])
    // The node count is on hover, not on the row.
    expect(screen.getByTestId('canvas-row-a')).toHaveAttribute('title', 'Alpha\n3 nodes')
    expect(screen.queryByTestId('canvas-count-a')).toBeNull()
    expect(screen.getByTestId('canvas-row-b')).toHaveAttribute('data-active', 'true')
    fireEvent.click(screen.getByTestId('canvas-row-a'))
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('canvas', { canvas: 'a' }), {
      newTab: false,
    })
    fireEvent.change(screen.getByTestId('sidebar-sub-search'), { target: { value: 'bet' } })
    expect(screen.queryByTestId('canvas-row-a')).toBeNull()
    expect(screen.getByTestId('canvas-row-b')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('sidebar-sub-search'), { target: { value: 'zzz' } })
    expect(screen.getByTestId('sidebar-sub-empty')).toHaveTextContent('No boards match')
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
})

describe('Setting row', () => {
  it('opens the Settings page on Theme and drills into the settings sub-page', () => {
    wrap(<MainNav />)
    fireEvent.click(screen.getByTestId('nav-setting'))
    expect(navLevelStore.getState().level).toBe('settings')
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('settings', { settingsSection: 'Theme' }), {
      newTab: false,
    })
  })
})

describe('customization', () => {
  const prefs = () => sidebarPrefsStore.getState()

  it("a row set to Don't show is gone, and a badged one waits for its badge", () => {
    prefs().setVisibility('habits', 'never')
    prefs().setVisibility('jobs', 'badged')
    const { unmount } = wrap(<MainNav />)
    expect(screen.queryByTestId('nav-habits')).toBeNull()
    expect(screen.queryByTestId('nav-jobs')).toBeNull()
    expect(screen.getByTestId('nav-meetings')).toBeInTheDocument()
    act(() => sidebarStore.setState({ scheduledJobs: 3 }))
    expect(screen.getByTestId('count-jobs')).toHaveTextContent('3')
    unmount()
  })

  it('the badge style turns the count into a dot or nothing', () => {
    sidebarStore.setState({ scheduledJobs: 3, loaded: true })
    prefs().setBadgeStyle('dot')
    wrap(<MainNav />)
    expect(screen.getByTestId('count-jobs')).toHaveClass('eva-sb-dot')
    expect(screen.getByTestId('count-jobs')).toBeEmptyDOMElement()
    act(() => prefs().setBadgeStyle('none'))
    expect(screen.queryByTestId('count-jobs')).toBeNull()
  })

  it('rows follow the saved order, new rows after it', () => {
    prefs().setOrder('main', ['meetings', 'jobs'])
    wrap(<MainNav />)
    const rows = screen
      .getAllByTestId(/^nav-/)
      .map((el) => el.getAttribute('data-testid'))
      .slice(0, 3)
    expect(rows).toEqual(['nav-meetings', 'nav-jobs', 'nav-assistants'])
  })

  it('a section can be collapsed from its header and hidden whole', () => {
    wrap(<MainNav />)
    fireEvent.click(screen.getByTestId('sidebar-section-main-head'))
    expect(prefs().collapsed).toEqual({ main: true })
    expect(screen.queryByTestId('nav-habits')).toBeNull()
    act(() => prefs().setVisibility('section:dashboards', 'never'))
    expect(screen.queryByTestId('sidebar-dashboards')).toBeNull()
  })

  it('right click opens the menu; Visibility hides the row, Customize opens the dialog', async () => {
    wrap(<MainNav />)
    fireEvent.contextMenu(screen.getByTestId('nav-canvas'))
    const menu = await screen.findByTestId('sidebar-menu')
    expect(within(menu).getByTestId('sidebar-menu-visibility')).toBeInTheDocument()
    expect(within(menu).getByTestId('sidebar-menu-customize')).toBeInTheDocument()
    expect(within(menu).getByText('Copy link')).toBeInTheDocument()
    expect(within(menu).getByText('Open in new tab')).toBeInTheDocument()
    fireEvent.mouseEnter(within(menu).getByTestId('sidebar-menu-visibility'))
    for (const label of ['Always show', 'Show when badged', "Don't show"]) {
      expect(await screen.findByText(label)).toBeInTheDocument()
    }
    fireEvent.click(screen.getByTestId('sidebar-menu-vis-never'))
    expect(prefs().visibility).toEqual({ canvas: 'never' })
    await waitFor(() => expect(screen.queryByTestId('nav-canvas')).toBeNull())

    fireEvent.contextMenu(screen.getByTestId('nav-chat'))
    fireEvent.click(await screen.findByTestId('sidebar-menu-customize'))
    expect(await screen.findByText('Default badge style')).toBeInTheDocument()
    expect(screen.getByTestId('cz-group-main')).toBeInTheDocument()
    expect(screen.getByTestId('cz-group-dashboards')).toBeInTheDocument()
    // The hidden row stays listed, muted, so it can be brought back.
    expect(screen.getByTestId('cz-row-canvas')).toHaveAttribute('data-hidden', 'true')
  })

  it('Add to favorites puts the page under Favorites; a folder groups it', async () => {
    wrap(<MainNav />)
    fireEvent.contextMenu(screen.getByTestId('nav-canvas'))
    fireEvent.click(await screen.findByTestId('sidebar-menu-favorite'))
    expect(await screen.findByTestId('sidebar-favorites')).toBeInTheDocument()
    expect(screen.getByTestId('fav-item')).toHaveAttribute('data-title', 'Canvas')
    fireEvent.click(screen.getByTestId('favorites-new-folder'))
    expect(await screen.findByTestId('fav-rename')).toHaveFocus()
    fireEvent.change(screen.getByTestId('fav-rename'), { target: { value: 'Make' } })
    fireEvent.keyDown(screen.getByTestId('fav-rename'), { key: 'Enter' })
    await waitFor(() =>
      expect(screen.getByTestId('fav-folder')).toHaveAttribute('data-title', 'Make'),
    )
    fireEvent.contextMenu(screen.getByTestId('fav-item'))
    fireEvent.mouseEnter(await screen.findByTestId('sidebar-menu-move'))
    fireEvent.click(within(await screen.findByTestId('sidebar-menu-move-list')).getByText('Make'))
    const folder = prefs().favorites[0]
    expect(folder?.kind === 'folder' && folder.items.map((i) => i.page)).toEqual(['canvas'])
    fireEvent.click(screen.getByTestId('fav-item'))
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('canvas'), { newTab: false })
  })
})
