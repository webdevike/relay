import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'

const invoke = vi.fn(() => Promise.resolve({ ok: true, value: { accepted: true } }))
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...a),
}))

import { Composer } from './Composer'

const wrap = (disabled = false) =>
  render(
    <MantineProvider>
      <Composer paneId="pane-1" disabled={disabled} />
    </MantineProvider>,
  )

describe('Composer', () => {
  it('Enter sends and clears', async () => {
    const user = userEvent.setup()
    wrap()
    const box = screen.getByTestId('composer-input')
    await user.type(box, 'hi there{Enter}')
    expect(invoke).toHaveBeenCalledWith('chat.send', { paneId: 'pane-1', text: 'hi there' })
    expect(box).toHaveValue('')
  })

  it('Shift+Enter inserts a newline and does not send', async () => {
    invoke.mockClear()
    const user = userEvent.setup()
    wrap()
    const box = screen.getByTestId('composer-input')
    await user.type(box, 'a{Shift>}{Enter}{/Shift}b')
    expect(invoke).not.toHaveBeenCalled()
    expect(box).toHaveValue('a\nb')
  })

  it('empty text does not send', async () => {
    invoke.mockClear()
    const user = userEvent.setup()
    wrap()
    await user.type(screen.getByTestId('composer-input'), '   {Enter}')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('disabled shows the not-running placeholder', () => {
    wrap(true)
    expect(
      screen.getByPlaceholderText('Session is not running. Resume it to send a message.'),
    ).toBeDisabled()
  })
})
