// Studio: image and video generation on the Relay host, with a queue, a gallery and remix.
//
// The shapes mirror the host's wire protocol (relay `packages/protocol/src/studio.ts`, which this
// app does not import): the host runs every job, this app asks `studio.list` (answered by
// `studio.state`), hears `studio.job` for every change to a job, `studio.removed` for a deletion,
// and sends everything else as `studio.req {rid, op}`, answered by `studio.res` with that rid.
// Assets are served on the host's http port at `/studio/<id>/<token>` (plus `/thumb`); the page
// loads them through `relay-media://`.
//
// Paid jobs never run on their own: `create` on a paid backend carries `confirmCredits`, the quote
// Isaac confirmed in the page's confirm dialog for that one job. Agents never start paid jobs.
import { z } from 'zod'

const id = z.string().min(1).max(100)
const nonEmpty = z.string().min(1)

export const MAX_STUDIO_JOBS = 300
export const MAX_STUDIO_UPLOADS = 100
export const MAX_STUDIO_PROMPT = 4000
export const MAX_STUDIO_REFS = 4

export const StudioModeSchema = z.enum(['image', 'video'])
export type StudioMode = z.infer<typeof StudioModeSchema>

/** `ltx`: local LTX video. `codex-image` / `codex-edit`: images on the ChatGPT subscription. `kontext`: local FLUX Kontext image edit. `higgsfield`: paid. */
export const StudioBackendIdSchema = z.enum(['ltx', 'codex-image', 'codex-edit', 'kontext', 'higgsfield'])
export type StudioBackendId = z.infer<typeof StudioBackendIdSchema>

export const StudioAspectSchema = z.enum(['9:16', '16:9', '1:1'])
export type StudioAspect = z.infer<typeof StudioAspectSchema>
export const STUDIO_ASPECTS = StudioAspectSchema.options

export const StudioFrameSlotSchema = z.enum(['start', 'mid', 'end'])
export type StudioFrameSlot = z.infer<typeof StudioFrameSlotSchema>

/** A file the host keeps: a job's output or an uploaded reference frame. */
export const StudioAssetSchema = z.object({
  id,
  kind: StudioModeSchema,
  mimeType: nonEmpty,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationMs: z.number().optional(),
  /** Bytes on disk. */
  size: z.number().int().nonnegative(),
  /** `/studio/<id>/<token>`; the token is the only credential. */
  path: nonEmpty,
  /** `/studio/<id>/<token>/thumb`: JPEG, at most 640 px on the long side. */
  thumb: nonEmpty,
  origin: z.enum(['output', 'upload']),
  createdAt: z.number(),
})
export type StudioAsset = z.infer<typeof StudioAssetSchema>

/** A host path Studio serves: an asset or its thumbnail. */
export const STUDIO_PATH_RE = /^\/studio\/[^/]+\/[^/]+(\/thumb)?$/

const StudioFramesSchema = z.object({
  start: id.optional(),
  mid: id.optional(),
  end: id.optional(),
})

/** What to make. Asset ids in `frames` and `refs` name outputs or uploads. */
export const StudioSpecSchema = z.object({
  mode: StudioModeSchema,
  backend: StudioBackendIdSchema,
  prompt: z.string().trim().min(1).max(MAX_STUDIO_PROMPT),
  aspect: StudioAspectSchema,
  /** A `StudioResolution.id` of the backend (or of the Higgsfield model), e.g. `384x672`, `720p`. */
  resolution: z.string().min(1).max(40),
  /** Video length. */
  seconds: z.number().min(1).max(20).optional(),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
  /** Video keyframes (only the slots the backend lists). */
  frames: StudioFramesSchema.optional(),
  /** Reference images for an edit. */
  refs: z.array(id).max(MAX_STUDIO_REFS).optional(),
  /** Higgsfield model id. */
  model: z.string().min(1).max(100).optional(),
  /** Paid backends: the credits Isaac confirmed for this one job. */
  confirmCredits: z.number().nonnegative().optional(),
})
export type StudioSpec = z.infer<typeof StudioSpecSchema>

/**
 * A form to start from (agents' `studio.open` drafts, remixes): any part of a spec, never a paid
 * confirmation. The page fills what it can and leaves the rest to Isaac.
 */
export const StudioDraftSchema = StudioSpecSchema.omit({ confirmCredits: true })
  .extend({ prompt: z.string().max(MAX_STUDIO_PROMPT) })
  .partial()
  .strict()
export type StudioDraft = z.infer<typeof StudioDraftSchema>

export const StudioJobStateSchema = z.enum(['queued', 'running', 'done', 'failed', 'cancelled'])
export type StudioJobState = z.infer<typeof StudioJobStateSchema>

export const StudioOriginSchema = z.enum(['phone', 'desktop', 'agent'])
export type StudioOrigin = z.infer<typeof StudioOriginSchema>

export const StudioJobSchema = z.object({
  id,
  spec: StudioSpecSchema,
  state: StudioJobStateSchema,
  origin: StudioOriginSchema,
  createdAt: z.number(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  /** 0 to 1. */
  progress: z.number().min(0).max(1),
  /** Estimated time left while running (or until done, while queued). */
  etaMs: z.number().optional(),
  /** One short line: "Waiting for the GPU", "Uploading frames". */
  note: z.string().max(400).optional(),
  error: z.string().max(2000).optional(),
  /** The seed the job ran with (a random one when the spec had none). */
  seed: z.number().int().optional(),
  /** Credits a paid job was charged (its confirmed quote). */
  credits: z.number().nonnegative().optional(),
  outputs: z.array(StudioAssetSchema).max(8),
})
export type StudioJob = z.infer<typeof StudioJobSchema>

export const StudioResolutionSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(60),
  aspect: StudioAspectSchema,
})
export type StudioResolution = z.infer<typeof StudioResolutionSchema>

/** A model on a model-picking backend (Higgsfield). */
export const StudioModelSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(120),
  mode: StudioModeSchema,
  resolutions: z.array(StudioResolutionSchema).max(20),
  /** Allowed lengths in seconds (video). */
  seconds: z.array(z.number().positive()).max(20),
  frames: z.array(StudioFrameSlotSchema).max(3),
})
export type StudioModel = z.infer<typeof StudioModelSchema>

export const StudioBackendSchema = z.object({
  id: StudioBackendIdSchema,
  label: z.string().min(1).max(80),
  mode: StudioModeSchema,
  paid: z.boolean(),
  /** False when it cannot run on this host now; `reason` says why in one line. */
  available: z.boolean(),
  reason: z.string().max(400).optional(),
  resolutions: z.array(StudioResolutionSchema).max(30),
  /** Allowed lengths in seconds (video). */
  seconds: z.array(z.number().positive()).max(20),
  /** Keyframe slots it takes (video). */
  frames: z.array(StudioFrameSlotSchema).max(3),
  /** How many reference images it takes (edits); 0 for none. */
  refs: z.number().int().min(0).max(MAX_STUDIO_REFS),
  /** It honors `seed`. */
  seed: z.boolean(),
  /** Runs one job at a time (the GPU); others wait in line. */
  serial: z.boolean(),
  models: z.array(StudioModelSchema).max(200).optional(),
  /** Paid backends: credits left, when known. */
  balance: z.number().optional(),
})
export type StudioBackend = z.infer<typeof StudioBackendSchema>

export const StudioImageSchema = z.object({
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  data: z
    .string()
    .min(1)
    .max(6 * 1024 * 1024),
})
export type StudioImage = z.infer<typeof StudioImageSchema>

/** Every op but `create`, which differs between the wire (with `origin`) and this app's page. */
const StudioOtherOps = [
  /** Price a paid job without running it; answered with `credits` and `balance`. Free. */
  z.object({ kind: z.literal('quote'), spec: StudioSpecSchema }),
  /** Stop a queued or running job. */
  z.object({ kind: z.literal('cancel'), id }),
  /** Remove a finished job and its files, or an upload. */
  z.object({ kind: z.literal('delete'), id }),
  /** Keep an image from the device as a reference frame; answered with `asset`. */
  z.object({
    kind: z.literal('upload'),
    image: StudioImageSchema,
    name: z.string().max(200).optional(),
  }),
  /** A video's first or last frame as a new upload; answered with `asset`. */
  z.object({ kind: z.literal('frame'), asset: id, at: z.enum(['first', 'last']) }),
  /** Re-read backends (models, balance, availability); a new `studio.state` follows. */
  z.object({ kind: z.literal('refresh') }),
] as const

/** One `studio.req` op as the host takes it. */
export const StudioOpSchema = z.discriminatedUnion('kind', [
  /** Queue a job; answered with `job`. */
  z.object({ kind: z.literal('create'), spec: StudioSpecSchema, origin: StudioOriginSchema }),
  ...StudioOtherOps,
])
export type StudioOp = z.infer<typeof StudioOpSchema>

/** One op from the Studio page: a `create` is Isaac's own (main sends it as `desktop`). */
export const StudioPageOpSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), spec: StudioSpecSchema }),
  ...StudioOtherOps,
])
export type StudioPageOp = z.infer<typeof StudioPageOpSchema>

export const StudioStateSchema = z.object({
  /** Newest first. */
  jobs: z.array(StudioJobSchema).max(MAX_STUDIO_JOBS),
  /** Newest first. */
  uploads: z.array(StudioAssetSchema).max(MAX_STUDIO_UPLOADS),
  backends: z.array(StudioBackendSchema).max(10),
})
export type StudioState = z.infer<typeof StudioStateSchema>

/** The host's answer to one op (`studio.res` without its rid). */
export const StudioAnswerSchema = z.object({
  ok: z.boolean(),
  /** Why it was refused, one line for the UI. */
  error: z.string().max(2000).optional(),
  job: StudioJobSchema.optional(),
  asset: StudioAssetSchema.optional(),
  credits: z.number().nonnegative().optional(),
  balance: z.number().optional(),
})
export type StudioAnswer = z.infer<typeof StudioAnswerSchema>

/** What the page shows: the host's state as last heard, and whether an op can go out now. */
export const StudioViewSchema = StudioStateSchema.extend({
  /** Relay is connected, so an op can be sent. */
  up: z.boolean(),
  /** False until the host's first `studio.state` arrives. */
  loaded: z.boolean(),
})
export type StudioView = z.infer<typeof StudioViewSchema>

/** One change to the page's view: a whole state, one job, a deletion, or Relay up or down. */
export const StudioChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state'), state: StudioStateSchema }),
  z.object({ kind: z.literal('job'), job: StudioJobSchema }),
  z.object({ kind: z.literal('removed'), id: nonEmpty }),
  z.object({ kind: z.literal('status'), up: z.boolean() }),
])
export type StudioChange = z.infer<typeof StudioChangeSchema>

export const studioInvoke = {
  /** Studio's jobs, uploads and backends: asks the host now (and after every reconnect). */
  'studio.state': {
    input: z.object({}).strict(),
    output: StudioViewSchema,
  },
  /** Sends one op to the host as Isaac (a `create` goes out with origin `desktop`). */
  'studio.req': {
    input: z.object({ op: StudioPageOpSchema }).strict(),
    output: StudioAnswerSchema,
  },
  /** Saves an asset from the host into ~/Downloads and shows it in Finder; answers the file. */
  'studio.download': {
    input: z
      .object({ path: z.string().regex(STUDIO_PATH_RE).max(400), name: z.string().min(1).max(120) })
      .strict(),
    output: z.object({ file: z.string() }),
  },
} as const

export const studioEvents = {
  /** The host's Studio changed (or Relay came up or went down). */
  'studio.changed': StudioChangeSchema,
} as const

// ---------------------------------------------------------------------------------------------
// Shared helpers (same as the host's protocol module)
// ---------------------------------------------------------------------------------------------

export function studioJobActive(job: StudioJob): boolean {
  return job.state === 'queued' || job.state === 'running'
}

/** The form a remix starts from: the job's spec without the paid confirmation. */
export function studioRemixSpec(job: StudioJob): StudioSpec {
  const { confirmCredits: _confirmed, ...spec } = job.spec
  return job.seed !== undefined && spec.seed === undefined ? { ...spec, seed: job.seed } : spec
}

/** "about 3 min left", "about 40 s left"; undefined without an estimate. */
export function studioEtaLabel(etaMs: number | undefined): string | undefined {
  if (etaMs === undefined || !Number.isFinite(etaMs)) return undefined
  const s = Math.max(0, Math.round(etaMs / 1000))
  if (s < 5) return 'almost done'
  if (s < 90) return `about ${Math.ceil(s / 5) * 5} s left`
  return `about ${Math.round(s / 60)} min left`
}

/** Resolutions the spec's backend (or model) offers for an aspect. */
export function studioResolutions(
  backend: StudioBackend,
  aspect: StudioAspect,
  model?: string,
): StudioResolution[] {
  const list =
    model === undefined
      ? backend.resolutions
      : (backend.models?.find((m) => m.id === model)?.resolutions ?? [])
  return list.filter((r) => r.aspect === aspect)
}

/** Lengths the backend (or its model) allows, in seconds. */
export function studioSeconds(backend: StudioBackend, model?: string): number[] {
  return model === undefined
    ? backend.seconds
    : (backend.models?.find((m) => m.id === model)?.seconds ?? [])
}

/** Keyframe slots the backend (or its model) takes. */
export function studioFrameSlots(backend: StudioBackend, model?: string): StudioFrameSlot[] {
  return model === undefined
    ? backend.frames
    : (backend.models?.find((m) => m.id === model)?.frames ?? [])
}

/** The state after one `studio.job`: replaced in place, or added newest first. */
export function studioWithJob(state: StudioState, job: StudioJob): StudioState {
  const at = state.jobs.findIndex((j) => j.id === job.id)
  const jobs =
    at >= 0
      ? state.jobs.with(at, job)
      : [job, ...state.jobs].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_STUDIO_JOBS)
  return { ...state, jobs }
}

/** The state after one `studio.removed`: the job or upload `id` gone. */
export function studioWithout(state: StudioState, removed: string): StudioState {
  return {
    ...state,
    jobs: state.jobs.filter((j) => j.id !== removed),
    uploads: state.uploads.filter((u) => u.id !== removed),
  }
}
