import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../ipc', () => ({
  invoke: async () => ({ ok: true, value: {} }),
  on: () => () => {},
}))

import { WriterPrompt } from './WriterPrompt'

const ui = (p: Partial<React.ComponentProps<typeof WriterPrompt>> = {}) => (
  <MantineProvider>
    <WriterPrompt
      opened
      message="Another pane is writing."
      onCancel={() => {}}
      onConfirm={() => {}}
      {...p}
    />
  </MantineProvider>
)

describe('WriterPrompt', () => {
  it('shows the title, the message and both buttons', () => {
    render(ui())
    expect(screen.getByText('Chat is open elsewhere')).toBeTruthy()
    expect(screen.getByText('Another pane is writing.')).toBeTruthy()
    expect(screen.getByRole('button', { name: "Don't send" })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send anyway' })).toBeTruthy()
  })

  it("Don't send cancels and Send anyway confirms", () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(ui({ onCancel, onConfirm }))
    fireEvent.click(screen.getByRole('button', { name: "Don't send" }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Send anyway' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('renders nothing when closed', () => {
    render(ui({ opened: false }))
    expect(screen.queryByText('Chat is open elsewhere')).toBeNull()
  })
})
