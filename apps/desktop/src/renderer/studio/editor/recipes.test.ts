import { describe, expect, it } from 'vitest'
import type { StudioAsset, StudioBackend, StudioItem, StudioJob } from '@evaos/contract'
import {
  angleRecipe,
  clampCrop,
  closestAspect,
  combineRecipe,
  cropRecipe,
  cutoutRecipe,
  dragCrop,
  editRecipe,
  regenerateRecipe,
  relightRecipe,
  upscaleRecipe,
  upscaleSize,
  videoRecipe,
  type Recipe,
} from './recipes'

const each = (id: string) =>
  (['1:1', '16:9', '9:16'] as const).map((aspect) => ({ id, label: id, aspect }))
const base = { paid: false, available: true, seconds: [], frames: [], seed: true, serial: true }
const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  mode: 'image' as const,
  resolutions: each('1mp'),
  seconds: [],
  frames: [],
  ...extra,
})

const BACKENDS: StudioBackend[] = [
  {
    ...base,
    id: 'comfyui',
    label: 'ComfyUI',
    mode: 'image',
    resolutions: [],
    refs: 4,
    models: [
      model('qwen-edit'),
      model('combine'),
      model('relight'),
      model('angles'),
      model('upscale', {
        name: 'Upscale (SeedVR2)',
        resolutions: each('auto'),
        inputs: [
          {
            kind: 'choice',
            id: 'size',
            label: 'Short side',
            default: '2048',
            options: ['2880', '1536', '2048', '3072', '4096', '6144'].map((id) => ({
              id,
              label: `${id} px`,
            })),
          },
        ],
      }),
    ],
  },
  {
    ...base,
    id: 'kontext',
    label: 'FLUX Kontext',
    mode: 'image',
    refs: 1,
    resolutions: [
      { id: '1024x576', label: 'Wide', aspect: '16:9' },
      { id: '576x1024', label: 'Tall', aspect: '9:16' },
      { id: '1024x1024', label: 'Square', aspect: '1:1' },
    ],
  },
  {
    ...base,
    id: 'codex-edit',
    label: 'Codex edit',
    mode: 'image',
    refs: 4,
    seed: false,
    serial: false,
    resolutions: [
      { id: '1088x1920', label: '1080p', aspect: '9:16' },
      { id: '1920x1088', label: '1080p', aspect: '16:9' },
      { id: '1024x1024', label: 'Square', aspect: '1:1' },
    ],
  },
  {
    ...base,
    id: 'sam',
    label: 'SAM 2.1',
    mode: 'image',
    refs: 1,
    resolutions: [],
    models: [model('cutout', { resolutions: each('source') })],
  },
  {
    ...base,
    id: 'crop',
    label: 'Crop',
    mode: 'image',
    refs: 1,
    serial: false,
    resolutions: [],
    models: [model('crop', { resolutions: each('source') })],
  },
  {
    ...base,
    id: 'ltx',
    label: 'LTX video',
    mode: 'video',
    refs: 0,
    seconds: [2, 3, 4, 5, 6, 8],
    frames: ['start', 'mid', 'end'],
    resolutions: [
      { id: '480x848', label: '480p', aspect: '9:16' },
      { id: '848x480', label: '480p', aspect: '16:9' },
      { id: '512x512', label: 'Square', aspect: '1:1' },
    ],
  },
  {
    ...base,
    id: 'moss',
    label: 'MOSS-Image',
    mode: 'image',
    refs: 0,
    resolutions: [],
    models: [
      model('moss-image', { resolutions: [{ id: '768x1344', label: 'P', aspect: '9:16' }] }),
    ],
  },
  {
    ...base,
    id: 'higgsfield',
    label: 'Higgsfield',
    mode: 'image',
    paid: true,
    refs: 0,
    resolutions: [{ id: '720p', label: '720p', aspect: '9:16' }],
  },
]

function item(over: Partial<StudioJob> = {}, asset: Partial<StudioAsset> = {}): StudioItem {
  const output: StudioAsset = {
    id: 'cur',
    kind: 'image',
    mimeType: 'image/png',
    width: 768,
    height: 1344,
    size: 1,
    path: '/studio/cur/t',
    thumb: '/studio/cur/t/thumb',
    origin: 'output',
    createdAt: 1,
    ...asset,
  }
  const job: StudioJob = {
    id: 'job-cur',
    spec: {
      mode: 'image',
      backend: 'moss',
      model: 'moss-image',
      prompt: 'A red fox in snow',
      aspect: '9:16',
      resolution: '768x1344',
    },
    state: 'done',
    origin: 'desktop',
    createdAt: 1,
    progress: 1,
    seed: 77,
    outputs: [output],
    project: 'proj-1',
    ...over,
  }
  return { asset: output, job }
}

const CUR = item()
const op = (r: Recipe) => {
  if (!r.ok) throw new Error(r.problem)
  return r.op
}
const lineage = (how: string) => ({ count: 1, project: 'proj-1', parent: { asset: 'cur', how } })

describe('closestAspect', () => {
  it('picks the wire aspect nearest the shape', () => {
    expect(closestAspect(768, 1344)).toBe('9:16')
    expect(closestAspect(1344, 768)).toBe('16:9')
    expect(closestAspect(1024, 1024)).toBe('1:1')
    expect(closestAspect(1100, 1000)).toBe('1:1')
    expect(closestAspect(1600, 1000)).toBe('16:9')
    expect(closestAspect(1000, 1500)).toBe('9:16')
  })
})

describe('editRecipe', () => {
  it('Qwen is ComfyUI qwen-edit on the current version, resolution for its aspect', () => {
    expect(op(editRecipe(CUR, BACKENDS, { engine: 'qwen', prompt: ' Make it night ' }))).toEqual({
      spec: {
        mode: 'image',
        backend: 'comfyui',
        model: 'qwen-edit',
        prompt: 'Make it night',
        aspect: '9:16',
        resolution: '1mp',
        refs: ['cur'],
      },
      ...lineage('edit'),
    })
  })

  it('Kontext and Codex use their own backends and first resolution for the aspect', () => {
    const k = op(editRecipe(CUR, BACKENDS, { engine: 'kontext', prompt: 'x' }))
    expect(k.spec).toMatchObject({ backend: 'kontext', resolution: '576x1024', refs: ['cur'] })
    expect(k.spec.model).toBeUndefined()
    const c = op(editRecipe(CUR, BACKENDS, { engine: 'codex', prompt: 'x' }))
    expect(c.spec).toMatchObject({ backend: 'codex-edit', resolution: '1088x1920', refs: ['cur'] })
  })

  it('carries the picked segment as the mask', () => {
    const r = op(editRecipe(CUR, BACKENDS, { engine: 'qwen', prompt: 'red', mask: 'seg-2' }))
    expect(r.spec.mask).toBe('seg-2')
  })

  it('omits the project when the version has none', () => {
    const r = op(
      editRecipe(item({ project: undefined }), BACKENDS, { engine: 'qwen', prompt: 'x' }),
    )
    expect(r.project).toBeUndefined()
  })

  it('refuses without a prompt, a backend, or the preset', () => {
    expect(editRecipe(CUR, BACKENDS, { engine: 'qwen', prompt: '  ' }).ok).toBe(false)
    expect(editRecipe(CUR, [], { engine: 'kontext', prompt: 'x' })).toEqual({
      ok: false,
      problem: 'Not on this host',
    })
    const noQwen = BACKENDS.map((b) =>
      b.id === 'comfyui' ? { ...b, models: b.models?.filter((m) => m.id !== 'qwen-edit') } : b,
    )
    expect(editRecipe(CUR, noQwen, { engine: 'qwen', prompt: 'x' })).toEqual({
      ok: false,
      problem: 'qwen-edit is not installed',
    })
    const off = BACKENDS.map((b) =>
      b.id === 'kontext' ? { ...b, available: false, reason: 'Kontext weights missing' } : b,
    )
    expect(editRecipe(CUR, off, { engine: 'kontext', prompt: 'x' })).toEqual({
      ok: false,
      problem: 'Kontext weights missing',
    })
  })
})

describe('combineRecipe', () => {
  it('combines the current version with one more image', () => {
    expect(
      op(combineRecipe(CUR, BACKENDS, { prompt: 'Put them together', refs: ['ref-a', 'ref-b'] })),
    ).toEqual({
      spec: {
        mode: 'image',
        backend: 'comfyui',
        model: 'combine',
        prompt: 'Put them together',
        aspect: '9:16',
        resolution: '1mp',
        refs: ['cur', 'ref-a'],
      },
      ...lineage('combine'),
    })
  })

  it('needs another image and a prompt', () => {
    expect(combineRecipe(CUR, BACKENDS, { prompt: 'x', refs: ['cur'] }).ok).toBe(false)
    expect(combineRecipe(CUR, BACKENDS, { prompt: '', refs: ['a'] }).ok).toBe(false)
  })
})

describe('cutoutRecipe', () => {
  it('is SAM 2.1 cutout on the current version, with the mask when picked', () => {
    expect(op(cutoutRecipe(CUR, BACKENDS, { mask: 'seg-1' }))).toEqual({
      spec: {
        mode: 'image',
        backend: 'sam',
        model: 'cutout',
        prompt: 'Remove background',
        aspect: '9:16',
        resolution: 'source',
        refs: ['cur'],
        mask: 'seg-1',
      },
      ...lineage('cutout'),
    })
    expect(op(cutoutRecipe(CUR, BACKENDS)).spec.mask).toBeUndefined()
  })
})

describe('relightRecipe', () => {
  it('sends the direction id and the typed prompt or the default', () => {
    const r = op(relightRecipe(CUR, BACKENDS, { direction: 'top-left' }))
    expect(r.spec).toMatchObject({
      backend: 'comfyui',
      model: 'relight',
      params: { direction: 'top-left' },
      prompt: 'soft natural light',
      refs: ['cur'],
    })
    expect(r.parent).toEqual({ asset: 'cur', how: 'relight' })
    expect(
      op(relightRecipe(CUR, BACKENDS, { direction: 'bottom', prompt: 'neon' })).spec.prompt,
    ).toBe('neon')
  })
})

describe('angleRecipe', () => {
  it('sends the angle id and the typed prompt or the default', () => {
    const r = op(angleRecipe(CUR, BACKENDS, { angle: 'right45' }))
    expect(r.spec).toMatchObject({
      model: 'angles',
      params: { angle: 'right45' },
      prompt: 'same scene',
      refs: ['cur'],
    })
    expect(r.parent).toEqual({ asset: 'cur', how: 'angle' })
    expect(
      op(angleRecipe(CUR, BACKENDS, { angle: 'close', prompt: 'her face' })).spec,
    ).toMatchObject({
      params: { angle: 'close' },
      prompt: 'her face',
    })
  })
})

describe('upscale', () => {
  const comfy = BACKENDS[0]!
  it('picks the smallest short side at least factor x, else the largest', () => {
    expect(upscaleSize(comfy, 1024, 1024, 2)).toBe('2048')
    expect(upscaleSize(comfy, 1024, 1024, 4)).toBe('4096')
    expect(upscaleSize(comfy, 1536, 2048, 2)).toBe('3072')
    expect(upscaleSize(comfy, 1536, 2048, 4)).toBe('6144')
    expect(upscaleSize(comfy, 768, 1344, 2)).toBe('1536')
    expect(upscaleSize(comfy, 4096, 4096, 4)).toBe('6144')
    expect(upscaleSize(BACKENDS[1]!, 1024, 1024, 2)).toBeUndefined()
  })

  it('sends the size and the model name as the prompt', () => {
    expect(op(upscaleRecipe(CUR, BACKENDS, { factor: 4 }))).toEqual({
      spec: {
        mode: 'image',
        backend: 'comfyui',
        model: 'upscale',
        prompt: 'Upscale (SeedVR2)',
        aspect: '9:16',
        resolution: 'auto',
        refs: ['cur'],
        params: { size: '3072' },
      },
      ...lineage('upscale'),
    })
  })
})

describe('videoRecipe', () => {
  it('is LTX from the current version, optional end frame, chosen length', () => {
    expect(op(videoRecipe(CUR, BACKENDS, { seconds: 4 }))).toEqual({
      spec: {
        mode: 'video',
        backend: 'ltx',
        prompt: 'Subtle natural motion',
        aspect: '9:16',
        resolution: '480x848',
        frames: { start: 'cur' },
        seconds: 4,
      },
      ...lineage('video'),
    })
    const r = op(videoRecipe(CUR, BACKENDS, { seconds: 8, end: 'v2', prompt: 'She turns' }))
    expect(r.spec).toMatchObject({
      frames: { start: 'cur', end: 'v2' },
      seconds: 8,
      prompt: 'She turns',
    })
  })

  it('refuses a length the backend does not make', () => {
    expect(videoRecipe(CUR, BACKENDS, { seconds: 7 }).ok).toBe(false)
  })
})

describe('regenerateRecipe', () => {
  it('reuses the version job spec without its seed', () => {
    const cur = item({
      spec: { ...CUR.job.spec, seed: 12, params: { turbo: 'on' }, refs: ['old'], mask: 'm' },
    })
    expect(op(regenerateRecipe(cur, BACKENDS))).toEqual({
      spec: {
        mode: 'image',
        backend: 'moss',
        model: 'moss-image',
        prompt: 'A red fox in snow',
        aspect: '9:16',
        resolution: '768x1344',
        params: { turbo: 'on' },
        refs: ['old'],
        mask: 'm',
      },
      ...lineage('regenerate'),
    })
    expect(op(regenerateRecipe(CUR, BACKENDS)).spec.seed).toBeUndefined()
  })

  it('does not rerun paid jobs', () => {
    const paid = item({
      spec: { ...CUR.job.spec, backend: 'higgsfield', model: undefined, confirmCredits: 40 },
    })
    expect(regenerateRecipe(paid, BACKENDS).ok).toBe(false)
  })
})

describe('crop', () => {
  it('sends fractions inside the image', () => {
    expect(op(cropRecipe(CUR, BACKENDS, { x: 0.1, y: 0.2, w: 0.5, h: 0.6 }))).toEqual({
      spec: {
        mode: 'image',
        backend: 'crop',
        model: 'crop',
        prompt: 'Crop',
        aspect: '9:16',
        resolution: 'source',
        refs: ['cur'],
        params: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 },
      },
      ...lineage('crop'),
    })
  })

  it('clamps, rounds and never lets an edge pass the image', () => {
    expect(clampCrop({ x: -0.2, y: 0.9, w: 0.5, h: 0.5 })).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 })
    expect(clampCrop({ x: 0.5, y: 0.5, w: 0.001, h: 2 })).toEqual({ x: 0.5, y: 0, w: 0.05, h: 1 })
    for (let i = 0; i < 200; i++) {
      const r = clampCrop({ x: i / 199, y: 1 - i / 199, w: 1 / 3 + i / 1000, h: 2 / 3 })
      expect(r.x + r.w).toBeLessThanOrEqual(1)
      expect(r.y + r.h).toBeLessThanOrEqual(1)
      expect(r.w).toBeGreaterThanOrEqual(0.05)
    }
  })
})

describe('dragCrop', () => {
  const start = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }
  it('moves the box inside the image', () => {
    const r = dragCrop('move', start, 0.5, -0.5)
    expect(r.x).toBeCloseTo(0.2)
    expect(r).toMatchObject({ y: 0, w: 0.8, h: 0.8 })
  })

  it('resizes from a corner, keeping the opposite edges', () => {
    const r = dragCrop('nw', start, 0.2, 0.3)
    expect(r.x).toBeCloseTo(0.3)
    expect(r.y).toBeCloseTo(0.4)
    expect(r.x + r.w).toBeCloseTo(0.9)
    expect(r.y + r.h).toBeCloseTo(0.9)
    const se = dragCrop('se', start, 0.5, 0.5)
    expect(se.x + se.w).toBe(1)
    expect(se.y + se.h).toBe(1)
  })

  it('never gets smaller than the minimum', () => {
    const r = dragCrop('ne', start, -2, 2)
    expect(r.w).toBeCloseTo(0.05)
    expect(r.h).toBeCloseTo(0.05)
  })
})
