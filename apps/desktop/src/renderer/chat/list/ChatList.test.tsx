import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))

import type { ChatList as ChatListValue } from '@evaos/contract'
import { ChatList } from './ChatList'
import { listStore, resetListForTests } from './list-store'

const row = (id: string, title: string, archived = false) => ({
  id,
  file: `/s/${id}.jsonl`,
  title,
  mtimeMs: 1000,
  archived,
  pinned: false,
  running: false,
  status: null,
})
const value: ChatListValue = {
  rows: [row('a', 'Grocery list'), row('b', 'Grocery old', true), row('c', 'Taxes')],
  prefs: { chat_categories: [], chat_group_order: [], chat_assignments: {}, collapsed_groups: [] },
  error: null,
}

const mount = (query: string) =>
  render(
    <MantineProvider>
      <ChatList query={query} />
    </MantineProvider>,
  )

beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async (ch: string) =>
    ch === 'chat.list' ? { ok: true, value } : { ok: true, value: { saved: true } },
  )
  resetListForTests()
})

describe('ChatList search and fold', () => {
  it('browse mode hides archived behind Archived (1) and opens it on click', async () => {
    mount('')
    expect(await screen.findByTestId('chat-archived-toggle')).toHaveTextContent('Archived (1)')
    expect(screen.queryByTestId('chat-row-b')).toBeNull()
    fireEvent.click(screen.getByTestId('chat-archived-toggle'))
    expect(screen.getByTestId('chat-row-b')).toBeInTheDocument()
  })

  it('a query shows archived matches with the Archived chip, and the empty copy when none match', async () => {
    const { rerender } = mount('grocery')
    expect(await screen.findByTestId('chat-row-b')).toHaveTextContent('Archived')
    expect(screen.queryByTestId('chat-archived-toggle')).toBeNull()
    expect(screen.queryByTestId('chat-row-c')).toBeNull()
    rerender(
      <MantineProvider>
        <ChatList query="zzz" />
      </MantineProvider>,
    )
    expect(await screen.findByText('No chats match "zzz"')).toBeInTheDocument()
    expect(screen.getByText('Try a different title.')).toBeInTheDocument()
  })

  it('a group header toggles collapse with aria-expanded and saves', async () => {
    mount('')
    const header = await screen.findByTestId('chat-group-Other')
    expect(header).toHaveAttribute('aria-expanded', 'true')
    await act(async () => {
      fireEvent.click(header)
    })
    expect(screen.getByTestId('chat-group-Other')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('chat-row-c')).toBeNull()
    expect(invoke).toHaveBeenCalledWith('chat.setCollapsed', { groups: ['Other'] })
    expect(listStore.getState().collapsed.has('Other')).toBe(true)
  })
})
