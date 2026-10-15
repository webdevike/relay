import { MantineProvider } from '@mantine/core'
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc', () => ({
  invoke: async () => ({ ok: true, value: {} }),
  on: () => () => {},
}))
vi.mock('../chat/ChatPane', () => ({
  ChatPane: () => <main data-testid="chat-pane">chat</main>,
}))
vi.mock('../jobs/JobsPage', () => ({
  JobsPage: () => <div data-testid="page-jobs">jobs</div>,
}))
vi.mock('../habits/HabitsPage', () => ({
  HabitsPage: () => <div data-testid="page-habits">habits</div>,
}))
vi.mock('../meetings/MeetingsHome', () => ({
  MeetingsHome: () => <div data-testid="page-meetings">meetings home</div>,
}))
vi.mock('../meetings/MeetingPage', () => ({
  MeetingPage: () => <div data-testid="page-meeting">meeting detail</div>,
}))
vi.mock('../dashboard/DashboardPage', () => ({
  DashboardPage: () => <div data-testid="page-dashboard">dash</div>,
}))
const scrollAreaProps = vi.fn()
vi.mock('../ui/ScrollArea', () => ({
  ScrollArea: (p: { children: React.ReactNode; scrollKey?: string; 'data-testid'?: string }) => {
    scrollAreaProps(p.scrollKey)
    return <div data-testid={p['data-testid']}>{p.children}</div>
  },
}))

import { createTabs, placeOf, type Place } from '@evaos/shell-core'
import { tabsStore } from '../tabs/tabs-store'
import { PageRouter } from './PageRouter'
import { pageRegistry } from './registry'
import { WorkspacePage } from '../workspace/WorkspacePage'

function go(place: Place): void {
  act(() => {
    tabsStore.setState(
      {
        tabs: createTabs([{ id: 0, here: place, back: [], forward: [], pinned: false }], 0),
        loaded: true,
      },
      true,
    )
  })
}
const ui = () =>
  render(
    <MantineProvider>
      <PageRouter />
    </MantineProvider>,
  )

beforeEach(() => scrollAreaProps.mockClear())

describe('PageRouter', () => {
  it('renders placeholders inside page-scroll and remounts per navigation', () => {
    go(placeOf('inbox'))
    ui()
    expect(screen.getByTestId('page-scroll')).toContainElement(screen.getByTestId('page-inbox'))
    expect(screen.getByRole('heading', { name: 'Inbox' })).toBeInTheDocument()
    expect(
      screen.getByText('Digests and approvals from Eva will appear here in a later update.'),
    ).toBeInTheDocument()
    go(placeOf('tasks'))
    expect(screen.getByTestId('page-tasks')).toBeInTheDocument()
    expect(screen.queryByTestId('page-inbox')).toBeNull()
  })

  it('dispatches kind page by slug: dashboard page, placeholders for the rest', () => {
    go(placeOf('dashboard'))
    const { unmount } = ui()
    expect(screen.getByTestId('page-dashboard')).toHaveTextContent('dash')
    unmount()
    for (const slug of ['calendar', 'tasks', 'memory', 'files', 'help'] as const) {
      go(placeOf(slug))
      const r = ui()
      expect(screen.getByTestId(`page-${slug}`)).toBeInTheDocument()
      expect(screen.queryByText('dash')).toBeNull()
      r.unmount()
    }
  })

  it('renders the jobs page for the jobs place', () => {
    go(placeOf('jobs'))
    ui()
    expect(screen.getByTestId('page-jobs')).toHaveTextContent('jobs')
  })

  it('renders the habits page for the habits place', () => {
    go(placeOf('habits'))
    ui()
    expect(screen.getByTestId('page-habits')).toHaveTextContent('habits')
  })

  it('renders Meetings home and Meeting detail', () => {
    go(placeOf('meetings'))
    const { unmount } = ui()
    expect(screen.getByTestId('page-meetings')).toHaveTextContent('meetings home')
    unmount()
    go(placeOf('meetings', { meeting: 'standup' }))
    ui()
    expect(screen.getByTestId('page-meeting')).toHaveTextContent('meeting detail')
  })

  it('keeps the chat pane mounted and hidden off the chat place', () => {
    go(placeOf('chat'))
    ui()
    const pane = screen.getByTestId('chat-pane')
    const wrap = screen.getByTestId('page-chat-wrap')
    expect(wrap.style.display).toBe('flex')
    expect(screen.queryByTestId('page-scroll')).toBeNull()
    go(placeOf('inbox'))
    expect(screen.getByTestId('chat-pane')).toBe(pane)
    expect(wrap.style.display).toBe('none')
    go(placeOf('chat'))
    expect(screen.getByTestId('chat-pane')).toBe(pane)
    expect(wrap.style.display).toBe('flex')
  })

  it('renders settings through the registry', () => {
    go(placeOf('settings', { settingsSection: 'Chat' }))
    ui()
    expect(screen.getByTestId('settings-chat')).toBeInTheDocument()
  })

  it('falls back to the placeholder for an unknown kind', () => {
    const saved = pageRegistry.settings
    ;(pageRegistry as Record<string, unknown>).settings = undefined
    try {
      go(placeOf('settings'))
      expect(() => ui()).not.toThrow()
    } finally {
      ;(pageRegistry as Record<string, unknown>).settings = saved
    }
  })

  it('maps the workspace kind to WorkspacePage', () => {
    expect(pageRegistry.workspace).toBe(WorkspacePage)
  })

  it('passes the place key as scrollKey', () => {
    go(placeOf('files'))
    ui()
    expect(scrollAreaProps).toHaveBeenCalledWith('page:files')
  })
})
