import { describe, expect, it } from 'vitest'
import {
  INITIAL_FORM,
  formBackend,
  formFromDraft,
  formProblem,
  formSpec,
  formWithAsset,
  settleForm,
  type StudioForm,
} from './studio-form'
import { BACKENDS } from './studio-test-data'

const settled = (patch: Partial<StudioForm>): StudioForm =>
  settleForm({ ...INITIAL_FORM, ...patch }, BACKENDS)
const problem = (form: StudioForm): string | null => formProblem(form, formBackend(form, BACKENDS))

describe('studio form', () => {
  it('settles on a free backend of the mode, a resolution for the aspect and a length', () => {
    expect(settled({})).toMatchObject({ backend: 'codex-image', resolution: '1536x1024' })
    expect(settled({ mode: 'video' })).toMatchObject({
      backend: 'ltx',
      resolution: '768x432',
      seconds: 3,
    })
    expect(settled({ mode: 'video', backend: 'codex-image' }).backend).toBe('ltx')
    expect(settled({ mode: 'video', backend: 'higgsfield', aspect: '9:16' })).toMatchObject({
      model: 'kling-2-5',
      resolution: '720p',
      seconds: 5,
    })
    expect(settled({ mode: 'video', aspect: '1:1' }).resolution).toBeNull()
    expect(settleForm(INITIAL_FORM, [])).toMatchObject({ backend: null, resolution: null })
  })

  it('says why Generate waits', () => {
    expect(problem(settled({}))).toBe('Write a prompt first.')
    expect(problem(settled({ prompt: 'x' }))).toBeNull()
    expect(problem(settled({ prompt: 'x', mode: 'video', frames: { start: 'a1' } }))).toBe(
      'Local video needs both a start and an end frame, or neither.',
    )
    expect(
      problem(settled({ prompt: 'x', mode: 'video', frames: { start: 'a', mid: 'b', end: 'c' } })),
    ).toBeNull()
    expect(
      problem(settled({ prompt: 'x', mode: 'video', backend: 'higgsfield', frames: { mid: 'b' } })),
    ).toBeNull()
    expect(problem(settled({ prompt: 'x', backend: 'codex-edit' }))).toBe(
      'Add a reference image to edit.',
    )
    expect(problem(settled({ prompt: 'x', mode: 'video', aspect: '1:1' }))).toBe(
      'Pick a resolution.',
    )
    const down = BACKENDS.map((b) => ({ ...b, available: false, reason: 'Codex is signed out' }))
    const form = settleForm({ ...INITIAL_FORM, prompt: 'x' }, down)
    expect(formProblem(form, formBackend(form, down))).toBe('Codex is signed out')
  })

  it('sends only what the backend takes', () => {
    const video = settled({
      prompt: ' Waves ',
      mode: 'video',
      seed: 7,
      frames: { start: 'a', end: 'b' },
      refs: ['r'],
    })
    expect(formSpec(video, formBackend(video, BACKENDS)!)).toEqual({
      mode: 'video',
      backend: 'ltx',
      prompt: 'Waves',
      aspect: '16:9',
      resolution: '768x432',
      seconds: 3,
      seed: 7,
      frames: { start: 'a', end: 'b' },
    })
    const image = settled({ prompt: 'x', seed: 7, frames: { start: 'a' } })
    expect(formSpec(image, formBackend(image, BACKENDS)!)).toEqual({
      mode: 'image',
      backend: 'codex-image',
      prompt: 'x',
      aspect: '16:9',
      resolution: '1536x1024',
    })
    const edit = settled({ prompt: 'x', backend: 'codex-edit', refs: ['a', 'b', 'c'] })
    expect(formSpec(edit, formBackend(edit, BACKENDS)!).refs).toEqual(['a', 'b'])
  })

  it('fills from a remix or a draft, keeping what the draft leaves out', () => {
    const before = settled({ prompt: 'old', seed: 3, refs: ['r'] })
    expect(formFromDraft(before, { prompt: 'new' })).toMatchObject({
      prompt: 'new',
      seed: null,
      refs: ['r'],
    })
    expect(formFromDraft(before, { backend: 'ltx', mode: 'video' })).toMatchObject({
      prompt: 'old',
      backend: 'ltx',
      refs: [],
    })
  })

  it('uses an asset as a keyframe or reference, switching to a backend that takes it', () => {
    const image = settled({ prompt: 'x' })
    expect(formWithAsset(image, BACKENDS, 'a1', 'start')).toMatchObject({
      mode: 'video',
      backend: 'ltx',
      frames: { start: 'a1' },
    })
    const edit = formWithAsset(image, BACKENDS, 'a1', 'ref')
    expect(edit).toMatchObject({ mode: 'image', backend: 'codex-edit', refs: ['a1'] })
    expect(
      formWithAsset(formWithAsset(edit, BACKENDS, 'a2', 'ref'), BACKENDS, 'a3', 'ref').refs,
    ).toEqual(['a2', 'a3'])
  })

  it('runs a preset: its references, its settings, and its name as the prompt when it takes none', () => {
    const angles = settled({ backend: 'comfyui', model: 'angles', params: { angle: 'top' } })
    const backend = formBackend(angles, BACKENDS)!
    expect(problem({ ...angles, prompt: 'x' })).toBe('Add a reference image to edit.')
    const ready = { ...angles, prompt: 'keep the logo', refs: ['a1', 'a2'] }
    expect(problem(ready)).toBeNull()
    expect(formSpec(ready, backend)).toMatchObject({
      backend: 'comfyui',
      model: 'angles',
      refs: ['a1'],
      params: { angle: 'top' },
      resolution: '1mp',
    })
    const upscale = settleForm({ ...ready, model: 'upscale', prompt: '' }, BACKENDS)
    expect(upscale.params).toEqual({})
    expect(problem(upscale)).toBeNull()
    expect(formSpec({ ...upscale, params: { scale: 4 } }, backend)).toMatchObject({
      prompt: 'Upscale',
      model: 'upscale',
      params: { scale: 4 },
    })
    expect(formSpec(upscale, backend).params).toBeUndefined()
  })
})
