import { describe, expect, it } from 'vitest'
import { EVENT_CHANNELS, INVOKE_CHANNELS } from './index'
import {
  STUDIO_PATH_RE,
  StudioChangeSchema,
  StudioOpSchema,
  StudioPageOpSchema,
  StudioSpecSchema,
  studioEtaLabel,
  studioFrameSlots,
  studioInvoke,
  studioJobActive,
  studioRemixSpec,
  studioResolutions,
  studioSeconds,
  studioWithJob,
  studioWithout,
  type StudioBackend,
  type StudioJob,
  type StudioState,
} from './studio'

const SPEC = {
  mode: 'video' as const,
  backend: 'higgsfield' as const,
  prompt: 'A kite over dunes',
  aspect: '16:9' as const,
  resolution: '720p',
  seconds: 5,
  model: 'kling-2-5',
  confirmCredits: 40,
}
const job = (id: string, createdAt: number, extra: Partial<StudioJob> = {}): StudioJob => ({
  id,
  spec: SPEC,
  state: 'done',
  origin: 'desktop',
  createdAt,
  progress: 1,
  outputs: [],
  ...extra,
})
const HIGGSFIELD: StudioBackend = {
  id: 'higgsfield',
  label: 'Higgsfield (paid)',
  mode: 'video',
  paid: true,
  available: true,
  resolutions: [{ id: 'base', label: 'Base', aspect: '16:9' }],
  seconds: [4],
  frames: [],
  refs: 0,
  seed: true,
  serial: false,
  balance: 500,
  models: [
    {
      id: 'kling-2-5',
      name: 'Kling 2.5',
      mode: 'video',
      resolutions: [
        { id: '720p', label: '720p', aspect: '16:9' },
        { id: '720p', label: '720p', aspect: '9:16' },
      ],
      seconds: [5, 10],
      frames: ['start', 'end'],
    },
  ],
}

describe('studio schemas', () => {
  it('take a spec, and refuse an empty prompt or too many references', () => {
    expect(StudioSpecSchema.parse({ ...SPEC, prompt: '  A kite  ' }).prompt).toBe('A kite')
    expect(StudioSpecSchema.safeParse({ ...SPEC, prompt: ' ' }).success).toBe(false)
    expect(StudioSpecSchema.safeParse({ ...SPEC, refs: ['a', 'b', 'c', 'd', 'e'] }).success).toBe(
      false,
    )
  })

  it('wire ops name an origin; page ops never do', () => {
    expect(StudioOpSchema.safeParse({ kind: 'create', spec: SPEC }).success).toBe(false)
    expect(StudioOpSchema.safeParse({ kind: 'create', spec: SPEC, origin: 'agent' }).success).toBe(
      true,
    )
    expect(StudioPageOpSchema.parse({ kind: 'create', spec: SPEC, origin: 'agent' })).toEqual({
      kind: 'create',
      spec: SPEC,
    })
    expect(
      StudioPageOpSchema.safeParse({
        kind: 'upload',
        image: { mimeType: 'image/gif', data: 'R0lG' },
      }).success,
    ).toBe(false)
    expect(StudioPageOpSchema.safeParse({ kind: 'frame', asset: 'a1', at: 'last' }).success).toBe(
      true,
    )
  })

  it('serves only Studio paths for download', () => {
    expect(STUDIO_PATH_RE.test('/studio/a1/tok')).toBe(true)
    expect(STUDIO_PATH_RE.test('/studio/a1/tok/thumb')).toBe(true)
    expect(STUDIO_PATH_RE.test('/studio/a1/tok/../../x')).toBe(false)
    expect(STUDIO_PATH_RE.test('/drops/a1/tok')).toBe(false)
    expect(
      studioInvoke['studio.download'].input.safeParse({ path: '/etc/passwd', name: 'x' }).success,
    ).toBe(false)
  })

  it('register their channels', () => {
    expect(INVOKE_CHANNELS).toEqual(
      expect.arrayContaining(['studio.state', 'studio.req', 'studio.download']),
    )
    expect(EVENT_CHANNELS).toContain('studio.changed')
    expect(StudioChangeSchema.safeParse({ kind: 'status', up: true }).success).toBe(true)
  })
})

describe('studio helpers', () => {
  it('tell active jobs, and remix without the paid confirmation but with the seed it ran', () => {
    expect(studioJobActive(job('a', 1, { state: 'queued' }))).toBe(true)
    expect(studioJobActive(job('a', 1, { state: 'failed' }))).toBe(false)
    const remix = studioRemixSpec(job('a', 1, { seed: 77 }))
    expect(remix).not.toHaveProperty('confirmCredits')
    expect(remix.seed).toBe(77)
    expect(studioRemixSpec(job('a', 1, { spec: { ...SPEC, seed: 3 }, seed: 77 })).seed).toBe(3)
  })

  it('say how long is left', () => {
    expect(studioEtaLabel(undefined)).toBeUndefined()
    expect(studioEtaLabel(2000)).toBe('almost done')
    expect(studioEtaLabel(38_000)).toBe('about 40 s left')
    expect(studioEtaLabel(185_000)).toBe('about 3 min left')
  })

  it('list resolutions, lengths and keyframes of a backend or its model', () => {
    expect(studioResolutions(HIGGSFIELD, '16:9').map((r) => r.id)).toEqual(['base'])
    expect(studioResolutions(HIGGSFIELD, '9:16', 'kling-2-5').map((r) => r.id)).toEqual(['720p'])
    expect(studioResolutions(HIGGSFIELD, '1:1', 'kling-2-5')).toEqual([])
    expect(studioResolutions(HIGGSFIELD, '16:9', 'nope')).toEqual([])
    expect(studioSeconds(HIGGSFIELD)).toEqual([4])
    expect(studioSeconds(HIGGSFIELD, 'kling-2-5')).toEqual([5, 10])
    expect(studioFrameSlots(HIGGSFIELD, 'kling-2-5')).toEqual(['start', 'end'])
  })

  it('apply a job change in place or newest first, and a removal', () => {
    const state: StudioState = {
      jobs: [job('b', 2), job('a', 1)],
      uploads: [],
      backends: [],
      projects: [],
      references: [],
    }
    const progressed = studioWithJob(state, job('a', 1, { state: 'running', progress: 0.5 }))
    expect(progressed.jobs.map((j) => [j.id, j.state])).toEqual([
      ['b', 'done'],
      ['a', 'running'],
    ])
    expect(studioWithJob(state, job('c', 3)).jobs.map((j) => j.id)).toEqual(['c', 'b', 'a'])
    expect(studioWithout(state, 'b').jobs.map((j) => j.id)).toEqual(['a'])
  })
})
