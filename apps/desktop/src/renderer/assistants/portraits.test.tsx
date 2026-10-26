import { MantineProvider } from '@mantine/core'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc', () => ({ invoke: vi.fn(), on: () => () => {} }))

import type { Assistant } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'
import { portrait } from '../ui/portrait'
import { AgentCrumb } from './AgentCrumb'
import { AssistantsHome } from './AssistantsHome'
import { assistantsStore } from './assistants-store'

const agent = (id: string, avatar: string): Assistant => ({
  id,
  title: id[0]!.toUpperCase() + id.slice(1),
  scope: '',
  avatar,
  status: 'idle',
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

  it("seeds each Home row and an agent's crumb from the registry, else from its id", () => {
    assistantsStore.setState({
      data: { agents: [agent('astra', 'astra-2'), agent('nova', 'nova')], relayUp: true },
    })
    render(
      <MantineProvider>
        <AssistantsHome place={placeOf('assistants')} />
        <AgentCrumb id="astra" />
        <AgentCrumb id="gone" />
      </MantineProvider>,
    )
    const src = (id: string) =>
      screen
        .getAllByTestId(`agent-portrait-${id}`)
        .map((el) => (el.tagName === 'IMG' ? el : el.querySelector('img'))?.getAttribute('src'))
    expect(src('astra')).toEqual([portrait('astra-2'), portrait('astra-2')])
    expect(src('nova')).toEqual([portrait('nova')])
    // A tab kept from a registry that dropped the agent still gets its id's face.
    expect(src('gone')).toEqual([portrait('gone')])
  })
})
