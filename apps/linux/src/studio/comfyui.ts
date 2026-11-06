// ComfyUI presets: named ComfyUI workflows (API-format JSON) a ComfyUI server runs, listed as the
// `comfyui` (images) and `comfyui-video` (videos) backends' models, like Higgsfield's preset cards.
//
// A preset is a folder in the presets dir: `preset.json` (name, mode, sizes, references, inputs; see
// `PresetManifest`) beside `workflow.json`, whose values may hold `{{name}}` placeholders. A value that
// is only a placeholder becomes the typed value (a number stays a number); a string holding some is
// interpolated. Names: `prompt` (the job's, or the preset's `promptTemplate` filled in), `seed`,
// `width` and `height` (a `WxH` resolution), `image`, `image2`..`image4` (the references, uploaded),
// every `constants` key, and every input id (a choice gives its option's `value`). Presets are read
// again on every describe and run, so a new folder shows up on the next refresh.
//
// A preset is listed only when the server has every node class its workflow uses and every file its
// loaders name (the server's own `/object_info` combos), so a half-installed preset never queues.
// A job uploads its references (`/upload/image`), queues the graph (`/prompt`), shows the sampler's
// steps from the websocket, waits for `/history` to report it, then downloads the first output
// (`/view`). A cancel deletes it from the queue and interrupts it. After ten idle minutes the server
// is asked to unload its models (`/free`), so the unified memory goes back to LTX, Kontext and Qwen.
//
// The server keeps its own copies: every upload in its `input/` dir and every saved output in its
// `output/` dir (`output/studio/` for the presets). When the server runs on this Mac (its dirs are
// configured), a job deletes its uploads once the prompt is done and reports the saved outputs as
// `copies`, which the host deletes with the image; a failed or cancelled job deletes them at once.

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, extname, join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { MAX_STUDIO_PARAMS, MAX_STUDIO_REFS, StudioAspect, StudioFrameSlot, StudioMode, type StudioBackend, type StudioModel } from "@relay/protocol";
import { BACKEND_BASE, parseSize } from "./backends";
import type { Fetch } from "./codex";
import type { StudioRunInput, StudioRunner, StudioRunOutput } from "./runner";

const IDLE_UNLOAD_MS = 10 * 60_000;
const POLL_MS = 1000;
const PROBE_TIMEOUT_MS = 3000;
const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{(\w+)\}\}$/;
const OUTPUT_KEYS = ["images", "gifs", "videos"] as const;
const MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".gif": "image/gif",
};

const word = z.string().min(1).max(40);
const PresetInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("choice"),
    id: word,
    label: z.string().min(1).max(60),
    options: z.array(z.object({ id: word, label: z.string().min(1).max(80), value: z.union([z.string(), z.number()]) })).min(1).max(40),
    default: word,
  }),
  z.object({
    kind: z.literal("number"),
    id: word,
    label: z.string().min(1).max(60),
    min: z.number(),
    max: z.number(),
    step: z.number().positive(),
    default: z.number(),
  }),
]);

/** `preset.json`. */
export const PresetManifest = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name: z.string().min(1).max(120),
  mode: StudioMode,
  description: z.string().max(300).optional(),
  resolutions: z.array(z.object({ id: word, label: z.string().min(1).max(60), aspect: StudioAspect })).min(1).max(20),
  seconds: z.array(z.number().positive()).max(20).default([]),
  frames: z.array(StudioFrameSlot).max(3).default([]),
  refs: z.number().int().min(0).max(MAX_STUDIO_REFS).default(0),
  minRefs: z.number().int().min(0).max(MAX_STUDIO_REFS).optional(),
  /** False: no prompt box; the workflow ignores `{{prompt}}` or uses `promptTemplate` alone. */
  prompt: z.boolean().default(true),
  /** Used when the job's prompt is empty or the preset takes none. */
  defaultPrompt: z.string().max(4000).default(""),
  /** The prompt the workflow sees, e.g. `"{{angle}} {{prompt}}"`; the job's prompt when absent. */
  promptTemplate: z.string().max(4000).optional(),
  inputs: z.array(PresetInput).max(MAX_STUDIO_PARAMS).default([]),
  constants: z.record(z.union([z.string(), z.number()])).default({}),
  /** A typical run on this host, for the ETA before calibration. */
  estimateMs: z.number().positive().default(120_000),
  /** The node whose output is the job's; the first node with an image or video when absent. */
  output: z.string().optional(),
  /**
   * Presets that load the same models (Edit, Product shot, Character on FLUX.2 klein) share a family;
   * switching family unloads the server's models first. The preset's id when absent.
   */
  family: z.string().min(1).max(40).optional(),
});
export type PresetManifest = z.infer<typeof PresetManifest>;

export interface ComfyPreset {
  readonly manifest: PresetManifest;
  readonly workflow: Record<string, ComfyNode>;
}

interface ComfyNode {
  readonly class_type: string;
  readonly inputs: Record<string, unknown>;
}

type Value = string | number;

/** Every valid preset folder under `dir` (sorted by id), and one line per folder that is not. */
export function loadPresets(dir: string): { presets: ComfyPreset[]; problems: string[] } {
  const presets: ComfyPreset[] = [];
  const problems: string[] = [];
  if (!existsSync(dir)) return { presets, problems: [`no presets folder at ${dir}`] };
  for (const name of readdirSync(dir).sort()) {
    const manifestPath = join(dir, name, "preset.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = PresetManifest.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
      const workflow = z
        .record(z.object({ class_type: z.string().min(1), inputs: z.record(z.unknown()) }).passthrough())
        .parse(JSON.parse(readFileSync(join(dir, name, "workflow.json"), "utf8")));
      presets.push({ manifest, workflow });
    } catch (error) {
      problems.push(`${name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  return { presets: presets.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id)), problems };
}

/** `/object_info`: every node class with its inputs. */
const ObjectInfo = z.record(
  z.object({ input: z.object({ required: z.record(z.unknown()).optional(), optional: z.record(z.unknown()).optional() }).passthrough().optional() }).passthrough(),
);
export type ObjectInfo = z.infer<typeof ObjectInfo>;

/** A combo input in `/object_info`: the old `[[...options]]` or the new `["COMBO", {options}]` shape. */
const Combo = z.union([
  z.tuple([z.array(z.unknown())]).rest(z.unknown()),
  z.tuple([z.literal("COMBO"), z.object({ options: z.array(z.unknown()) }).passthrough()]).rest(z.unknown()),
]);

/** Why the server can't run `preset` (a missing node or file), or null. */
export function presetGap(preset: ComfyPreset, objectInfo: ObjectInfo): string | null {
  for (const node of Object.values(preset.workflow)) {
    const info = objectInfo[node.class_type];
    if (info === undefined) return `the server has no ${node.class_type} node`;
    const specs = { ...info.input?.required, ...info.input?.optional };
    for (const [input, value] of Object.entries(node.inputs)) {
      if (typeof value !== "string" || value.includes("{{")) continue;
      const combo = Combo.safeParse(specs[input]);
      if (!combo.success) continue;
      const options = combo.data[0] === "COMBO" ? combo.data[1].options : combo.data[0];
      if (options.length > 0 && !options.includes(value)) return `the server has no ${value} for ${node.class_type}`;
    }
  }
  return null;
}

/** `{{name}}` placeholders filled from `values`; an unknown name is an error. */
export function fillPlaceholders(node: unknown, values: Readonly<Record<string, Value>>): unknown {
  if (Array.isArray(node)) return node.map((item) => fillPlaceholders(item, values));
  if (typeof node === "object" && node !== null)
    return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, fillPlaceholders(item, values)]));
  if (typeof node !== "string") return node;
  const lookup = (name: string): Value => {
    const value = values[name];
    if (value === undefined) throw new Error(`The preset's workflow asks for {{${name}}}, which this job does not have`);
    return value;
  };
  const whole = WHOLE_PLACEHOLDER.exec(node);
  if (whole !== null) return lookup(whole[1] ?? "");
  return node.replace(PLACEHOLDER, (_, name: string) => String(lookup(name)));
}

/** The values a job fills the workflow with, references not yet uploaded. */
export function presetValues(manifest: PresetManifest, input: Pick<StudioRunInput, "spec" | "seed">): Record<string, Value> {
  const { spec } = input;
  const values: Record<string, Value> = { ...manifest.constants, seed: input.seed ?? 0 };
  const size = parseSize(spec.resolution);
  if (size !== null) [values["width"], values["height"]] = size;
  for (const field of manifest.inputs) {
    const given = spec.params?.[field.id] ?? field.default;
    if (field.kind === "choice") {
      const option = field.options.find((candidate) => candidate.id === String(given));
      if (option === undefined) throw new Error(`${manifest.name} has no ${field.label} ${String(given)}`);
      values[field.id] = option.value;
    } else {
      const number = Number(given);
      if (!Number.isFinite(number) || number < field.min || number > field.max)
        throw new Error(`${field.label} must be between ${String(field.min)} and ${String(field.max)}`);
      values[field.id] = number;
    }
  }
  const typed = manifest.prompt && spec.prompt.trim() !== manifest.name ? spec.prompt.trim() : "";
  values["prompt"] = typed === "" ? manifest.defaultPrompt : typed;
  if (manifest.promptTemplate !== undefined)
    values["prompt"] = manifest.promptTemplate.replace(PLACEHOLDER, (_, name: string) => String(values[name] ?? "")).replace(/\s+/g, " ").trim();
  return values;
}

/** The preset as clients see it: a model of the backend. */
export function presetModel(manifest: PresetManifest): StudioModel {
  return {
    id: manifest.id,
    name: manifest.name,
    mode: manifest.mode,
    resolutions: manifest.resolutions,
    seconds: manifest.seconds,
    frames: manifest.frames,
    refs: manifest.refs,
    ...(manifest.minRefs === undefined ? {} : { minRefs: manifest.minRefs }),
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    prompt: manifest.prompt,
    estimateMs: manifest.estimateMs,
    inputs: manifest.inputs.map((field) =>
      field.kind === "choice" ? { ...field, options: field.options.map(({ id, label }) => ({ id, label })) } : field,
    ),
  };
}

const OutputFile = z.object({ filename: z.string().min(1), subfolder: z.string(), type: z.string() });
export type OutputFile = z.infer<typeof OutputFile>;

/** A node's outputs in `/history`: `images`, `gifs` (video combine nodes) or `videos`, among others. */
type NodeOutputs = Record<string, Record<string, unknown>>;

/** The job's output file in a `/history` entry: the manifest's node, else the first image or video. */
export function pickOutput(outputs: NodeOutputs, node?: string): OutputFile | null {
  const entries = node === undefined ? Object.entries(outputs) : Object.entries(outputs).filter(([id]) => id === node);
  for (const [, output] of entries) {
    for (const key of OUTPUT_KEYS) {
      const first = z.array(OutputFile).min(1).safeParse(output[key]);
      if (first.success) return first.data[0] ?? null;
    }
  }
  return null;
}

/** Every file the prompt saved into the server's output dir (`type: "output"`; previews go to its temp dir). */
export function savedOutputs(outputs: NodeOutputs): OutputFile[] {
  return Object.values(outputs).flatMap((output) =>
    OUTPUT_KEYS.flatMap((key) => {
      const files = z.array(OutputFile).safeParse(output[key]);
      return files.success ? files.data.filter((file) => file.type === "output") : [];
    }),
  );
}

/** `dir/parts...` as an absolute path, or null when it would leave `dir` (a server-named `../` subfolder). */
function inside(dir: string, ...parts: string[]): string | null {
  const root = resolve(dir);
  const path = resolve(root, ...parts);
  return path.startsWith(root + sep) ? path : null;
}

const Queued = z.object({ prompt_id: z.string().min(1) });
const Uploaded = z.object({ name: z.string().min(1), subfolder: z.string().optional() });
const Freed = z.unknown();
const SocketMessage = z.object({
  type: z.string(),
  data: z.object({ prompt_id: z.string().nullish(), value: z.number().optional(), max: z.number().optional() }).passthrough(),
});
const History = z.record(
  z.object({
    status: z
      .object({
        completed: z.boolean(),
        status_str: z.string(),
        messages: z.array(z.tuple([z.string(), z.record(z.unknown())])).default([]),
      })
      .optional(),
    outputs: z.record(z.record(z.unknown())).default({}),
  }),
);
const ExecutionError = z.object({ node_type: z.string().optional(), exception_message: z.string().optional() }).passthrough();
const ErrorBody = z.object({
  error: z.object({ message: z.string().optional() }).passthrough().optional(),
  node_errors: z.record(z.object({ errors: z.array(z.object({ message: z.string().optional(), details: z.string().optional() })).default([]) })).default({}),
});

/** What the runner needs from a websocket; tests pass a fake. */
export interface ComfySocket {
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

export interface ComfyUIDeps {
  readonly backend: "comfyui" | "comfyui-video";
  /** The server, e.g. `http://127.0.0.1:8188`. */
  readonly url: string;
  readonly presetsDir: string;
  readonly fetch: Fetch;
  readonly socket: (url: string) => ComfySocket;
  readonly readFile: (path: string) => Promise<Uint8Array>;
  /** The server's `output/` dir when it runs on this Mac: saved outputs are recorded as copies there. */
  readonly outputDir?: string;
  /** The server's `input/` dir when it runs on this Mac: uploads are deleted there after the prompt. */
  readonly inputDir?: string;
}

/**
 * The image server runs on this Mac from `<agentHome>/work/local-higgsfield/ComfyUI` (dirs
 * `$RELAY_STUDIO_COMFYUI_OUTPUT`, `$RELAY_STUDIO_COMFYUI_INPUT`); the video server is on the GPU box, so its
 * dirs are only known when `$RELAY_STUDIO_COMFYUI_VIDEO_OUTPUT` / `_INPUT` name a mount of them.
 */
export function defaultComfyDeps(backend: ComfyUIDeps["backend"], agentHome: string, env: NodeJS.ProcessEnv = process.env): ComfyUIDeps {
  const video = backend === "comfyui-video";
  const comfy = join(agentHome, "work", "local-higgsfield", "ComfyUI");
  const outputDir = video ? env["RELAY_STUDIO_COMFYUI_VIDEO_OUTPUT"] : (env["RELAY_STUDIO_COMFYUI_OUTPUT"] ?? join(comfy, "output"));
  const inputDir = video ? env["RELAY_STUDIO_COMFYUI_VIDEO_INPUT"] : (env["RELAY_STUDIO_COMFYUI_INPUT"] ?? join(comfy, "input"));
  return {
    backend,
    url: (video ? env["RELAY_STUDIO_COMFYUI_VIDEO_URL"] : env["RELAY_STUDIO_COMFYUI_URL"]) ?? (video ? "http://127.0.0.1:18188" : "http://127.0.0.1:8188"),
    presetsDir: env["RELAY_STUDIO_COMFYUI_PRESETS"] ?? join(agentHome, "work", "local-higgsfield", "presets"),
    fetch,
    // Bun's WebSocket has the members ComfySocket names; its MessageEvent handler type just doesn't unify with the fake's.
    socket: (url) => new WebSocket(url) as unknown as ComfySocket,
    readFile: (path) => readFile(path),
    ...(outputDir === undefined ? {} : { outputDir }),
    ...(inputDir === undefined ? {} : { inputDir }),
  };
}

export class ComfyUIRunner implements StudioRunner {
  private idle: NodeJS.Timeout | undefined;
  /** The model family the server last ran (`PresetManifest.family`). */
  private family: string | null = null;

  constructor(
    private readonly deps: ComfyUIDeps,
    private readonly pollMs = POLL_MS,
  ) {}

  private presets(): { presets: ComfyPreset[]; problems: string[] } {
    const mode = BACKEND_BASE[this.deps.backend].mode;
    const loaded = loadPresets(this.deps.presetsDir);
    return { presets: loaded.presets.filter((preset) => preset.manifest.mode === mode), problems: loaded.problems };
  }

  private async json<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, init: RequestInit = {}): Promise<T> {
    const response = await this.deps.fetch(`${this.deps.url}${path}`, init);
    const text = await response.text();
    if (!response.ok) throw new Error(`ComfyUI answered ${String(response.status)} to ${path}: ${comfyError(text)}`);
    const parsed = schema.safeParse(text === "" ? null : JSON.parse(text));
    if (!parsed.success) throw new Error(`ComfyUI answered ${path} with something unexpected`);
    return parsed.data;
  }

  private post<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.json(path, schema, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) });
  }

  async describe(): Promise<StudioBackend> {
    const base = BACKEND_BASE[this.deps.backend];
    const down = (reason: string): StudioBackend => ({ ...base, available: false, reason, models: [] });
    const { presets, problems } = this.presets();
    if (presets.length === 0) return down(problems[0] ?? `no ${base.mode} presets in ${this.deps.presetsDir}`);
    let objectInfo: ObjectInfo;
    try {
      objectInfo = await this.json("/object_info", ObjectInfo, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 5) });
    } catch {
      return down(`ComfyUI is not answering at ${this.deps.url}`);
    }
    const ready = presets.filter((preset) => presetGap(preset, objectInfo) === null);
    if (ready.length === 0) {
      const first = presets[0];
      return down(first === undefined ? "no presets" : `${first.manifest.name}: ${presetGap(first, objectInfo) ?? ""}`);
    }
    return { ...base, available: true, models: ready.map((preset) => presetModel(preset.manifest)) };
  }

  async run(input: StudioRunInput): Promise<StudioRunOutput> {
    clearTimeout(this.idle);
    try {
      return await this.runPreset(input);
    } finally {
      this.idle = setTimeout(() => {
        this.family = null;
        void this.unload().catch(() => undefined);
      }, IDLE_UNLOAD_MS);
      this.idle.unref();
    }
  }

  private unload(): Promise<unknown> {
    return this.post("/free", Freed, { unload_models: true, free_memory: true });
  }

  /**
   * Another local GPU backend (MOSS-Image) is about to run: the server unloads its models now instead of after
   * ten idle minutes. Best effort; never rejects.
   */
  async release(): Promise<void> {
    clearTimeout(this.idle);
    this.family = null;
    await this.json("/free", Freed, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    }).catch(() => undefined);
  }

  private async runPreset(input: StudioRunInput): Promise<StudioRunOutput> {
    const { spec, signal } = input;
    const preset = this.presets().presets.find((candidate) => candidate.manifest.id === spec.model);
    if (preset === undefined) throw new Error(`There is no ComfyUI preset ${spec.model ?? "(none picked)"}`);
    const values = presetValues(preset.manifest, input);
    const family = preset.manifest.family ?? preset.manifest.id;
    if (this.family !== null && this.family !== family) {
      // Custom nodes (SeedVR2) hold their own weights beside ComfyUI's cache; two families at once swap the Mac to a crawl.
      input.note("Unloading the last preset's models");
      await this.unload();
    }
    this.family = family;
    /** Server-side names of this job's uploads, deleted from the input dir when the prompt is done. */
    const uploads: string[] = [];
    /** The output dir's copies of what the prompt saved; deleted unless the run hands them to the host. */
    let copies: string[] = [];
    try {
      input.note("Uploading references");
      for (const [index, path] of input.refs.entries()) {
        const name = await this.upload(path, `${basename(input.workDir)}-${String(index + 1)}`, signal);
        uploads.push(name);
        values[index === 0 ? "image" : `image${String(index + 1)}`] = name;
      }
      const graph = fillPlaceholders(preset.workflow, values);
      const clientId = randomUUID();
      const socket = this.openSocket(clientId, input);
      try {
        input.note("Loading models");
        const { prompt_id: promptId } = await this.post("/prompt", Queued, { prompt: graph, client_id: clientId }, signal);
        socket.promptId = promptId;
        const outputs = await this.finished(promptId, signal);
        const outputDir = this.deps.outputDir;
        if (outputDir !== undefined)
          copies = savedOutputs(outputs).flatMap((saved) => inside(outputDir, saved.subfolder, saved.filename) ?? []);
        const file = pickOutput(outputs, preset.manifest.output);
        if (file === null) throw new Error(`${preset.manifest.name} finished without an output`);
        input.note("Saving");
        const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
        const response = await this.deps.fetch(`${this.deps.url}/view?${query.toString()}`, { signal });
        if (!response.ok) throw new Error(`ComfyUI answered ${String(response.status)} for the output`);
        const ext = extname(file.filename).toLowerCase();
        const out = join(input.workDir, `out${ext}`);
        await writeFile(out, new Uint8Array(await response.arrayBuffer()));
        const kept = copies;
        copies = [];
        return { path: out, mimeType: MIME[ext] ?? "application/octet-stream", ...(kept.length > 0 ? { copies: kept } : {}) };
      } finally {
        socket.close();
      }
    } finally {
      const inputDir = this.deps.inputDir;
      const uploaded = inputDir === undefined ? [] : uploads.flatMap((name) => inside(inputDir, name) ?? []);
      for (const path of [...copies, ...uploaded]) rmSync(path, { force: true });
    }
  }

  private async upload(path: string, stem: string, signal: AbortSignal): Promise<string> {
    const form = new FormData();
    const ext = extname(path) || ".png";
    form.append("image", new Blob([await this.deps.readFile(path)], { type: MIME[ext.toLowerCase()] ?? "image/png" }), `relay-${stem}${ext}`);
    form.append("overwrite", "true");
    const answer = await this.json("/upload/image", Uploaded, { method: "POST", body: form, signal });
    return answer.subfolder ? `${answer.subfolder}/${answer.name}` : answer.name;
  }

  /** Step notes from the websocket; `promptId` is set once the graph is queued. */
  private openSocket(clientId: string, input: StudioRunInput): { promptId: string | null; close: () => void } {
    const state: { promptId: string | null; close: () => void } = { promptId: null, close: () => undefined };
    try {
      const socket = this.deps.socket(`${this.deps.url.replace(/^http/, "ws")}/ws?clientId=${clientId}`);
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        const message = SocketMessage.safeParse(JSON.parse(event.data));
        if (!message.success || message.data.data.prompt_id !== state.promptId) return;
        const { value, max } = message.data.data;
        if (message.data.type === "progress" && value !== undefined && max !== undefined) input.note(`Step ${String(value)} of ${String(max)}`);
      };
      state.close = () => {
        socket.close();
      };
    } catch {
      // Progress is a nicety; the job still finishes through /history.
    }
    return state;
  }

  /** The prompt's outputs once `/history` reports it done; rejects on its error or a cancel. */
  private async finished(promptId: string, signal: AbortSignal): Promise<NodeOutputs> {
    const cancel = (): void => {
      void this.post("/queue", Freed, { delete: [promptId] }).catch(() => undefined);
      void this.post("/interrupt", Freed, { prompt_id: promptId }).catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      for (;;) {
        await sleep(this.pollMs);
        if (signal.aborted) throw new Error("Cancelled");
        const entry = (await this.json(`/history/${promptId}`, History, { signal }))[promptId];
        if (entry?.status === undefined) continue;
        if (entry.status.status_str === "error") {
          const raw = entry.status.messages.find(([kind]) => kind === "execution_error")?.[1];
          const failure = ExecutionError.safeParse(raw);
          const where = failure.success ? ` in ${failure.data.node_type ?? "a node"}: ${(failure.data.exception_message ?? "").trim()}` : "";
          throw new Error(`ComfyUI failed${where}`);
        }
        if (entry.status.completed) return entry.outputs;
      }
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
}

/** ComfyUI's error body in one line: `{error: {message}, node_errors}` or the raw text. */
function comfyError(text: string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return text.slice(0, 300);
  }
  const body = ErrorBody.safeParse(raw);
  if (!body.success) return text.slice(0, 300);
  const node = Object.values(body.data.node_errors)[0]?.errors[0];
  return [body.data.error?.message, node?.message, node?.details].filter(Boolean).join(": ") || text.slice(0, 300);
}
