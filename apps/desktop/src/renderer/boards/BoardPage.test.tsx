import { MantineProvider } from '@mantine/core'
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc', () => ({ invoke: vi.fn(), on: () => () => {} }))

import type { Board } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'
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

const wrap = (slug: string) =>
  render(
    <MantineProvider>
      <BoardPage place={placeOf(`board:${slug}`)} />
    </MantineProvider>,
  )

afterEach(() => boardsStore.setState({ data: null }))

describe('BoardPage', () => {
  it("draws the board's tiles by span and follows Relay's writes", () => {
    boardsStore.setState({ data: { boards: [board], relayUp: true } })
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
        },
      }),
    )
    expect(screen.queryByTestId('board-tile-up')).toBeNull()
    expect(screen.getByText('Busy')).toBeInTheDocument()
  })

  it('says when the host has no such board, and when Relay is down', () => {
    boardsStore.setState({ data: { boards: [board], relayUp: true } })
    const { unmount } = wrap('gone')
    expect(screen.getByText("gone isn't on the Relay host.")).toBeInTheDocument()
    unmount()
    boardsStore.setState({ data: { boards: [], relayUp: false } })
    wrap('ops')
    expect(
      screen.getByText("Relay isn't running, so its dashboards can't be shown."),
    ).toBeInTheDocument()
  })
})
