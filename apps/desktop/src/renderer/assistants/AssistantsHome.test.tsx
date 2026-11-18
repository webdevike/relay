import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc', () => ({ invoke: vi.fn(), on: () => () => {} }))
const openFromNav = vi.hoisted(() => vi.fn())
vi.mock('../navigation/open-in-app', () => ({ openFromNav }))

import type { Assistant } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'
import { AssistantsHome } from './AssistantsHome'
import { assistantsStore } from './assistants-store'

const agent = (id: string, patch: Partial<Assistant> = {}): Assistant => ({
  id,
  title: id[0]!.toUpperCase() + id.slice(1),
  scope: '',
  avatar: { style: 'notionists', seed: id },
  status: 'idle',
  tool: null,
  file: null,
  reply: null,
  ...patch,
})

const show = (agents: Assistant[]) => {
  assistantsStore.setState({ data: { agents, relayUp: true } })
  render(
    <MantineProvider>
      <AssistantsHome place={placeOf('assistants')} />
    </MantineProvider>,
  )
}

afterEach(() => {
  assistantsStore.setState({ data: null })
  openFromNav.mockClear()
})

describe('AssistantsHome', () => {
  it("shows a card per agent with its status and opens that agent's thread on click", () => {
    show([
      agent('astra'),
      agent('iris', { status: 'working', reply: { text: 'hi', at: Date.now() } }),
    ])
    expect(screen.getByTestId('assistant-status-astra').textContent).toBe('Idle')
    expect(screen.getByTestId('assistant-status-iris').textContent).toContain('Working')
    fireEvent.click(screen.getByTestId('assistant-row-iris'))
    expect(openFromNav).toHaveBeenCalledWith(placeOf('agent:iris'), expect.anything())
  })

  it('says so when the registry has no agents', () => {
    show([])
    expect(screen.getByTestId('assistants-empty')).toBeTruthy()
    expect(screen.queryByTestId('assistants-grid')).toBeNull()
  })
})
