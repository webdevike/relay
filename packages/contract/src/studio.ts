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

/** The library is kept: the host never evicts finished jobs. */
export const MAX_STUDIO_JOBS = 5000
export const MAX_STUDIO_UPLOADS = 100
export const MAX_STUDIO_PROMPT = 4000
export const MAX_STUDIO_REFS = 4
export const MAX_STUDIO_PARAMS = 8
/** At most this many images per `create` (each its own job). */
export const MAX_STUDIO_COUNT = 4
/** A trashed image can be restored for this long; then the host deletes every copy of it. */
export const STUDIO_UNDO_MS = 10 * 60_000
/** The project of every job that names none. */
export const STUDIO_UNSORTED = 'unsorted'
export const MAX_STUDIO_PROJECTS = 200
export const MAX_STUDIO_REFERENCES = 200
export const MAX_STUDIO_SEGMENTS = 24

export const StudioModeSchema = z.enum(['image', 'video'])
export type StudioMode = z.infer<typeof StudioModeSchema>

/**
 * `ltx`: local LTX video. `codex-image` / `codex-edit`: images on the ChatGPT subscription. `moss`: local MOSS-Image
 * (MLX) text to image, one model per checkpoint (MOSS-Image, Jib Mix Moss). `kontext`: local FLUX Kontext image edit.
 * `comfyui` / `comfyui-video`: presets (named ComfyUI workflows) on a ComfyUI server the host reaches. `higgsfield`: paid.
 */
export const StudioBackendIdSchema = z.enum([
  'ltx',
  'codex-image',
  'codex-edit',
  'moss',
  'kontext',
  'comfyui',
  'comfyui-video',
  'sam',
  'crop',
  'higgsfield',
])
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
  /** Isaac's favorite (outputs only). */
  favorite: z.boolean().optional(),
  /** Trashed at (outputs only): hidden, restorable for STUDIO_UNDO_MS, then deleted with every copy. */
  deletedAt: z.number().optional(),
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
  /** Higgsfield model id, or a ComfyUI preset id. */
  model: z.string().min(1).max(100).optional(),
  /** A preset's own inputs (`StudioModel.inputs`): a choice's option id or a number, by input id. */
  params: z
    .record(z.string().min(1).max(40), z.union([z.string().max(200), z.number().finite()]))
    .refine(
      (params) => Object.keys(params).length <= MAX_STUDIO_PARAMS,
      `At most ${MAX_STUDIO_PARAMS} params`,
    )
    .optional(),
  /** Paid backends: the credits Isaac confirmed for this one job. */
  confirmCredits: z.number().nonnegative().optional(),
  /** An edit scoped to one SAM 2.1 segment (a `StudioSegment.id`): the host composites inside that mask only. */
  mask: id.optional(),
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

/** How a version was made from its parent, for lineage labels. */
export const StudioHowSchema = z.enum([
  'vary',
  'edit',
  'upscale',
  'video',
  'relight',
  'angle',
  'character',
  'combine',
  'cutout',
  'crop',
  'regenerate',
])
export type StudioHow = z.infer<typeof StudioHowSchema>

/** Where a job came from: the output image (asset id) it was made from, and how. */
export const StudioParentSchema = z.object({ asset: id, how: StudioHowSchema })
export type StudioParent = z.infer<typeof StudioParentSchema>

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
  /** A `StudioProject.id`; STUDIO_UNSORTED when absent. */
  project: id.optional(),
  /** Lineage: the image this job was made from. Absent for an original. */
  parent: StudioParentSchema.optional(),
  /** One `create` with `count` > 1 makes `count` jobs sharing a batch id. */
  batch: z
    .object({
      id,
      index: z.number().int().min(0),
      count: z.number().int().min(1).max(MAX_STUDIO_COUNT),
    })
    .optional(),
})
export type StudioJob = z.infer<typeof StudioJobSchema>

export const StudioResolutionSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(60),
  aspect: StudioAspectSchema,
})
export type StudioResolution = z.infer<typeof StudioResolutionSchema>

/** One option of a preset's choice input ("Low angle"). */
export const StudioChoiceSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(80),
})
export type StudioChoice = z.infer<typeof StudioChoiceSchema>

/** A preset's own input beyond prompt and references: a choice (angle, light) or a number (strength). */
export const StudioInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('choice'),
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(60),
    options: z.array(StudioChoiceSchema).min(1).max(40),
    /** An option id. */
    default: z.string().min(1).max(40),
  }),
  z.object({
    kind: z.literal('number'),
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(60),
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().positive(),
    default: z.number().finite(),
  }),
])
export type StudioInput = z.infer<typeof StudioInputSchema>

/** A model on a model-picking backend: a Higgsfield model, or a ComfyUI preset. */
export const StudioModelSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(120),
  mode: StudioModeSchema,
  resolutions: z.array(StudioResolutionSchema).max(20),
  /** Allowed lengths in seconds (video). */
  seconds: z.array(z.number().positive()).max(20),
  frames: z.array(StudioFrameSlotSchema).max(3),
  /** One line under the name on a preset card. */
  description: z.string().max(300).optional(),
  /** How many reference images it takes; the backend's `refs` when absent. */
  refs: z.number().int().min(0).max(MAX_STUDIO_REFS).optional(),
  /** How many it needs at least; 1 when it takes any and this is absent (an edit). */
  minRefs: z.number().int().min(0).max(MAX_STUDIO_REFS).optional(),
  /** False: it uses no prompt (an upscale); the page hides the box and sends the model's name. */
  prompt: z.boolean().optional(),
  inputs: z.array(StudioInputSchema).max(MAX_STUDIO_PARAMS).optional(),
  /** A typical run on the host (presets). */
  estimateMs: z.number().positive().optional(),
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

export const StudioProjectSchema = z.object({
  id,
  name: z.string().trim().min(1).max(80),
  createdAt: z.number(),
})
export type StudioProject = z.infer<typeof StudioProjectSchema>

export const StudioReferenceKindSchema = z.enum(['style', 'character'])
export type StudioReferenceKind = z.infer<typeof StudioReferenceKindSchema>

/** A saved Style or Character: the host's own copy of an image; its `asset.id` goes in `spec.refs`. */
export const StudioReferenceSchema = z.object({
  id,
  kind: StudioReferenceKindSchema,
  name: z.string().trim().min(1).max(80),
  asset: StudioAssetSchema,
  createdAt: z.number(),
})
export type StudioReference = z.infer<typeof StudioReferenceSchema>

/** One object SAM 2.1 found in an image. */
export const StudioSegmentSchema = z.object({
  /** The mask's id: send it as `spec.mask` to scope an edit (or a cutout) to this object. */
  id,
  label: z.string().min(1).max(60),
  /** Bounding box, fractions of the image: x, y, width, height. */
  box: z.tuple([
    z.number().min(0).max(1),
    z.number().min(0).max(1),
    z.number().min(0).max(1),
    z.number().min(0).max(1),
  ]),
  /** Share of the image it covers, 0 to 1. */
  area: z.number().min(0).max(1),
  /** `/studio/<id>/<token>`: grayscale PNG mask the size of the image (white = the object). */
  mask: nonEmpty,
  /** `/studio/<id>/<token>/thumb`: the object cut out, for the list. */
  thumb: nonEmpty,
})
export type StudioSegment = z.infer<typeof StudioSegmentSchema>

/** SAM 2.1's objects for one image (`segment` op; pushed as `studio.segments`, kept by the host). */
export const StudioSegmentsSchema = z.object({
  asset: id,
  state: z.enum(['queued', 'running', 'done', 'failed']),
  segments: z.array(StudioSegmentSchema).max(MAX_STUDIO_SEGMENTS),
  error: z.string().max(2000).optional(),
})
export type StudioSegments = z.infer<typeof StudioSegmentsSchema>

export const StudioImageSchema = z.object({
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  data: z
    .string()
    .min(1)
    .max(6 * 1024 * 1024),
})
export type StudioImage = z.infer<typeof StudioImageSchema>

const studioAssetIds = z.array(id).min(1).max(MAX_STUDIO_JOBS)

/** Every op but `create`, which differs between the wire (with `origin`) and this app's page. */
const StudioOtherOps = [
  /** Price a paid job without running it; answered with `credits` and `balance`. Free. */
  z.object({ kind: z.literal('quote'), spec: StudioSpecSchema }),
  /** Stop a queued or running job. */
  z.object({ kind: z.literal('cancel'), id }),
  /** Remove a finished job and its files (every copy), or an upload, now. */
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
  /** Favorite (or unfavorite) output images. */
  z.object({ kind: z.literal('favorite'), assets: studioAssetIds, value: z.boolean() }),
  /** Move output images (their jobs) to a project (STUDIO_UNSORTED for none). */
  z.object({ kind: z.literal('move'), assets: studioAssetIds, project: id }),
  /** Trash output images: hidden now, restorable for STUDIO_UNDO_MS, then deleted with every copy. */
  z.object({ kind: z.literal('trash'), assets: studioAssetIds }),
  /** Undo a trash. */
  z.object({ kind: z.literal('restore'), assets: studioAssetIds }),
  /** New project; `id` lets an Undo bring a deleted one back. Answered with `project`. */
  z.object({
    kind: z.literal('project.create'),
    name: z.string().trim().min(1).max(80),
    id: id.optional(),
  }),
  z.object({ kind: z.literal('project.rename'), id, name: z.string().trim().min(1).max(80) }),
  /** Delete a project; its images move to Unsorted. */
  z.object({ kind: z.literal('project.delete'), id }),
  /** Save an output image as a Style or Character (the host copies it); answered with `reference`. */
  z.object({
    kind: z.literal('reference.create'),
    asset: id,
    referenceKind: StudioReferenceKindSchema,
    name: z.string().trim().min(1).max(80),
  }),
  z.object({ kind: z.literal('reference.delete'), id }),
  /** Find the objects in an image with SAM 2.1; answered with the current `segments`, then `studio.segments` pushes. */
  z.object({ kind: z.literal('segment'), asset: id }),
] as const

/** Lineage, project and count of a `create` (both the wire's and the page's). */
const StudioCreateFields = {
  spec: StudioSpecSchema,
  /** Queue this many jobs (default 1), seeds `seed` to `seed + count - 1` (or random). */
  count: z.number().int().min(1).max(MAX_STUDIO_COUNT).optional(),
  project: id.optional(),
  parent: StudioParentSchema.optional(),
}

/** One `studio.req` op as the host takes it. */
export const StudioOpSchema = z.discriminatedUnion('kind', [
  /** Queue jobs; answered with `jobs` (and `job`, the first). */
  z.object({ kind: z.literal('create'), ...StudioCreateFields, origin: StudioOriginSchema }),
  ...StudioOtherOps,
])
export type StudioOp = z.infer<typeof StudioOpSchema>

/** One op from the Studio page: a `create` is Isaac's own (main sends it as `desktop`). */
export const StudioPageOpSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), ...StudioCreateFields }),
  ...StudioOtherOps,
])
export type StudioPageOp = z.infer<typeof StudioPageOpSchema>

export const StudioStateSchema = z.object({
  /** Newest first. */
  jobs: z.array(StudioJobSchema).max(MAX_STUDIO_JOBS),
  /** Newest first. */
  uploads: z.array(StudioAssetSchema).max(MAX_STUDIO_UPLOADS),
  backends: z.array(StudioBackendSchema).max(12),
  /** Oldest first. Absent from hosts before projects. */
  projects: z.array(StudioProjectSchema).max(MAX_STUDIO_PROJECTS).default([]),
  /** Oldest first. */
  references: z.array(StudioReferenceSchema).max(MAX_STUDIO_REFERENCES).default([]),
})
export type StudioState = z.infer<typeof StudioStateSchema>

/** Projects and references changed (`studio.library`). */
export const StudioLibrarySchema = z.object({
  projects: z.array(StudioProjectSchema).max(MAX_STUDIO_PROJECTS),
  references: z.array(StudioReferenceSchema).max(MAX_STUDIO_REFERENCES),
})
export type StudioLibrary = z.infer<typeof StudioLibrarySchema>

/** The host's answer to one op (`studio.res` without its rid). */
export const StudioAnswerSchema = z.object({
  ok: z.boolean(),
  /** Why it was refused, one line for the UI. */
  error: z.string().max(2000).optional(),
  job: StudioJobSchema.optional(),
  asset: StudioAssetSchema.optional(),
  /** `create`: every job it queued. */
  jobs: z.array(StudioJobSchema).max(MAX_STUDIO_COUNT).optional(),
  project: StudioProjectSchema.optional(),
  reference: StudioReferenceSchema.optional(),
  segments: StudioSegmentsSchema.optional(),
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
  /** SAM 2.1 results heard so far, by image asset id. */
  segments: z.record(z.string(), StudioSegmentsSchema).default({}),
})
export type StudioView = z.infer<typeof StudioViewSchema>

/** One change to the page's view: a whole state, one job, a deletion, the library, segments, or Relay up or down. */
export const StudioChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state'), state: StudioStateSchema }),
  z.object({ kind: z.literal('job'), job: StudioJobSchema }),
  z.object({ kind: z.literal('removed'), id: nonEmpty }),
  z.object({ kind: z.literal('library'), library: StudioLibrarySchema }),
  z.object({ kind: z.literal('segments'), segments: StudioSegmentsSchema }),
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
  /**
   * Copies output images from the host onto a Canvas board (the board folder's `studio/`) as image
   * cards on its first page, through the board store; an open board reloads. Answers how many.
   */
  'studio.canvas': {
    input: z
      .object({
        slug: z.string().regex(/^[a-z0-9-]{1,80}$/),
        assets: z
          .array(
            z
              .object({
                path: z.string().regex(STUDIO_PATH_RE).max(400),
                name: z.string().min(1).max(120),
              })
              .strict(),
          )
          .min(1)
          .max(50),
      })
      .strict(),
    output: z.object({ added: z.number().int().nonnegative() }),
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

/** How many reference images the backend (or its model) takes at most and needs at least. */
export function studioRefs(backend: StudioBackend, model?: string): { max: number; min: number } {
  const found = model === undefined ? undefined : backend.models?.find((m) => m.id === model)
  const max = found?.refs ?? backend.refs
  return { max, min: Math.min(max, found?.minRefs ?? (max > 0 ? 1 : 0)) }
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

// ---------------------------------------------------------------------------------------------
// Library (projects, lineage): same as the host's protocol module
// ---------------------------------------------------------------------------------------------

/** The project a job belongs to (STUDIO_UNSORTED when it names none). */
export function studioProjectOf(job: StudioJob): string {
  return job.project ?? STUDIO_UNSORTED
}

/** One image (or video) in the library: an output of a finished job. */
export interface StudioItem {
  readonly asset: StudioAsset
  readonly job: StudioJob
}

/** Every output that is not trashed, newest first (outputs of one job in their order). */
export function studioItems(jobs: readonly StudioJob[]): StudioItem[] {
  const out: StudioItem[] = []
  for (const job of jobs)
    for (const asset of job.outputs) if (asset.deletedAt === undefined) out.push({ asset, job })
  return out.sort(
    (a, b) =>
      b.asset.createdAt - a.asset.createdAt ||
      a.job.outputs.indexOf(a.asset) - b.job.outputs.indexOf(b.asset),
  )
}

export interface StudioLineage {
  readonly byId: ReadonlyMap<string, StudioItem>
  /** Live children of each asset, oldest first. */
  readonly children: ReadonlyMap<string, readonly StudioItem[]>
}

export function studioLineage(items: readonly StudioItem[]): StudioLineage {
  const byId = new Map(items.map((i) => [i.asset.id, i]))
  const children = new Map<string, StudioItem[]>()
  for (const item of [...items].sort((a, b) => a.asset.createdAt - b.asset.createdAt)) {
    const parent = item.job.parent?.asset
    if (parent === undefined || !byId.has(parent)) continue
    const list = children.get(parent)
    if (list) list.push(item)
    else children.set(parent, [item])
  }
  return { byId, children }
}

/** An original: made from nothing, or its parent is gone (trashed or deleted). */
export function studioIsOriginal(item: StudioItem, lineage: StudioLineage): boolean {
  const parent = item.job.parent?.asset
  return parent === undefined || !lineage.byId.has(parent)
}

/** The original an image descends from (itself when it is one). */
export function studioRootOf(id: string, lineage: StudioLineage): StudioItem | undefined {
  let item = lineage.byId.get(id)
  const seen = new Set<string>()
  while (item && !seen.has(item.asset.id)) {
    seen.add(item.asset.id)
    const parent = item.job.parent?.asset
    const up = parent === undefined ? undefined : lineage.byId.get(parent)
    if (!up) return item
    item = up
  }
  return item
}

/** An original's versions: itself, then every descendant depth first, each family oldest first. */
export function studioVersions(rootId: string, lineage: StudioLineage): StudioItem[] {
  const root = lineage.byId.get(rootId)
  if (!root) return []
  const out: StudioItem[] = [root]
  const seen = new Set([rootId])
  const walk = (id: string): void => {
    for (const child of lineage.children.get(id) ?? []) {
      if (seen.has(child.asset.id)) continue
      seen.add(child.asset.id)
      out.push(child)
      walk(child.asset.id)
    }
  }
  walk(rootId)
  return out
}

/** How many versions descend from an image (the grid tile's iteration badge). */
export function studioDescendantCount(id: string, lineage: StudioLineage): number {
  return studioVersions(id, lineage).length - 1
}

/** The state after one `studio.library`. */
export function studioWithLibrary(state: StudioState, library: StudioLibrary): StudioState {
  return { ...state, projects: library.projects, references: library.references }
}
