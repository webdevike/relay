import { MantineProvider } from '@mantine/core'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn(async () => ({ ok: true, value: { title: 't', messages: [] } }))
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...a),
  on: () => () => {},
}))

import type { Assistant } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'
import { AgentPage } from './AgentPage'
import { assistantsStore } from './assistants-store'

const nova = (file: string | null): Assistant => ({
  id: 'nova',
  title: 'Nova',
  scope: '',
  avatar: { style: 'notionists', seed: 'nova' },
  status: 'idle',
  tool: null,
  file,
  reply: null,
})

const ui = () =>
  render(
    <MantineProvider>
      <AgentPage place={placeOf('agent:nova')} />
    </MantineProvider>,
  )

afterEach(() => {
  assistantsStore.setState({ data: null })
  invoke.mockClear()
})

describe('AgentPage in a tool pane', () => {
  it('reads the thread once the assistant has one, else shows the start card', async () => {
    assistantsStore.setState({ data: { agents: [nova(null)], relayUp: true } })
    const { unmount } = ui()
    expect(screen.getByTestId('agent-start-nova')).toBeTruthy()
    unmount()

    assistantsStore.setState({ data: { agents: [nova('/s/nova.jsonl')], relayUp: true } })
    ui()
    expect(screen.queryByTestId('agent-start-nova')).toBeNull()
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('chat.readThread', { file: '/s/nova.jsonl' }),
    )
    expect(await screen.findByText('No messages yet.')).toBeTruthy()
  })
})
