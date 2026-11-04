import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn(async (..._a: unknown[]) => ({ ok: true, value: {} }))
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: () => () => {},
}))

import { UpdateCard } from './UpdateCard'
import { updateStore } from './update-store'

const wrap = () =>
  render(
    <MantineProvider>
      <UpdateCard />
    </MantineProvider>,
  )

beforeEach(() => {
  invoke.mockClear()
  updateStore.setState({ update: { pending: false, build: null, summary: null } })
})

describe('UpdateCard', () => {
  it('renders nothing without a pending update', () => {
    wrap()
    expect(screen.queryByTestId('update-card')).toBeNull()
  })

  it('shows the summary and restarts on click; clears once the update is gone', () => {
    updateStore.setState({ update: { pending: true, build: 'b1', summary: 'Faster lists' } })
    wrap()
    expect(screen.getByText('Update ready')).toBeTruthy()
    expect(screen.getByTestId('update-card-summary').textContent).toBe('Faster lists')
    fireEvent.click(screen.getByTestId('update-card-restart'))
    expect(invoke).toHaveBeenCalledWith('update.restart', {})
    act(() => updateStore.setState({ update: { pending: false, build: null, summary: null } }))
    expect(screen.queryByTestId('update-card')).toBeNull()
  })
})
