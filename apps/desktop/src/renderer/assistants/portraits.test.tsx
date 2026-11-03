import { MantineProvider } from '@mantine/core'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc', () => ({ invoke: vi.fn(), on: () => () => {} }))

import type { Assistant, AssistantPortrait } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'
import { portrait } from '../ui/portrait'
import { AgentNotch } from './AgentNotch'
import { AssistantsHome } from './AssistantsHome'
import { assistantsStore } from './assistants-store'

const NOVA: AssistantPortrait = {
  style: 'micah',
  seed: 'nova-17',
  options: {
    glasses: ['round'],
    glassesProbability: 100,
    hairColor: ['e0ddff'],
    baseColor: ['b16a5b'],
  },
  colors: { paper: '#e7f5ff', accent: '#f76707' },
}

const agent = (id: string, avatar: AssistantPortrait): Assistant => ({
  id,
  title: id[0]!.toUpperCase() + id.slice(1),
  scope: '',
  avatar,
  status: 'idle',
  tool: null,
  file: null,
  reply: null,
})

afterEach(() => assistantsStore.setState({ data: null }))

describe('assistant portraits', () => {
  it('draws the same face for a seed every time', () => {
    expect(portrait('astra-2')).toBe(portrait('astra-2'))
    expect(portrait('astra-2')).not.toBe(portrait('astra'))
    expect(portrait('astra-2').startsWith('data:image/svg+xml')).toBe(true)
  })

  it('draws a designed micah portrait with its parts on a disc of its paper', () => {
    const svg = decodeURIComponent(
      portrait(NOVA).replace(/^data:image\/svg\+xml;charset=utf-8,/, ''),
    )
    expect(svg).toContain('#e0ddff')
    expect(svg).toContain('#b16a5b')
    expect(svg).toContain('#e7f5ff')
    expect(portrait(NOVA)).toBe(portrait({ ...NOVA }))
    expect(portrait(NOVA)).not.toBe(
      portrait({ ...NOVA, options: { ...NOVA.options, glassesProbability: 0 } }),
    )
    expect(portrait({ style: 'notionists', seed: 'astra-2' })).toBe(portrait('astra-2'))
  })

  it("seeds each Home row and an agent's notch from the registry, else from its id", () => {
    assistantsStore.setState({
      data: {
        agents: [agent('astra', { style: 'notionists', seed: 'astra-2' }), agent('nova', NOVA)],
        relayUp: true,
      },
    })
    render(
      <MantineProvider>
        <AssistantsHome place={placeOf('assistants')} />
        <AgentNotch id="astra" />
        <AgentNotch id="gone" />
      </MantineProvider>,
    )
    const src = (id: string) =>
      screen
        .getAllByTestId(`agent-portrait-${id}`)
        .map((el) => (el.tagName === 'IMG' ? el : el.querySelector('img'))?.getAttribute('src'))
    expect(src('astra')).toEqual([portrait('astra-2'), portrait('astra-2')])
    expect(src('nova')).toEqual([portrait(NOVA)])
    // A tab kept from a registry that dropped the agent still gets its id's face.
    expect(src('gone')).toEqual([portrait('gone')])
  })
})
