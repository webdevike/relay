import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StudioJob, StudioPageOp, StudioView } from '@evaos/contract'

const invoke = vi.fn()
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: () => () => undefined,
}))

import { placeOf } from '@evaos/shell-core'
import { StudioPage } from './StudioPage'
import { localStore, resetLocalForTests } from './library/local'
import { requestStudioOpen, studioStore } from './studio-store'
import { BACKENDS, DONE_JOB } from './studio-test-data'

const output = (id: string, createdAt: number) => ({
  ...DONE_JOB.outputs[0]!,
  id,
  path: `/studio/${id}/tok`,
  thumb: `/studio/${id}/tok/thumb`,
  createdAt,
})
const job = (
  id: string,
  asset: string,
  createdAt: number,
  over: Partial<StudioJob> = {},
): StudioJob => ({
  ...DONE_JOB,
  id,
  createdAt,
  spec: { ...DONE_JOB.spec, prompt: `Prompt ${id}` },
  outputs: [output(asset, createdAt)],
  ...over,
})

const ROOT = job('j1', 'a1', 1)
const CHILD = job('j2', 'a2', 2, { parent: { asset: 'a1', how: 'edit' } })
const OTHER = job('j3', 'a3', 3, { project: 'p1' })

const VIEW: StudioView = {
  up: true,
  loaded: true,
  jobs: [OTHER, CHILD, ROOT],
  uploads: [],
  backends: BACKENDS,
  projects: [{ id: 'p1', name: 'Portraits', createdAt: 1 }],
  references: [],
  segments: {},
}
let ops: StudioPageOp[] = []

function page() {
  return render(
    <MantineProvider>
      <StudioPage place={placeOf('studio')} />
    </MantineProvider>,
  )
}

const tiles = () => screen.queryAllByTestId('studio-tile').map((t) => t.dataset.id)

beforeEach(() => {
  ops = []
  resetLocalForTests()
  // jsdom has no scrolling; the create bar scrolls the grid to the new tiles.
  Element.prototype.scrollTo = () => undefined
  studioStore.setState({
    view: { ...VIEW, up: false, loaded: false, jobs: [], backends: [], projects: [] },
    error: null,
    request: null,
  })
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string, input: { op: StudioPageOp }) => {
    if (channel === 'studio.state') return { ok: true, value: VIEW }
    if (channel !== 'studio.req') return { ok: false, error: { code: 'nope', message: 'nope' } }
    ops.push(input.op)
    if (input.op.kind === 'create') {
      const queued = {
        ...DONE_JOB,
        id: 'j9',
        spec: input.op.spec,
        state: 'queued',
        progress: 0,
        outputs: [],
        createdAt: 9,
        ...(input.op.project ? { project: input.op.project } : {}),
      }
      return { ok: true, value: { ok: true, job: queued, jobs: [queued] } }
    }
    return { ok: true, value: { ok: true } }
  })
})

describe('StudioPage', () => {
  it('shows originals newest first with an iteration badge, per view', async () => {
    page()
    await waitFor(() => expect(tiles()).toEqual(['a3', 'a1']))
    const root = screen.getAllByTestId('studio-tile')[1]!
    expect(within(root).getByTestId('studio-tile-count').textContent).toContain('1')
    expect(screen.getByTestId('studio-count').textContent).toBe('2 images')
    fireEvent.click(screen.getByTestId('studio-rail-p1'))
    expect(tiles()).toEqual(['a3'])
    expect(screen.getByTestId('studio-view-title').textContent).toBe('Portraits')
    fireEvent.click(screen.getByTestId('studio-rail-unsorted'))
    expect(tiles()).toEqual(['a1'])
  })

  it('queues count images into the open project from the create bar', async () => {
    page()
    await waitFor(() => expect(tiles()).toHaveLength(2))
    fireEvent.click(screen.getByTestId('studio-rail-p1'))
    fireEvent.change(screen.getByTestId('studio-prompt'), { target: { value: 'A lighthouse' } })
    fireEvent.click(screen.getByRole('button', { name: '3' }))
    fireEvent.click(screen.getByTestId('studio-generate'))
    await waitFor(() => expect(ops.filter((o) => o.kind === 'create')).toHaveLength(1))
    expect(ops[0]).toMatchObject({
      kind: 'create',
      count: 3,
      project: 'p1',
      spec: { backend: 'moss', model: 'moss-image', prompt: 'A lighthouse', aspect: '1:1' },
    })
    expect(await screen.findByTestId('studio-pending')).toBeTruthy()
  })

  it('selects with Cmd, trashes from the bulk bar and restores with Undo', async () => {
    page()
    await waitFor(() => expect(tiles()).toHaveLength(2))
    const [first, second] = screen.getAllByTestId('studio-tile')
    fireEvent.click(first!, { metaKey: true })
    fireEvent.click(second!, { metaKey: true })
    expect(screen.getByTestId('studio-bulk-count').textContent).toBe('2 selected')
    fireEvent.click(within(screen.getByTestId('studio-bulk')).getByText('Delete'))
    // One confirm that says how many images go; nothing is sent before it.
    const modal = localStore.getState().modal
    expect(modal).toMatchObject({ kind: 'confirm', title: 'Delete 3 images?' })
    expect(ops.filter((op) => op.kind === 'trash')).toEqual([])
    act(() => {
      if (modal?.kind === 'confirm') modal.onConfirm()
    })
    await waitFor(() => expect(ops).toContainEqual({ kind: 'trash', assets: ['a3', 'a1', 'a2'] }))
    expect(screen.queryByTestId('studio-bulk')).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(ops).toContainEqual({ kind: 'restore', assets: ['a3', 'a1', 'a2'] }))
  })

  it('selects all with Cmd+A and clears with the bar', async () => {
    page()
    await waitFor(() => expect(tiles()).toHaveLength(2))
    fireEvent.keyDown(window, { key: 'a', metaKey: true })
    expect(screen.getByTestId('studio-bulk-count').textContent).toBe('2 selected')
    fireEvent.keyDown(window, { key: 'f' })
    await waitFor(() =>
      expect(ops).toContainEqual({ kind: 'favorite', assets: ['a3', 'a1'], value: true }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(screen.queryByTestId('studio-bulk')).toBeNull()
  })

  it("fills the create bar from an agent's draft", async () => {
    page()
    await waitFor(() => expect(tiles()).toHaveLength(2))
    act(() =>
      requestStudioOpen({ draft: { prompt: 'A kite', backend: 'codex-image', aspect: '16:9' } }),
    )
    await waitFor(() =>
      expect((screen.getByTestId('studio-prompt') as HTMLTextAreaElement).value).toBe('A kite'),
    )
    expect(screen.getByTestId('studio-model').textContent).toContain('Codex image')
    expect(screen.getByRole('button', { name: 'Aspect ratio' }).textContent).toContain('16:9')
  })

  it('says when Relay is down', async () => {
    invoke.mockImplementation(async () => ({ ok: true, value: { ...VIEW, up: false } }))
    page()
    expect(await screen.findByTestId('studio-notice')).toBeTruthy()
  })
})
