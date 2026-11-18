import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { makeMessage, type ChatMessage } from '@evaos/chat-core/message'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../ipc', () => ({ invoke, on: () => () => {} }))

import { liveRowId, type LogItem } from './ChatLog'
import { MessageRow } from './MessageRow'
import { WidgetActions } from './widgets/actions'

const ASK =
  'Tests pass on the branch. Push it?\n\n[[replies: Yes, push it | Not yet | Show me the diff]]'

function show(m: ChatMessage, live: boolean, canReply = true) {
  const reply = vi.fn()
  const view = render(
    <MantineProvider>
      <WidgetActions.Provider value={{ reply, canReply }}>
        <MessageRow m={m} live={live} />
      </WidgetActions.Provider>
    </MantineProvider>,
  )
  return { reply, ...view }
}

describe('reply chips on a message row', () => {
  it('the live row shows its answers as a labelled group of buttons, without the token', () => {
    const { container } = show(makeMessage('a', 'assistant', ASK), true)
    const group = screen.getByRole('group', { name: 'Suggested replies' })
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Yes, push it', 'Not yet', 'Show me the diff'])
    expect(container.textContent).toContain('Push it?')
    expect(container.textContent).not.toContain('[[')
    expect(container.textContent).not.toContain('replies:')
  })

  it('a tap sends the label as the next message, once per tap', () => {
    const { reply } = show(makeMessage('a', 'assistant', ASK), true)
    fireEvent.click(screen.getByRole('button', { name: 'Not yet' }))
    expect(reply).toHaveBeenCalledTimes(1)
    expect(reply).toHaveBeenCalledWith('Not yet')
  })

  it('an older row strips the token but shows no chips', () => {
    const { container } = show(makeMessage('a', 'assistant', ASK), false)
    expect(screen.queryByTestId('reply-chips')).toBeNull()
    expect(container.textContent).not.toContain('[[')
  })

  it('a streaming row shows no chips and never a partly arrived token', () => {
    const { container, rerender } = show(
      makeMessage('a', 'assistant', 'Push it?\n\n[[repl', { streaming: true }),
      true,
    )
    expect(container.textContent).not.toContain('[[')
    expect(screen.queryByTestId('reply-chips')).toBeNull()
    rerender(
      <MantineProvider>
        <MessageRow m={makeMessage('a', 'assistant', ASK, { streaming: true })} live />
      </MantineProvider>,
    )
    expect(container.textContent).not.toContain('[[')
    expect(screen.queryByTestId('reply-chips')).toBeNull()
  })

  it('shows no chips for a token with fewer than two answers, nor for a user row', () => {
    show(makeMessage('a', 'assistant', 'Ok?\n[[replies: Yes]]'), true)
    expect(screen.queryByTestId('reply-chips')).toBeNull()
    show(makeMessage('u', 'user', 'Push it?\n[[replies: Yes | No]]'), true)
    expect(screen.queryByTestId('reply-chips')).toBeNull()
  })

  it('chips are disabled where the composer could not send', () => {
    const { reply } = show(makeMessage('a', 'assistant', ASK), true, false)
    const yes = screen.getByRole('button', { name: 'Yes, push it' })
    expect(yes).toBeDisabled()
    fireEvent.click(yes)
    expect(reply).not.toHaveBeenCalled()
  })
})

describe('liveRowId', () => {
  const msg = (m: ChatMessage): LogItem => ({ kind: 'message', m })
  const reply = makeMessage('a1', 'assistant', ASK)

  it('is the last row when it is a finished reply and the chat is idle', () => {
    expect(liveRowId([msg(makeMessage('u1', 'user', 'run the tests')), msg(reply)], false)).toBe(
      'a1',
    )
  })

  it('is null while the chat is busy, typing or the reply streams', () => {
    expect(liveRowId([msg(reply)], true)).toBeNull()
    expect(liveRowId([msg(reply), { kind: 'typing', who: 'Nova' }], false)).toBeNull()
    expect(
      liveRowId([msg(makeMessage('a1', 'assistant', ASK, { streaming: true }))], false),
    ).toBeNull()
  })

  it('is null once a prompt, sent or still unconfirmed, or a tool call follows', () => {
    expect(liveRowId([msg(reply), msg(makeMessage('u2', 'user', 'Not yet'))], false)).toBeNull()
    expect(
      liveRowId(
        [msg(reply), msg(makeMessage('u2', 'user', 'Not yet', { unconfirmed: true }))],
        false,
      ),
    ).toBeNull()
    expect(
      liveRowId([msg(reply), { kind: 'tools', tools: [makeMessage('t', 'tool', 'read')] }], false),
    ).toBeNull()
    expect(liveRowId([], false)).toBeNull()
  })
})
