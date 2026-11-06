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

/** Which of the two pickers a draft is on: the model dropdown, or ComfyUI's presets. */
export type StudioTab = "models" | "comfyui";

export type StudioGroup = "Local" | "ChatGPT" | "Paid";
export const STUDIO_GROUPS: readonly StudioGroup[] = ["Local", "ChatGPT", "Paid"];

/** One choice in the model dropdown (or one ComfyUI preset): a model, or a backend that has none. */
export interface StudioEntry {
  backend: StudioBackendId;
  /** Absent for a backend that picks no model. */
  model?: string | undefined;
  label: string;
  mode: StudioMode;
  available: boolean;
  reason?: string | undefined;
  paid: boolean;
  group: StudioGroup;
  /** A preset's one line. */
  description?: string | undefined;
}

/** What a tab remembers: the mode, backend and model last chosen on it. */
export interface StudioChoice {
  mode: StudioMode;
  backend: StudioBackendId;
  model?: string | undefined;
}

function entriesOf(backend: StudioBackend): StudioEntry[] {
  const group: StudioGroup = backend.paid ? "Paid" : backend.id === "codex-image" || backend.id === "codex-edit" ? "ChatGPT" : "Local";
  const models = backend.models;
  if (backend.available && models !== undefined && models.length > 0) {
    return models.map((m) => ({ backend: backend.id, model: m.id, label: m.name, mode: m.mode, available: true, paid: backend.paid, group, description: m.description }));
  }
  return [{ backend: backend.id, label: backend.label, mode: backend.mode, available: backend.available, reason: backend.reason, paid: backend.paid, group }];
}

/**
 * Every model the host offers outside ComfyUI, grouped Local, ChatGPT, Paid; images before videos
 * inside a group, otherwise in the host's order. A backend that is down or lists no models is one
 * entry of its own (disabled, with its reason).
 */
export function studioEntries(backends: readonly StudioBackend[]): StudioEntry[] {
  const entries = backends.filter((b) => !isPresetBackend(b.id)).flatMap(entriesOf);
  const out: StudioEntry[] = [];
  for (const group of STUDIO_GROUPS) {
    const inGroup = entries.filter((e) => e.group === group);
    out.push(...inGroup.filter((e) => e.mode === "image"), ...inGroup.filter((e) => e.mode === "video"));
  }
  return out;
}

/** ComfyUI's presets, image presets first, then video presets (only the available backends have any). */
export function studioPresets(backends: readonly StudioBackend[]): StudioEntry[] {
  const presets = backends.filter((b) => isPresetBackend(b.id)).flatMap(entriesOf).filter((e) => e.model !== undefined);
  return [...presets.filter((e) => e.mode === "image"), ...presets.filter((e) => e.mode === "video")];
}

/** Why ComfyUI offers nothing, in one line; undefined when it has presets or the host has no ComfyUI. */
export function comfyReason(backends: readonly StudioBackend[]): string | undefined {
  const comfy = backends.filter((b) => isPresetBackend(b.id));
  if (comfy.length === 0 || studioPresets(backends).length > 0) return undefined;
  return comfy.find((b) => b.reason !== undefined)?.reason ?? "ComfyUI has no presets on this host";
}

/** The entry a new composer starts on: the first available free one, else the first available, else the first. */
export function defaultEntry(backends: readonly StudioBackend[]): StudioEntry | undefined {
  const entries = studioEntries(backends);
  return entries.find((e) => e.available && !e.paid) ?? entries.find((e) => e.available) ?? entries[0];
}

/** The tab a draft is on: ComfyUI when its backend is a ComfyUI one. */
export function draftTab(draft: Pick<StudioDraft, "backend">): StudioTab {
  return isPresetBackend(draft.backend) ? "comfyui" : "models";
}

/** The draft with an entry or preset chosen: mode, backend and model move together (the model is cleared for a model-less backend). */
export function draftForEntry(draft: StudioDraft, entry: Pick<StudioEntry, "backend" | "model" | "mode">): StudioDraft {
  return { ...draft, mode: entry.mode, backend: entry.backend, model: entry.model };
}

export function draftChoice(draft: StudioDraft): StudioChoice | undefined {
  return draft.backend === undefined ? undefined : { mode: draft.mode, backend: draft.backend, model: draft.model };
}

/**
 * The draft moved to `tab`: the choice that tab last held when it is still offered, else its first
 * available entry (a ComfyUI backend with no presets is chosen as itself so its reason shows).
 * Undefined when there is nothing to switch to.
 */
export function draftForTab(draft: StudioDraft, backends: readonly StudioBackend[], tab: StudioTab, remembered?: StudioChoice): StudioDraft | undefined {
  if (draftTab(draft) === tab) return draft;
  const same = (e: StudioEntry) => remembered?.backend === e.backend && remembered.model === e.model;
  if (tab === "models") {
    const entry = studioEntries(backends).find((e) => e.available && same(e)) ?? defaultEntry(backends);
    return entry === undefined ? undefined : draftForEntry(draft, entry);
  }
  const presets = studioPresets(backends);
  const preset = presets.find(same) ?? presets.find((e) => e.available);
  if (preset !== undefined) return draftForEntry(draft, preset);
  const comfy = backends.find((b) => isPresetBackend(b.id));
  return comfy === undefined ? undefined : { ...draft, mode: comfy.mode, backend: comfy.id, model: undefined };
}

/** The draft fitted to the host's backends, with the choices the screen offers. */
export interface StudioForm {
  draft: StudioDraft;
  /** Every backend the host offers, in its order. */
  all: StudioBackend[];
  /** The model dropdown's entries (grouped, ordered). */
  entries: StudioEntry[];
  /** ComfyUI's presets. */
  presets: StudioEntry[];
  tab: StudioTab;
  /** The chosen entry or preset; undefined when the host lists none for that backend. */
  entry: StudioEntry | undefined;
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

const serves = (b: StudioBackend, mode: StudioMode) => b.mode === mode || (b.models?.some((m) => m.mode === mode) ?? false);

/**
 * The draft's mode, backend and model made valid: a draft without a backend (or on one the host
 * lacks) starts on the default entry; a backend that doesn't serve the mode gives way to one that does.
 */
function settle(draft: StudioDraft, all: readonly StudioBackend[]): StudioDraft {
  const known = draft.backend === undefined ? undefined : all.find((b) => b.id === draft.backend);
  if (known !== undefined && serves(known, draft.mode)) return draft;
  const inMode = known === undefined ? [] : all.filter((b) => serves(b, draft.mode));
  const fallback = inMode.find((b) => b.available) ?? inMode[0];
  if (fallback !== undefined) return { ...draft, backend: fallback.id, model: undefined };
  const entry = defaultEntry(all);
  if (entry !== undefined) return draftForEntry(draft, entry);
  const first = all[0];
  return first === undefined ? draft : { ...draft, mode: first.mode, backend: first.id, model: undefined };
}

export function studioForm(input: StudioDraft, all: readonly StudioBackend[]): StudioForm {
  const draft = settle(input, all);
  const backend = all.find((b) => b.id === draft.backend);
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
  const entries = studioEntries(all);
  const presets = studioPresets(all);
  const pool = isPresetBackend(backend?.id) ? presets : entries;
  return {
    draft: { ...draft, backend: backend?.id, model: model?.id, resolution: resolution?.id, seconds: length, params },
    all: [...all],
    entries,
    presets,
    tab: draftTab({ backend: backend?.id }),
    entry: pool.find((e) => e.backend === backend?.id && e.model === model?.id) ?? pool.find((e) => e.backend === backend?.id && e.model === undefined),
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
