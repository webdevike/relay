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

export const MAX_STUDIO_JOBS = 300;
export const MAX_STUDIO_UPLOADS = 100;
export const MAX_STUDIO_PROMPT = 4000;
export const MAX_STUDIO_REFS = 4;

export const StudioMode = z.enum(["image", "video"]);
export type StudioMode = z.infer<typeof StudioMode>;

/** `ltx`: local LTX-2.5 video. `codex-image` / `codex-edit`: images on the ChatGPT subscription. `higgsfield`: paid. */
export const StudioBackendId = z.enum(["ltx", "codex-image", "codex-edit", "higgsfield"]);
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
  /** Higgsfield model id. */
  model: z.string().min(1).max(100).optional(),
  /** Paid backends: the credits Isaac confirmed for this one job. */
  confirmCredits: z.number().nonnegative().optional(),
});
export type StudioSpec = z.infer<typeof StudioSpec>;

export const StudioJobState = z.enum(["queued", "running", "done", "failed", "cancelled"]);
export type StudioJobState = z.infer<typeof StudioJobState>;

export const StudioOrigin = z.enum(["phone", "desktop", "agent"]);
export type StudioOrigin = z.infer<typeof StudioOrigin>;

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
});
export type StudioJob = z.infer<typeof StudioJob>;

export const StudioResolution = z.object({
  id: z.string().min(1).max(40),
  label: z.string().min(1).max(60),
  aspect: StudioAspect,
});
export type StudioResolution = z.infer<typeof StudioResolution>;

/** A model on a model-picking backend (Higgsfield). */
export const StudioModel = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(120),
  mode: StudioMode,
  resolutions: z.array(StudioResolution).max(20),
  /** Allowed lengths in seconds (video). */
  seconds: z.array(z.number().positive()).max(20),
  frames: z.array(StudioFrameSlot).max(3),
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

const StudioImage = z.object({
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  data: z.string().min(1).max(6 * 1024 * 1024),
});

export const StudioOp = z.discriminatedUnion("kind", [
  /** Queue a job; answered with `job`. */
  z.object({ kind: z.literal("create"), spec: StudioSpec, origin: StudioOrigin }),
  /** Price a paid job without running it; answered with `credits` and `balance`. Free. */
  z.object({ kind: z.literal("quote"), spec: StudioSpec }),
  /** Stop a queued or running job. */
  z.object({ kind: z.literal("cancel"), id }),
  /** Remove a finished job and its files, or an upload. */
  z.object({ kind: z.literal("delete"), id }),
  /** Keep an image from the device as a reference frame; answered with `asset`. */
  z.object({ kind: z.literal("upload"), image: StudioImage, name: z.string().max(200).optional() }),
  /** A video's first or last frame as a new upload, to reuse it as a keyframe; answered with `asset`. */
  z.object({ kind: z.literal("frame"), asset: id, at: z.enum(["first", "last"]) }),
  /** Re-read backends (models, balance, availability); a new `studio.state` follows. */
  z.object({ kind: z.literal("refresh") }),
]);
export type StudioOp = z.infer<typeof StudioOp>;

export const StudioRid = z.string().min(1).max(64);

export const StudioState = z.object({
  /** Newest first. */
  jobs: z.array(StudioJob).max(MAX_STUDIO_JOBS),
  /** Newest first. */
  uploads: z.array(StudioAsset).max(MAX_STUDIO_UPLOADS),
  backends: z.array(StudioBackend).max(10),
});
export type StudioState = z.infer<typeof StudioState>;

export const StudioResult = z.object({
  rid: StudioRid,
  ok: z.boolean(),
  /** Why it was refused, one line for the UI. */
  error: z.string().max(2000).optional(),
  job: StudioJob.optional(),
  asset: StudioAsset.optional(),
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
export function studioResolutions(backend: StudioBackend, aspect: StudioAspect, model?: string): StudioResolution[] {
  const list = model === undefined ? backend.resolutions : (backend.models?.find((m) => m.id === model)?.resolutions ?? []);
  return list.filter((r) => r.aspect === aspect);
}
