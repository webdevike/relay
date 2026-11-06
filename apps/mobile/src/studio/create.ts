/**
 * The create bar as plain data: which models make originals (MOSS-Image and the host's MOSS
 * fine-tunes, FLUX.2 klein create, Codex image, the paid backends' image models), the draft Isaac
 * is typing, where its images land, and the one `create` op it sends. A paid model's `create` only
 * leaves through the confirm sheet, which passes the confirmed credits in; the draft never keeps them.
 */
import {
  MAX_STUDIO_COUNT,
  STUDIO_UNSORTED,
  studioResolutions,
  type StudioAspect,
  type StudioBackend,
  type StudioBackendId,
  type StudioOp,
  type StudioProject,
  type StudioSpec,
} from "@relay/protocol";
import { projectName, viewProject, type LibraryView } from "./library";

export const STUDIO_ASPECTS: readonly StudioAspect[] = ["1:1", "16:9", "9:16"];

/** The ComfyUI preset that makes an image from text. */
export const KLEIN_CREATE = "klein-create";

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
  prompt: string;
  /** The chosen entry's key; the default entry when absent or no longer offered. */
  entry?: string | undefined;
  aspect: StudioAspect;
  count: number;
  /** A project id or STUDIO_UNSORTED; null follows the open project. */
  target: string | null;
}

export const EMPTY_CREATE: CreateDraft = { prompt: "", aspect: "1:1", count: 1, target: null };

type Group = Omit<CreateEntry, "key">;

function entry(e: Group): CreateEntry {
  return { ...e, key: `${e.backend}:${e.model ?? ""}` };
}

/** A backend that is down: one disabled entry with its reason. */
function down(b: StudioBackend, group: CreateGroup, label = b.label): CreateEntry {
  return entry({ backend: b.id, label, group, available: false, reason: b.reason ?? `${b.label} is unavailable`, paid: b.paid });
}

/** What the create bar offers for originals, grouped Local, ChatGPT, Paid. */
export function createEntries(backends: readonly StudioBackend[]): CreateEntry[] {
  const out: CreateEntry[] = [];
  const moss = backends.find((b) => b.id === "moss");
  if (moss !== undefined) {
    const models = moss.models?.filter((m) => m.mode === "image") ?? [];
    if (!moss.available || models.length === 0) out.push(down(moss, "Local", "MOSS-Image"));
    else out.push(...models.map((m) => entry({ backend: "moss", model: m.id, label: m.name, group: "Local", available: true, paid: false })));
  }
  const comfy = backends.find((b) => b.id === "comfyui");
  const klein = comfy?.models?.find((m) => m.id === KLEIN_CREATE);
  if (comfy !== undefined && klein !== undefined) {
    out.push(comfy.available ? entry({ backend: "comfyui", model: klein.id, label: klein.name, group: "Local", available: true, paid: false }) : down(comfy, "Local", klein.name));
  }
  const codex = backends.find((b) => b.id === "codex-image");
  if (codex !== undefined) out.push(codex.available ? entry({ backend: codex.id, label: "Codex image", group: "ChatGPT", available: true, paid: false }) : down(codex, "ChatGPT", "Codex image"));
  for (const b of backends.filter((x) => x.paid)) {
    const models = b.models?.filter((m) => m.mode === "image");
    // A paid backend that makes no images (video only) has nothing for the create bar.
    if (models === undefined ? b.mode !== "image" : models.length === 0) continue;
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

/** Paid jobs are confirmed one at a time, so a paid model makes one image per Generate. */
export function createCount(draft: CreateDraft, chosen: CreateEntry | undefined): number {
  return chosen?.paid === true ? 1 : Math.min(Math.max(1, Math.round(draft.count)), MAX_STUDIO_COUNT);
}

/** Where the images land: the draft's project, or the open project (Unsorted from All images and Favorites). */
export function createTarget(draft: CreateDraft, view: LibraryView, projects: readonly StudioProject[]): { id: string; name: string } {
  const exists = (id: string) => id === STUDIO_UNSORTED || projects.some((p) => p.id === id);
  const open = viewProject(view);
  const id = draft.target !== null && exists(draft.target) ? draft.target : open !== undefined && exists(open) ? open : STUDIO_UNSORTED;
  return { id, name: projectName(id, projects) };
}

/** Why Generate waits, in one line; undefined when it can go. */
export function createProblem(draft: CreateDraft, chosen: CreateEntry | undefined, backends: readonly StudioBackend[]): string | undefined {
  if (chosen === undefined) return "No image model on this host";
  if (!chosen.available) return chosen.reason ?? `${chosen.label} is unavailable`;
  const backend = backends.find((b) => b.id === chosen.backend);
  if (backend === undefined || studioResolutions(backend, draft.aspect, chosen.model)[0] === undefined) return `No ${draft.aspect} size for ${chosen.label}`;
  if (draft.prompt.trim().length === 0) return "Describe what to make";
  return undefined;
}

/** The spec of one image: the model's first size for the aspect; no seed (the host picks one per image). */
export function createSpec(draft: CreateDraft, chosen: CreateEntry | undefined, backends: readonly StudioBackend[], confirmCredits?: number): StudioSpec | undefined {
  if (createProblem(draft, chosen, backends) !== undefined || chosen === undefined) return undefined;
  const backend = backends.find((b) => b.id === chosen.backend);
  const resolution = backend === undefined ? undefined : studioResolutions(backend, draft.aspect, chosen.model)[0];
  if (resolution === undefined) return undefined;
  return {
    mode: "image",
    backend: chosen.backend,
    prompt: draft.prompt.trim(),
    aspect: draft.aspect,
    resolution: resolution.id,
    ...(chosen.model === undefined ? {} : { model: chosen.model }),
    ...(confirmCredits === undefined ? {} : { confirmCredits }),
  };
}

/** `project` for a `create`: absent for Unsorted, which is where a job naming none lands. */
export function projectField(id: string): { project?: string } {
  return id === STUDIO_UNSORTED ? {} : { project: id };
}

/** The one `create` the bar sends: `count` images, each its own queued job, in the target project. */
export function createOp(spec: StudioSpec, count: number, project: string): Extract<StudioOp, { kind: "create" }> {
  return { kind: "create", spec, origin: "phone", ...(count > 1 ? { count } : {}), ...projectField(project) };
}
