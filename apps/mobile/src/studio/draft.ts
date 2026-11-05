/**
 * Studio's composer as plain data. The draft keeps what Isaac picked; `studioForm` fits it to the
 * backends the host offers right now (a backend of the mode, a model, a resolution and length that
 * backend has), so the screen always shows a valid choice and a host change never strands it.
 * The draft has no `confirmCredits`: a paid confirmation lives only in the one `create` it was
 * tapped for (`draftSpec(form, credits)`), never in anything that outlives it.
 */
import {
  MAX_STUDIO_REFS,
  studioRefs,
  studioRemixSpec,
  studioResolutions,
  type StudioAspect,
  type StudioBackend,
  type StudioBackendId,
  type StudioFrameSlot,
  type StudioInput,
  type StudioJob,
  type StudioMode,
  type StudioModel,
  type StudioResolution,
  type StudioSpec,
} from "@relay/protocol";

/** A preset's input values by input id. */
export type StudioParams = Record<string, string | number>;

export type StudioFrames = Partial<Record<StudioFrameSlot, string | undefined>>;

export interface StudioDraft {
  mode: StudioMode;
  backend?: StudioBackendId | undefined;
  model?: string | undefined;
  prompt: string;
  aspect: StudioAspect;
  resolution?: string | undefined;
  seconds?: number | undefined;
  /** None: the host picks a random one. */
  seed?: number | undefined;
  frames: StudioFrames;
  refs: string[];
  /** A preset's own inputs by input id: a choice's option id or a number. Unset ids take the host's default. */
  params?: StudioParams | undefined;
}

export const EMPTY_DRAFT: StudioDraft = { mode: "image", prompt: "", aspect: "9:16", frames: {}, refs: [] };

export const STUDIO_ASPECTS: readonly StudioAspect[] = ["9:16", "16:9", "1:1"];
export const STUDIO_SLOTS: readonly StudioFrameSlot[] = ["start", "mid", "end"];

/** Where an asset can go in the composer: a keyframe slot or the edit references. */
export type StudioTarget = StudioFrameSlot | "ref";

/** The draft fitted to the host's backends, with the choices the screen offers. */
export interface StudioForm {
  draft: StudioDraft;
  /** Backends of the draft's mode, in the host's order. */
  backends: StudioBackend[];
  backend: StudioBackend | undefined;
  /** The backend's models of the draft's mode; empty unless it picks models. */
  models: StudioModel[];
  model: StudioModel | undefined;
  resolutions: StudioResolution[];
  /** Lengths offered (video). */
  seconds: number[];
  /** Keyframe slots offered. */
  slots: StudioFrameSlot[];
  /** How many reference images it takes. */
  refLimit: number;
  /** How many references it needs at least (an edit needs 1). */
  refMin: number;
  /** The chosen model's own inputs (presets); empty otherwise. */
  inputs: StudioInput[];
  /** False: the model uses no prompt, so the box is hidden and its name is the prompt. */
  takesPrompt: boolean;
}

export function studioForm(draft: StudioDraft, all: readonly StudioBackend[]): StudioForm {
  const backends = all.filter((b) => b.mode === draft.mode);
  const backend = backends.find((b) => b.id === draft.backend) ?? backends.find((b) => b.available) ?? backends[0];
  const models = backend?.models?.filter((m) => m.mode === draft.mode) ?? [];
  const model = models.find((m) => m.id === draft.model) ?? models[0];
  const resolutions = backend === undefined ? [] : studioResolutions(backend, draft.aspect, model?.id);
  const resolution = resolutions.find((r) => r.id === draft.resolution) ?? resolutions[0];
  const seconds = draft.mode === "video" ? (model?.seconds ?? backend?.seconds ?? []) : [];
  const length = seconds.find((s) => s === draft.seconds) ?? seconds[0];
  const slots = draft.mode === "video" ? (model?.frames ?? backend?.frames ?? []) : [];
  const refs = backend === undefined || draft.mode !== "image" ? { max: 0, min: 0 } : studioRefs(backend, model?.id);
  const refLimit = Math.min(refs.max, MAX_STUDIO_REFS);
  const inputs = model?.inputs ?? [];
  const params = Object.fromEntries(Object.entries(draft.params ?? {}).filter(([id]) => inputs.some((input) => input.id === id)));
  return {
    draft: { ...draft, backend: backend?.id, model: model?.id, resolution: resolution?.id, seconds: length, params },
    backends,
    backend,
    models,
    model,
    resolutions,
    seconds,
    slots,
    refLimit,
    refMin: Math.min(refs.min, refLimit),
    inputs,
    takesPrompt: model?.prompt !== false,
  };
}

/** Why Generate can't run yet, in one line; undefined when it can. */
export function formProblem(form: StudioForm): string | undefined {
  const { draft, backend } = form;
  if (backend === undefined) return `No ${draft.mode} backend on this host`;
  if (!backend.available) return backend.reason ?? `${backend.label} is unavailable`;
  if (draft.resolution === undefined) return `No ${draft.aspect} size for ${form.model?.name ?? backend.label}`;
  if (form.takesPrompt && draft.prompt.trim().length === 0) return "Describe what to make";
  const frames = usedFrames(form);
  // LTX takes a start and an end together, or neither; a mid frame only with both.
  if (backend.id === "ltx" && (frames.start === undefined) !== (frames.end === undefined)) return "Add both a start and an end frame, or neither";
  if (backend.id === "ltx" && frames.mid !== undefined && frames.start === undefined) return "A mid frame needs a start and an end frame";
  if (draft.refs.length < form.refMin) return form.refMin === 1 ? "Add a reference image to edit" : `Add ${form.refMin} reference images`;
  return undefined;
}

function usedFrames(form: StudioForm): StudioFrames {
  const frames: StudioFrames = {};
  for (const slot of form.slots) {
    const id = form.draft.frames[slot];
    if (id !== undefined) frames[slot] = id;
  }
  return frames;
}

/**
 * The spec to send: only what the chosen backend takes. `confirmCredits` is the quote Isaac just
 * tapped to confirm in the paid dialog; it is passed per call and never stored.
 */
export function draftSpec(form: StudioForm, confirmCredits?: number): StudioSpec | undefined {
  const { draft, backend } = form;
  const prompt = form.takesPrompt ? draft.prompt.trim() : (form.model?.name ?? "");
  if (backend === undefined || draft.resolution === undefined || prompt.length === 0) return undefined;
  const frames = usedFrames(form);
  const refs = draft.refs.slice(0, form.refLimit);
  return {
    mode: draft.mode,
    backend: backend.id,
    prompt,
    aspect: draft.aspect,
    resolution: draft.resolution,
    ...(draft.seconds === undefined ? {} : { seconds: draft.seconds }),
    ...(backend.seed && draft.seed !== undefined ? { seed: draft.seed } : {}),
    ...(Object.keys(frames).length > 0 ? { frames } : {}),
    ...(refs.length > 0 ? { refs } : {}),
    ...(form.model === undefined ? {} : { model: form.model.id }),
    ...(draft.params !== undefined && Object.keys(draft.params).length > 0 ? { params: draft.params } : {}),
    ...(confirmCredits === undefined ? {} : { confirmCredits }),
  };
}

/** The composer filled from a job, as `studioRemixSpec` describes it (no paid confirmation). */
export function remixDraft(job: StudioJob): StudioDraft {
  const spec = studioRemixSpec(job);
  return {
    mode: spec.mode,
    backend: spec.backend,
    model: spec.model,
    prompt: spec.prompt,
    aspect: spec.aspect,
    resolution: spec.resolution,
    seconds: spec.seconds,
    seed: spec.seed,
    frames: { ...spec.frames },
    refs: [...(spec.refs ?? [])],
    ...(spec.params === undefined ? {} : { params: { ...spec.params } }),
  };
}

/**
 * `asset` put into `target`: a keyframe switches the composer to video on a backend that has that
 * slot, a reference to images on one that takes references (the current backend when it does).
 */
export function draftWithAsset(draft: StudioDraft, backends: readonly StudioBackend[], target: StudioTarget, asset: string): StudioDraft {
  if (target === "ref") {
    const fits = (b: StudioBackend) => b.mode === "image" && b.refs > 0;
    const current = backends.find((b) => b.id === draft.backend && fits(b));
    const backend = current ?? backends.find((b) => fits(b) && b.available) ?? backends.find(fits);
    const limit = Math.min(backend === undefined ? MAX_STUDIO_REFS : studioRefs(backend, backend.id === draft.backend ? draft.model : undefined).max, MAX_STUDIO_REFS);
    const refs = [...draft.refs.filter((id) => id !== asset), asset].slice(-limit);
    return { ...draft, mode: "image", backend: backend?.id ?? draft.backend, refs };
  }
  const takes = (b: StudioBackend) => b.mode === "video" && (b.frames.includes(target) || (b.models?.some((m) => m.mode === "video" && m.frames.includes(target)) ?? false));
  const current = backends.find((b) => b.id === draft.backend && takes(b));
  const backend = current ?? backends.find((b) => takes(b) && b.available) ?? backends.find(takes);
  return { ...draft, mode: "video", backend: backend?.id ?? draft.backend, frames: { ...draft.frames, [target]: asset } };
}

/** The draft without `ids` (deleted assets) in its slots and references. */
export function draftWithout(draft: StudioDraft, ids: ReadonlySet<string>): StudioDraft {
  const frames: StudioFrames = {};
  let changed = false;
  for (const slot of STUDIO_SLOTS) {
    const id = draft.frames[slot];
    if (id === undefined) continue;
    if (ids.has(id)) changed = true;
    else frames[slot] = id;
  }
  const refs = draft.refs.filter((id) => !ids.has(id));
  if (!changed && refs.length === draft.refs.length) return draft;
  return { ...draft, frames, refs };
}

/** A number input stepped up or down one `step`, clamped to its range and rounded to the step's decimals. */
export function stepParam(input: Extract<StudioInput, { kind: "number" }>, current: number, direction: 1 | -1): number {
  const decimals = (String(input.step).split(".")[1] ?? "").length;
  const next = Math.min(input.max, Math.max(input.min, current + direction * input.step));
  return Number(next.toFixed(decimals));
}

/** The ComfyUI backends: their models are presets, shown as "Preset" with a description. */
export function isPresetBackend(id: StudioBackendId | undefined): boolean {
  return id === "comfyui" || id === "comfyui-video";
}

/** The settings a quote priced: the spec minus the prompt and seed, which never change the price. */
export function quoteKey(spec: StudioSpec): string {
  // JSON drops undefined fields, so these three never reach the key.
  return JSON.stringify({ ...spec, prompt: undefined, seed: undefined, confirmCredits: undefined });
}
