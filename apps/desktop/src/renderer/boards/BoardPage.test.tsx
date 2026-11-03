import { MantineProvider } from '@mantine/core'
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc', () => ({ invoke: vi.fn(), on: () => () => {} }))

import type { Board } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'
import { invoke } from '../ipc'
import { BoardPage } from './BoardPage'
import { boardsStore } from './boards-store'

const board: Board = {
  slug: 'ops',
  title: 'Ops live',
  workspace: 'Relay',
  icon: null,
  updatedAt: '2026-10-23T15:04:00.000Z',
  widgets: [
    { id: 'up', span: 4, spec: { widget: 'stat', label: 'Uptime', value: '99.9%' } },
    { id: 'note', span: 12, spec: { widget: 'text', text: 'All quiet' } },
  ],
}

/** A live tile: the host's static render says 2, its Query says what the host answers now. */
const live: Board = {
  ...board,
  widgets: [
    {
      id: 'items',
      span: 6,
      spec: { widget: 'stat', label: 'Open items', value: '2' },
      openui: `root = Stat("Open items", "" + items.total)
items = Query("work_items", {}, {total: 0}, 30)`,
    },
  ],
}

const wrap = (slug: string) =>
  render(
    <MantineProvider>
      <BoardPage place={placeOf(`board:${slug}`)} />
    </MantineProvider>,
  )

afterEach(() => {
  boardsStore.setState({ data: null })
  vi.mocked(invoke).mockReset()
})

describe('BoardPage', () => {
  it("draws the board's tiles by span and follows Relay's writes", () => {
    boardsStore.setState({ data: { boards: [board], relayUp: true, queries: false } })
    wrap('ops')
    expect(screen.getByRole('heading', { name: 'Ops live' })).toBeInTheDocument()
    expect(screen.getByText('Relay')).toBeInTheDocument()
    expect(screen.getByTestId('board-tile-up')).toHaveStyle({ gridColumn: 'span 4' })
    expect(screen.getByTestId('board-tile-note')).toHaveStyle({ gridColumn: 'span 12' })
    expect(screen.getByText('99.9%')).toBeInTheDocument()
    act(() =>
      boardsStore.setState({
        data: {
          boards: [
            {
              ...board,
              widgets: [{ ...board.widgets[1]!, spec: { widget: 'text', text: 'Busy' } }],
            },
          ],
          relayUp: true,
          queries: false,
        },
      }),
    )
    expect(screen.queryByTestId('board-tile-up')).toBeNull()
    expect(screen.getByText('Busy')).toBeInTheDocument()
  })

  it('says when the host has no such board, and when Relay is down', () => {
    boardsStore.setState({ data: { boards: [board], relayUp: true, queries: false } })
    const { unmount } = wrap('gone')
    expect(screen.getByText("gone isn't on the Relay host.")).toBeInTheDocument()
    unmount()
    boardsStore.setState({ data: { boards: [], relayUp: false, queries: false } })
    wrap('ops')
    expect(
      screen.getByText("Relay isn't running, so its dashboards can't be shown."),
    ).toBeInTheDocument()
  })

  it('runs a live tile against the host and marks the board live', async () => {
    vi.mocked(invoke).mockResolvedValue({ ok: true, value: { ok: true, data: { total: 7 } } })
    boardsStore.setState({ data: { boards: [live], relayUp: true, queries: true } })
    wrap('ops')
    expect(screen.getByTestId('board-tile-items')).toHaveAttribute('data-live', 'true')
    expect(await screen.findByText('7')).toBeInTheDocument()
    expect(screen.getByText('Live')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('boards.query', { tool: 'work_items', args: {} })
  })

  it("draws a live tile's static spec on a host that runs no queries", () => {
    boardsStore.setState({ data: { boards: [live], relayUp: true, queries: false } })
    wrap('ops')
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByTestId('board-tile-items')).not.toHaveAttribute('data-live')
    expect(screen.queryByText('Live')).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('falls back to the static spec when the host turns out too old to answer', async () => {
    vi.mocked(invoke).mockResolvedValue({
      ok: true,
      value: { ok: false, error: 'old host', unsupported: true },
    })
    boardsStore.setState({ data: { boards: [live], relayUp: true, queries: true } })
    wrap('ops')
    expect(await screen.findByText('2')).toBeInTheDocument()
    expect(boardsStore.getState().data?.queries).toBe(false)
  })
})
