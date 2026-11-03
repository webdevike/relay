// @vitest-environment jsdom
import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ContextSnapshot } from '@evaos/contract'
import { contextStore } from '../context/context-store'
import { ArtifactsButton } from './ArtifactsButton'

vi.mock('./ArtifactsPanel', () => ({
  ArtifactsPanel: ({ scope }: { scope: string }) => <div data-testid="panel">{scope}</div>,
}))
vi.mock('../ipc', () => ({ invoke: vi.fn(), on: vi.fn(() => () => undefined) }))

const snap = (dot: 'running' | 'needs' | null, kind: ContextSnapshot['kind'] = 'assistant') =>
  ({
    kind,
    button: { icon: 'activity', label: dot ? '2 running' : null, dot, summary: 's' },
    scope: 'here',
    pinned: [],
    sections: [],
    actions: [],
    footer: { jobsRunning: 0, jobsScheduled: 0, benchRunning: 0 },
    updatedAt: 0,
  }) as unknown as ContextSnapshot

const ui = () =>
  render(
    <MantineProvider>
      <ArtifactsButton agent="nova" />
    </MantineProvider>,
  )

describe('ArtifactsButton', () => {
  it('is an icon-only Artifacts button with no count text', () => {
    contextStore.setState({ snapshot: snap(null) })
    ui()
    const b = screen.getByRole('button', { name: 'Artifacts' })
    expect(b.textContent).toBe('')
    expect(b.querySelector('.eva-ctx-dot')).toBeNull()
  })

  it('shows a dot while this assistant has something running, and no text', () => {
    contextStore.setState({ snapshot: snap('running') })
    ui()
    const b = screen.getByRole('button', { name: 'Artifacts' })
    expect(b.querySelector('.eva-ctx-dot')).not.toBeNull()
    expect(b.textContent).toBe('')
  })

  it("opens an overlay with the assistant's artifacts", async () => {
    contextStore.setState({ snapshot: snap(null) })
    ui()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Artifacts' }))
    })
    expect((await screen.findByTestId('panel')).textContent).toBe('page:agent:nova')
  })
})
