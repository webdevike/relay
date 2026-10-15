import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import type { LaunchState } from '@evaos/contract'

const baseState: LaunchState = {
  approval: 'yolo',
  profile: null,
  model: ['anthropic', 'claude-opus-5-5'],
  thinking: 'off',
  fast: false,
  unsent: true,
  harness: 'omp',
  imagesAllowed: true,
}
let current: LaunchState = baseState
const models = [
  {
    provider: 'anthropic',
    id: 'claude-opus-5-5',
    name: 'Opus 5.5',
    contextWindow: 200000,
    images: true,
    levels: ['off', 'low'],
  },
  {
    provider: 'fake',
    id: 'text-only',
    name: 'Text Only',
    contextWindow: 1,
    images: false,
    levels: [],
  },
]
const invoke = vi.fn((channel: string, input?: { patch?: Record<string, unknown> }) => {
  if (channel === 'chat.models') return Promise.resolve({ ok: true, value: { models } })
  if (channel === 'chat.launchState') return Promise.resolve({ ok: true, value: current })
  if (channel === 'chat.setLaunch') {
    if (input?.patch?.approval === 'write' && current.harness === 'omp' && !current.unsent) {
      return Promise.resolve({
        ok: false,
        error: { code: 'busy', message: 'Wait for the reply to finish, then change access.' },
      })
    }
    return Promise.resolve({ ok: true, value: current })
  }
  return Promise.resolve({ ok: true, value: {} })
})
vi.mock('../../ipc', () => ({
  invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...a),
}))

import { Composer } from '../Composer'
import { ContextRing, contextLabel } from './ContextRing'
import { chatStore } from '../chat-store'

const open = (tokens: number | null, window: number | null) => {
  chatStore.setState({ panes: {} })
  chatStore.getState().openPane('pane-1', {
    file: '/f',
    title: 't',
    messages: [],
    meta: { model: ['anthropic', 'claude-opus-5-5'], thinking: null, contextTokens: tokens },
  })
  chatStore.setState((s) => ({
    panes: { ...s.panes, 'pane-1': { ...s.panes['pane-1']!, contextWindow: window } },
  }))
}
const wrap = (disabled = false) =>
  render(
    <MantineProvider>
      <Composer paneId="pane-1" disabled={disabled} />
    </MantineProvider>,
  )

beforeEach(() => {
  invoke.mockClear()
  current = baseState
})

describe('ContextRing', () => {
  const arc = (c: HTMLElement) => c.querySelectorAll('circle')[1]?.getAttribute('stroke')
  const ring = (tokens: number | null, window: number | null) =>
    render(
      <MantineProvider>
        <ContextRing tokens={tokens} window={window} />
      </MantineProvider>,
    )

  it('42000 of 200000 reads 21% with the accent arc', () => {
    const { container } = ring(42000, 200000)
    expect(screen.getByTestId('composer-context')).toHaveAttribute('aria-label', 'Context 21% used')
    expect(arc(container)).toBe('var(--eva-c-primary-background)')
  })
  it('85% is warning and 96% is danger', () => {
    const w = ring(85, 100)
    expect(arc(w.container)).toBe('var(--eva-c-warning-background)')
    w.unmount()
    const d = ring(96, 100)
    expect(arc(d.container)).toBe('var(--eva-c-danger-background)')
  })
  it('an unknown window shows the token count, no reading says Unavailable and never 0%', () => {
    expect(contextLabel(5000, null)).toBe('Context 5,000 tokens used')
    expect(contextLabel(null, null)).toBe('Unavailable')
    expect(contextLabel(null, 200000)).toBe('Unavailable')
    expect(contextLabel(0, 200000)).toBe('Context 0% used')
  })
})

describe('Composer toolbar', () => {
  it('renders attach, model, access, account (unsent), then context ring and send in order', async () => {
    open(42000, 200000)
    wrap()
    await screen.findByTestId('composer-account')
    const bar = screen.getByTestId('composer').querySelector('.eva-composer-toolbar')!
    const order = Array.from(bar.querySelectorAll('[data-testid],[aria-label="Attach image"]')).map(
      (e) => e.getAttribute('data-testid') ?? e.getAttribute('aria-label'),
    )
    expect(order.filter((x) => x !== 'composer-file-input')).toEqual([
      'Attach image',
      'composer-model',
      'composer-access',
      'composer-account',
      'composer-context',
      'composer-send',
    ])
    expect(screen.getByTestId('composer-model')).toHaveTextContent('Opus 5.5')
    expect(screen.getByTestId('composer-access')).toHaveTextContent('Full access')
  })

  it('the account selector is hidden once the chat has been prompted, or on Claude', async () => {
    current = { ...baseState, unsent: false }
    open(1, 100)
    wrap()
    await screen.findByTestId('composer-access')
    await waitFor(() => expect(screen.getByTestId('composer-access')).toHaveTextContent('Full'))
    expect(screen.queryByTestId('composer-account')).toBeNull()
  })

  it('picking a model calls chat.setLaunch with provider and model id', async () => {
    open(1, 100)
    wrap()
    const user = userEvent.setup()
    await waitFor(() => expect(screen.getByTestId('composer-model')).toHaveTextContent('Opus 5.5'))
    await user.click(screen.getByTestId('composer-model'))
    await user.click(await screen.findByTestId('model-option-fake-text-only'))
    expect(invoke).toHaveBeenCalledWith('chat.setLaunch', {
      paneId: 'pane-1',
      patch: { model: { provider: 'fake', modelId: 'text-only' } },
    })
  })

  it('access labels come from APPROVAL_LABEL and a busy refusal shows inline', async () => {
    current = { ...baseState, unsent: false }
    open(1, 100)
    wrap()
    const user = userEvent.setup()
    await waitFor(() => expect(screen.getByTestId('composer-access')).toHaveTextContent('Full'))
    await user.click(screen.getByTestId('composer-access'))
    expect(await screen.findByText('Ask before commands')).toBeInTheDocument()
    expect(screen.getByText('Ask before edits')).toBeInTheDocument()
    await user.click(screen.getByTestId('access-option-write'))
    expect(await screen.findByTestId('composer-launch-error')).toHaveTextContent(
      'Wait for the reply to finish, then change access.',
    )
  })

  it('controls are aria-disabled at half opacity class with no pane, and attach follows imagesAllowed', async () => {
    chatStore.setState({ panes: {} })
    const { unmount } = wrap(true)
    expect(screen.getByTestId('composer-model')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('composer-access')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: 'Attach image' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    unmount()
    open(1, 100)
    chatStore.setState((st) => ({
      panes: { ...st.panes, 'pane-1': { ...st.panes['pane-1']!, stopped: true } },
    }))
    const closed = wrap()
    expect(screen.getByTestId('composer-model')).toHaveAttribute('aria-disabled', 'true')
    closed.unmount()
    current = { ...baseState, imagesAllowed: false }
    open(1, 100)
    wrap()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Attach image' })).toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    )
  })
})
