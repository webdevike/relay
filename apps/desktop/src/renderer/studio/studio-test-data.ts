import type { StudioBackend, StudioJob } from '@evaos/contract'

const res = (aspect: '16:9' | '9:16' | '1:1', id: string) => ({ id, label: id, aspect })
const IMAGE_RES = [res('16:9', '1536x1024'), res('9:16', '1024x1536'), res('1:1', '1024x1024')]

/** Studio's backends as the host lists them, for renderer tests. */
export const BACKENDS: StudioBackend[] = [
  {
    id: 'ltx',
    label: 'Local video (LTX, free)',
    mode: 'video',
    paid: false,
    available: true,
    resolutions: [res('16:9', '768x432'), res('9:16', '432x768')],
    seconds: [3, 5],
    frames: ['start', 'mid', 'end'],
    refs: 0,
    seed: true,
    serial: true,
  },
  {
    id: 'codex-image',
    label: 'Image (Codex, free)',
    mode: 'image',
    paid: false,
    available: true,
    resolutions: IMAGE_RES,
    seconds: [],
    frames: [],
    refs: 0,
    seed: false,
    serial: false,
  },
  {
    id: 'codex-edit',
    label: 'Image edit (Codex, free)',
    mode: 'image',
    paid: false,
    available: true,
    resolutions: IMAGE_RES,
    seconds: [],
    frames: [],
    refs: 2,
    seed: false,
    serial: false,
  },
  {
    id: 'higgsfield',
    label: 'Higgsfield (paid)',
    mode: 'video',
    paid: true,
    available: true,
    resolutions: [],
    seconds: [],
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
        resolutions: [res('16:9', '720p'), res('9:16', '720p')],
        seconds: [5, 10],
        frames: ['start', 'end'],
      },
    ],
  },
]

/** A finished image job with one output. */
export const DONE_JOB: StudioJob = {
  id: 'j1',
  spec: {
    mode: 'image',
    backend: 'codex-image',
    prompt: 'A paper boat',
    aspect: '16:9',
    resolution: '1536x1024',
  },
  state: 'done',
  origin: 'desktop',
  createdAt: 1,
  progress: 1,
  seed: 99,
  outputs: [
    {
      id: 'a1',
      kind: 'image',
      mimeType: 'image/png',
      width: 1536,
      height: 1024,
      size: 1000,
      path: '/studio/a1/tok',
      thumb: '/studio/a1/tok/thumb',
      origin: 'output',
      createdAt: 1,
    },
  ],
}
