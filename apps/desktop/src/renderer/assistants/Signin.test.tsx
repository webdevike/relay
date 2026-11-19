import { MantineProvider } from '@mantine/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (channel: string, _args?: unknown): Promise<unknown> => {
    if (channel === 'setup.run') return { ok: true, value: { ok: true, version: 'anthropic' } }
    return { ok: false, error: { code: 'test', message: `${channel} is not served here` } }
  }),
}))
vi.mock('../ipc', () => ({
  invoke: (...a: [string, unknown]) => invoke(...a),
  on: () => () => {},
}))

import type { Assistant, Assistants } from '@evaos/contract'
import { assistantsStore } from './assistants-store'
import { signinStore } from './agent-signin'
import { FailureStrip } from './Signin'

const FAILURE = {
  at: 1,
  kind: 'auth' as const,
  title: "Nova couldn't reply",
  text: 'No API key found for anthropic. Sign in again under the personal profile.',
  fix: { kind: 'signin' as const, provider: 'anthropic', profile: 'personal' },
}

const nova = (over: Partial<Assistant> = {}): Assistant => ({
  id: 'nova',
  title: 'Nova',
  scope: '',
  avatar: { style: 'notionists', seed: 'nova' },
  status: 'idle',
  background: 0,
  turn: false,
  tool: null,
  file: '/s/nova.jsonl',
  reply: null,
  profile: 'personal',
  ...over,
})

const show = (agent: Assistant, extra: Partial<Assistants> = {}) =>
  act(() => assistantsStore.setState({ data: { agents: [agent], relayUp: true, ...extra } }))

const ui = () =>
  render(
    <MantineProvider>
      <FailureStrip agent="nova" />
    </MantineProvider>,
  )

afterEach(() => {
  invoke.mockClear()
  assistantsStore.setState({ data: null, starting: {}, failed: {} })
  signinStore.setState({ busy: {}, notes: {} })
})

describe('FailureStrip', () => {
  it('ends the thread with the failed turn, signs its profile in again, and goes once the host clears it', async () => {
    show(nova({ failure: FAILURE }))
    ui()
    const strip = screen.getByTestId('turn-failure-nova')
    expect(strip).toHaveAttribute('data-tone', 'danger')
    expect(strip).toHaveTextContent("Nova couldn't reply")
    expect(strip).toHaveTextContent('No API key found for anthropic.')
    await userEvent.click(screen.getByTestId('turn-failure-nova-signin'))
    expect(invoke).toHaveBeenCalledWith('setup.run', {
      runId: expect.stringMatching(/^signin-/),
      run: { task: 'ai-login', provider: 'anthropic', profile: 'personal' },
    })
    await waitFor(() =>
      expect(screen.getByTestId('turn-failure-nova-note')).toHaveTextContent(
        'Signed in. Send your message again.',
      ),
    )
    // The host's next list carries no failure (a reply landed) and the profile signed in.
    show(nova({ auth: { profile: 'personal', provider: 'anthropic', state: 'ok' } }))
    expect(screen.queryByTestId('turn-failure-nova')).toBeNull()
  })

  it('warns of a signed-out profile before a turn fails', () => {
    show(
      nova({
        auth: {
          profile: 'personal',
          provider: 'anthropic',
          state: 'signed_out',
          detail: 'Refresh token expired.',
        },
      }),
    )
    ui()
    const strip = screen.getByTestId('turn-failure-nova')
    expect(strip).toHaveAttribute('data-tone', 'warn')
    expect(strip).toHaveTextContent('Claude, personal profile: signed out')
    expect(strip).toHaveTextContent('Refresh token expired.')
    expect(screen.getByTestId('turn-failure-nova-signin')).toHaveTextContent('Sign in again')
  })

  it("on a thin client says to sign in on the host's Mac, running nothing here", () => {
    show(nova({ failure: FAILURE }), { hostMac: 'Mac mini' })
    ui()
    expect(screen.getByTestId('turn-failure-nova-signin-elsewhere')).toHaveTextContent(
      'Sign in on Mac mini: Relay > Settings > Connections',
    )
    expect(screen.queryByTestId('turn-failure-nova-signin')).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('gives the command for a provider setup cannot sign in, and no button for a failure signing in does not fix', () => {
    show(
      nova({
        failure: {
          ...FAILURE,
          fix: { kind: 'signin', provider: 'google-gemini-cli', profile: 'personal' },
        },
      }),
    )
    const view = ui()
    expect(screen.getByTestId('turn-failure-nova-signin-command')).toHaveTextContent(
      'omp --profile personal login google-gemini-cli',
    )
    view.unmount()
    show(
      nova({
        failure: {
          at: 1,
          kind: 'rate_limit',
          title: "Nova couldn't reply",
          text: 'Usage limit reached.',
        },
      }),
    )
    ui()
    expect(screen.getByTestId('turn-failure-nova')).toHaveTextContent('Usage limit reached.')
    expect(screen.queryByTestId('turn-failure-nova-signin')).toBeNull()
  })

  it('shows nothing while all is well', () => {
    show(nova({ auth: { profile: 'personal', provider: 'anthropic', state: 'ok' } }))
    ui()
    expect(screen.queryByTestId('turn-failure-nova')).toBeNull()
  })
})
