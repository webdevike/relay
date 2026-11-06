import { describe, expect, it } from 'vitest'
import {
  INITIAL_FORM,
  formBackend,
  formFromDraft,
  formProblem,
  formSpec,
  formWithAsset,
  decodeEntryKey,
  defaultEntry,
  entryKey,
  formEntryKey,
  selectEntry,
  settleForm,
  settleStudio,
  studioEntries,
  studioPresets,
  studioTab,
  tabChoice,
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

  describe('model picker', () => {
    const labels = (backends = BACKENDS): string[] => studioEntries(backends).map((e) => e.label)

    it('lists every model in Local, ChatGPT, Paid order, images before video, ComfyUI left out', () => {
      expect(labels()).toEqual([
        'MOSS-Image',
        'Jib Mix Moss',
        'FLUX Kontext',
        'LTX video',
        'Codex image',
        'Codex edit',
        'Soul',
        'Kling 2.5',
      ])
      expect(studioEntries(BACKENDS).map((e) => e.group)).toEqual([
        'Local',
        'Local',
        'Local',
        'Local',
        'ChatGPT',
        'ChatGPT',
        'Paid',
        'Paid',
      ])
      expect(studioEntries(BACKENDS).find((e) => e.label === 'Soul')).toMatchObject({
        backend: 'higgsfield',
        model: 'soul',
        mode: 'image',
        paid: true,
      })
    })

    it('shows an unavailable backend as one disabled entry with its reason', () => {
      const down = BACKENDS.map((b) =>
        b.id === 'moss' ? { ...b, available: false, reason: 'MLX is not installed' } : b,
      )
      const moss = studioEntries(down).find((e) => e.backend === 'moss')
      expect(moss).toMatchObject({
        model: null,
        label: 'MOSS-Image',
        available: false,
        reason: 'MLX is not installed',
      })
      expect(studioEntries(down).filter((e) => e.backend === 'moss')).toHaveLength(1)
      expect(defaultEntry(studioEntries(down))?.label).toBe('FLUX Kontext')
    })

    it('picks the first available free entry as the default', () => {
      expect(defaultEntry(studioEntries(BACKENDS))).toMatchObject({
        backend: 'moss',
        model: 'moss-image',
      })
      expect(defaultEntry(studioEntries(BACKENDS.filter((b) => b.paid)))?.backend).toBe(
        'higgsfield',
      )
      expect(settleStudio(INITIAL_FORM, BACKENDS)).toMatchObject({
        mode: 'image',
        backend: 'moss',
        model: 'moss-image',
        resolution: '1344x768',
      })
      expect(
        settleStudio({ ...INITIAL_FORM, backend: 'ltx', mode: 'video' }, BACKENDS),
      ).toMatchObject({ backend: 'ltx', model: null })
    })

    it('encodes an entry as backend and model, even when the model id has the separator', () => {
      expect(decodeEntryKey(entryKey('ltx', null))).toEqual({ backend: 'ltx', model: null })
      expect(decodeEntryKey(entryKey('moss', 'a|b'))).toEqual({ backend: 'moss', model: 'a|b' })
    })

    it('chooses mode, backend and model together, clearing the model of a model-less backend', () => {
      const entries = studioEntries(BACKENDS)
      const pick = (label: string) => entries.find((e) => e.label === label)!
      const jib = selectEntry(settled({ prompt: 'x' }), BACKENDS, pick('Jib Mix Moss'))
      expect(jib).toMatchObject({ backend: 'moss', model: 'Jib_Mix_Moss_V2_H_int8', mode: 'image' })
      const ltx = selectEntry(jib, BACKENDS, pick('LTX video'))
      expect(ltx).toMatchObject({ mode: 'video', backend: 'ltx', model: null, seconds: 3 })
      const soul = selectEntry(ltx, BACKENDS, pick('Soul'))
      expect(soul).toMatchObject({
        mode: 'image',
        backend: 'higgsfield',
        model: 'soul',
        seconds: null,
      })
      expect(formBackend(soul, BACKENDS)?.id).toBe('higgsfield')
      expect(formEntryKey(soul, BACKENDS)).toBe('higgsfield|soul')
      expect(selectEntry(soul, BACKENDS, pick('Codex image'))).toMatchObject({
        backend: 'codex-image',
        model: null,
      })
    })

    it('derives the tab from the backend', () => {
      expect(studioTab({ backend: 'comfyui' })).toBe('comfyui')
      expect(studioTab({ backend: 'comfyui-video' })).toBe('comfyui')
      expect(studioTab({ backend: 'moss' })).toBe('models')
      expect(studioTab({ backend: null })).toBe('models')
    })

    it('offers ComfyUI presets together, and says why when there are none', () => {
      const video = {
        ...BACKENDS.find((b) => b.id === 'comfyui')!,
        id: 'comfyui-video' as const,
        mode: 'video' as const,
        models: [
          {
            id: 'animate',
            name: 'Animate',
            mode: 'video' as const,
            resolutions: [],
            seconds: [],
            frames: [],
          },
        ],
      }
      const both = [...BACKENDS, video]
      expect(studioPresets(both).presets.map((p) => p.label)).toEqual([
        'Angles',
        'Upscale',
        'Animate',
      ])
      const comfy = studioPresets(both).presets.find((p) => p.label === 'Animate')!
      expect(selectEntry(settled({}), both, comfy)).toMatchObject({
        mode: 'video',
        backend: 'comfyui-video',
        model: 'animate',
      })
      const none = BACKENDS.map((b) =>
        b.id === 'comfyui' ? { ...b, available: false, reason: 'ComfyUI is not running' } : b,
      )
      expect(studioPresets(none)).toEqual({ presets: [], reason: 'ComfyUI is not running' })
      expect(studioPresets(BACKENDS.filter((b) => b.id !== 'comfyui')).reason).toBe(
        'ComfyUI has no presets on this host.',
      )
    })

    it('returns to the last choice made on a tab while it is offered, else the default', () => {
      expect(tabChoice('models', BACKENDS, 'kontext')?.backend).toBe('kontext')
      expect(tabChoice('models', BACKENDS, 'gone')?.key).toBe('moss|moss-image')
      expect(tabChoice('models', BACKENDS, null)?.key).toBe('moss|moss-image')
      expect(tabChoice('comfyui', BACKENDS, 'comfyui|upscale')?.model).toBe('upscale')
      expect(tabChoice('comfyui', BACKENDS, 'models-key')?.model).toBe('angles')
      expect(
        tabChoice(
          'comfyui',
          BACKENDS.filter((b) => b.id !== 'comfyui'),
          null,
        ),
      ).toBeNull()
    })
  })
})
