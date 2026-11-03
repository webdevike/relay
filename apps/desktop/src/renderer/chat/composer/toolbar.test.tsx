import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
let favorites: string[] = []
const invoke = vi.fn((channel: string, input?: Record<string, unknown>) => {
  const patch = input?.patch as Record<string, unknown> | undefined
  if (channel === 'chat.models')
    return Promise.resolve({ ok: true, value: { models, thinking: 'low' } })
  if (channel === 'chat.launchState') return Promise.resolve({ ok: true, value: current })
  if (channel === 'settings.load' || channel === 'settings.save') {
    if (Array.isArray(input?.favorite_models)) favorites = input.favorite_models as string[]
    return Promise.resolve({
      ok: true,
      value: {
        show_thinking: false,
        show_tools: false,
        harness: 'omp',
        favorite_models: favorites,
      },
    })
  }
  if (channel === 'chat.setLaunch') {
    if (patch?.approval === 'write' && current.harness === 'omp' && !current.unsent) {
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
import { resetSettingsForTest } from '../../settings/settings-store'
import { dispatchChord } from '../../hotkeys/router'

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
  favorites = []
  resetSettingsForTest()
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
    // Nothing starred: the picker opens on the first provider's tab.
    expect(await screen.findByTestId('model-option-anthropic-claude-opus-5-5')).toBeInTheDocument()
    expect(screen.queryByTestId('model-option-fake-text-only')).toBeNull()
    expect(screen.getByPlaceholderText('Search Anthropic...')).toBeInTheDocument()
    await user.click(screen.getByTestId('model-tab-fake'))
    await user.click(await screen.findByTestId('model-option-fake-text-only'))
    expect(invoke).toHaveBeenCalledWith('chat.setLaunch', {
      paneId: 'pane-1',
      patch: { model: { provider: 'fake', modelId: 'text-only' } },
    })
  })

  it('a star saves favorite_models and the starred tab numbers ⌘1-⌘9', async () => {
    open(1, 100)
    wrap()
    const user = userEvent.setup()
    await waitFor(() => expect(screen.getByTestId('composer-model')).toHaveTextContent('Opus 5.5'))
    await user.click(screen.getByTestId('composer-model'))
    await user.click(await screen.findByTestId('model-tab-fake'))
    await user.click(screen.getByTestId('model-star-fake-text-only'))
    expect(invoke).toHaveBeenCalledWith('settings.save', { favorite_models: ['fake/text-only'] })
    // The star is not a pick.
    expect(invoke).not.toHaveBeenCalledWith('chat.setLaunch', expect.anything())
    await user.click(screen.getByTestId('model-tab-starred'))
    expect(screen.getByPlaceholderText('Search starred...')).toBeInTheDocument()
    expect(screen.getByTestId('model-option-fake-text-only')).toHaveTextContent('⌘ 1')
    expect(dispatchChord('cmd+1', { fromGuest: false })).toBe(true)
    expect(invoke).toHaveBeenCalledWith('chat.setLaunch', {
      paneId: 'pane-1',
      patch: { model: { provider: 'fake', modelId: 'text-only' } },
    })
    // Nothing at ⌘2: the chord passes through.
    expect(dispatchChord('cmd+2', { fromGuest: false })).toBe(false)
  })

  it('the thinking level shows on the trigger and resets to omp’s default', async () => {
    open(1, 100)
    wrap()
    const user = userEvent.setup()
    await waitFor(() => expect(screen.getByTestId('composer-model')).toHaveTextContent('Off'))
    await user.click(screen.getByTestId('composer-model'))
    expect(await screen.findByTestId('thinking-level')).toHaveTextContent('Off')
    // The popover is still mid-transition for jsdom's accessibility tree.
    const slider = screen.getByRole('slider', { name: 'Thinking level', hidden: true })
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(invoke).toHaveBeenCalledWith('chat.setLaunch', {
      paneId: 'pane-1',
      patch: { thinking: 'low' },
    })
    invoke.mockClear()
    await user.click(screen.getByTestId('thinking-reset'))
    expect(invoke).toHaveBeenCalledWith('chat.setLaunch', {
      paneId: 'pane-1',
      patch: { thinking: 'low' },
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
