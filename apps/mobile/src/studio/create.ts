/**
 * The create bar as plain data: which models make originals (images: MOSS-Image and the host's MOSS
 * fine-tunes, FLUX.2 klein create, Codex image, the paid backends' image models; videos: LTX, the
 * ComfyUI video presets, the paid backends' video models), the draft Isaac is typing, where its
 * output lands, and the one `create` op it sends. Picked images ride along as in Relay desktop:
 * an image create with references becomes an edit (Codex edit, or FLUX.2 klein on ComfyUI), a
 * video takes keyframes and the references its model lists. A paid model's `create` only leaves
 * through the confirm sheet, which passes the confirmed credits in; the draft never keeps them.
 */
import {
  MAX_STUDIO_COUNT,
  MAX_STUDIO_REFS,
  STUDIO_UNSORTED,
  studioResolutions,
  type StudioAspect,
  type StudioBackend,
  type StudioBackendId,
  type StudioFrameSlot,
  type StudioHow,
  type StudioMode,
  type StudioOp,
  type StudioParent,
  type StudioProject,
  type StudioReference,
  type StudioResolution,
  type StudioSpec,
  studioRefs,
} from "@relay/protocol";
import { projectName, viewProject, type LibraryView } from "./library";

export const STUDIO_ASPECTS: readonly StudioAspect[] = ["1:1", "16:9", "9:16"];

export type CreateGroup = "Local" | "ChatGPT" | "Paid";
export const CREATE_GROUPS: readonly CreateGroup[] = ["Local", "ChatGPT", "Paid"];

export interface CreateEntry {
  /** `backend:model`. */
  key: string;
  backend: StudioBackendId;
  model?: string | undefined;
  label: string;
  group: CreateGroup;
  available: boolean;
  /** Why it is unavailable. */
  reason?: string | undefined;
  paid: boolean;
}

export interface CreateDraft {
  /** What the bar makes: images, or videos. */
  mode: StudioMode;
  prompt: string;
  /** The chosen entry's key; the default entry when absent or no longer offered. */
  entry?: string | undefined;
  aspect: StudioAspect;
  count: number;
  /** A project id or STUDIO_UNSORTED; null follows the open project. */
  target: string | null;
  /** Picked images (library image ids or saved Style and Character asset ids): the edit's references, or a video model's. */
  refs: string[];
  /** Video: a size id of the model, a length in seconds, and keyframe image ids. Defaults apply when unset or not offered. */
  resolution?: string | undefined;
  seconds?: number | undefined;
  start?: string | undefined;
  end?: string | undefined;
}

export const EMPTY_CREATE: CreateDraft = { mode: "image", prompt: "", aspect: "1:1", count: 1, target: null, refs: [] };

/**
 * ComfyUI presets are named for what they do on the host ("Create", "Relight"), which means nothing
 * in the model picker next to MOSS-Image. Every ComfyUI entry says where it runs, and the one preset
 * whose name hides its model says that too.
 */
const COMFY_NAMES: Record<string, string> = { "klein-create": "FLUX.2 Klein" };

export function comfyLabel(model: { id: string; name: string }): string {
  return `${COMFY_NAMES[model.id] ?? model.name} (ComfyUI)`;
}

/** FLUX.2 klein takes at most this many references. */
export const MAX_KLEIN_REFS = 2;

/** The clip length a video starts on when its model offers it. */
export const DEFAULT_SECONDS = 4;

type Group = Omit<CreateEntry, "key">;

function entry(e: Group): CreateEntry {
  return { ...e, key: `${e.backend}:${e.model ?? ""}` };
}

/** A backend that is down: one disabled entry with its reason. */
function down(b: StudioBackend, group: CreateGroup, label = b.label): CreateEntry {
  return entry({ backend: b.id, label, group, available: false, reason: b.reason ?? `${b.label} is unavailable`, paid: b.paid });
}

/** What the create bar offers, grouped Local, ChatGPT, Paid: originals for images, LTX and the video presets for videos. */
export function createEntries(backends: readonly StudioBackend[], mode: StudioMode = "image"): CreateEntry[] {
  const out: CreateEntry[] = [];
  if (mode === "image") {
    const moss = backends.find((b) => b.id === "moss");
    if (moss !== undefined) {
      const models = moss.models?.filter((m) => m.mode === "image") ?? [];
      if (!moss.available || models.length === 0) out.push(down(moss, "Local", "MOSS-Image"));
      else out.push(...models.map((m) => entry({ backend: "moss", model: m.id, label: m.name, group: "Local", available: true, paid: false })));
    }
    // Every ComfyUI preset the host lists that makes an image from a prompt alone (FLUX.2 klein create, and any workflow added later).
    const comfy = backends.find((b) => b.id === "comfyui");
    for (const m of comfy?.models?.filter((x) => x.mode === "image" && studioRefs(comfy, x.id).min === 0 && x.prompt !== false) ?? []) {
      out.push(entry({ backend: "comfyui", model: m.id, label: comfyLabel(m), group: "Local", available: comfy?.available === true, reason: comfy?.available === true ? undefined : (comfy?.reason ?? "ComfyUI is unavailable"), paid: false }));
    }
    const codex = backends.find((b) => b.id === "codex-image");
    if (codex !== undefined) out.push(codex.available ? entry({ backend: codex.id, label: "Codex image", group: "ChatGPT", available: true, paid: false }) : down(codex, "ChatGPT", "Codex image"));
  } else {
    const ltx = backends.find((b) => b.id === "ltx");
    if (ltx !== undefined) out.push(ltx.available ? entry({ backend: "ltx", label: ltx.label, group: "Local", available: true, paid: false }) : down(ltx, "Local"));
    const comfy = backends.find((b) => b.id === "comfyui-video");
    if (comfy !== undefined) {
      const models = comfy.models?.filter((m) => m.mode === "video") ?? [];
      if (!comfy.available || models.length === 0) out.push(down(comfy, "Local"));
      else out.push(...models.map((m) => entry({ backend: comfy.id, model: m.id, label: comfyLabel(m), group: "Local", available: true, paid: false })));
    }
  }
  for (const b of backends.filter((x) => x.paid)) {
    const models = b.models?.filter((m) => m.mode === mode);
    // A paid backend that makes none of this mode has nothing for the create bar.
    if (models === undefined ? b.mode !== mode : models.length === 0) continue;
    if (!b.available) out.push(down(b, "Paid"));
    else if (models === undefined) out.push(entry({ backend: b.id, label: b.label, group: "Paid", available: true, paid: true }));
    else out.push(...models.map((m) => entry({ backend: b.id, model: m.id, label: m.name, group: "Paid", available: true, paid: true })));
  }
  return out;
}

/** The draft's entry when still offered, else the first available free one, else the first available, else the first. */
export function chosenEntry(draft: CreateDraft, entries: readonly CreateEntry[]): CreateEntry | undefined {
  return entries.find((e) => e.key === draft.entry && e.available) ?? entries.find((e) => e.available && !e.paid) ?? entries.find((e) => e.available) ?? entries[0];
}

/** Paid jobs are confirmed one at a time and videos are heavy, so a paid model or a video makes one per Generate. */
export function createCount(draft: CreateDraft, chosen: CreateEntry | undefined): number {
  return chosen?.paid === true || draft.mode === "video" ? 1 : Math.min(Math.max(1, Math.round(draft.count)), MAX_STUDIO_COUNT);
}

/** Where the images land: the draft's project, or the open project (Unsorted from All images and Favorites). */
export function createTarget(draft: CreateDraft, view: LibraryView, projects: readonly StudioProject[]): { id: string; name: string } {
  const exists = (id: string) => id === STUDIO_UNSORTED || projects.some((p) => p.id === id);
  const open = viewProject(view);
  const id = draft.target !== null && exists(draft.target) ? draft.target : open !== undefined && exists(open) ? open : STUDIO_UNSORTED;
  return { id, name: projectName(id, projects) };
}

/** What a model offers: its own sizes, lengths, keyframe slots and reference counts, else its backend's. Undefined for a model the backend lacks. */
function offerOf(backend: StudioBackend, model?: string) {
  const found = model === undefined ? undefined : backend.models?.find((m) => m.id === model);
  if (model !== undefined && found === undefined) return undefined;
  const source = found ?? backend;
  return { resolutions: source.resolutions, seconds: source.seconds, frames: source.frames, refs: studioRefs(backend, model) };
}

/** A video model's options for the draft: the sizes for its aspect, the lengths, the keyframes and references it takes, and the size and length in effect. */
export interface VideoSettings {
  resolutions: StudioResolution[];
  /** The draft's size when the model offers it at this aspect, else the first. */
  resolution: StudioResolution | undefined;
  seconds: number[];
  /** The draft's length when offered, else DEFAULT_SECONDS when offered, else the first. */
  length: number | undefined;
  frames: StudioFrameSlot[];
  refs: { max: number; min: number };
}

export function videoSettings(draft: CreateDraft, chosen: CreateEntry | undefined, backends: readonly StudioBackend[]): VideoSettings | undefined {
  const backend = chosen === undefined ? undefined : backends.find((b) => b.id === chosen.backend);
  const offer = backend === undefined ? undefined : offerOf(backend, chosen?.model);
  if (offer === undefined) return undefined;
  const resolutions = offer.resolutions.filter((r) => r.aspect === draft.aspect);
  const length = draft.seconds !== undefined && offer.seconds.includes(draft.seconds) ? draft.seconds : offer.seconds.includes(DEFAULT_SECONDS) ? DEFAULT_SECONDS : offer.seconds[0];
  return { resolutions, resolution: resolutions.find((r) => r.id === draft.resolution) ?? resolutions[0], seconds: offer.seconds, length, frames: offer.frames, refs: offer.refs };
}

/** What a create makes: one spec (with the lineage the first library image gives it), or one line on why not. */
export type CreatePlan = { spec: StudioSpec; parent?: StudioParent | undefined } | string;

function imagePlan(draft: CreateDraft, chosen: CreateEntry, backends: readonly StudioBackend[], references: readonly StudioReference[], confirmCredits: number | undefined): CreatePlan {
  const refs = [...draft.refs];
  let backendId = chosen.backend;
  let model = chosen.model;
  let how: StudioHow | undefined;
  if (refs.length > 0) {
    // Edits never switch to a paid engine on their own.
    if (chosen.paid) return "Paid models take no reference images";
    if (chosen.backend === "codex-image") {
      backendId = "codex-edit";
      model = undefined;
      how = "edit";
    } else {
      if (refs.length > MAX_KLEIN_REFS) return `FLUX.2 klein takes at most ${MAX_KLEIN_REFS} references`;
      backendId = "comfyui";
      if (refs.length === 2) {
        model = "combine";
        how = "combine";
      } else if (references.find((r) => r.asset.id === refs[0])?.kind === "character") {
        model = "character";
        how = "character";
      } else {
        model = "klein-edit";
        how = "edit";
      }
    }
  }
  const backend = backends.find((b) => b.id === backendId);
  if (backend === undefined) return `This host has no ${backendId} backend`;
  if (!backend.available) return backend.reason ?? `${backend.label} is unavailable`;
  if (model !== undefined && !(backend.models ?? []).some((m) => m.id === model)) return `${backend.label} has no ${model} preset`;
  const resolution = studioResolutions(backend, draft.aspect, model)[0];
  if (resolution === undefined) return refs.length > 0 ? `${backend.label} has no ${draft.aspect} size` : `No ${draft.aspect} size for ${chosen.label}`;
  if (draft.prompt.trim().length === 0) return "Describe what to make";
  const first = refs[0];
  const parent = first !== undefined && how !== undefined && !references.some((r) => r.asset.id === first) ? { asset: first, how } : undefined;
  return {
    spec: {
      mode: "image",
      backend: backendId,
      prompt: draft.prompt.trim(),
      aspect: draft.aspect,
      resolution: resolution.id,
      ...(model === undefined ? {} : { model }),
      ...(refs.length > 0 ? { refs } : {}),
      ...(confirmCredits === undefined ? {} : { confirmCredits }),
    },
    parent,
  };
}

function videoPlan(draft: CreateDraft, chosen: CreateEntry, backends: readonly StudioBackend[], references: readonly StudioReference[], confirmCredits: number | undefined): CreatePlan {
  const settings = videoSettings(draft, chosen, backends);
  if (settings === undefined) return `${chosen.label} is unavailable`;
  if (settings.resolution === undefined) return `No ${draft.aspect} size for ${chosen.label}`;
  if (settings.length === undefined) return `${chosen.label} lists no clip lengths`;
  const frames: { start?: string; end?: string } = {};
  if (settings.frames.includes("start") && draft.start !== undefined) frames.start = draft.start;
  if (settings.frames.includes("end") && draft.end !== undefined) frames.end = draft.end;
  if (chosen.backend === "ltx" && (frames.start === undefined) !== (frames.end === undefined)) return "LTX needs both a start and an end frame, or neither";
  const refs = draft.refs.slice(0, settings.refs.max);
  if (refs.length < settings.refs.min) return settings.refs.min === 1 ? "Add a reference image" : `${chosen.label} needs ${settings.refs.min} reference images`;
  if (draft.prompt.trim().length === 0) return "Describe what to make";
  const start = frames.start;
  const parent = start !== undefined && !references.some((r) => r.asset.id === start) ? { asset: start, how: "video" as const } : undefined;
  return {
    spec: {
      mode: "video",
      backend: chosen.backend,
      prompt: draft.prompt.trim(),
      aspect: draft.aspect,
      resolution: settings.resolution.id,
      seconds: settings.length,
      ...(chosen.model === undefined ? {} : { model: chosen.model }),
      ...(frames.start === undefined && frames.end === undefined ? {} : { frames }),
      ...(refs.length > 0 ? { refs } : {}),
      ...(confirmCredits === undefined ? {} : { confirmCredits }),
    },
    parent,
  };
}

/** The create the draft makes on `chosen`; no seed (the host picks one per job). Images with references become edits, as on desktop. */
export function createPlan(draft: CreateDraft, chosen: CreateEntry | undefined, backends: readonly StudioBackend[], references: readonly StudioReference[] = [], confirmCredits?: number): CreatePlan {
  if (chosen === undefined) return `No ${draft.mode} model on this host`;
  if (!chosen.available) return chosen.reason ?? `${chosen.label} is unavailable`;
  return draft.mode === "video" ? videoPlan(draft, chosen, backends, references, confirmCredits) : imagePlan(draft, chosen, backends, references, confirmCredits);
}

/** Why Generate waits, in one line; undefined when it can go. */
export function createProblem(draft: CreateDraft, chosen: CreateEntry | undefined, backends: readonly StudioBackend[], references: readonly StudioReference[] = []): string | undefined {
  const plan = createPlan(draft, chosen, backends, references);
  return typeof plan === "string" ? plan : undefined;
}

/** The spec of one create (see `createPlan`); undefined while something is in the way. */
export function createSpec(draft: CreateDraft, chosen: CreateEntry | undefined, backends: readonly StudioBackend[], confirmCredits?: number, references: readonly StudioReference[] = []): StudioSpec | undefined {
  const plan = createPlan(draft, chosen, backends, references, confirmCredits);
  return typeof plan === "string" ? undefined : plan.spec;
}

/** `project` for a `create`: absent for Unsorted, which is where a job naming none lands. */
export function projectField(id: string): { project?: string } {
  return id === STUDIO_UNSORTED ? {} : { project: id };
}

/** The one `create` the bar sends: `count` jobs, each its own, in the target project, as a child of `parent` when it has one. */
export function createOp(spec: StudioSpec, count: number, project: string, parent?: StudioParent): Extract<StudioOp, { kind: "create" }> {
  return { kind: "create", spec, origin: "phone", ...(count > 1 ? { count } : {}), ...projectField(project), ...(parent === undefined ? {} : { parent }) };
}

/** How many images the draft can carry: an edit's references (Codex takes 4, FLUX.2 klein 2, a paid model none), or the video model's own count. */
export function refLimit(draft: CreateDraft, chosen: CreateEntry | undefined, backends: readonly StudioBackend[]): number {
  if (draft.mode === "video") return videoSettings(draft, chosen, backends)?.refs.max ?? 0;
  if (chosen === undefined || chosen.paid) return 0;
  return chosen.backend === "codex-image" ? MAX_STUDIO_REFS : MAX_KLEIN_REFS;
}
