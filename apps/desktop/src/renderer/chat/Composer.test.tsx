import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import { createRef } from 'react'

// Only chat.send is scripted; the toolbar's launch and model reads get an empty value.
const sendResults: unknown[] = []
const invoke = vi.fn((channel: string, ..._rest: unknown[]) =>
  channel === 'chat.send'
    ? Promise.resolve(sendResults.shift() ?? { ok: true, value: { accepted: true } })
    : Promise.resolve({ ok: true, value: {} }),
)
const sent = (): unknown[][] => invoke.mock.calls.filter((c) => c[0] === 'chat.send')
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...a),
}))

import { Composer, type ComposerHandle } from './Composer'
import { chatStore } from './chat-store'
import { DISMISS_PRIORITY, dismissTop, useDismissable } from '../hotkeys/dismiss'

const wrap = (disabled = false) =>
  render(
    <MantineProvider>
      <Composer paneId="pane-1" disabled={disabled} />
    </MantineProvider>,
  )

function SidebarBack({ onBack }: { onBack: () => void }) {
  useDismissable(DISMISS_PRIORITY.subPageBack, onBack)
  return null
}
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
    sendResults.push({
      ok: false,
      error: { code: 'spawn-failed', message: 'Could not start omp: ENOENT' },
    })
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
    expect(sent()).toHaveLength(0)
  })

  it('Shift+Enter inserts a newline and does not send', async () => {
    invoke.mockClear()
    const user = userEvent.setup()
    wrap()
    const box = screen.getByTestId('composer-input')
    await user.type(box, 'a{Shift>}{Enter}{/Shift}b')
    expect(sent()).toHaveLength(0)
    expect(box).toHaveValue('a\nb')
  })

  it('empty text does not send', async () => {
    invoke.mockClear()
    const user = userEvent.setup()
    wrap()
    await user.type(screen.getByTestId('composer-input'), '   {Enter}')
    expect(sent()).toHaveLength(0)
  })

  it('focused running composer aborts before sidebar Back in the capture Escape ladder', async () => {
    invoke.mockClear()
    chatStore.setState({ panes: {} })
    chatStore.getState().openPane('pane-1', {
      file: '/f',
      title: 't',
      messages: [],
      meta: { model: null, thinking: null, contextTokens: null },
    })
    chatStore.getState().applyOps('pane-1', [{ op: 'meta', patch: { running: true } }], 1)
    const back = vi.fn()
    render(<SidebarBack onBack={back} />)
    wrap()
    fireEvent.focus(screen.getByTestId('composer-input'))
    act(() => {
      expect(dismissTop()).toBe(true)
    })
    expect(invoke).toHaveBeenCalledWith('chat.abort', { paneId: 'pane-1' })
    expect(back).not.toHaveBeenCalled()
    fireEvent.blur(screen.getByTestId('composer-input'))
    act(() => {
      dismissTop()
    })
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('disabled shows the not-running placeholder', () => {
    wrap(true)
    expect(
      screen.getByPlaceholderText('Session is not running. Resume it to send a message.'),
    ).toBeDisabled()
  })

  describe('widget replies', () => {
    const withHandle = () => {
      const handle = createRef<ComposerHandle>()
      render(
        <MantineProvider>
          <Composer ref={handle} paneId="pane-1" disabled={false} />
        </MantineProvider>,
      )
      return handle
    }

    it('sendReply sends the text through chat.send and leaves the draft alone', async () => {
      invoke.mockClear()
      const user = userEvent.setup()
      const handle = withHandle()
      const box = screen.getByTestId('composer-input')
      await user.type(box, 'my draft')
      act(() => handle.current!.sendReply('nudge Noah on ENG-6211'))
      await waitFor(() =>
        expect(sent()).toEqual([
          ['chat.send', { paneId: 'pane-1', text: 'nudge Noah on ENG-6211' }],
        ]),
      )
      expect(box).toHaveValue('my draft')
    })

    it('a reply owned elsewhere asks first, then resends that reply forced', async () => {
      invoke.mockClear()
      sendResults.push({
        ok: false,
        error: { code: 'owned-elsewhere', message: 'Another window is writing.' },
      })
      const handle = withHandle()
      act(() => handle.current!.sendReply('ship it'))
      fireEvent.click(await screen.findByTestId('writer-prompt-confirm'))
      await waitFor(() =>
        expect(sent()).toEqual([
          ['chat.send', { paneId: 'pane-1', text: 'ship it' }],
          ['chat.send', { paneId: 'pane-1', text: 'ship it', force: true }],
        ]),
      )
      expect(screen.getByTestId('composer-input')).toHaveValue('')
    })
  })

  describe('images', () => {
    const png = () => new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' })
    const revoke = vi.fn()
    beforeEach(() => {
      revoke.mockClear()
      vi.stubGlobal(
        'URL',
        Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: revoke }),
      )
    })
    afterEach(() => vi.unstubAllGlobals())

    const pasteImage = async () => {
      fireEvent.paste(screen.getByTestId('composer-input'), {
        clipboardData: { files: [png()], types: ['Files'] },
      })
      await screen.findByAltText('Pasted image 1')
    }

    it('paste adds a chip, Send is enabled with empty text, Enter sends the images', async () => {
      invoke.mockClear()
      const user = userEvent.setup()
      wrap()
      expect(screen.getByTestId('composer-send')).toBeDisabled()
      await pasteImage()
      expect(screen.getByText('a.png')).toHaveAttribute('title', 'a.png')
      expect(screen.getByTestId('composer-send')).toBeEnabled()
      await user.type(screen.getByTestId('composer-input'), '{Enter}')
      expect(invoke).toHaveBeenCalledWith('chat.send', {
        paneId: 'pane-1',
        text: '',
        images: [{ mimeType: 'image/png', data: 'AQID' }],
      })
      await waitFor(() => expect(screen.queryByAltText('Pasted image 1')).toBeNull())
      expect(revoke).toHaveBeenCalledWith('blob:x')
    })

    it('Remove image 1 removes the chip and revokes its url', async () => {
      const user = userEvent.setup()
      wrap()
      await pasteImage()
      await user.click(screen.getByLabelText('Remove image 1'))
      expect(screen.queryByAltText('Pasted image 1')).toBeNull()
      expect(revoke).toHaveBeenCalledWith('blob:x')
    })

    it('a failed send keeps the text and the chips', async () => {
      sendResults.push({ ok: false, error: { code: 'x', message: 'nope' } })
      const user = userEvent.setup()
      wrap()
      await pasteImage()
      await user.type(screen.getByTestId('composer-input'), 'look{Enter}')
      await screen.findByAltText('Pasted image 1')
      expect(screen.getByTestId('composer-input')).toHaveValue('look')
    })

    it('dropping a text file shows the notice; the overlay follows dragenter and drop', async () => {
      wrap()
      const box = screen.getByTestId('composer')
      const dt = (files: File[]) => ({ dataTransfer: { files, types: ['Files'] } })
      fireEvent.dragEnter(box, dt([]))
      expect(screen.getByText('Drop images to attach')).toBeTruthy()
      fireEvent.drop(box, dt([new File(['x'], 'a.txt', { type: 'text/plain' })]))
      expect(screen.queryByText('Drop images to attach')).toBeNull()
      expect(await screen.findByText('Only images can be attached.')).toBeTruthy()
      fireEvent.dragEnter(box, dt([]))
      fireEvent.dragLeave(box, dt([]))
      expect(screen.queryByText('Drop images to attach')).toBeNull()
    })
  })
})
