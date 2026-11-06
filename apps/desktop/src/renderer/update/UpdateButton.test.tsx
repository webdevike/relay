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
  if (a[0] === 'update.check') return { ok: true, value: { status: 'failed' } }
  return { ok: true, value: {} }
})
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: () => () => {},
}))

import { chatStore, type PaneState } from '../chat/chat-store'
import { UpdateButton } from './UpdateButton'
import { updateStore } from './update-store'

const wrap = () =>
  render(
    <MantineProvider>
      <UpdateButton />
    </MantineProvider>,
  )

beforeEach(() => {
  invoke.mockClear()
  chatStore.setState({ panes: {} })
  updateStore.setState({
    update: { pending: false, build: null, summary: null },
    checking: false,
    installing: false,
    error: null,
  })
})

describe('UpdateButton', () => {
  it('checks for updates when idle and shows a failed check on hover', async () => {
    wrap()
    const btn = screen.getByTestId('update-button')
    expect(btn.getAttribute('aria-label')).toBe('Check for updates')
    fireEvent.click(btn)
    expect(invoke).toHaveBeenCalledWith('update.check', {})
    await act(async () => {})
    fireEvent.mouseEnter(screen.getByTestId('update-button'))
    expect((await screen.findByTestId('update-popover-error')).textContent).toBe(
      "Couldn't check. Try again.",
    )
  })

  it('restarts in one click when an update is ready, with details on hover', async () => {
    updateStore.setState({ update: { pending: true, build: 'bbbbbbb222', summary: 'Faster' } })
    chatStore.setState({
      panes: { p1: { running: true, title: 'Fix login' } as unknown as PaneState },
    })
    wrap()
    const btn = screen.getByTestId('update-button')
    expect(btn.getAttribute('aria-label')).toBe('Update and restart')
    fireEvent.mouseEnter(btn)
    expect((await screen.findByTestId('update-popover-changes')).textContent).toBe('Calmer sidebar')
    expect(screen.getByTestId('update-popover-build').textContent).toBe('Build bbbbbbb')
    expect(screen.getByTestId('update-popover-note').textContent).toContain('Fix login')
    fireEvent.click(btn)
    expect(invoke).toHaveBeenCalledWith('update.restart', {})
    expect(screen.getByTestId('update-button').getAttribute('aria-busy')).toBe('true')
  })
})
