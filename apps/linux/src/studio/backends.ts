// Studio's backends as clients see them before a runner fills in availability (and Higgsfield its
// models and balance), how long a job is expected to take, and the checks a spec must pass before
// it queues. Pure: no I/O.

import { MAX_STUDIO_REFS, studioRefs, type StudioAsset, type StudioBackend, type StudioBackendId, type StudioModel, type StudioSpec } from "@relay/protocol";

/** Every backend in the order clients list them. */
export const STUDIO_BACKENDS: readonly StudioBackendId[] = ["ltx", "codex-image", "codex-edit", "moss", "kontext", "comfyui", "comfyui-video", "sam", "crop", "higgsfield"];

/** One size per aspect, close to what Codex really draws (about 1.6 MP), so the exact crop upscales little. */
const CODEX_RESOLUTIONS: StudioBackend["resolutions"] = [
  { id: "1088x1920", label: "1080p", aspect: "9:16" },
  { id: "1920x1088", label: "1080p", aspect: "16:9" },
  { id: "1280x1280", label: "1280 square", aspect: "1:1" },
];

/** FLUX.1 Kontext dev draws exactly these (multiples of 16, about 0.6 to 1 MP). */
const KONTEXT_RESOLUTIONS: StudioBackend["resolutions"] = [
  { id: "576x1024", label: "576x1024", aspect: "9:16" },
  { id: "1024x576", label: "1024x576", aspect: "16:9" },
  { id: "1024x1024", label: "1024 square", aspect: "1:1" },
];

/** SAM cutouts and crops keep the source's pixels: one `source` size per aspect (the spec's aspect is the source's nearest). */
const SOURCE_RESOLUTIONS: StudioBackend["resolutions"] = [
  { id: "source", label: "Source size", aspect: "1:1" },
  { id: "source", label: "Source size", aspect: "16:9" },
  { id: "source", label: "Source size", aspect: "9:16" },
];

/** A crop edge in `params`: a fraction of the source's width or height. */
const cropEdge = (id: string, label: string, value: number): NonNullable<StudioModel["inputs"]>[number] => ({
  kind: "number",
  id,
  label,
  min: 0,
  max: 1,
  step: 0.001,
  default: value,
});

/** The smallest crop side, as a fraction of the source's. */
export const MIN_CROP_SIDE = 0.01;

/** Each backend with `available: false`; its runner's `describe` says whether it can run now. */
export const BACKEND_BASE: Readonly<Record<StudioBackendId, StudioBackend>> = {
  ltx: {
    id: "ltx",
    label: "LTX video",
    mode: "video",
    paid: false,
    available: false,
    resolutions: [
      { id: "384x672", label: "Fast", aspect: "9:16" },
      { id: "480x848", label: "Draft", aspect: "9:16" },
      { id: "576x1024", label: "Fine", aspect: "9:16" },
      { id: "672x384", label: "Fast", aspect: "16:9" },
      { id: "848x480", label: "Draft", aspect: "16:9" },
      { id: "1024x576", label: "Fine", aspect: "16:9" },
      { id: "512x512", label: "Draft", aspect: "1:1" },
      { id: "640x640", label: "Fine", aspect: "1:1" },
    ],
    seconds: [2, 3, 4, 5, 6, 8],
    frames: ["start", "mid", "end"],
    refs: 0,
    seed: true,
    serial: true,
  },
  "codex-image": {
    id: "codex-image",
    label: "Codex image",
    mode: "image",
    paid: false,
    available: false,
    resolutions: CODEX_RESOLUTIONS,
    seconds: [],
    frames: [],
    refs: 0,
    seed: false,
    serial: false,
  },
  "codex-edit": {
    id: "codex-edit",
    label: "Codex edit",
    mode: "image",
    paid: false,
    available: false,
    resolutions: CODEX_RESOLUTIONS,
    seconds: [],
    frames: [],
    refs: MAX_STUDIO_REFS,
    seed: false,
    serial: false,
  },
  moss: {
    id: "moss",
    label: "MOSS-Image",
    mode: "image",
    paid: false,
    available: false,
    resolutions: [],
    seconds: [],
    frames: [],
    refs: 0,
    seed: true,
    serial: true,
    models: [],
  },
  kontext: {
    id: "kontext",
    label: "FLUX Kontext",
    mode: "image",
    paid: false,
    available: false,
    resolutions: KONTEXT_RESOLUTIONS,
    seconds: [],
    frames: [],
    refs: 1,
    seed: true,
    serial: true,
  },
  comfyui: {
    id: "comfyui",
    label: "ComfyUI",
    mode: "image",
    paid: false,
    available: false,
    resolutions: [],
    seconds: [],
    frames: [],
    refs: MAX_STUDIO_REFS,
    seed: true,
    serial: true,
    models: [],
  },
  "comfyui-video": {
    id: "comfyui-video",
    label: "ComfyUI video",
    mode: "video",
    paid: false,
    available: false,
    resolutions: [],
    seconds: [],
    frames: [],
    refs: MAX_STUDIO_REFS,
    seed: true,
    serial: true,
    models: [],
  },
  higgsfield: {
    id: "higgsfield",
    label: "Higgsfield",
    mode: "video",
    paid: true,
    available: false,
    resolutions: [],
    seconds: [],
    frames: [],
    refs: 0,
    seed: false,
    serial: false,
    models: [],
  },
  sam: {
    id: "sam",
    label: "SAM 2.1",
    mode: "image",
    paid: false,
    available: false,
    resolutions: SOURCE_RESOLUTIONS,
    seconds: [],
    frames: [],
    refs: 1,
    seed: false,
    serial: true,
    models: [
      {
        id: "cutout",
        name: "Remove background",
        mode: "image",
        description: "The subject, or the picked object, on a transparent background. SAM 2.1, local.",
        resolutions: SOURCE_RESOLUTIONS,
        seconds: [],
        frames: [],
        refs: 1,
        minRefs: 1,
        prompt: false,
        inputs: [],
      },
    ],
  },
  crop: {
    id: "crop",
    label: "Crop",
    mode: "image",
    paid: false,
    available: false,
    resolutions: SOURCE_RESOLUTIONS,
    seconds: [],
    frames: [],
    refs: 1,
    seed: false,
    serial: false,
    models: [
      {
        id: "crop",
        name: "Crop",
        mode: "image",
        description: "Cut the picture to a rectangle. Local, no AI.",
        resolutions: SOURCE_RESOLUTIONS,
        seconds: [],
        frames: [],
        refs: 1,
        minRefs: 1,
        prompt: false,
        inputs: [cropEdge("x", "Left", 0), cropEdge("y", "Top", 0), cropEdge("w", "Width", 1), cropEdge("h", "Height", 1)],
      },
    ],
  },
};

/**
 * How many jobs run at once, per pool: the Mac's GPU takes one LTX, MOSS, Kontext, ComfyUI or SAM job at a time
 * (first in, first out), ComfyUI video runs on the GPU box one at a time, both Codex backends share
 * one ChatGPT account, Higgsfield bills each job, crops are a quick ffmpeg each.
 */
export const STUDIO_POOLS: Readonly<Record<StudioBackendId, { readonly pool: string; readonly max: number }>> = {
  ltx: { pool: "gpu", max: 1 },
  "codex-image": { pool: "codex", max: 3 },
  "codex-edit": { pool: "codex", max: 3 },
  moss: { pool: "gpu", max: 1 },
  kontext: { pool: "gpu", max: 1 },
  comfyui: { pool: "gpu", max: 1 },
  "comfyui-video": { pool: "gpu-box", max: 1 },
  sam: { pool: "gpu", max: 1 },
  crop: { pool: "crop", max: 4 },
  higgsfield: { pool: "higgsfield", max: 2 },
};

/** A Kontext job: model load plus 24 steps (about 3 min at 1024x576 on the Mac Mini). */
const KONTEXT_ESTIMATE_MS = 240_000;
/** A MOSS-Image job with Turbo (15 network passes) and the prompt enhancer: about 2 min at 768x1344. */
export const MOSS_TURBO_ESTIMATE_MS = 120_000;
/** Turbo off: 50 steps with CFG (100 network passes) on top of the same load and enhancer. */
const MOSS_FULL_ESTIMATE_MS = 420_000;
/** A SAM 2.1 cutout: model load, the image encoder and the point grid, on the CPU. */
const SAM_ESTIMATE_MS = 45_000;
/** A cutout of a mask SAM already found: no model, just the alpha. */
const SAM_MASK_ESTIMATE_MS = 4000;

/** `WxH` as numbers; null for other ids (`720p`, `std`). */
export function parseSize(resolution: string): readonly [number, number] | null {
  const match = /^(\d+)x(\d+)$/.exec(resolution);
  return match === null ? null : [Number(match[1]), Number(match[2])];
}

const LTX_FPS = 24;

/** draft.py's frame count: 8k+1 frames at 24 fps. */
export function ltxFrames(seconds: number): number {
  return Math.max(1, Math.round((seconds * LTX_FPS) / 8)) * 8 + 1;
}

/** draft.py's `generation_size`: the 64-px grid size nearest in area whose aspect is within 3%. */
export function ltxGenerationSize(width: number, height: number): readonly [number, number] {
  const aspect = height / width;
  const area = width * height;
  let best: readonly [number, number, number] | null = null;
  for (let w = 256; w <= 2048; w += 64) {
    const h = Math.max(256, Math.round((w * aspect) / 64) * 64);
    const aspectError = Math.abs(h / w - aspect) / aspect;
    if (aspectError > 0.03) continue;
    const score = Math.abs(w * h - area) / area + aspectError;
    if (best === null || score < best[0]) best = [score, w, h];
  }
  return best === null ? [width, height] : [best[1], best[2]];
}

function ltxWork(resolution: string, seconds: number): number {
  const [w, h] = parseSize(resolution) ?? [480, 848];
  const [gw, gh] = ltxGenerationSize(w, h);
  return ltxFrames(seconds) * gw * gh;
}

/** Model load, text encoding and the H.264 encode: what an LTX job costs before its first frame. */
const LTX_OVERHEAD_MS = 45_000;
/** Generation time per frame-pixel, fitted so 5 s at 480x848 takes about 210 s in all. */
const LTX_MS_PER_UNIT = (210_000 - LTX_OVERHEAD_MS) / ltxWork("480x848", 5);

/**
 * How long `spec` should take before calibration (the service scales it by what jobs really took). A
 * ComfyUI preset says its own (`backend`'s model), else two minutes.
 */
export function baseEstimateMs(spec: StudioSpec, backend?: StudioBackend): number {
  switch (spec.backend) {
    case "ltx":
      return LTX_OVERHEAD_MS + LTX_MS_PER_UNIT * ltxWork(spec.resolution, spec.seconds ?? 5);
    case "codex-image":
      return 25_000;
    case "codex-edit":
      return 45_000;
    case "moss":
      return spec.params?.["turbo"] === "off" ? MOSS_FULL_ESTIMATE_MS : MOSS_TURBO_ESTIMATE_MS;
    case "kontext":
      return KONTEXT_ESTIMATE_MS;
    case "comfyui":
    case "comfyui-video":
      return backend?.models?.find((model) => model.id === spec.model)?.estimateMs ?? 120_000;
    case "sam":
      return spec.mask === undefined ? SAM_ESTIMATE_MS : SAM_MASK_ESTIMATE_MS;
    case "crop":
      return 2000;
    case "higgsfield":
      return 120_000;
  }
}

/**
 * Why `spec` can't run on `backend`, in one line; null when it can. `asset` finds an output or
 * upload by id.
 */
export function validateSpec(spec: StudioSpec, backend: StudioBackend, asset: (id: string) => StudioAsset | undefined): string | null {
  if (spec.mode !== backend.mode) return `${backend.label} makes ${backend.mode === "image" ? "images" : "videos"}`;
  const model = backend.models?.find((candidate) => candidate.id === spec.model);
  if (backend.models !== undefined && model === undefined)
    return spec.model === undefined ? "Pick a model" : `${backend.label} has no model ${spec.model}`;
  const offer = model ?? backend;
  const name = model?.name ?? backend.label;
  if (!offer.resolutions.some((resolution) => resolution.id === spec.resolution && resolution.aspect === spec.aspect))
    return `${name} has no ${spec.resolution} at ${spec.aspect}`;
  if (spec.mode === "video" && (spec.seconds === undefined || !offer.seconds.includes(spec.seconds)))
    return `${name} makes clips of ${offer.seconds.join(", ")} s`;
  const frames = spec.frames ?? {};
  for (const slot of ["start", "mid", "end"] as const) {
    if (frames[slot] !== undefined && !offer.frames.includes(slot)) return `${name} takes no ${slot} frame`;
  }
  if (spec.backend === "ltx" && (frames.start === undefined) !== (frames.end === undefined))
    return "LTX needs both a start and an end frame, or neither";
  if (frames.mid !== undefined && (frames.start === undefined || frames.end === undefined))
    return "A mid frame needs a start and an end frame";
  const refs = spec.refs ?? [];
  const allowed = studioRefs(backend, spec.model);
  if (refs.length > allowed.max)
    return allowed.max === 0 ? `${name} takes no reference images` : `${name} takes at most ${String(allowed.max)} reference images`;
  if (refs.length < allowed.min)
    return allowed.min === 1 ? "Add a reference image to edit" : `${name} needs ${String(allowed.min)} reference images`;
  const inputs = model?.inputs ?? [];
  for (const [key, value] of Object.entries(spec.params ?? {})) {
    const field = inputs.find((candidate) => candidate.id === key);
    if (field === undefined) return `${name} has no setting ${key}`;
    if (field.kind === "choice" && !field.options.some((option) => option.id === value)) return `${field.label} has no option ${String(value)}`;
    if (field.kind === "number" && (typeof value !== "number" || value < field.min || value > field.max))
      return `${field.label} must be between ${String(field.min)} and ${String(field.max)}`;
  }
  if (spec.backend === "crop") {
    if (spec.mask !== undefined) return "Crop takes no mask";
    const problem = cropProblem(spec.params ?? {});
    if (problem !== null) return problem;
  }
  for (const id of [...Object.values(frames), ...refs]) {
    if (id === undefined) continue;
    const found = asset(id);
    if (found === undefined) return "A frame or reference image is gone; pick it again";
    if (found.kind !== "image") return "Frames and reference images must be images";
  }
  return null;
}

/** A crop rectangle from `params` (fractions of the source; absent edges are the whole picture). */
export function cropBox(params: NonNullable<StudioSpec["params"]>): readonly [number, number, number, number] {
  const edge = (key: string, fallback: number): number => {
    const value = params[key];
    return typeof value === "number" ? value : fallback;
  };
  return [edge("x", 0), edge("y", 0), edge("w", 1), edge("h", 1)];
}

/** Why a crop's rectangle is no good, in one line; null when it fits inside the picture. */
function cropProblem(params: NonNullable<StudioSpec["params"]>): string | null {
  const [x, y, w, h] = cropBox(params);
  if (w < MIN_CROP_SIDE || h < MIN_CROP_SIDE) return "The crop is too small";
  // A little slack: clients send rounded fractions.
  if (x + w > 1 + 1e-6 || y + h > 1 + 1e-6) return "The crop goes past the edge of the picture";
  return null;
}
