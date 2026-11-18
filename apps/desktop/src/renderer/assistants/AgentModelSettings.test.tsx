import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../ipc', () => ({ invoke, on: () => () => {} }))

import { assistantsStore } from './assistants-store'
import { catalogStore } from '../rooms/model-catalog'
import { AgentModelSettings, splitModel } from './AgentModelSettings'

const model = (id: string, name: string, levels: string[]) => ({
  provider: 'anthropic',
  id,
  name,
  contextWindow: null,
  images: true,
  levels,
})

const MODELS = [
  model('claude-opus-5-5', 'Claude Opus 5.5', ['off', 'low', 'medium', 'high', 'xhigh']),
  model('claude-sonnet-5-5', 'Claude Sonnet 5.5', ['off', 'low', 'medium', 'high']),
]

function seed(registryModel: string | undefined) {
  assistantsStore.setState({
    data: {
      agents: [
        {
          id: 'nova',
          title: 'Nova',
          scope: '',
          avatar: { style: 'notionists', seed: 'nova' },
          ...(registryModel === undefined ? {} : { model: registryModel }),
          status: 'idle',
          background: 0,
          turn: false,
          tool: null,
          file: null,
          reply: null,
        },
      ],
      relayUp: true,
    },
  })
}

beforeEach(() => {
  // jsdom has no scrollIntoView, which the select's list calls when it opens.
  Element.prototype.scrollIntoView = vi.fn()
  invoke.mockReset()
  invoke.mockImplementation((channel: string) =>
    Promise.resolve(
      channel === 'chat.models'
        ? { ok: true, value: { models: MODELS, thinking: null } }
        : { ok: true, value: { set: true } },
    ),
  )
  catalogStore.setState({ models: MODELS, error: null })
})
afterEach(() => {
  vi.restoreAllMocks()
})

function show() {
  render(
    <MantineProvider>
      <AgentModelSettings id="nova" />
    </MantineProvider>,
  )
}

describe('splitModel', () => {
  it('reads the thinking suffix and leaves a colon that belongs to the id', () => {
    expect(splitModel('anthropic/claude-opus-5-5:high')).toEqual({
      spec: 'anthropic/claude-opus-5-5',
      level: 'high',
    })
    expect(splitModel('openrouter/x:free')).toEqual({ spec: 'openrouter/x:free', level: null })
  })
})

describe('the avatar menu model settings', () => {
  it('shows the registry model and level, and a picked level writes the registry model with it', async () => {
    seed('anthropic/claude-opus-5-5:medium')
    show()
    expect(screen.getByTestId('agent-model-select')).toHaveValue('Claude Opus 5.5')
    expect(screen.getByTestId('agent-thinking-select')).toHaveValue('Medium')
    fireEvent.click(screen.getByTestId('agent-thinking-select'))
    fireEvent.click(await screen.findByText('High'))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('assistants.configure', {
        agent: 'nova',
        model: 'anthropic/claude-opus-5-5:high',
      }),
    )
  })

  it('a model that lacks the current level gets the nearest one it has', async () => {
    seed('anthropic/claude-opus-5-5:xhigh')
    show()
    fireEvent.click(screen.getByTestId('agent-model-select'))
    fireEvent.click(await screen.findByText('Claude Sonnet 5.5'))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('assistants.configure', {
        agent: 'nova',
        model: 'anthropic/claude-sonnet-5-5:high',
      }),
    )
  })

  it("shows the host's refusal under the selects", async () => {
    seed('anthropic/claude-opus-5-5:medium')
    invoke.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'chat.models'
          ? { ok: true, value: { models: MODELS, thinking: null } }
          : { ok: false, error: { message: 'no assistant nova' } },
      ),
    )
    show()
    fireEvent.click(screen.getByTestId('agent-thinking-select'))
    fireEvent.click(await screen.findByText('Low'))
    expect(await screen.findByRole('alert')).toHaveTextContent('no assistant nova')
  })
})
