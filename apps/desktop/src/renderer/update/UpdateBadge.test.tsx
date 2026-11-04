import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn(async (...a: unknown[]) => {
  if (a[0] === 'update.changelog')
    return {
      ok: true,
      value: {
        entries: [
          {
            kind: 'desktop',
            build: 'bbbbbbb222',
            at: '2026-11-03T10:00:00Z',
            changes: ['Calmer sidebar'],
          },
          {
            kind: 'desktop',
            build: 'aaaaaaa111',
            at: '2026-11-02T10:00:00Z',
            changes: ['Old thing'],
          },
        ],
      },
    }
  if (a[0] === 'app.about') return { ok: true, value: { build: 'aaaaaaa111' } }
  return { ok: true, value: {} }
})
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: () => () => {},
}))

import { chatStore, type PaneState } from '../chat/chat-store'
import { UpdateBadge } from './UpdateBadge'
import { updateStore } from './update-store'

const wrap = () =>
  render(
    <MantineProvider>
      <UpdateBadge />
    </MantineProvider>,
  )

beforeEach(() => {
  invoke.mockClear()
  chatStore.setState({ panes: {} })
  updateStore.setState({ update: { pending: false, build: null, summary: null } })
})

describe('UpdateBadge', () => {
  it('renders nothing without a pending update', () => {
    wrap()
    expect(screen.queryByTestId('update-badge')).toBeNull()
  })

  it('opens the details on hover, restarts, and clears once the update is gone', async () => {
    updateStore.setState({ update: { pending: true, build: 'bbbbbbb222', summary: 'Faster' } })
    chatStore.setState({
      panes: { p1: { running: true, title: 'Fix login' } as unknown as PaneState },
    })
    wrap()
    expect(screen.queryByTestId('update-popover')).toBeNull()
    fireEvent.mouseEnter(screen.getByTestId('update-badge'))
    expect(await screen.findByTestId('update-popover')).toBeTruthy()
    expect((await screen.findByTestId('update-popover-changes')).textContent).toBe('Calmer sidebar')
    expect(screen.getByTestId('update-popover-build').textContent).toBe('Build bbbbbbb')
    expect(screen.getByTestId('update-popover-note').textContent).toContain('Fix login')
    fireEvent.click(screen.getByTestId('update-popover-restart'))
    expect(invoke).toHaveBeenCalledWith('update.restart', {})
    act(() => updateStore.setState({ update: { pending: false, build: null, summary: null } }))
    expect(screen.queryByTestId('update-badge')).toBeNull()
  })
})
