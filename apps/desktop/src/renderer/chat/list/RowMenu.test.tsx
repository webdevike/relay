import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatRow as Row } from '@evaos/contract'

import { ChatRow } from './ChatRow'
import { RowMenu } from './RowMenu'
import { chatRow } from './test-rows'

vi.mock('../../ipc', () => ({
  invoke: async () => ({ ok: true, value: {} }),
  on: () => () => {},
}))

const base: Row = chatRow('p4-x', 'Some chat')
const handlers = () => ({
  onClose: vi.fn(),
  onRename: vi.fn(),
  onPin: vi.fn(),
  onSnooze: vi.fn(),
  onSettle: vi.fn(),
  onDelete: vi.fn(),
})
const menu = (row: Row, settled = false, extra?: React.ReactNode) =>
  render(
    <MantineProvider>
      <RowMenu
        row={row}
        settled={settled}
        anchor={{ x: 10, y: 10 }}
        {...handlers()}
        menuExtraItems={extra}
      />
    </MantineProvider>,
  )
const names = (): string[] =>
  screen.getAllByRole('menuitem').map((el) => el.getAttribute('data-testid') ?? '')

describe('RowMenu', () => {
  it('lists Rename, Pin, the Snooze presets, Settle, Delete in native order', () => {
    menu(base)
    const ids = names()
    expect(ids[0]).toBe('row-menu-rename')
    expect(ids[1]).toBe('row-menu-pin')
    expect(ids.slice(2, -2).every((id) => id.startsWith('row-menu-snooze-'))).toBe(true)
    expect(ids.slice(2, -2).length).toBeGreaterThan(0)
    expect(ids.slice(-2)).toEqual(['row-menu-settle', 'row-menu-delete'])
    expect(screen.getByText('Rename chat')).toBeInTheDocument()
    expect(screen.getByText('Pin chat')).toBeInTheDocument()
    expect(screen.getByText('Settle')).toBeInTheDocument()
    expect(screen.getByText('In 1 hour')).toBeInTheDocument()
  })

  it('flips to Unpin chat, Unsnooze and Unsettle from the row state', () => {
    menu({ ...base, pinned: true, snoozedUntilMs: 5 }, true)
    expect(names()).toEqual([
      'row-menu-rename',
      'row-menu-pin',
      'row-menu-unsnooze',
      'row-menu-settle',
      'row-menu-delete',
    ])
    expect(screen.getByText('Unpin chat')).toBeInTheDocument()
    expect(screen.getByText('Unsnooze')).toBeInTheDocument()
    expect(screen.getByText('Unsettle')).toBeInTheDocument()
  })

  it('offers no snooze for a chat waiting on Isaac', () => {
    menu({ ...base, status: 'needs-approval' })
    expect(names().some((id) => id.startsWith('row-menu-snooze-'))).toBe(false)
  })

  it('puts extra items after Settle, before Delete', () => {
    menu(
      base,
      false,
      <button role="menuitem" data-testid="row-menu-move">
        Move to
      </button>,
    )
    expect(names().slice(-3)).toEqual(['row-menu-settle', 'row-menu-move', 'row-menu-delete'])
  })

  it('marks Delete as the danger item', () => {
    menu(base)
    expect(screen.getByTestId('row-menu-delete')).toHaveClass('eva-cl-menu-danger')
  })

  it('calls the matching handler with the row', () => {
    const h = handlers()
    render(
      <MantineProvider>
        <RowMenu row={base} settled anchor={{ x: 1, y: 1 }} {...h} />
      </MantineProvider>,
    )
    fireEvent.click(screen.getByTestId('row-menu-pin'))
    expect(h.onPin).toHaveBeenCalledWith(base)
    fireEvent.click(screen.getByTestId('row-menu-settle'))
    expect(h.onSettle).toHaveBeenCalledWith(base, false)
    fireEvent.click(screen.getByTestId('row-menu-snooze-In 1 hour'))
    expect(h.onSnooze).toHaveBeenCalledWith(base, expect.any(Number))
    fireEvent.click(screen.getByTestId('row-menu-delete'))
    expect(h.onDelete).toHaveBeenCalledWith(base)
  })

  it('stays closed without a row', () => {
    render(
      <MantineProvider>
        <RowMenu row={null} settled={false} anchor={null} {...handlers()} />
      </MantineProvider>,
    )
    expect(screen.queryByTestId('row-menu')).toBeNull()
  })
})

describe('ChatRow menu triggers and inline rename', () => {
  const mount = (props: Partial<React.ComponentProps<typeof ChatRow>> = {}) =>
    render(
      <MantineProvider>
        <ChatRow
          row={base}
          category="Other"
          nested
          settled={false}
          now={2000}
          active={false}
          onOpen={vi.fn()}
          {...props}
        />
      </MantineProvider>,
    )

  it('opens the menu on contextmenu and Shift+F10', async () => {
    const onMenu = vi.fn()
    mount({ onMenu })
    const row = screen.getByTestId('chat-row-p4-x')
    fireEvent.contextMenu(row, { clientX: 5, clientY: 6 })
    expect(onMenu).toHaveBeenLastCalledWith(base, 5, 6)
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true })
    await waitFor(() => expect(onMenu).toHaveBeenCalledTimes(2))
  })

  it('Enter commits the typed text once', () => {
    const onCommit = vi.fn()
    mount({ renaming: true, onCommitRename: onCommit })
    const input = screen.getByTestId('chat-rename-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  New name ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(base, '  New name ')
  })

  it('Escape cancels without committing, even though unmounting blurs', () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    mount({ renaming: true, onCommitRename: onCommit, onCancelRename: onCancel })
    const input = screen.getByTestId('chat-rename-input')
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.blur(input)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('blur commits', () => {
    const onCommit = vi.fn()
    mount({ renaming: true, onCommitRename: onCommit })
    fireEvent.blur(screen.getByTestId('chat-rename-input'))
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('shows an error message under the row', () => {
    mount({ error: 'Could not rename this chat. Try again.' })
    expect(screen.getByTestId('chat-row-error')).toHaveTextContent('Could not rename')
  })
})
