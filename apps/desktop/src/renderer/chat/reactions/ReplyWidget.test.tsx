import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { makeMessage, type ChatMessage } from '@evaos/chat-core/message'

const invoke = vi.hoisted(() => vi.fn())
const listeners = vi.hoisted(() => new Map<string, (payload: unknown) => void>())
vi.mock('../../ipc', () => ({
  invoke,
  on: (channel: string, fn: (payload: unknown) => void) => {
    listeners.set(channel, fn)
    return () => listeners.delete(channel)
  },
}))

import { MessageRow } from '../MessageRow'
import { ReactionScope, reactionsStore, startReactions } from './reactions-store'
import { applyHostWidgets, replyWidgetsStore, settleReplyWidget } from './reply-widgets'

const THREAD = 'assistant:nova'
const FENCE = '```openui\nroot = Card([Text("Sales are up")], "Brief")\n```'
const OTHER = '```openui\nroot = Card([Text("Second look")], "Again")\n```'
const reply = makeMessage('a1', 'assistant', 'Sales rose **12%** this month.', { at: 200 })
const older = makeMessage('a0', 'assistant', 'Earlier reply.', { at: 100 })

function show(...rows: ChatMessage[]) {
  return render(
    <MantineProvider>
      <ReactionScope.Provider value={{ thread: THREAD, reply: vi.fn() }}>
        {rows.map((m) => (
          <MessageRow key={m.id} m={m} />
        ))}
      </ReactionScope.Provider>
    </MantineProvider>,
  )
}

/** A reactions view for the thread, as main pushes it. */
const view = (widgets: Record<string, string> | null, training = false) => ({
  thread: THREAD,
  up: true,
  reactions: {},
  bookmarks: null,
  bookmarksUp: false,
  widgets,
  training,
})

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue({ ok: true, value: { sent: true } })
  reactionsStore.setState({ up: true, threads: {} })
  replyWidgetsStore.setState({ threads: {}, arrived: {}, training: false })
})

describe('follow-up reply widgets', () => {
  it("renders a snapshot's block under the matching reply only, after its text, without sliding in", () => {
    applyHostWidgets(THREAD, { 'assistant@200': FENCE }, false)
    show(older, reply)
    const row = screen.getByTestId('msg-a1')
    const widget = within(row).getByTestId('reply-widget')
    expect(widget).toHaveAttribute('data-reply', 'assistant@200')
    expect(widget).not.toHaveAttribute('data-arrived')
    expect(within(widget).getByTestId('widget')).toHaveAttribute('data-widget', 'card')
    expect(within(widget).getByText('Sales are up')).toBeInTheDocument()
    // Under the bubble: the reply's own text comes first.
    const bubble = within(row).getByTestId('bubble-a1')
    expect(bubble.compareDocumentPosition(widget) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(bubble.contains(widget)).toBe(false)
    expect(within(screen.getByTestId('msg-a0')).queryByTestId('reply-widget')).toBeNull()
  })

  it('slides in a block pushed live, once, through the reactions views', () => {
    const stop = startReactions()
    act(() => listeners.get('reactions.changed')!(view({})))
    show(older, reply)
    expect(screen.queryByTestId('reply-widget')).toBeNull()
    act(() => listeners.get('reactions.changed')!(view({ 'assistant@200': FENCE })))
    const widget = within(screen.getByTestId('msg-a1')).getByTestId('reply-widget')
    expect(widget).toHaveAttribute('data-arrived', 'true')
    // The slide finished (jsdom runs no CSS animations, so its end is told directly).
    act(() => settleReplyWidget(THREAD, 'assistant@200'))
    expect(widget).not.toHaveAttribute('data-arrived')
    // Another reply's block arriving does not replay this one.
    act(() =>
      listeners.get('reactions.changed')!(view({ 'assistant@200': FENCE, 'assistant@100': OTHER })),
    )
    expect(widget).not.toHaveAttribute('data-arrived')
    expect(within(screen.getByTestId('msg-a0')).getByTestId('reply-widget')).toHaveAttribute(
      'data-arrived',
      'true',
    )
    stop()
  })

  it('shows nothing from a host without the feature, and drops blocks when it stops sending them', () => {
    const stop = startReactions()
    act(() => listeners.get('reactions.changed')!(view({ 'assistant@200': FENCE })))
    show(reply)
    expect(screen.getByTestId('reply-widget')).toBeInTheDocument()
    act(() => listeners.get('reactions.changed')!(view(null)))
    expect(screen.queryByTestId('reply-widget')).toBeNull()
    stop()
  })

  it('skips a reply that draws its own widget, and one still streaming', () => {
    const own = makeMessage('a2', 'assistant', `Here:\n\n${OTHER}\n`, { at: 300 })
    const streaming = makeMessage('a3', 'assistant', 'Working', { at: 400, streaming: true })
    applyHostWidgets(THREAD, { 'assistant@300': FENCE, 'assistant@400': FENCE }, false)
    show(own, streaming)
    expect(screen.queryByTestId('reply-widget')).toBeNull()
    expect(within(screen.getByTestId('msg-a2')).getByText('Second look')).toBeInTheDocument()
  })
})
