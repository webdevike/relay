/**
 * What the editor's "Describe your edit" bar sends, the same recipe as Relay desktop: one `create`
 * of one image whose parent is the version on screen (`how: "edit"`), with that version as the
 * only reference, in its job's project, at the wire aspect closest to the image and the engine's
 * first size for it. Engines: Qwen Image Edit (ComfyUI preset `qwen-edit`, the default), FLUX
 * Kontext (`kontext`), Codex edit (`codex-edit`).
 */
import {
  studioProjectOf,
  studioResolutions,
  type StudioAspect,
  type StudioBackend,
  type StudioBackendId,
  type StudioItem,
  type StudioOp,
} from "@relay/protocol";
import { projectField, STUDIO_ASPECTS } from "./create";

export type EditEngineId = "qwen" | "kontext" | "codex";

export interface EditEngine {
  id: EditEngineId;
  label: string;
  /** Where it runs, the muted hint beside the name. */
  where: string;
  backend: StudioBackendId;
  model?: string;
}

export const EDIT_ENGINES: readonly EditEngine[] = [
  { id: "qwen", label: "Qwen Image Edit", where: "local", backend: "comfyui", model: "qwen-edit" },
  { id: "kontext", label: "FLUX Kontext", where: "local", backend: "kontext" },
  { id: "codex", label: "Codex edit", where: "ChatGPT", backend: "codex-edit" },
];

/** Tapped into an empty bar. */
export const EDIT_SUGGESTIONS: readonly string[] = ["Make it night", "Change the background", "Add warm sunlight", "Turn it into a watercolor"];

/** The wire aspects ordered by how close each is to `width` x `height`, closest first. */
export function aspectsByCloseness(width: number, height: number): StudioAspect[] {
  const ratio = Math.log(width / height);
  const of = (aspect: StudioAspect) => {
    const [w = 1, h = 1] = aspect.split(":").map(Number);
    return Math.abs(Math.log(w / h) - ratio);
  };
  return [...STUDIO_ASPECTS].sort((a, b) => of(a) - of(b));
}

/** Why an engine can't run on this host, in one line; undefined when it can. */
export function engineProblem(engine: EditEngine, backends: readonly StudioBackend[]): string | undefined {
  const backend = backends.find((b) => b.id === engine.backend);
  if (backend === undefined) return `${engine.label} is not on this host`;
  if (!backend.available) return backend.reason ?? `${engine.label} is unavailable`;
  if (engine.model !== undefined && !(backend.models ?? []).some((m) => m.id === engine.model)) return `${engine.label} is not on this host`;
  return undefined;
}

/** Qwen Image Edit unless it can't run here and another engine can. */
export function defaultEngine(backends: readonly StudioBackend[]): EditEngineId {
  return EDIT_ENGINES.find((e) => engineProblem(e, backends) === undefined)?.id ?? "qwen";
}

export type EditRecipe = { ok: true; op: Extract<StudioOp, { kind: "create" }> } | { ok: false; error: string };

/** The `create` that edits `current` with `prompt` on `engineId`. */
export function editRecipe(engineId: EditEngineId, current: StudioItem, prompt: string, backends: readonly StudioBackend[]): EditRecipe {
  const engine = EDIT_ENGINES.find((e) => e.id === engineId) ?? EDIT_ENGINES[0];
  if (engine === undefined) return { ok: false, error: "No edit engine" };
  const text = prompt.trim();
  if (text.length === 0) return { ok: false, error: "Describe the edit first" };
  if (current.asset.kind !== "image") return { ok: false, error: "Only images can be edited" };
  const problem = engineProblem(engine, backends);
  const backend = backends.find((b) => b.id === engine.backend);
  if (problem !== undefined || backend === undefined) return { ok: false, error: problem ?? `${engine.label} is not on this host` };
  // The closest aspect the engine has a size for; presets list one (`1mp`) per aspect.
  let fit: { aspect: StudioAspect; resolution: string } | undefined;
  for (const aspect of aspectsByCloseness(current.asset.width, current.asset.height)) {
    const first = studioResolutions(backend, aspect, engine.model)[0];
    if (first !== undefined) {
      fit = { aspect, resolution: first.id };
      break;
    }
  }
  if (fit === undefined) return { ok: false, error: `${engine.label} lists no sizes` };
  return {
    ok: true,
    op: {
      kind: "create",
      origin: "phone",
      spec: {
        mode: "image",
        backend: engine.backend,
        prompt: text,
        aspect: fit.aspect,
        resolution: fit.resolution,
        refs: [current.asset.id],
        ...(engine.model === undefined ? {} : { model: engine.model }),
      },
      ...projectField(studioProjectOf(current.job)),
      parent: { asset: current.asset.id, how: "edit" },
    },
  };
}
