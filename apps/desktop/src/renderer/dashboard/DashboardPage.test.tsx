import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))
const openPlace = vi.fn()
vi.mock('../navigation/navigate', () => ({ openPlace: (...a: unknown[]) => openPlace(...a) }))
const runAction = vi.fn()
vi.mock('../hotkeys/router', () => ({
  runAction: (...a: unknown[]) => runAction(...a),
  registerAction: () => () => {},
}))
vi.mock('../ui/ActivityChart', () => ({
  ActivityChart: (p: { rows: unknown[]; name: string; testid?: string }) => (
    <div data-testid={p.testid} data-rows={p.rows.length}>
      {p.name}
    </div>
  ),
}))
let resizeCb: ((e: Array<{ contentRect: { width: number } }>) => void) | null = null
class MockRO {
  constructor(cb: typeof resizeCb) {
    resizeCb = cb
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', MockRO)

import { placeOf } from '@evaos/shell-core'
import { resetEntranceForTests } from '../theme/motion'
import { resetReloadForTests } from '../reload/reload'
import { DashboardPage } from './DashboardPage'
import { dashboardStore, resetDashboardForTests } from './dashboard-store'

const day = (n: number): string => {
  const d = new Date(2026, 9, 15 - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const ws = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  displayName: id.toUpperCase(),
  tagline: `${id} tagline`,
  latest: `${id} latest`,
  lastActive: day(1),
  openTodos: 0,
  builtIn: false,
  hasFile: true,
  aliases: [],
  daily: new Array(90).fill(0),
  ...over,
})
const payload = (over: Record<string, unknown> = {}) => ({
  today: day(0),
  generatedAt: new Date(2026, 9, 15, 15, 5).getTime(),
  workspaces: [
    ws('eva', { builtIn: true, openTodos: 1, lastActive: day(0) }),
    ws('flo', { openTodos: 2, lastActive: day(1) }),
    ws('relay', { openTodos: 1, tagline: null, latest: null, lastActive: day(3) }),
    ws('goodops', { openTodos: 1, lastActive: day(5) }),
    ws('bambee', { lastActive: day(9) }),
    ws('texo', { lastActive: day(60) }),
    ws('personal', { lastActive: null }),
  ],
  todos: [1, 2, 3, 4, 5, 6, 7].map((n) => ({
    id: `T${n}`,
    tag: 'flo',
    text: `todo ${n}`,
    added: null,
  })),
  updates7d: 4,
  ...over,
})

const ui = () =>
  render(
    <MantineProvider>
      <DashboardPage place={placeOf('dashboard')} />
    </MantineProvider>,
  )
async function mount(p = payload()) {
  invoke.mockResolvedValue({ ok: true, value: p })
  ui()
  await screen.findByTestId('dash-hero')
}

beforeEach(() => {
  invoke.mockReset()
  openPlace.mockReset()
  runAction.mockReset()
  resetDashboardForTests()
  resetReloadForTests()
  resetEntranceForTests()
})

describe('DashboardPage', () => {
  it('renders the hero with summary and New Todo action', async () => {
    await mount()
    const hero = screen.getByTestId('dash-hero')
    expect(hero).toHaveTextContent('WELCOME BACK')
    expect(within(hero).getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.getByTestId('dash-summary')).toHaveTextContent(
      '7 workspaces, 7 open todos, 4 updates this week',
    )
    fireEvent.click(screen.getByTestId('dash-new-todo'))
    expect(runAction).toHaveBeenCalledWith('new-todo')
    expect(screen.getByTestId('dash-updated')).toHaveTextContent('Updated 3:05 PM')
    expect(screen.getByTestId('dash-refresh')).toHaveAttribute(
      'aria-label',
      'Reload from the Eva repo',
    )
  })

  it('filters with counts, footer and empty copy', async () => {
    await mount()
    expect(screen.getByTestId('dash-filters')).toHaveAttribute('role', 'radiogroup')
    expect(screen.getByTestId('filter-active')).toHaveTextContent('Active 5')
    expect(screen.getByTestId('filter-quiet')).toHaveTextContent('Quiet 2')
    fireEvent.click(screen.getByTestId('filter-quiet'))
    expect(screen.getByText('Every matching workspace is shown above.')).toBeInTheDocument()
    expect(screen.getAllByTestId('dash-chart-card')).toHaveLength(2)
    act(() => {
      dashboardStore.setState({
        data: { ...payload(), workspaces: [ws('flo', { lastActive: day(1), openTodos: 0 })] },
      })
    })
    fireEvent.click(screen.getByTestId('filter-todos'))
    expect(screen.getByText('No workspaces match this filter.')).toBeInTheDocument()
  })

  it('renders grid cards after the recent pair with navigation and cue classes', async () => {
    await mount()
    expect(screen.queryByTestId('ws-card-eva')).toBeNull()
    expect(screen.queryByTestId('ws-card-flo')).toBeNull()
    const relay = screen.getByTestId('ws-card-relay')
    expect(relay).toHaveTextContent('No tagline')
    expect(relay).toHaveTextContent('No updates yet')
    expect(relay).toHaveTextContent('Active 3d ago')
    expect(relay).toHaveTextContent('1')
    expect(screen.getByTestId('ws-card-bambee')).not.toHaveTextContent('open todos')
    expect(relay).toHaveClass('eva-cue-grid-cards')
    expect(relay.style.getPropertyValue('--i')).toBe('0')
    fireEvent.click(relay)
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('workspace:relay'), { newTab: false })
    fireEvent.click(relay, { metaKey: true })
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('workspace:relay'), { newTab: true })
  })

  it('shows the Eva badge on a built-in card in the grid', async () => {
    const p = payload()
    p.workspaces = [ws('a'), ws('b'), ws('eva', { builtIn: true })]
    await mount(p)
    expect(within(screen.getByTestId('ws-card-eva')).getByText('Eva')).toBeInTheDocument()
  })

  it('renders two chart cards and the range switch drives row counts', async () => {
    await mount()
    const cards = screen.getAllByTestId('dash-chart-card')
    expect(cards).toHaveLength(2)
    expect(screen.getByTestId('dash-chart-eva')).toHaveAttribute('data-rows', '7')
    fireEvent.click(screen.getByTestId('range-30'))
    expect(dashboardStore.getState().range).toBe(30)
    expect(screen.getByTestId('dash-chart-eva')).toHaveAttribute('data-rows', '30')
  })

  it('lists at most six todos, the empty copy, and quick stats', async () => {
    await mount()
    const todos = screen.getByTestId('dash-todos')
    expect(within(todos).getAllByRole('listitem')).toHaveLength(6)
    expect(within(todos).getByTitle('todo 1')).toBeInTheDocument()
    fireEvent.click(within(todos).getByText('Show all in Tasks'))
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('tasks'), { newTab: false })
    const stats = screen.getByTestId('dash-stats')
    expect(stats).toHaveTextContent('Workspaces')
    expect(stats).toHaveTextContent('Updates, 7 days')
    expect(stats).toHaveTextContent('PRs to review')
    act(() => dashboardStore.setState({ data: { ...payload(), todos: [] } }))
    expect(screen.getByText('Nothing open.')).toBeInTheDocument()
  })

  it('toggles data-compact below 760', async () => {
    await mount()
    const root = screen.getByTestId('page-dashboard')
    expect(root).toHaveAttribute('data-compact', 'false')
    act(() => resizeCb?.([{ contentRect: { width: 700 } }]))
    expect(root).toHaveAttribute('data-compact', 'true')
    act(() => resizeCb?.([{ contentRect: { width: 900 } }]))
    expect(root).toHaveAttribute('data-compact', 'false')
  })

  it('shows loading, then an error card with Try again', async () => {
    invoke.mockReturnValue(new Promise(() => {}))
    ui()
    expect(screen.getByTestId('dash-loading')).toBeInTheDocument()
  })

  it('shows the error copy and retries', async () => {
    invoke.mockResolvedValue({ ok: false, error: { code: 'internal', message: 'x' } })
    ui()
    expect(await screen.findByText(/Could not read the Eva repo/)).toBeInTheDocument()
    invoke.mockResolvedValue({ ok: true, value: payload() })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByTestId('dash-hero')).toBeInTheDocument()
  })
})
