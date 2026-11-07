import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  StudioAsset,
  StudioBackend,
  StudioJob,
  StudioPageOp,
  StudioSegments,
} from '@evaos/contract'

const invoke = vi.fn()
vi.mock('../../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: () => () => {},
}))

import { dismissTop } from '../../hotkeys/dismiss'
import { applyStudioChange, studioStore } from '../studio-store'
import { StudioEditor } from './StudioEditor'
import { localStore } from '../library/local'

const each = (id: string) =>
  (['1:1', '16:9', '9:16'] as const).map((aspect) => ({ id, label: id, aspect }))
const model = (id: string) => ({
  id,
  name: id,
  mode: 'image' as const,
  resolutions: each('1mp'),
  seconds: [],
  frames: [],
})
const BACKENDS: StudioBackend[] = [
  {
    id: 'comfyui',
    label: 'ComfyUI',
    mode: 'image',
    paid: false,
    available: true,
    resolutions: [],
    seconds: [],
    frames: [],
    refs: 4,
    seed: true,
    serial: true,
    models: ['qwen-edit', 'relight', 'angles', 'combine'].map(model),
  },
]

function asset(id: string, at: number, kind: 'image' | 'video' = 'image'): StudioAsset {
  return {
    id,
    kind,
    mimeType: kind === 'image' ? 'image/png' : 'video/mp4',
    width: 768,
    height: 1344,
    size: 1,
    path: `/studio/${id}/t`,
    thumb: `/studio/${id}/t/thumb`,
    origin: 'output',
    createdAt: at,
  }
}

function job(id: string, out: StudioAsset | null, extra: Partial<StudioJob> = {}): StudioJob {
  return {
    id,
    spec: {
      mode: 'image',
      backend: 'comfyui',
      model: 'qwen-edit',
      prompt: 'A fox',
      aspect: '9:16',
      resolution: '1mp',
    },
    state: out ? 'done' : 'queued',
    origin: 'desktop',
    createdAt: out?.createdAt ?? 100,
    progress: out ? 1 : 0,
    outputs: out ? [out] : [],
    project: 'p1',
    ...extra,
  }
}

const ROOT = job('j-root', asset('root', 1))
const CHILD = job('j-child', asset('child', 2), { parent: { asset: 'root', how: 'edit' } })
const SEGMENTS: StudioSegments = {
  asset: 'root',
  state: 'done',
  segments: [
    {
      id: 'seg-1',
      label: 'Subject',
      box: [0.2, 0.1, 0.5, 0.7],
      area: 0.3,
      mask: '/studio/seg-1/t',
      thumb: '/studio/seg-1/t/thumb',
    },
  ],
}

let ops: StudioPageOp[] = []
const created = () => ops.filter((op) => op.kind === 'create')

beforeEach(() => {
  ops = []
  studioStore.setState({
    view: {
      up: true,
      loaded: true,
      jobs: [CHILD, ROOT],
      uploads: [],
      backends: BACKENDS,
      projects: [],
      references: [],
      segments: {},
    },
    error: null,
    request: null,
  })
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string, input: { op: StudioPageOp }) => {
    if (channel !== 'studio.req') return { ok: false, error: { code: 'nope', message: 'nope' } }
    ops.push(input.op)
    if (input.op.kind === 'segment') {
      return {
        ok: true,
        value: { ok: true, segments: { asset: input.op.asset, state: 'queued', segments: [] } },
      }
    }
    if (input.op.kind === 'create') {
      const queued = job('j-new', null, {
        spec: input.op.spec,
        ...(input.op.parent && { parent: input.op.parent }),
        createdAt: 50,
      })
      return { ok: true, value: { ok: true, job: queued, jobs: [queued] } }
    }
    return { ok: true, value: { ok: true } }
  })
})

function editor(assetId = 'root', onClose = vi.fn()) {
  render(
    <MantineProvider>
      <StudioEditor assetId={assetId} onClose={onClose} />
    </MantineProvider>,
  )
  return onClose
}

const media = () => screen.getByTestId('studio-ed-media')

describe('StudioEditor', () => {
  it('lists the versions and steps through them with the arrow keys', () => {
    editor()
    expect(screen.getAllByTestId('studio-ed-version').map((v) => v.dataset.id)).toEqual([
      'root',
      'child',
    ])
    expect(media().dataset.id).toBe('root')
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(media().dataset.id).toBe('child')
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(media().dataset.id).toBe('child')
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(media().dataset.id).toBe('root')
  })

  it('holds Space to show the parent version', () => {
    editor('child')
    fireEvent.keyDown(window, { key: ' ' })
    expect(media().dataset.id).toBe('root')
    expect(screen.getByTestId('studio-ed-parent-label')).toHaveTextContent('Parent version')
    fireEvent.keyUp(window, { key: ' ' })
    expect(media().dataset.id).toBe('child')
  })

  it('asks for segments; a picked one scopes the next Qwen edit', async () => {
    editor()
    await waitFor(() => expect(ops).toContainEqual({ kind: 'segment', asset: 'root' }))
    expect(screen.getAllByTestId('studio-ed-seg-skeleton').length).toBeGreaterThan(0)
    act(() => applyStudioChange({ kind: 'segments', segments: SEGMENTS }))
    fireEvent.click(screen.getByTestId('studio-ed-seg'))
    expect(screen.getByTestId('studio-ed-editing-only')).toHaveTextContent('Editing only: Subject')
    expect(screen.getByTestId('studio-ed-mask')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('studio-ed-prompt'), { target: { value: 'Make it red' } })
    fireEvent.keyDown(screen.getByTestId('studio-ed-prompt'), { key: 'Enter' })
    await waitFor(() => expect(created()).toHaveLength(1))
    expect(created()[0]).toEqual({
      kind: 'create',
      spec: {
        mode: 'image',
        backend: 'comfyui',
        model: 'qwen-edit',
        prompt: 'Make it red',
        aspect: '9:16',
        resolution: '1mp',
        refs: ['root'],
        mask: 'seg-1',
      },
      project: 'p1',
      parent: { asset: 'root', how: 'edit' },
    })
    await waitFor(() =>
      expect(screen.getByTestId('studio-ed-overlay')).toHaveTextContent('Waiting in the GPU queue'),
    )
    expect(screen.queryByTestId('studio-ed-editing-only')).toBeNull()
    expect(screen.getByTestId('studio-ed-relight')).toBeDisabled()
  })

  it('shows progress in its own slot, keeps earlier versions previewable, then selects the new version when watched', () => {
    editor()
    const running = job('j-run', null, {
      state: 'running',
      progress: 0.42,
      parent: { asset: 'root', how: 'relight' },
      createdAt: 60,
    })
    act(() => applyStudioChange({ kind: 'job', job: running }))
    // The source stays clean and previewable; the pending job is its own slot in the strip.
    expect(screen.queryByTestId('studio-ed-overlay')).toBeNull()
    expect(media().dataset.id).toBe('root')
    expect(screen.getAllByTestId('studio-ed-pending')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('studio-ed-pending'))
    expect(screen.getByTestId('studio-ed-overlay')).toHaveTextContent('Generating 42%')
    fireEvent.click(screen.getAllByTestId('studio-ed-version')[0]!)
    expect(screen.queryByTestId('studio-ed-overlay')).toBeNull()
    fireEvent.click(screen.getByTestId('studio-ed-pending'))
    act(() =>
      applyStudioChange({
        kind: 'job',
        job: { ...running, state: 'done', progress: 1, outputs: [asset('made', 60)] },
      }),
    )
    expect(media().dataset.id).toBe('made')
    expect(screen.getAllByTestId('studio-ed-version')).toHaveLength(3)
    expect(screen.queryByTestId('studio-ed-overlay')).toBeNull()
  })

  it('cancels the pending job from its slot', async () => {
    editor()
    const running = job('j-run', null, {
      state: 'running',
      progress: 0.3,
      parent: { asset: 'root', how: 'relight' },
      createdAt: 60,
    })
    act(() => applyStudioChange({ kind: 'job', job: running }))
    fireEvent.click(screen.getByTestId('studio-ed-pending'))
    fireEvent.click(screen.getByTestId('studio-ed-cancel'))
    await waitFor(() => expect(ops).toContainEqual({ kind: 'cancel', id: 'j-run' }))
  })

  it('does not pull Isaac off an earlier version when the pending one lands', () => {
    editor()
    const running = job('j-run', null, {
      state: 'running',
      progress: 0.5,
      parent: { asset: 'root', how: 'relight' },
      createdAt: 60,
    })
    act(() => applyStudioChange({ kind: 'job', job: running }))
    act(() =>
      applyStudioChange({
        kind: 'job',
        job: { ...running, state: 'done', progress: 1, outputs: [asset('made', 60)] },
      }),
    )
    expect(media().dataset.id).toBe('root')
    expect(screen.getAllByTestId('studio-ed-version')).toHaveLength(3)
  })

  it('relight sends the picked direction', async () => {
    editor()
    fireEvent.click(screen.getByTestId('studio-ed-dir-bottom-right'))
    fireEvent.click(screen.getByTestId('studio-ed-relight'))
    await waitFor(() => expect(created()).toHaveLength(1))
    expect(created()[0]).toMatchObject({
      spec: { model: 'relight', params: { direction: 'bottom-right' }, refs: ['root'] },
      parent: { asset: 'root', how: 'relight' },
    })
  })

  it('locks editing on a video version', () => {
    const video = job('j-vid', asset('vid', 3, 'video'), {
      parent: { asset: 'root', how: 'video' },
      spec: { ...ROOT.spec, mode: 'video', backend: 'ltx', model: undefined },
    })
    studioStore.setState((s) => ({ view: { ...s.view, jobs: [video, ...s.view.jobs] } }))
    editor('vid')
    expect(media().tagName).toBe('VIDEO')
    expect(screen.getByTestId('studio-ed-prompt')).toBeDisabled()
    expect(screen.getByTestId('studio-ed-crop-start')).toBeDisabled()
    const strip = screen.getByTestId('studio-ed-strip')
    expect(within(strip).getAllByTestId('studio-ed-version')).toHaveLength(3)
  })

  it('delete confirms, then trashes the version and steps to a neighbour', async () => {
    const onClose = editor('child')
    fireEvent.click(screen.getByTestId('studio-ed-delete'))
    const modal = localStore.getState().modal
    expect(modal).toMatchObject({ kind: 'confirm', title: 'Delete 1 image?' })
    expect(ops.filter((op) => op.kind === 'trash')).toEqual([])
    act(() => {
      if (modal?.kind === 'confirm') modal.onConfirm()
    })
    expect(media().dataset.id).toBe('root')
    await waitFor(() => expect(ops).toContainEqual({ kind: 'trash', assets: ['child'] }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('deleting the original takes every version made from it and leaves the editor', async () => {
    const onClose = editor('root')
    fireEvent.click(screen.getByTestId('studio-ed-delete'))
    const modal = localStore.getState().modal
    expect(modal).toMatchObject({ kind: 'confirm', title: 'Delete 2 images?' })
    act(() => {
      if (modal?.kind === 'confirm') modal.onConfirm()
    })
    await waitFor(() => expect(ops).toContainEqual({ kind: 'trash', assets: ['root', 'child'] }))
    expect(onClose).toHaveBeenCalled()
  })

  it('Escape goes back to the grid', () => {
    const onClose = editor()
    act(() => void dismissTop())
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
