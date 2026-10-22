import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))

import type { ChatList as ChatListValue } from '@evaos/contract'
import { ChatList } from './ChatList'
import { listStore, resetListForTests } from './list-store'
import { chatRow, listPrefs } from './test-rows'

const now = Date.now()
const value: ChatListValue = {
  rows: [
    chatRow('a', 'Grocery list', { returnedMs: now - 60_000 }),
    chatRow('b', 'Grocery old', { archived: true, returnedMs: now - 120_000 }),
    chatRow('c', 'Taxes', { returnedMs: now - 30_000 }),
    chatRow('r', 'Relay fix', {
      returnedMs: now - 10_000,
      running: true,
      status: 'working',
      startedMs: now - 5000,
    }),
    chatRow('p', 'Pinned plan', { pinned: true, returnedMs: now - 1000 }),
    chatRow('s', 'Snoozed thing', { snoozedUntilMs: now + 3_600_000 }),
    chatRow('e', 'Eren chat', { agent: 'Eren', returnedMs: now }),
  ],
  prefs: listPrefs(),
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

describe('ChatList layout', () => {
  it('pinned rows sit flat at the top; folders follow, newest return first', async () => {
    mount('')
    const tree = await screen.findByTestId('chat-tree')
    expect(screen.queryByText('Pinned')).toBeNull()
    const order = [
      ...tree.querySelectorAll('[data-testid^="chat-row-"], [data-testid^="chat-group-"]'),
    ].map((e) => e.getAttribute('data-testid'))
    expect(order).toEqual([
      'chat-row-p',
      'chat-group-Relay',
      'chat-row-r',
      'chat-group-Other',
      'chat-row-c',
      'chat-row-a',
    ])
    const relay = screen.getByTestId('chat-group-Relay')
    expect(relay).toHaveTextContent('Relay1')
    expect(within(relay).getByLabelText('Working')).toBeInTheDocument()
  })

  it('agent tabs count every chat, hide empty ones, and filter', async () => {
    mount('')
    expect(await screen.findByTestId('chat-agent-eva')).toHaveTextContent('Eva6')
    expect(screen.getByTestId('chat-agent-eren')).toHaveTextContent('Eren1')
    expect(screen.queryByTestId('chat-agent-elysia')).toBeNull()
    expect(screen.queryByTestId('chat-row-e')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByText('Eren'))
    })
    expect(invoke).toHaveBeenCalledWith('chat.setAgent', { agent: 'Eren' })
    expect(screen.getByTestId('chat-row-e')).toBeInTheDocument()
    expect(screen.queryByTestId('chat-row-a')).toBeNull()
  })

  it('Snoozed and Settled folds stay closed until clicked', async () => {
    mount('')
    expect(await screen.findByTestId('chat-settled-toggle')).toHaveTextContent('Settled (1)')
    expect(screen.getByTestId('chat-snoozed-toggle')).toHaveTextContent('Snoozed (1)')
    expect(screen.queryByTestId('chat-row-b')).toBeNull()
    expect(screen.queryByTestId('chat-row-s')).toBeNull()
    fireEvent.click(screen.getByTestId('chat-settled-toggle'))
    expect(screen.getByTestId('chat-row-b')).toBeInTheDocument()
    expect(screen.getByTestId('chat-settled-toggle')).toHaveAttribute('aria-expanded', 'true')
  })

  it('a query opens everything, settled matches in their fold, and the empty copy', async () => {
    const { rerender } = mount('grocery')
    expect(await screen.findByTestId('chat-row-b')).toBeInTheDocument()
    expect(screen.getByTestId('chat-settled-toggle')).toHaveTextContent('Settled (1)')
    expect(screen.queryByTestId('chat-row-c')).toBeNull()
    rerender(
      <MantineProvider>
        <ChatList query="zzz" />
      </MantineProvider>,
    )
    expect(await screen.findByText('No chats match.')).toBeInTheDocument()
  })

  it('a folder header toggles collapse and saves, running or not; a search opens it', async () => {
    const { rerender } = mount('')
    const header = await screen.findByTestId('chat-group-Other')
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById(header.getAttribute('aria-controls')!)).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(header)
    })
    expect(screen.getByTestId('chat-group-Other')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('chat-row-c')).toBeNull()
    expect(invoke).toHaveBeenCalledWith('chat.setCollapsed', { groups: ['Other'] })
    // A running chat no longer pins its folder open; the header keeps its status hint.
    await act(async () => {
      fireEvent.click(screen.getByTestId('chat-group-Relay'))
    })
    const relay = screen.getByTestId('chat-group-Relay')
    expect(relay).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('chat-row-r')).toBeNull()
    expect(within(relay).getByRole('img', { name: 'Working' })).toBeInTheDocument()
    rerender(
      <MantineProvider>
        <ChatList query="relay" />
      </MantineProvider>,
    )
    expect(await screen.findByTestId('chat-row-r')).toBeInTheDocument()
    expect(screen.getByTestId('chat-group-Relay')).toHaveAttribute('aria-expanded', 'true')
  })

  it('a folder shows ten rows, then Show N more', async () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      chatRow(`m${i}`, `Misc ${i}`, { returnedMs: now - i * 1000 }),
    )
    invoke.mockImplementation(async (ch: string) =>
      ch === 'chat.list'
        ? { ok: true, value: { ...value, rows: many } }
        : { ok: true, value: { saved: true } },
    )
    mount('')
    const more = await screen.findByTestId('chat-show-more-Other')
    expect(more).toHaveTextContent('Show 3 more')
    expect(screen.queryByTestId('chat-row-m10')).toBeNull()
    fireEvent.click(more)
    expect(screen.getByTestId('chat-row-m12')).toBeInTheDocument()
    expect(screen.getByTestId('chat-show-more-Other')).toHaveTextContent('Show fewer')
  })

  it('opening a chat marks it read', async () => {
    mount('')
    fireEvent.click(await screen.findByTestId('chat-row-c'))
    expect(invoke).toHaveBeenCalledWith('chat.markRead', { id: 'c' })
  })
})

describe('ChatList row menu', () => {
  it('right-click and Shift+F10 open the menu for that row', async () => {
    mount('')
    const row = await screen.findByTestId('chat-row-a')
    fireEvent.contextMenu(row, { clientX: 20, clientY: 30 })
    expect(await screen.findByTestId('row-menu')).toBeInTheDocument()
    expect(listStore.getState().menu).toMatchObject({ id: 'a', x: 20, y: 30 })
    await act(async () => {
      listStore.getState().closeMenu()
    })
    fireEvent.keyDown(screen.getByTestId('chat-row-c'), { key: 'F10', shiftKey: true })
    await waitFor(() => expect(listStore.getState().menu).toMatchObject({ id: 'c' }))
    expect(await screen.findByTestId('row-menu')).toBeInTheDocument()
  })
})
