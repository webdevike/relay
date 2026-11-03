import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StudioPageOp, StudioView } from '@evaos/contract'

const invoke = vi.fn()
const listeners = new Map<string, (payload: unknown) => void>()
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: (channel: string, cb: (payload: unknown) => void) => {
    listeners.set(channel, cb)
    return () => listeners.delete(channel)
  },
}))

import { placeOf } from '@evaos/shell-core'
import { StudioPage } from './StudioPage'
import { requestStudioOpen, studioStore } from './studio-store'
import { BACKENDS, DONE_JOB } from './studio-test-data'

const VIEW: StudioView = {
  up: true,
  loaded: true,
  jobs: [DONE_JOB],
  uploads: [],
  backends: BACKENDS,
}
let ops: StudioPageOp[] = []

function page() {
  return render(
    <MantineProvider>
      <StudioPage place={placeOf('studio')} />
    </MantineProvider>,
  )
}

const created = (): StudioPageOp[] => ops.filter((op) => op.kind === 'create')

beforeEach(() => {
  ops = []
  studioStore.setState({
    view: { up: false, loaded: false, jobs: [], uploads: [], backends: [] },
    error: null,
    request: null,
  })
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string, input: { op: StudioPageOp }) => {
    if (channel === 'studio.state') return { ok: true, value: VIEW }
    if (channel !== 'studio.req') return { ok: false, error: { code: 'nope', message: 'nope' } }
    ops.push(input.op)
    if (input.op.kind === 'quote')
      return { ok: true, value: { ok: true, credits: 40, balance: 500 } }
    if (input.op.kind === 'create') {
      const job = {
        ...DONE_JOB,
        id: `j${ops.length + 1}`,
        spec: input.op.spec,
        state: 'queued',
        progress: 0,
        outputs: [],
      }
      return { ok: true, value: { ok: true, job } }
    }
    return { ok: true, value: { ok: true } }
  })
})

describe('StudioPage', () => {
  it('shows the gallery and sends a free job once the prompt is written', async () => {
    page()
    expect(await screen.findAllByTestId('studio-gallery-item')).toHaveLength(1)
    const go = screen.getByTestId('studio-generate')
    expect(go).toBeDisabled()
    fireEvent.change(screen.getByTestId('studio-prompt'), { target: { value: 'A lighthouse' } })
    expect(go).toBeEnabled()
    fireEvent.click(go)
    await waitFor(() => expect(created()).toHaveLength(1))
    expect(created()[0]).toEqual({
      kind: 'create',
      spec: {
        mode: 'image',
        backend: 'codex-image',
        prompt: 'A lighthouse',
        aspect: '16:9',
        resolution: '1536x1024',
      },
    })
    expect(await screen.findByTestId('studio-queue-row')).toHaveTextContent('A lighthouse')
  })

  it('holds Generate while the keyframes do not fit the backend', async () => {
    requestStudioOpen({
      draft: { mode: 'video', backend: 'ltx', prompt: 'Waves', frames: { start: 'a1' } },
    })
    page()
    expect(await screen.findByTestId('studio-problem')).toHaveTextContent(
      'Local video needs both a start and an end frame, or neither.',
    )
    expect(screen.getByTestId('studio-generate')).toBeDisabled()
    expect(screen.getByTestId('studio-prompt')).toHaveValue('Waves')
    expect(studioStore.getState().request).toBeNull()
  })

  it('sends a paid job only from the confirm dialog, with the quoted credits, every time', async () => {
    requestStudioOpen({ draft: { mode: 'video', backend: 'higgsfield', prompt: 'Kite' } })
    page()
    await waitFor(() =>
      expect(screen.getByTestId('studio-backend')).toHaveValue('Higgsfield (paid)'),
    )
    expect(screen.getByTestId('studio-model')).toHaveValue('Kling 2.5')
    // The model picker's prices and the balance, quoted without spending.
    await waitFor(() =>
      expect(screen.getByTestId('studio-balance')).toHaveTextContent(
        '40 credits for this job, 500 credits left',
      ),
    )
    fireEvent.click(screen.getByTestId('studio-generate'))
    expect(await screen.findByText('Spend 40 credits on Higgsfield?')).toBeInTheDocument()
    expect(screen.getByTestId('studio-confirm-after')).toHaveTextContent('460 credits')
    expect(created()).toEqual([])
    // Cancel sends nothing, and a later Generate asks again.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByTestId('studio-confirm-cost')).toBeNull())
    expect(created()).toEqual([])
    fireEvent.click(screen.getByTestId('studio-generate'))
    const spend = await screen.findByTestId('studio-confirm-spend')
    await waitFor(() => expect(spend).toBeEnabled())
    await act(async () => fireEvent.click(spend))
    await waitFor(() => expect(created()).toHaveLength(1))
    expect(created()[0]).toMatchObject({
      kind: 'create',
      spec: { backend: 'higgsfield', model: 'kling-2-5', prompt: 'Kite', confirmCredits: 40 },
    })
  })

  it('follows the host while mounted', async () => {
    page()
    await screen.findAllByTestId('studio-gallery-item')
    act(() => listeners.get('studio.changed')?.({ kind: 'removed', id: 'j1' }))
    expect(await screen.findByTestId('studio-empty')).toBeInTheDocument()
    act(() => listeners.get('studio.changed')?.({ kind: 'status', up: false }))
    expect(screen.getByTestId('studio-notice')).toHaveTextContent("Relay isn't connected.")
  })
})
