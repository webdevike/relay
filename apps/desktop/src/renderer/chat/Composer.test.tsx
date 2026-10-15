import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'

const invoke = vi.fn(() => Promise.resolve({ ok: true, value: { accepted: true } }))
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...a),
}))

import { Composer } from './Composer'
import { chatStore } from './chat-store'

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

  it('a failed send gives the text back and reports the error on the pane', async () => {
    invoke.mockClear()
    invoke.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        error: { code: 'spawn-failed', message: 'Could not start omp: ENOENT' },
      } as unknown as { ok: true; value: { accepted: true } }),
    )
    chatStore.setState({ panes: {} })
    chatStore.getState().openPane('pane-1', {
      file: '/f',
      title: 't',
      messages: [],
      meta: { model: null, thinking: null, contextTokens: null },
    })
    const user = userEvent.setup()
    wrap()
    const box = screen.getByTestId('composer-input')
    await user.type(box, 'keep me{Enter}')
    expect(invoke).toHaveBeenCalledWith('chat.send', { paneId: 'pane-1', text: 'keep me' })
    expect(box).toHaveValue('keep me')
    expect(chatStore.getState().panes['pane-1']!.error).toBe('Could not start omp: ENOENT')
  })

  it('a successful send clears a previous pane error, so a restored prompt can be re-sent', async () => {
    invoke.mockClear()
    chatStore.setState({ panes: {} })
    chatStore.getState().openPane('pane-1', {
      file: '/f',
      title: 't',
      messages: [],
      meta: { model: null, thinking: null, contextTokens: null },
    })
    const user = userEvent.setup()
    wrap()
    const box = screen.getByTestId('composer-input')
    await user.type(box, 'second try')
    // The error lands after the text is in place (as the WR-08 restore does), so only the
    // successful send can clear it here.
    chatStore.getState().setError('pane-1', 'Could not start omp: ENOENT')
    expect(box).toBeEnabled()
    await user.keyboard('{Enter}')
    expect(invoke).toHaveBeenCalledWith('chat.send', { paneId: 'pane-1', text: 'second try' })
    expect(chatStore.getState().panes['pane-1']!.error).toBeNull()
  })

  it('editing the composer clears the pane error', async () => {
    invoke.mockClear()
    chatStore.setState({ panes: {} })
    chatStore.getState().openPane('pane-1', {
      file: '/f',
      title: 't',
      messages: [],
      meta: { model: null, thinking: null, contextTokens: null },
    })
    chatStore.getState().setError('pane-1', 'The session ended unexpectedly.')
    const user = userEvent.setup()
    wrap()
    await user.type(screen.getByTestId('composer-input'), 'x')
    expect(chatStore.getState().panes['pane-1']!.error).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
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
