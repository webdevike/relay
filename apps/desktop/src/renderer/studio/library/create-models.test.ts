import { describe, expect, it } from 'vitest'
import type { StudioBackend, StudioModel, StudioReference } from '@evaos/contract'
import { createChoices, refsUseKlein, routeCreate, type CreateChoice } from './create-models'

const one = (id: string) => [{ id, label: id, aspect: '1:1' as const }]
const model = (id: string, name: string, mode: 'image' | 'video' = 'image'): StudioModel => ({
  id,
  name,
  mode,
  resolutions: one('1mp'),
  seconds: [],
  frames: [],
})
const backend = (id: StudioBackend['id'], over: Partial<StudioBackend> = {}): StudioBackend => ({
  id,
  label: id,
  mode: 'image',
  paid: false,
  available: true,
  resolutions: one('1024x1024'),
  seconds: [],
  frames: [],
  refs: 0,
  seed: true,
  serial: true,
  ...over,
})

const BACKENDS: StudioBackend[] = [
  backend('moss', {
    resolutions: [],
    models: [
      {
        ...model('moss-image', 'MOSS-Image'),
        inputs: [
          { kind: 'number', id: 'steps', label: 'Steps', min: 1, max: 50, step: 1, default: 8 },
        ],
      },
      model('Jib_Mix', 'Jib Mix Moss'),
    ],
  }),
  backend('comfyui', {
    resolutions: [],
    refs: 4,
    models: [
      { ...model('klein-create', 'Create'), refs: 0 },
      model('klein-edit', 'FLUX.2 klein edit'),
      model('character', 'Character'),
      model('combine', 'Combine'),
      model('upscale', 'Upscale'),
    ],
  }),
  backend('codex-image', { seed: false }),
  backend('codex-edit', { seed: false, refs: 4 }),
  backend('higgsfield', {
    mode: 'video',
    paid: true,
    resolutions: [],
    models: [model('kling', 'Kling', 'video'), model('soul', 'Soul')],
  }),
]

const REFS: StudioReference[] = [
  {
    id: 'r1',
    kind: 'character',
    name: 'Mia',
    createdAt: 1,
    asset: {
      id: 'ref-asset',
      kind: 'image',
      mimeType: 'image/png',
      width: 1,
      height: 1,
      size: 1,
      path: '/studio/ref-asset/t',
      thumb: '/studio/ref-asset/t/thumb',
      origin: 'upload',
      createdAt: 1,
    },
  },
]

const choices = createChoices(BACKENDS)
const pick = (key: string): CreateChoice => choices.find((c) => c.key === key)!

describe('createChoices', () => {
  it('offers originals only: MOSS models, klein create, Codex image, paid image models', () => {
    expect(choices.map((c) => c.key)).toEqual([
      'moss:moss-image',
      'moss:Jib_Mix',
      'comfyui:klein-create',
      'codex-image',
      'higgsfield:soul',
    ])
    expect(pick('higgsfield:soul').paid).toBe(true)
  })

  it('labels a ComfyUI entry with where it runs, not the preset name alone ("Create")', () => {
    expect(pick('comfyui:klein-create').label).toBe('FLUX.2 Klein (ComfyUI)')
    const more = createChoices([
      backend('comfyui', {
        refs: 4,
        models: [{ ...model('poster', 'Poster'), refs: 0 }, model('relight', 'Relight')],
      }),
    ])
    expect(more.map((c) => [c.key, c.label])).toEqual([['comfyui:poster', 'Poster (ComfyUI)']])
  })
})

describe('routeCreate', () => {
  const base = { prompt: 'A lighthouse', aspect: '1:1' as const, refs: [] as string[] }

  it('makes the picked model with its first size, seed and steps', () => {
    expect(
      routeCreate({ ...base, choice: pick('moss:moss-image'), seed: 7, steps: 12 }, BACKENDS, REFS),
    ).toEqual({
      spec: {
        mode: 'image',
        backend: 'moss',
        model: 'moss-image',
        prompt: 'A lighthouse',
        aspect: '1:1',
        resolution: '1mp',
        seed: 7,
        params: { steps: 12 },
      },
    })
  })

  it('sends Codex image with refs to Codex edit, the library image as parent', () => {
    expect(
      routeCreate({ ...base, choice: pick('codex-image'), refs: ['a1'] }, BACKENDS, REFS),
    ).toEqual({
      spec: {
        mode: 'image',
        backend: 'codex-edit',
        prompt: 'A lighthouse',
        aspect: '1:1',
        resolution: '1024x1024',
        refs: ['a1'],
      },
      parent: { asset: 'a1', how: 'edit' },
    })
  })

  it('routes other models with refs to FLUX.2 klein presets', () => {
    const route = (refs: string[]) =>
      routeCreate({ ...base, choice: pick('moss:moss-image'), refs }, BACKENDS, REFS)
    expect(route(['ref-asset'])).toMatchObject({ spec: { backend: 'comfyui', model: 'character' } })
    expect(route(['ref-asset'])).not.toHaveProperty('parent')
    expect(route(['a1'])).toMatchObject({
      spec: { backend: 'comfyui', model: 'klein-edit', refs: ['a1'] },
      parent: { asset: 'a1', how: 'edit' },
    })
    expect(route(['a1', 'ref-asset'])).toMatchObject({
      spec: { model: 'combine' },
      parent: { asset: 'a1', how: 'combine' },
    })
    expect(route(['a1', 'a2', 'a3'])).toBe('FLUX.2 klein takes at most 2 references')
  })

  it('says why it cannot run', () => {
    expect(
      routeCreate({ ...base, prompt: '  ', choice: pick('codex-image') }, BACKENDS, REFS),
    ).toBe('Write a prompt first')
  })
})

describe('OpenRouter images', () => {
  const openrouter = backend('openrouter-image', {
    label: 'OpenRouter images',
    paid: true,
    unit: 'usd',
    refs: 4,
    resolutions: [],
    models: [
      {
        ...model('google/nano', 'Google: Nano'),
        refs: 4,
        minRefs: 0,
        description: 'About $0.0387 per image',
      },
      { ...model('acme/edit-only', 'Acme: Edit only'), refs: 2, minRefs: 1 },
      { ...model('acme/plain', 'Acme: Plain'), refs: 0 },
    ],
  })
  const list = createChoices([openrouter])
  const nano = list.find((c) => c.key === 'openrouter-image:google/nano')!
  const input = { choice: nano, prompt: 'make it night', aspect: '1:1' as const }

  it('lists the models that make an original, with their price line, not the edit-only one', () => {
    expect(list.map((c) => [c.key, c.note, c.group])).toEqual([
      ['openrouter-image:google/nano', 'About $0.0387 per image', 'Paid'],
      ['openrouter-image:acme/plain', 'Paid, priced before it runs', 'Paid'],
    ])
  })

  it('edits references with its own model (never FLUX.2 klein) and records them as an edit', () => {
    const routed = routeCreate({ ...input, refs: ['a1', 'a2'] }, [openrouter], [])
    expect(routed).toMatchObject({
      spec: { backend: 'openrouter-image', model: 'google/nano', refs: ['a1', 'a2'] },
      parent: { asset: 'a1', how: 'edit' },
    })
    expect(refsUseKlein(nano, ['a1'])).toBe(false)
  })

  it('stops at the references the model takes', () => {
    const plain = list.find((c) => c.model === 'acme/plain')!
    expect(routeCreate({ ...input, choice: plain, refs: ['a1'] }, [openrouter], [])).toBe(
      'Acme: Plain takes no reference images',
    )
    expect(routeCreate({ ...input, refs: ['a', 'b', 'c', 'd', 'e'] }, [openrouter], [])).toBe(
      'Google: Nano takes at most 4 reference images',
    )
  })
})
