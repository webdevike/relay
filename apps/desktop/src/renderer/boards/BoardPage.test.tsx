import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen } from '@testing-library/react'
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
  tabs: null,
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

  it('shows one tab of tiles at a time and falls back to the first when the picked tab goes', () => {
    const tile = (id: string, text: string) => ({
      id,
      span: 12,
      spec: { widget: 'text', text },
    })
    const tabbed: Board = {
      ...board,
      slug: 'lists',
      tabs: [
        { id: 'deals', title: 'Deals', widgets: [tile('d1', 'Half price oats')] },
        { id: 'wife', title: "Wife's list", widgets: [tile('w1', 'Buy tulips')] },
      ],
      widgets: [],
    }
    const write = (b: Board) =>
      act(() => boardsStore.setState({ data: { boards: [b], relayUp: true, queries: false } }))
    write(tabbed)
    wrap('lists')
    expect(screen.getByTestId('board-tabs')).toBeInTheDocument()
    expect(screen.getByText('Half price oats')).toBeInTheDocument()
    expect(screen.queryByText('Buy tulips')).toBeNull()
    fireEvent.click(screen.getByTestId('board-tab-wife'))
    expect(screen.getByText('Buy tulips')).toBeInTheDocument()
    expect(screen.queryByText('Half price oats')).toBeNull()
    write({ ...tabbed, tabs: [tabbed.tabs![0]!] })
    expect(screen.getByText('Half price oats')).toBeInTheDocument()
    expect(screen.queryByText('Buy tulips')).toBeNull()
    write({ ...tabbed, tabs: [{ id: 'deals', title: 'Deals', widgets: [] }] })
    expect(screen.getByText('This tab has no widgets yet.')).toBeInTheDocument()
  })

  it("sends a button's words to the assistant it names and says so on the tile", async () => {
    const xmas: Board = {
      ...board,
      slug: 'xmas',
      widgets: [
        {
          id: 'xmas-add-lamp',
          span: 6,
          spec: {
            widget: 'stack',
            direction: 'horizontal',
            children: [
              { widget: 'button', label: 'Add to Wife list', reply: 'Add lamp', agent: 'penny' },
              { widget: 'button', label: 'Ask here', reply: 'why?' },
            ],
          },
        },
      ],
    }
    vi.mocked(invoke).mockResolvedValueOnce({ ok: true, value: { sent: true } })
    boardsStore.setState({ data: { boards: [xmas], relayUp: true, queries: false } })
    wrap('xmas')
    // A reply without an assistant still has no chat to go to on a board.
    expect(screen.getByRole('button', { name: 'Ask here' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Add to Wife list' }))
    expect(invoke).toHaveBeenCalledWith('assistants.turn', { agent: 'penny', text: 'Add lamp' })
    expect(await screen.findByTestId('board-tile-sent')).toHaveTextContent('Sent to penny')

    vi.mocked(invoke).mockResolvedValueOnce({
      ok: false,
      error: { code: 'agent_not_found', message: 'no assistant penny on this host' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add to Wife list' }))
    expect(await screen.findByText('Not sent: no assistant penny on this host')).toBeInTheDocument()
  })
})
