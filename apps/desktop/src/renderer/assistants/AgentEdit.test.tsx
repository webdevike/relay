import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ChatMessage } from '@evaos/chat-core/message'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc', () => ({ invoke: vi.fn(), on: () => () => {} }))

import { dropLocalRows, useLocalRows } from '../chat/local-rows'
import { AgentNotch } from './AgentNotch'
import { EDIT_INSTRUCTIONS_MESSAGE } from './AgentEdit'

afterEach(() => dropLocalRows('pane-1'))

let seen: ChatMessage[] = []
function Rows() {
  seen = useLocalRows('pane-1')
  return null
}

function show() {
  const reply = vi.fn()
  render(
    <MantineProvider>
      <Rows />
      <AgentNotch id="nova" edit={{ paneId: 'pane-1', reply }} />
    </MantineProvider>,
  )
  return reply
}

describe('the header edit menu', () => {
  it('has no pencil outside a chat', () => {
    render(
      <MantineProvider>
        <AgentNotch id="nova" />
      </MantineProvider>,
    )
    expect(screen.queryByTestId('agent-edit-pencil')).toBeNull()
  })

  it('offers Edit avatar and Edit instructions from the pencil', async () => {
    show()
    fireEvent.click(screen.getByTestId('agent-edit-pencil'))
    expect(await screen.findByTestId('agent-edit-avatar')).toHaveTextContent('Edit avatar')
    expect(screen.getByTestId('agent-edit-instructions')).toHaveTextContent('Edit instructions')
  })

  it('Edit instructions sends the ask as the next turn', async () => {
    const reply = show()
    fireEvent.click(screen.getByTestId('agent-edit-pencil'))
    fireEvent.click(await screen.findByTestId('agent-edit-instructions'))
    expect(reply).toHaveBeenCalledExactlyOnceWith("I'd like to change your instructions")
    expect(EDIT_INSTRUCTIONS_MESSAGE).toBe("I'd like to change your instructions")
  })

  it('Edit avatar posts the editor into the thread, once', async () => {
    show()
    for (let i = 0; i < 2; i++) {
      fireEvent.click(screen.getByTestId('agent-edit-pencil'))
      fireEvent.click(await screen.findByTestId('agent-edit-avatar'))
    }
    const rows = seen
    expect(rows).toHaveLength(1)
    expect(rows[0]?.text).toContain('AvatarEditor("nova"')
  })
})
