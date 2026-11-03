import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: () => () => {},
}))
const reloadAll = vi.fn(async () => {})
vi.mock('../reload/reload', () => ({ reloadAll: () => reloadAll() }))
const show = vi.fn()
vi.mock('@mantine/notifications', () => ({
  notifications: { show: (...a: unknown[]) => show(...a) },
}))

import { dashboardStore, resetDashboardForTests } from '../dashboard/dashboard-store'
import { NewTodoModal } from './NewTodoModal'
import { newTodoStore, openNewTodo, resetNewTodoForTests } from './new-todo-store'

const PREVIEW = { ok: true, value: { nextId: 'T16', today: '2026-10-15' } }

function ws(id: string, displayName: string) {
  return { id, displayName }
}

function setup(addResult: unknown = { ok: true, value: { id: 'T16', tag: 'relay', row: 'r' } }) {
  invoke.mockImplementation(async (ch: string) => (ch === 'eva.todo.preview' ? PREVIEW : addResult))
  dashboardStore.setState({
    data: { workspaces: [ws('eva', 'Eva'), ws('relay', 'Relay')] } as never,
    loading: false,
  })
  render(
    <MantineProvider>
      <NewTodoModal />
    </MantineProvider>,
  )
  act(() => openNewTodo({ tag: 'relay' }))
}

const type = (v: string) =>
  fireEvent.change(screen.getByTestId('new-todo-text'), { target: { value: v } })

describe('NewTodoModal', () => {
  beforeEach(() => {
    invoke.mockReset()
    reloadAll.mockClear()
    show.mockClear()
    resetNewTodoForTests()
    resetDashboardForTests()
  })

  it('renders fields, disabled submit and a live preview', async () => {
    setup()
    expect(await screen.findByTestId('new-todo-workspace')).toBeInTheDocument()
    expect(screen.getByTestId('new-todo-text')).toHaveAttribute('placeholder', 'What needs doing')
    expect(screen.getByTestId('new-todo-submit')).toBeDisabled()
    type('Ship it')
    await waitFor(() =>
      expect(screen.getByTestId('new-todo-preview')).toHaveTextContent(
        'T16 [relay] Ship it (added 2026-10-15)',
      ),
    )
    expect(screen.getByTestId('new-todo-submit')).toBeEnabled()
  })

  it('shows the line break hint and collapses in the preview; Meta+Enter submits', async () => {
    setup()
    await screen.findByTestId('new-todo-text')
    type('one\ntwo')
    expect(screen.getByText('Line breaks become spaces.')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('new-todo-preview')).toHaveTextContent('[relay] one two (added'),
    )
    fireEvent.keyDown(screen.getByTestId('new-todo-text'), { key: 'Enter', metaKey: true })
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('eva.todo.add', { tag: 'relay', text: 'one two' }),
    )
  })

  it('closes, toasts and reloads on success', async () => {
    setup()
    await screen.findByTestId('new-todo-text')
    type('Ship it')
    fireEvent.click(screen.getByTestId('new-todo-submit'))
    await waitFor(() => expect(newTodoStore.getState().opened).toBe(false))
    expect(show.mock.calls[0]![0]).toMatchObject({ message: 'Added T16 to Relay.' })
    expect(reloadAll).toHaveBeenCalled()
    expect(newTodoStore.getState().lastTag).toBe('relay')
  })

  it('stays open with an alert on error and re-fetches the preview', async () => {
    setup({ ok: false, error: { code: 'changed-on-disk', message: 'x' } })
    await screen.findByTestId('new-todo-text')
    type('Ship it')
    const before = invoke.mock.calls.filter((c) => c[0] === 'eva.todo.preview').length
    fireEvent.click(screen.getByTestId('new-todo-submit'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not add the todo. memory/todos.md changed while you were typing or could not be written. Review the preview and try again.',
    )
    expect(newTodoStore.getState().opened).toBe(true)
    await waitFor(() =>
      expect(invoke.mock.calls.filter((c) => c[0] === 'eva.todo.preview').length).toBe(before + 1),
    )
  })

  it('Discard todo closes without adding', async () => {
    setup()
    await screen.findByTestId('new-todo-text')
    type('x')
    fireEvent.click(screen.getByTestId('new-todo-discard'))
    await waitFor(() => expect(newTodoStore.getState().opened).toBe(false))
    expect(invoke.mock.calls.some((c) => c[0] === 'eva.todo.add')).toBe(false)
  })
})
