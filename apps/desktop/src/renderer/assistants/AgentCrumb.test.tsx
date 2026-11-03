import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc', () => ({ invoke: vi.fn(), on: () => () => {} }))

import { setNavigator } from '../navigation/navigate'
import { AgentCrumb, OwnedCrumb } from './AgentCrumb'
import { AgentNotch } from './AgentNotch'

const open = vi.fn()
beforeEach(() => setNavigator(open))

const ui = (children: React.ReactNode) => render(<MantineProvider>{children}</MantineProvider>)

afterEach(() => {
  setNavigator(null)
  open.mockClear()
})

describe('assistant breadcrumb', () => {
  it('each segment navigates: Assistants to the home, the name to its thread', () => {
    ui(<AgentCrumb id="nova" />)
    fireEvent.click(screen.getByTestId('breadcrumb-back'))
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ page: 'assistants' }), {
      newTab: false,
    })
    fireEvent.click(screen.getByTestId('breadcrumb-agent'))
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ page: 'agent:nova' }), {
      newTab: false,
    })
  })

  it('carries only the way back; the portrait and status words live in the header notch', () => {
    ui(
      <>
        <AgentCrumb id="nova" />
        <AgentNotch id="nova" />
      </>,
    )
    const crumb = screen.getByTestId('agent-crumb')
    expect(crumb.querySelector('[data-testid="agent-portrait-nova"]')).toBeNull()
    expect(crumb.querySelector('[data-testid="agent-crumb-status"]')).toBeNull()
    const notch = screen.getByTestId('agent-notch')
    expect(notch.querySelector('[data-testid="agent-portrait-nova"]')).not.toBeNull()
    expect(notch.querySelector('[data-testid="agent-crumb-status"]')).not.toBeNull()
  })

  it("a chat an assistant started links back to that assistant's thread", () => {
    ui(<OwnedCrumb agent="astra" title="ENG-1 auto-work" />)
    fireEvent.click(screen.getByTestId('owned-crumb-back'))
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ page: 'agent:astra' }), {
      newTab: false,
    })
  })
})
