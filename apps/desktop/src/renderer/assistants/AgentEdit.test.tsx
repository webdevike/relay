import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ChatMessage } from '@evaos/chat-core/message'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as FilesStore from '../files/files-store'
import type * as TilingStore from '../tiling/tiling-store'

vi.mock('../ipc', () => ({ invoke: vi.fn(), on: () => () => {} }))
vi.mock('../files/files-store', async (orig) => ({
  ...(await orig<typeof FilesStore>()),
  openAgentFiles: vi.fn(() => Promise.resolve()),
}))
vi.mock('../tiling/tiling-store', async (orig) => ({
  ...(await orig<typeof TilingStore>()),
  revealTool: vi.fn(() => 'files'),
}))

import { dropLocalRows, useLocalRows } from '../chat/local-rows'
import { openAgentFiles } from '../files/files-store'
import { revealTool } from '../tiling/tiling-store'
import { AgentNotch } from './AgentNotch'
import { INSTRUCTION_FILES_HINT } from './AgentEdit'

afterEach(() => dropLocalRows('pane-1'))

let seen: ChatMessage[] = []
function Rows() {
  seen = useLocalRows('pane-1')
  return null
}

function show() {
  render(
    <MantineProvider>
      <Rows />
      <AgentNotch id="nova" edit={{ paneId: 'pane-1' }} />
    </MantineProvider>,
  )
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

  it('offers Edit avatar and Edit instructions, with the two files as a dimmed hint', async () => {
    show()
    fireEvent.click(screen.getByTestId('agent-edit-pencil'))
    expect(await screen.findByTestId('agent-edit-avatar')).toHaveTextContent('Edit avatar')
    expect(screen.getByTestId('agent-edit-instructions')).toHaveTextContent('Edit instructions')
    expect(screen.getByTestId('agent-edit-instructions-hint')).toHaveTextContent(
      'prime.md, thread.md',
    )
    expect(INSTRUCTION_FILES_HINT).toBe('prime.md, thread.md')
  })

  it('Edit instructions opens the assistant files in the Files tab, not the chat', async () => {
    show()
    fireEvent.click(screen.getByTestId('agent-edit-pencil'))
    fireEvent.click(await screen.findByTestId('agent-edit-instructions'))
    expect(revealTool).toHaveBeenCalledExactlyOnceWith('files')
    expect(openAgentFiles).toHaveBeenCalledExactlyOnceWith('nova', 'nova', null)
    expect(seen).toHaveLength(0)
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
