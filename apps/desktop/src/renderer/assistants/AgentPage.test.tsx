import { MantineProvider } from '@mantine/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

const meta = { model: null, thinking: null, contextTokens: null }
const invoke = vi.fn(async (channel: string, _args?: unknown): Promise<unknown> => {
  if (channel === 'chat.open') {
    return {
      ok: true,
      value: {
        title: 'Nova',
        messages: [{ id: 'a1', role: 'assistant', text: 'Hi Isaac, dentist at five.' }],
        meta,
        owner: null,
      },
    }
  }
  if (channel === 'chat.send') return { ok: true, value: { accepted: true } }
  if (channel === 'chat.drop') return { ok: true, value: {} }
  return { ok: false, error: { code: 'test', message: `${channel} is not served here` } }
})
vi.mock('../ipc', () => ({
  invoke: (...a: [string, unknown]) => invoke(...a),
  on: () => () => {},
}))
// jsdom has no layout for the virtual list: the log's rows as plain text (e2e sees the real one).
vi.mock('../chat/ChatLog', () => ({
  ChatLog: ({ messages }: { messages: Array<{ text: string }> }) => (
    <div data-testid="chat-log">{messages.map((m) => m.text).join('\n')}</div>
  ),
}))

import type { Assistant } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'
import { chatStore } from '../chat/chat-store'
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

const calls = (channel: string) =>
  invoke.mock.calls.filter((c) => c[0] === channel).map((c) => c[1] as Record<string, unknown>)

afterEach(() => {
  assistantsStore.setState({ data: null })
  chatStore.setState({ panes: {} })
  invoke.mockClear()
})

describe('AgentPage in a tool pane', () => {
  it('shows the start card until the assistant has a thread', () => {
    assistantsStore.setState({ data: { agents: [nova(null)], relayUp: true } })
    ui()
    expect(screen.getByTestId('agent-start-nova')).toBeTruthy()
    expect(calls('chat.open')).toEqual([])
  })

  it('is the full chat under its own pane: thread, crumb, notch, composer that sends, dropped on close', async () => {
    assistantsStore.setState({ data: { agents: [nova('/s/nova.jsonl')], relayUp: true } })
    const { unmount } = ui()
    expect(screen.queryByTestId('agent-start-nova')).toBeNull()
    await waitFor(() => expect(calls('chat.open')).toHaveLength(1))
    const { paneId } = calls('chat.open')[0]!
    expect(paneId).toMatch(/^tool-\d+$/)
    expect(calls('chat.open')[0]).toEqual({ paneId, file: '/s/nova.jsonl' })
    expect(await screen.findByText('Hi Isaac, dentist at five.')).toBeTruthy()
    const pane = screen.getByTestId('chat-pane')
    expect(pane.getAttribute('data-chat-pane')).toBe(paneId)
    expect(screen.getByTestId('agent-crumb')).toBeTruthy()
    expect(screen.getByTestId('agent-notch')).toBeTruthy()
    // Main's own controls (sidebar, tool panes) stay in main's header.
    expect(screen.queryByTestId('sidebar-toggle')).toBeNull()
    expect(screen.queryByTestId('panel-toggle')).toBeNull()

    const box = screen.getByTestId('composer-input')
    await waitFor(() => expect(box).toBeEnabled())
    await userEvent.type(box, 'and the vet?{Enter}')
    await waitFor(() => expect(calls('chat.send')).toEqual([{ paneId, text: 'and the vet?' }]))

    unmount()
    await waitFor(() => expect(calls('chat.drop')).toEqual([{ paneId }]))
    expect(chatStore.getState().panes[paneId as string]).toBeUndefined()
  })
})
