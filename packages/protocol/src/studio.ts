// Studio: image and video generation on the host, with a queue, a gallery and remix.
//
// The host runs every job (`apps/linux/src/studio/`): local LTX video on the Mac's GPU (one at a
// time), Codex images and edits on Isaac's ChatGPT subscription (several at once), and Higgsfield
// (paid credits). Outputs and uploaded reference frames live in `$XDG_CONFIG_HOME/relay/studio/`
// and are served like drops at `/studio/<id>/<token>` (plus `/thumb`, a JPEG preview; a video's is
// its first frame). Paths never change, so clients may cache them forever.
//
// Clients ask `studio.list` (answered by `studio.state`), then get `studio.job` for every change to
// a job (progress ticks included), `studio.removed` when one is deleted and a fresh `studio.state`
// when backends or uploads change. Everything else is one request family: `studio.req {rid, op}`,
// answered by `studio.res` with the same rid.
//
// Paid jobs never run on their own: `create` on a paid backend needs `confirmCredits` (the quote
// Isaac tapped to confirm, from `quote`), the host re-quotes and refuses when the price went up, and
// it refuses paid jobs from agents outright (`origin: "agent"`).
//
// Pure module: zod only, no imports from the rest of the protocol (index.ts re-exports it).
import { z } from "zod";

const ms = z.number().finite();
const nonEmpty = z.string().min(1);
const id = z.string().min(1).max(100);

/** The library is kept: the host never evicts finished jobs (only failed and cancelled ones past this many). */
export const MAX_STUDIO_JOBS = 5000;
export const MAX_STUDIO_UPLOADS = 100;
export const MAX_STUDIO_PROMPT = 4000;
export const MAX_STUDIO_REFS = 4;
export const MAX_STUDIO_PARAMS = 8;
/** At most this many images per `create` (each its own job, seeds `s` to `s + count - 1`). */
export const MAX_STUDIO_COUNT = 4;
/** A trashed image can be restored for this long; then the host deletes every copy of it. */
export const STUDIO_UNDO_MS = 10 * 60_000;
/** The project of every job that names none (and of everything from before projects). */
export const STUDIO_UNSORTED = "unsorted";
export const MAX_STUDIO_PROJECTS = 200;
export const MAX_STUDIO_REFERENCES = 200;
export const MAX_STUDIO_SEGMENTS = 24;

export const StudioMode = z.enum(["image", "video"]);
export type StudioMode = z.infer<typeof StudioMode>;

/**
 * `ltx`: local LTX-2.5 video. `codex-image` / `codex-edit`: images on the ChatGPT subscription. `moss`: local
 * MOSS-Image (MLX) text to image; its models are MOSS-Image and the fine-tunes on this host (Jib Mix Moss). `kontext`:
 * local FLUX.1 Kontext image edit. `comfyui` / `comfyui-video`: presets (named ComfyUI workflows) on a ComfyUI server
 * the host reaches, images and videos (Qwen Image Edit, relight, angles, SeedVR2 upscale, FLUX.2 klein). `sam`: local
 * SAM 2.1, model `cutout` (the subject, or `spec.mask`, on a transparent background). `crop`: local, no AI, model
 * `crop` with params `x`, `y`, `w`, `h` (0 to 1 of the source). `higgsfield`: paid. Older clients drop backends they
 * do not know.
 */
export const StudioBackendId = z.enum([
  "ltx",
  "codex-image",
  "codex-edit",
  "moss",
  "kontext",
  "comfyui",
  "comfyui-video",
  "sam",
  "crop",
  "higgsfield",
]);
export type StudioBackendId = z.infer<typeof StudioBackendId>;

export const StudioAspect = z.enum(["9:16", "16:9", "1:1"]);
export type StudioAspect = z.infer<typeof StudioAspect>;

export const StudioFrameSlot = z.enum(["start", "mid", "end"]);
export type StudioFrameSlot = z.infer<typeof StudioFrameSlot>;

/** A file the host keeps: a job's output or an uploaded reference frame. */
export const StudioAsset = z.object({
  id,
  kind: StudioMode,
  mimeType: nonEmpty,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationMs: ms.optional(),
  /** Bytes on disk. */
  size: z.number().int().nonnegative(),
  /** `/studio/<id>/<token>`; the token is the only credential. */
  path: nonEmpty,
  /** `/studio/<id>/<token>/thumb`: JPEG, at most 640 px on the long side. */
  thumb: nonEmpty,
  origin: z.enum(["output", "upload"]),
  createdAt: ms,
  /** Isaac's favorite (outputs only). */
  favorite: z.boolean().optional(),
  /** Trashed at (outputs only): hidden, restorable for STUDIO_UNDO_MS, then deleted with every copy. */
  deletedAt: ms.optional(),
});
export type StudioAsset = z.infer<typeof StudioAsset>;

/** What to make. Asset ids in `frames` and `refs` name outputs or uploads. */
export const StudioSpec = z.object({
  mode: StudioMode,
  backend: StudioBackendId,
  prompt: z.string().trim().min(1).max(MAX_STUDIO_PROMPT),
  aspect: StudioAspect,
  /** A `StudioResolution.id` of the backend (or of the Higgsfield model), e.g. `384x672`, `1024x1536`, `720p`. */
  resolution: z.string().min(1).max(40),
  /** Video length. */
  seconds: z.number().min(1).max(20).optional(),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
  /** Video keyframes (only the slots the backend lists). */
  frames: z.object({ start: id.optional(), mid: id.optional(), end: id.optional() }).optional(),
  /** Reference images for an edit. */
  refs: z.array(id).max(MAX_STUDIO_REFS).optional(),
  /** Higgsfield model id, or a ComfyUI preset id. */
  model: z.string().min(1).max(100).optional(),
  /** A preset's own inputs (`StudioModel.inputs`): a choice's option id or a number, by input id. */
  params: z
    .record(z.string().min(1).max(40), z.union([z.string().max(200), z.number().finite()]))
    .refine((params) => Object.keys(params).length <= MAX_STUDIO_PARAMS, `At most ${MAX_STUDIO_PARAMS} params`)
    .optional(),
  /** Paid backends: the credits Isaac confirmed for this one job. */
  confirmCredits: z.number().nonnegative().optional(),
  /**
   * An edit scoped to one SAM 2.1 segment: a `StudioSegment.id` (a mask the host keeps). The host composites the
   * engine's result back into the source image inside that mask only.
   */
  mask: id.optional(),
});
export type StudioSpec = z.infer<typeof StudioSpec>;

export const StudioJobState = z.enum(["queued", "running", "done", "failed", "cancelled"]);
export type StudioJobState = z.infer<typeof StudioJobState>;

export const StudioOrigin = z.enum(["phone", "desktop", "agent"]);
export type StudioOrigin = z.infer<typeof StudioOrigin>;

/** How a version was made from its parent, for lineage labels. */
export const StudioHow = z.enum([
  "vary",
  "edit",
  "upscale",
  "video",
  "relight",
  "angle",
  "character",
  "combine",
  "cutout",
  "crop",
  "regenerate",
]);
export type StudioHow = z.infer<typeof StudioHow>;

/** Where a job came from: the output image (asset id) it was made from, and how. */
export const StudioParent = z.object({ asset: id, how: StudioHow });
export type StudioParent = z.infer<typeof StudioParent>;

export const StudioJob = z.object({
  id,
  spec: StudioSpec,
  state: StudioJobState,
  origin: StudioOrigin,
  createdAt: ms,
  startedAt: ms.optional(),
  finishedAt: ms.optional(),
  /** 0 to 1. Local and Codex jobs estimate it from how long similar jobs took. */
  progress: z.number().min(0).max(1),
  /** Estimated time left while running (or until done, while queued). */
  etaMs: ms.optional(),
  /** One short line: "Waiting for the GPU", "Uploading frames", the failure. */
  note: z.string().max(400).optional(),
  error: z.string().max(2000).optional(),
  /** The seed the job ran with (a random one when the spec had none). */
  seed: z.number().int().optional(),
  /** Credits a paid job was charged (its confirmed quote). */
  credits: z.number().nonnegative().optional(),
  outputs: z.array(StudioAsset).max(8),
  /** A `StudioProject.id`; STUDIO_UNSORTED when absent. */
  project: id.optional(),
  /** Lineage: the image this job was made from. Absent for an original. */
  parent: StudioParent.optional(),
  /** One `create` with `count` > 1 makes `count` jobs sharing a batch id. */
  batch: z.object({ id, index: z.number().int().min(0), count: z.number().int().min(1).max(MAX_STUDIO_COUNT) }).optional(),
});
export type StudioJob = z.infer<typeof StudioJob>;

export const StudioResolution = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(60),
  aspect: StudioAspect,
});
export type StudioResolution = z.infer<typeof StudioResolution>;

/** One option of a preset's choice input ("Low angle"). */
export const StudioChoice = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(80),
});
export type StudioChoice = z.infer<typeof StudioChoice>;

/** A preset's own input beyond prompt and references: a choice (angle, light) or a number (strength). */
export const StudioInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("choice"),
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(60),
    options: z.array(StudioChoice).min(1).max(40),
    /** An option id. */
    default: z.string().min(1).max(40),
  }),
  z.object({
    kind: z.literal("number"),
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(60),
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().positive(),
    default: z.number().finite(),
  }),
]);
export type StudioInput = z.infer<typeof StudioInput>;

/** A model on a model-picking backend: a Higgsfield model, or a ComfyUI preset. */
export const StudioModel = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(120),
  mode: StudioMode,
  resolutions: z.array(StudioResolution).max(20),
  /** Allowed lengths in seconds (video). */
  seconds: z.array(z.number().positive()).max(20),
  frames: z.array(StudioFrameSlot).max(3),
  /** One line under the name on a preset card. */
  description: z.string().max(300).optional(),
  /** How many reference images it takes; the backend's `refs` when absent. */
  refs: z.number().int().min(0).max(MAX_STUDIO_REFS).optional(),
  /** How many it needs at least; 1 when it takes any and this is absent (an edit). */
  minRefs: z.number().int().min(0).max(MAX_STUDIO_REFS).optional(),
  /** False: it uses no prompt (an upscale); clients hide the box and send the model's name. */
  prompt: z.boolean().optional(),
  inputs: z.array(StudioInput).max(MAX_STUDIO_PARAMS).optional(),
  /** A typical run on this host (presets). */
  estimateMs: z.number().positive().optional(),
});
export type StudioModel = z.infer<typeof StudioModel>;

export const StudioBackend = z.object({
  id: StudioBackendId,
  label: z.string().min(1).max(80),
  mode: StudioMode,
  paid: z.boolean(),
  /** False when it cannot run on this host now; `reason` says why in one line. */
  available: z.boolean(),
  reason: z.string().max(400).optional(),
  resolutions: z.array(StudioResolution).max(30),
  /** Allowed lengths in seconds (video). */
  seconds: z.array(z.number().positive()).max(20),
  /** Keyframe slots it takes (video). */
  frames: z.array(StudioFrameSlot).max(3),
  /** How many reference images it takes (edits); 0 for none. */
  refs: z.number().int().min(0).max(MAX_STUDIO_REFS),
  /** It honors `seed`. */
  seed: z.boolean(),
  /** Runs one job at a time (the GPU); others wait in line. */
  serial: z.boolean(),
  models: z.array(StudioModel).max(200).optional(),
  /** Paid backends: credits left, when known. */
  balance: z.number().optional(),
});
export type StudioBackend = z.infer<typeof StudioBackend>;

export const StudioProject = z.object({
  id,
  name: z.string().trim().min(1).max(80),
  createdAt: ms,
});
export type StudioProject = z.infer<typeof StudioProject>;

export const StudioReferenceKind = z.enum(["style", "character"]);
export type StudioReferenceKind = z.infer<typeof StudioReferenceKind>;

/**
 * A saved Style or Character: the host's own copy of an image (it outlives the image it was saved from), usable as a
 * reference with `@`. Its `asset.id` goes in `spec.refs` like any other image.
 */
export const StudioReference = z.object({
  id,
  kind: StudioReferenceKind,
  name: z.string().trim().min(1).max(80),
  asset: StudioAsset,
  createdAt: ms,
});
export type StudioReference = z.infer<typeof StudioReference>;

/** One object SAM 2.1 found in an image. */
export const StudioSegment = z.object({
  /** The mask's id: send it as `spec.mask` to scope an edit (or a cutout) to this object. */
  id,
  /** "Object 1", or what the host could tell ("Background"). */
  label: z.string().min(1).max(60),
  /** Bounding box, fractions of the image: x, y, width, height. */
  box: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]),
  /** Share of the image it covers, 0 to 1. */
  area: z.number().min(0).max(1),
  /** `/studio/<id>/<token>`: the mask, a grayscale PNG the size of the image (white = the object). */
  mask: nonEmpty,
  /** `/studio/<id>/<token>/thumb`: the object cut out, for the list. */
  thumb: nonEmpty,
});
export type StudioSegment = z.infer<typeof StudioSegment>;

/** SAM 2.1's objects for one image (`segment` op; pushed as `studio.segments`, kept by the host). */
export const StudioSegments = z.object({
  asset: id,
  state: z.enum(["queued", "running", "done", "failed"]),
  segments: z.array(StudioSegment).max(MAX_STUDIO_SEGMENTS),
  error: z.string().max(2000).optional(),
});
export type StudioSegments = z.infer<typeof StudioSegments>;

const StudioImage = z.object({
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  data: z
    .string()
    .min(1)
    .max(6 * 1024 * 1024),
});

const assets = z.array(id).min(1).max(MAX_STUDIO_JOBS);

export const StudioOp = z.discriminatedUnion("kind", [
  /**
   * Queue `count` jobs (default 1; seeds `seed` to `seed + count - 1`, or random), each in line on its own;
   * answered with `jobs` (and `job`, the first). `project` defaults to Unsorted; `parent` records lineage.
   */
  z.object({
    kind: z.literal("create"),
    spec: StudioSpec,
    origin: StudioOrigin,
    count: z.number().int().min(1).max(MAX_STUDIO_COUNT).optional(),
    project: id.optional(),
    parent: StudioParent.optional(),
  }),
  /** Price a paid job without running it; answered with `credits` and `balance`. Free. */
  z.object({ kind: z.literal("quote"), spec: StudioSpec }),
  /** Stop a queued or running job. */
  z.object({ kind: z.literal("cancel"), id }),
  /** Remove a finished job and its files (every copy), or an upload, now. */
  z.object({ kind: z.literal("delete"), id }),
  /** Keep an image from the device as a reference frame; answered with `asset`. */
  z.object({ kind: z.literal("upload"), image: StudioImage, name: z.string().max(200).optional() }),
  /** A video's first or last frame as a new upload, to reuse it as a keyframe; answered with `asset`. */
  z.object({ kind: z.literal("frame"), asset: id, at: z.enum(["first", "last"]) }),
  /** Re-read backends (models, balance, availability); a new `studio.state` follows. */
  z.object({ kind: z.literal("refresh") }),
  /** Favorite (or unfavorite) output images. */
  z.object({ kind: z.literal("favorite"), assets, value: z.boolean() }),
  /** Move output images (their jobs) to a project (STUDIO_UNSORTED for none). */
  z.object({ kind: z.literal("move"), assets, project: id }),
  /** Trash output images: hidden now, restorable for STUDIO_UNDO_MS, then deleted with every copy. */
  z.object({ kind: z.literal("trash"), assets }),
  /** Undo a trash. */
  z.object({ kind: z.literal("restore"), assets }),
  /** New project; `id` lets an Undo bring a deleted one back as it was. Answered with `project`. */
  z.object({ kind: z.literal("project.create"), name: z.string().trim().min(1).max(80), id: id.optional() }),
  z.object({ kind: z.literal("project.rename"), id, name: z.string().trim().min(1).max(80) }),
  /** Delete a project; its images move to Unsorted. */
  z.object({ kind: z.literal("project.delete"), id }),
  /** Save an output image as a Style or Character (the host copies it); answered with `reference`. */
  z.object({
    kind: z.literal("reference.create"),
    asset: id,
    referenceKind: StudioReferenceKind,
    name: z.string().trim().min(1).max(80),
  }),
  z.object({ kind: z.literal("reference.delete"), id }),
  /**
   * Find the objects in an image with SAM 2.1 (in line for the GPU). Answered at once with the host's current
   * `segments` (cached results come back done); progress and the result arrive as `studio.segments`.
   */
  z.object({ kind: z.literal("segment"), asset: id }),
]);
export type StudioOp = z.infer<typeof StudioOp>;

export const StudioRid = z.string().min(1).max(64);

/**
 * `items` of a `studio.state` list without the entries a newer host added for a backend this build does not know
 * (`backendOf` reads its id), so an older phone keeps the rest of Studio instead of rejecting the whole frame. Entries
 * that are not objects, or name no backend, are left for `item` to judge.
 */
function withoutUnknownBackends<T extends z.ZodTypeAny>(items: z.ZodArray<T>, backendOf: (entry: Record<string, unknown>) => unknown) {
  return z.preprocess((value: unknown) => {
    if (!Array.isArray(value)) return value;
    return (value as unknown[]).filter((entry) => {
      if (typeof entry !== "object" || entry === null) return true;
      const backend = backendOf(entry as Record<string, unknown>);
      return typeof backend !== "string" || StudioBackendId.safeParse(backend).success;
    });
  }, items);
}

const specBackend = (job: Record<string, unknown>): unknown => {
  const spec = job["spec"];
  return typeof spec === "object" && spec !== null ? (spec as Record<string, unknown>)["backend"] : undefined;
};

export const StudioState = z.object({
  /** Newest first. Jobs on a backend this build does not know are dropped. */
  jobs: withoutUnknownBackends(z.array(StudioJob).max(MAX_STUDIO_JOBS), specBackend),
  /** Newest first. */
  uploads: z.array(StudioAsset).max(MAX_STUDIO_UPLOADS),
  /** Backends this build does not know are dropped. */
  backends: withoutUnknownBackends(z.array(StudioBackend).max(12), (backend) => backend["id"]),
  /** Oldest first. Absent from hosts before projects. */
  projects: z.array(StudioProject).max(MAX_STUDIO_PROJECTS).default([]),
  /** Oldest first. */
  references: z.array(StudioReference).max(MAX_STUDIO_REFERENCES).default([]),
});
export type StudioState = z.infer<typeof StudioState>;

/** Projects and references changed; pushed to every device as `studio.library`. */
export const StudioLibrary = z.object({
  projects: z.array(StudioProject).max(MAX_STUDIO_PROJECTS),
  references: z.array(StudioReference).max(MAX_STUDIO_REFERENCES),
});
export type StudioLibrary = z.infer<typeof StudioLibrary>;

export const StudioResult = z.object({
  rid: StudioRid,
  ok: z.boolean(),
  /** Why it was refused, one line for the UI. */
  error: z.string().max(2000).optional(),
  job: StudioJob.optional(),
  asset: StudioAsset.optional(),
  /** `create`: every job it queued. */
  jobs: z.array(StudioJob).max(MAX_STUDIO_COUNT).optional(),
  project: StudioProject.optional(),
  reference: StudioReference.optional(),
  segments: StudioSegments.optional(),
  credits: z.number().nonnegative().optional(),
  balance: z.number().optional(),
});
export type StudioResult = z.infer<typeof StudioResult>;

// ---------------------------------------------------------------------------------------------
// Shared helpers (both clients)
// ---------------------------------------------------------------------------------------------

export function studioJobActive(job: StudioJob): boolean {
  return job.state === "queued" || job.state === "running";
}

/** The form a remix starts from: the job's spec without the paid confirmation. */
export function studioRemixSpec(job: StudioJob): StudioSpec {
  const { confirmCredits: _confirmed, ...spec } = job.spec;
  return job.seed !== undefined && spec.seed === undefined ? { ...spec, seed: job.seed } : spec;
}

/** "about 3 min left", "about 40 s left"; undefined without an estimate. */
export function studioEtaLabel(etaMs: number | undefined): string | undefined {
  if (etaMs === undefined || !Number.isFinite(etaMs)) return undefined;
  const s = Math.max(0, Math.round(etaMs / 1000));
  if (s < 5) return "almost done";
  if (s < 90) return `about ${Math.ceil(s / 5) * 5} s left`;
  return `about ${Math.round(s / 60)} min left`;
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
      : (backend.models?.find((m) => m.id === model)?.resolutions ?? []);
  return list.filter((r) => r.aspect === aspect);
}

/** How many reference images the backend (or its model) takes at most and needs at least. */
export function studioRefs(backend: StudioBackend, model?: string): { readonly max: number; readonly min: number } {
  const found = model === undefined ? undefined : backend.models?.find((m) => m.id === model);
  const max = found?.refs ?? backend.refs;
  return { max, min: Math.min(max, found?.minRefs ?? (max > 0 ? 1 : 0)) };
}

// ---------------------------------------------------------------------------------------------
// Library (projects, lineage): both clients derive their views from the jobs with these
// ---------------------------------------------------------------------------------------------

/** The project a job belongs to (STUDIO_UNSORTED when it names none). */
export function studioProjectOf(job: StudioJob): string {
  return job.project ?? STUDIO_UNSORTED;
}

/** One image (or video) in the library: an output of a finished job. */
export interface StudioItem {
  readonly asset: StudioAsset;
  readonly job: StudioJob;
}

/** Every output that is not trashed, newest first (outputs of one job in their order). */
export function studioItems(jobs: readonly StudioJob[]): StudioItem[] {
  const out: StudioItem[] = [];
  for (const job of jobs) for (const asset of job.outputs) if (asset.deletedAt === undefined) out.push({ asset, job });
  return out.sort((a, b) => b.asset.createdAt - a.asset.createdAt || a.job.outputs.indexOf(a.asset) - b.job.outputs.indexOf(b.asset));
}

export interface StudioLineage {
  readonly byId: ReadonlyMap<string, StudioItem>;
  /** Live children of each asset, oldest first. */
  readonly children: ReadonlyMap<string, readonly StudioItem[]>;
}

export function studioLineage(items: readonly StudioItem[]): StudioLineage {
  const byId = new Map(items.map((i) => [i.asset.id, i]));
  const children = new Map<string, StudioItem[]>();
  for (const item of [...items].sort((a, b) => a.asset.createdAt - b.asset.createdAt)) {
    const parent = item.job.parent?.asset;
    if (parent === undefined || !byId.has(parent)) continue;
    const list = children.get(parent);
    if (list) list.push(item);
    else children.set(parent, [item]);
  }
  return { byId, children };
}

/** An original: made from nothing, or its parent is gone (trashed or deleted). */
export function studioIsOriginal(item: StudioItem, lineage: StudioLineage): boolean {
  const parent = item.job.parent?.asset;
  return parent === undefined || !lineage.byId.has(parent);
}

/** The original an image descends from (itself when it is one). */
export function studioRootOf(id: string, lineage: StudioLineage): StudioItem | undefined {
  let item = lineage.byId.get(id);
  const seen = new Set<string>();
  while (item && !seen.has(item.asset.id)) {
    seen.add(item.asset.id);
    const parent = item.job.parent?.asset;
    const up = parent === undefined ? undefined : lineage.byId.get(parent);
    if (!up) return item;
    item = up;
  }
  return item;
}

/** An original's versions: itself, then every descendant depth first, each family oldest first. */
export function studioVersions(rootId: string, lineage: StudioLineage): StudioItem[] {
  const root = lineage.byId.get(rootId);
  if (!root) return [];
  const out: StudioItem[] = [root];
  const seen = new Set([rootId]);
  const walk = (id: string): void => {
    for (const child of lineage.children.get(id) ?? []) {
      if (seen.has(child.asset.id)) continue;
      seen.add(child.asset.id);
      out.push(child);
      walk(child.asset.id);
    }
  };
  walk(rootId);
  return out;
}

/** How many versions descend from an image (the grid tile's iteration badge). */
export function studioDescendantCount(id: string, lineage: StudioLineage): number {
  return studioVersions(id, lineage).length - 1;
}

/**
 * What deleting images removes: each one and every version made from it (its edits, their edits, and
 * so on), once each, in the order met. Deleting only the image would leave its versions as orphan originals.
 */
export function studioFamily(ids: readonly string[], lineage: StudioLineage): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    if (!lineage.byId.has(id)) {
      out.add(id);
      continue;
    }
    for (const item of studioVersions(id, lineage)) out.add(item.asset.id);
  }
  return [...out];
}
