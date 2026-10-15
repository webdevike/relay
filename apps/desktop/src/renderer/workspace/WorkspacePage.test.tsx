import { MantineProvider } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))
const openPlace = vi.fn()
vi.mock('../navigation/navigate', () => ({ openPlace: (...a: unknown[]) => openPlace(...a) }))
const openNewTodo = vi.fn()
vi.mock('../todo/new-todo-store', () => ({ openNewTodo: (...a: unknown[]) => openNewTodo(...a) }))
vi.mock('../hotkeys/router', () => ({ runAction: vi.fn(), registerAction: () => () => {} }))
vi.mock('../ui/ActivityChart', () => ({
  ActivityChart: (p: { testid?: string }) => <div data-testid={p.testid} />,
}))
class MockRO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', MockRO)

import { placeOf } from '@evaos/shell-core'
import { resetReloadForTests } from '../reload/reload'
import { WorkspacePage } from './WorkspacePage'
import { resetWorkspaceForTests } from './workspace-store'

const day = (n: number): string => {
  const d = new Date(2026, 9, 15 - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const summary = (over: Record<string, unknown> = {}) => ({
  id: 'flo',
  name: 'Flo',
  displayName: 'Flo',
  tagline: 'Tag line',
  latest: null,
  lastActive: day(0),
  openTodos: 2,
  builtIn: false,
  hasFile: true,
  aliases: ['fl'],
  daily: new Array(90).fill(0),
  ...over,
})
const detail = (over: Record<string, unknown> = {}) => ({
  today: day(0),
  workspace: summary(),
  timeline: Array.from({ length: 11 }, (_, i) => ({
    date: day(i < 2 ? 0 : i < 4 ? 1 : 5),
    kind: i % 2 ? 'thread' : 'journal',
    title: `Entry ${i}`,
    source: 'src',
  })),
  todos: [{ id: 'T1', tag: 'flo', text: 'Do it', added: null }],
  sections: ['A', 'B', 'C', 'D'].map((t) => ({ title: t, body: `body ${t} <b>x</b>` })),
  ...over,
})

function ui(id = 'flo') {
  return render(
    <MantineProvider>
      <Notifications />
      <WorkspacePage place={placeOf(`workspace:${id}`)} />
    </MantineProvider>,
  )
}
async function ready() {
  await screen.findByTestId('ws-header')
}

beforeEach(() => {
  invoke.mockReset()
  openPlace.mockReset()
  openNewTodo.mockReset()
  resetWorkspaceForTests()
  resetReloadForTests()
})

describe('WorkspacePage', () => {
  it('renders header, chips, and wires New Todo', async () => {
    invoke.mockResolvedValue({ ok: true, value: detail() })
    ui()
    await ready()
    const h = screen.getByTestId('ws-header')
    expect(within(h).getByText('Flo')).toBeInTheDocument()
    expect(within(h).queryByText('Eva')).toBeNull()
    for (const t of ['Tag line', 'Active', 'Last active Today', '2 open todos', 'Tags: fl'])
      expect(within(h).getByText(t)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('ws-new-todo'))
    expect(openNewTodo).toHaveBeenCalledWith({ tag: 'flo' })
  })

  it('shows the Eva badge and disables Open File without a file', async () => {
    invoke.mockResolvedValue({
      ok: true,
      value: detail({
        workspace: summary({ id: 'eva', displayName: 'Eva', builtIn: true, hasFile: false }),
      }),
    })
    ui('eva')
    await ready()
    expect(within(screen.getByTestId('ws-header')).getAllByText('Eva').length).toBeGreaterThan(1)
    expect(screen.getByTestId('ws-open-file')).toBeDisabled()
  })

  it('Open File invokes and toasts on open-failed', async () => {
    invoke.mockResolvedValue({ ok: true, value: detail() })
    ui()
    await ready()
    invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: 'open-failed', message: 'Could not open /x/flo.md' },
    })
    fireEvent.click(screen.getByTestId('ws-open-file'))
    expect(invoke).toHaveBeenCalledWith('eva.workspace.openFile', { id: 'flo' })
    expect(
      await screen.findByText(
        'Could not open /x/flo.md. Check that the file exists, then try again.',
      ),
    ).toBeInTheDocument()
  })

  it('groups the timeline by day and toggles show all', async () => {
    invoke.mockResolvedValue({ ok: true, value: detail() })
    ui()
    await ready()
    const tl = screen.getByTestId('ws-timeline')
    expect(within(tl).getAllByTestId('ws-timeline-row')).toHaveLength(8)
    expect(within(tl).getByText('Today')).toBeInTheDocument()
    expect(within(tl).getByText('Yesterday')).toBeInTheDocument()
    expect(within(tl).getByText('Oct 10')).toBeInTheDocument()
    const t = screen.getByTestId('ws-timeline-toggle')
    expect(t).toHaveTextContent('Show all 11')
    expect(t).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(t)
    expect(within(tl).getAllByTestId('ws-timeline-row')).toHaveLength(11)
    expect(t).toHaveTextContent('Show fewer')
    expect(t).toHaveAttribute('aria-expanded', 'true')
  })

  it('shows empty timeline and todos', async () => {
    invoke.mockResolvedValue({ ok: true, value: detail({ timeline: [], todos: [], sections: [] }) })
    ui()
    await ready()
    expect(
      within(screen.getByTestId('ws-timeline')).getByText('No updates yet'),
    ).toBeInTheDocument()
    expect(within(screen.getByTestId('ws-todos')).getByText('Nothing open.')).toBeInTheDocument()
    expect(screen.getByText('This workspace file has no sections.')).toBeInTheDocument()
  })

  it('renders todos and sections as text with the first three expanded', async () => {
    invoke.mockResolvedValue({ ok: true, value: detail() })
    ui()
    await ready()
    expect(within(screen.getByTestId('ws-todos')).getByText('Do it')).toBeInTheDocument()
    const s = screen.getByTestId('ws-sections')
    expect(within(s).getByText('body A <b>x</b>')).toBeInTheDocument()
    expect(s.querySelector('b')).toBeNull()
    expect(within(s).queryByText('body D <b>x</b>')).toBeNull()
    const d = within(s).getByRole('button', { name: 'D' })
    expect(d).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(d)
    expect(within(s).getByText('body D <b>x</b>')).toBeInTheDocument()
  })

  it('shows Workspace not found with Open Dashboard', async () => {
    invoke.mockResolvedValue({ ok: true, value: detail({ workspace: null }) })
    ui('nope')
    await waitFor(() => expect(screen.getByText('Workspace not found')).toBeInTheDocument())
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open Dashboard' })))
    expect(openPlace).toHaveBeenCalledWith(placeOf('dashboard'))
  })
})
