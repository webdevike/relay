import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { makeMessage } from '@evaos/chat-core/message'
import type { CanvasChatEntry } from '@evaos/chat-core/canvas-live'
import type { CanvasRoom } from '@evaos/contract'

vi.mock('../ipc', () => ({ invoke: vi.fn(), on: vi.fn(() => () => {}) }))
const nav = vi.hoisted(() => ({ joinCanvas: vi.fn(), openBoard: vi.fn() }))
vi.mock('../canvas/live/return-point', () => nav)

import { MessageRow } from './MessageRow'
import { liveStore } from '../canvas/live/live-store'

const wrap = (ui: React.ReactElement) => render(<MantineProvider>{ui}</MantineProvider>)
const agent = { name: 'Nova', color: '#7c5cff', avatar: '/canvas/avatar/nova' }
const entry = (kind: CanvasChatEntry['kind'], extra: Partial<CanvasChatEntry> = {}) =>
  makeMessage(`c-${kind}`, 'canvas', 'canvas row', {
    canvas: { kind, roomId: 'r1', slug: 'mind-map', board: 'Mind map', agent, ...extra },
  })
const room = (live: boolean): CanvasRoom => ({
  id: 'r1',
  slug: 'mind-map',
  board: 'Mind map',
  live,
  agent,
  chat: { assistant: 'nova' },
  humans: [],
  startedAt: 1,
})

beforeEach(() => {
  nav.joinCanvas.mockReset()
  nav.openBoard.mockReset()
  liveStore.setState({ data: null })
})

describe('canvas rows', () => {
  it('a live room offers Join, which joins its board', () => {
    liveStore.setState({
      data: { rooms: [room(true)], relayUp: true, origin: 'http://127.0.0.1:7817' },
    })
    wrap(<MessageRow m={entry('start', { text: 'Sketch the onboarding flow' })} />)
    expect(screen.getByText('Join Nova on Mind map')).toBeInTheDocument()
    expect(screen.getByText('Sketch the onboarding flow')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    expect(nav.joinCanvas).toHaveBeenCalledWith('mind-map', 'split')
    fireEvent.click(screen.getByRole('button', { name: 'Join' }), { altKey: true })
    expect(nav.joinCanvas).toHaveBeenLastCalledWith('mind-map', 'here')
    // The avatar loads from the host.
    expect(document.querySelector('img')?.getAttribute('src')).toBe(
      'http://127.0.0.1:7817/canvas/avatar/nova',
    )
  })

  it('an ended room says so and opens the board instead', () => {
    liveStore.setState({ data: { rooms: [room(false)], relayUp: true, origin: null } })
    wrap(<MessageRow m={entry('start')} />)
    expect(screen.getByText('Ended')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Join' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open board' }))
    expect(nav.openBoard).toHaveBeenCalledWith('mind-map', 'split')
    fireEvent.click(screen.getByRole('button', { name: 'Open board' }), { metaKey: true })
    expect(nav.openBoard).toHaveBeenLastCalledWith('mind-map', 'tab')
  })

  it('without Relay it cannot tell, and says why', () => {
    wrap(<MessageRow m={entry('start')} />)
    expect(screen.getByText("Relay isn't connected")).toBeInTheDocument()
  })

  it('a turn shows both sides on two lines', () => {
    wrap(
      <MessageRow
        m={entry('turn', { human: { name: 'Isaac', text: 'add a login step' }, text: 'Added it.' })}
      />,
    )
    const row = screen.getByTestId('canvas-turn')
    expect(row).toHaveTextContent('Isaac: add a login step')
    expect(row).toHaveTextContent('Nova: Added it.')
  })

  it('the wrap-up shows the summary and opens the board', () => {
    wrap(<MessageRow m={entry('end', { text: 'We picked **email** login.' })} />)
    expect(screen.getByText('Canvas wrap-up')).toBeInTheDocument()
    expect(screen.getByText('email').tagName).toBe('STRONG')
    fireEvent.click(screen.getByRole('button', { name: 'Open board' }))
    expect(nav.openBoard).toHaveBeenCalledWith('mind-map', 'split')
  })
})
