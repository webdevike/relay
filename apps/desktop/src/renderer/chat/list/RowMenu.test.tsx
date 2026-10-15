import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatRow as Row } from '@evaos/contract'

import { ChatRow } from './ChatRow'
import { RowMenu } from './RowMenu'

vi.mock('../../ipc', () => ({
  invoke: async () => ({ ok: true, value: {} }),
  on: () => () => {},
}))

const base: Row = {
  id: 'p4-x',
  file: '/s/p4-x.jsonl',
  title: 'Some chat',
  mtimeMs: 1,
  archived: false,
  pinned: false,
  running: false,
  status: null,
}
const handlers = () => ({
  onClose: vi.fn(),
  onRename: vi.fn(),
  onPin: vi.fn(),
  onArchive: vi.fn(),
  onDelete: vi.fn(),
})
const menu = (row: Row, extra?: React.ReactNode) =>
  render(
    <MantineProvider>
      <RowMenu row={row} anchor={{ x: 10, y: 10 }} {...handlers()} menuExtraItems={extra} />
    </MantineProvider>,
  )
const labels = (): string[] =>
  screen.getAllByRole('menuitem').map((el) => el.textContent?.trim() ?? '')

describe('RowMenu', () => {
  it('lists Rename, Pin, Archive, Delete in that order', () => {
    menu(base)
    expect(labels()).toEqual(['Rename', 'Pin', 'Archive', 'Delete'])
  })

  it('flips to Unpin and Unarchive from the row state', () => {
    menu({ ...base, pinned: true, archived: true })
    expect(labels()).toEqual(['Rename', 'Unpin', 'Unarchive', 'Delete'])
  })

  it('puts extra items between Archive and the divider, before Delete', () => {
    menu(base, <button role="menuitem">Move to</button>)
    expect(labels()).toEqual(['Rename', 'Pin', 'Archive', 'Move to', 'Delete'])
  })

  it('marks Delete as the danger item', () => {
    menu(base)
    expect(screen.getByTestId('row-menu-delete')).toHaveClass('eva-cl-menu-danger')
  })

  it('calls the matching handler with the row', () => {
    const h = handlers()
    render(
      <MantineProvider>
        <RowMenu row={base} anchor={{ x: 1, y: 1 }} {...h} />
      </MantineProvider>,
    )
    fireEvent.click(screen.getByTestId('row-menu-pin'))
    expect(h.onPin).toHaveBeenCalledWith(base)
    fireEvent.click(screen.getByTestId('row-menu-delete'))
    expect(h.onDelete).toHaveBeenCalledWith(base)
  })

  it('stays closed without a row', () => {
    render(
      <MantineProvider>
        <RowMenu row={null} anchor={null} {...handlers()} />
      </MantineProvider>,
    )
    expect(screen.queryByTestId('row-menu')).toBeNull()
  })
})

describe('ChatRow menu triggers and inline rename', () => {
  const mount = (props: Partial<React.ComponentProps<typeof ChatRow>> = {}) =>
    render(
      <MantineProvider>
        <ChatRow row={base} active={false} onOpen={vi.fn()} {...props} />
      </MantineProvider>,
    )

  it('opens the menu on contextmenu, the Chat actions button and Shift+F10', async () => {
    const onMenu = vi.fn()
    mount({ onMenu })
    const row = screen.getByTestId('chat-row-p4-x')
    fireEvent.contextMenu(row, { clientX: 5, clientY: 6 })
    expect(onMenu).toHaveBeenLastCalledWith(base, 5, 6)
    fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }))
    expect(onMenu).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true })
    await waitFor(() => expect(onMenu).toHaveBeenCalledTimes(3))
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
