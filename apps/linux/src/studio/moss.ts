// Local MOSS-Image text to image on native Apple MLX, run directly (no ComfyUI server): `moss.py` in
// `<agent-home>/work/local-higgsfield/moss-mlx` (`$RELAY_STUDIO_MOSS_DIR`) on the moss-image-mlx venv's Python
// (`~/.local/share/moss-mlx/.venv`, `$RELAY_STUDIO_MOSS_PYTHON`), one process per image in its own process group like
// LTX, so a cancel signals the whole group (a fine-tune's conversion included).
//
// Models: MOSS-Image (the 8bit tier's own SFT transformer) plus every MOSS-Image fine-tune on this Mac: a ComfyUI-format
// checkpoint in `<local-higgsfield>/models/diffusion_models` (recognised by its keys, e.g. Jib Mix Moss int8), or an MLX
// transformer directory already converted into `~/.local/share/moss-mlx/transformers/<name>`. Read again on every
// describe, so a dropped-in checkpoint shows up on the next Studio open.
//
// moss.py, in order: checks every cached file (about a second; a missing one fails with one `[moss] error:` line naming
// it and the setup command), runs the prompt enhancer (local Qwen3), takes the machine-wide GPU lock
// (`~/.cache/eva-gpu.lock`, shared with LTX's draft.py; Studio shows the wait), converts a fine-tune on first use,
// then samples (`step i/n`). Offline: the model is read from the Hugging Face cache only.

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { StudioBackend, StudioInput, StudioModel, StudioResolution } from "@relay/protocol";
import { BACKEND_BASE, MOSS_TURBO_ESTIMATE_MS, parseSize } from "./backends";
import { LTX_KILL_GRACE_MS, runProcessGroup } from "./ltx";
import type { StudioRunInput, StudioRunner, StudioRunOutput } from "./runner";

export const MOSS_TIER = "VisualInference/MOSS-Image-SFT-MLX-8bit";
/** The model id of MOSS-Image itself (the tier's own SFT transformer). */
export const MOSS_SFT = "moss-image";
/** Comfy-Org's int8 SFT file is the tier's own transformer; listing it would only add a slow conversion. */
const SFT_COMFY_FILE = "moss_image_sft_int8_convrot.safetensors";
/** A safetensors header bigger than this is not a checkpoint we read. */
const MAX_HEADER_BYTES = 64 * 1024 * 1024;
const PATH_PREFIX = "/opt/homebrew/bin:/usr/local/bin";
const STEP_LINE = /^step (\d+)\/(\d+)/;
/** Quantization or variant tags dropped from a file name to name the model ("Jib_Mix_Moss_V2_H_int8" is "Jib Mix Moss V2"). */
const NAME_TAG = /^(int8|int4|fp8|fp16|bf16|fp32|q\d\w*|[a-z])$/i;

const RESOLUTIONS: StudioResolution[] = [
  { id: "768x1344", label: "Portrait", aspect: "9:16" },
  { id: "1344x768", label: "Landscape", aspect: "16:9" },
  { id: "1024x1024", label: "Square", aspect: "1:1" },
];

const INPUTS: StudioInput[] = [
  {
    kind: "choice",
    id: "turbo",
    label: "Turbo",
    default: "on",
    options: [
      { id: "on", label: "On (about 2 min)" },
      { id: "off", label: "Off (50 steps, slower)" },
    ],
  },
  {
    kind: "choice",
    id: "enhance",
    label: "Prompt enhancer",
    default: "on",
    options: [
      { id: "on", label: "On (local Qwen3 rewrites it)" },
      { id: "off", label: "Off (prompt as typed)" },
    ],
  },
];

export interface MossPaths {
  /** The moss-image-mlx venv's Python. */
  readonly python: string;
  /** `moss.py`. */
  readonly script: string;
  /** Where ComfyUI-format fine-tunes are dropped (`local-higgsfield/models/diffusion_models`). */
  readonly checkpoints: string;
  /** Converted MLX transformer directories, one per fine-tune. */
  readonly transformers: string;
  /** The tier's `snapshots` dir in the Hugging Face cache. */
  readonly snapshots: string;
}

export function defaultMossPaths(agentHome: string, env: NodeJS.ProcessEnv = process.env): MossPaths {
  const root = join(agentHome, "work", "local-higgsfield");
  const dir = env["RELAY_STUDIO_MOSS_DIR"] ?? join(root, "moss-mlx");
  const home = join(homedir(), ".local", "share", "moss-mlx");
  const hub = env["HF_HUB_CACHE"] ?? join(env["HF_HOME"] ?? join(homedir(), ".cache", "huggingface"), "hub");
  return {
    python: env["RELAY_STUDIO_MOSS_PYTHON"] ?? join(home, ".venv", "bin", "python"),
    script: join(dir, "moss.py"),
    checkpoints: join(root, "models", "diffusion_models"),
    transformers: join(home, "transformers"),
    snapshots: join(hub, `models--${MOSS_TIER.replace("/", "--")}`, "snapshots"),
  };
}

/** A fine-tune: its converted directory (maybe not made yet) and the checkpoint it comes from (maybe removed since). */
interface FineTune {
  readonly transformer: string;
  readonly source?: string;
}

/** "Jib Mix Moss V2" from `Jib_Mix_Moss_V2_H_int8`. */
export function fineTuneName(stem: string): string {
  const words = stem.split(/[_\s-]+/).filter((word) => word !== "");
  while (words.length > 1 && NAME_TAG.test(words.at(-1) ?? "")) words.pop();
  return words.join(" ");
}

function model(id: string, name: string, description: string): StudioModel {
  return {
    id,
    name,
    mode: "image",
    description,
    resolutions: RESOLUTIONS,
    seconds: [],
    frames: [],
    refs: 0,
    inputs: INPUTS,
    estimateMs: MOSS_TURBO_ESTIMATE_MS,
  };
}

export class MossRunner implements StudioRunner {
  /** Whether a checkpoint is a MOSS-Image transformer, by path, size and mtime. */
  private readonly mossFiles = new Map<string, boolean>();

  constructor(
    private readonly paths: MossPaths,
    /** Before each run: ComfyUI unloads its models, so the unified memory is MOSS's. */
    private readonly beforeRun: () => Promise<void> = () => Promise.resolve(),
    private readonly graceMs = LTX_KILL_GRACE_MS,
  ) {}

  describe(): Promise<StudioBackend> {
    const down = (reason: string): StudioBackend => ({ ...BACKEND_BASE.moss, available: false, reason, models: [] });
    const missing = [this.paths.script, this.paths.python].find((path) => !existsSync(path));
    if (missing !== undefined) return Promise.resolve(down(`MOSS-Image is not set up on this host (no ${missing})`));
    const cached = existsSync(this.paths.snapshots) && readdirSync(this.paths.snapshots).length > 0;
    if (!cached) return Promise.resolve(down(`MOSS-Image is not set up on this host (${MOSS_TIER} is not in the Hugging Face cache; run ${this.paths.script} --setup)`));
    const models = [model(MOSS_SFT, "MOSS-Image", "Text and layouts in the image. Local, MLX.")];
    for (const [id, fineTune] of this.fineTunes()) {
      const ready = existsSync(join(fineTune.transformer, "config.json"));
      models.push(model(id, fineTuneName(id), ready ? "MOSS-Image fine-tune. Local, MLX." : "MOSS-Image fine-tune. Local, MLX; the first run converts it."));
    }
    return Promise.resolve({ ...BACKEND_BASE.moss, available: true, models });
  }

  async run(input: StudioRunInput): Promise<StudioRunOutput> {
    const { spec } = input;
    const size = parseSize(spec.resolution);
    if (size === null) throw new Error(`MOSS-Image has no size ${spec.resolution}`);
    const id = spec.model ?? MOSS_SFT;
    const fineTune = id === MOSS_SFT ? null : this.fineTunes().get(id);
    if (fineTune === undefined) throw new Error(`There is no MOSS-Image model ${id} on this host`);
    const out = join(input.workDir, "out.png");
    const argv: [string, ...string[]] = [
      this.paths.python, "-u", this.paths.script,
      "--prompt", spec.prompt,
      "--width", String(size[0]),
      "--height", String(size[1]),
      "--seed", String(input.seed ?? 0),
      "--out", out,
    ];
    if ((spec.params?.["turbo"] ?? "on") === "on") argv.push("--turbo");
    if ((spec.params?.["enhance"] ?? "on") === "on") argv.push("--enhance");
    if (fineTune !== null) {
      argv.push("--transformer", fineTune.transformer);
      if (fineTune.source !== undefined) argv.push("--source", fineTune.source);
    }
    await this.beforeRun().catch(() => undefined);
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${PATH_PREFIX}:${process.env["PATH"] ?? "/usr/bin:/bin"}`, HF_HUB_OFFLINE: "1", PYTHONUNBUFFERED: "1" };
    delete env["PYTHONPATH"];
    /** moss.py's own `[moss] error:` line, when it printed one. */
    const failure = { reason: null as string | null };
    try {
      await runProcessGroup(argv, {
        env,
        signal: input.signal,
        graceMs: this.graceMs,
        onLine: (line) => {
          const step = STEP_LINE.exec(line);
          if (step !== null) input.note(`Step ${step[1] ?? ""} of ${step[2] ?? ""}`);
          else if (line.startsWith("[moss] error: ")) failure.reason = line.slice("[moss] error: ".length).trim();
          else if (line.startsWith("[moss] waiting for GPU")) input.blocked(true);
          else if (line.startsWith("[moss] GPU lock acquired")) input.blocked(false);
          else if (line === "[moss] checking files") input.note("Checking the model files");
          else if (line === "[moss] enhancing the prompt") input.note("Enhancing the prompt");
          else if (line.startsWith("[moss] converting")) input.note(`Converting ${fineTuneName(id)} to MLX (first use)`);
          else if (line === "[moss] loading the model") input.note("Loading MOSS-Image");
        },
      });
    } catch (error) {
      // moss.py's own one-line reason (a missing file and how to get it) beats the stderr tail.
      if (failure.reason !== null && !input.signal.aborted) throw new Error(failure.reason, { cause: error });
      throw error;
    }
    if (!existsSync(out)) throw new Error("MOSS-Image finished without writing an image");
    return { path: out, mimeType: "image/png" };
  }

  /** Every fine-tune on this Mac by model id (its file or directory name), sorted. */
  private fineTunes(): Map<string, FineTune> {
    const found = new Map<string, FineTune>();
    for (const name of list(this.paths.checkpoints)) {
      const path = join(this.paths.checkpoints, name);
      if (!name.endsWith(".safetensors") || name === SFT_COMFY_FILE || !this.isMoss(path)) continue;
      const id = basename(name, ".safetensors");
      found.set(id, { transformer: join(this.paths.transformers, id), source: path });
    }
    for (const id of list(this.paths.transformers)) {
      const transformer = join(this.paths.transformers, id);
      if (!found.has(id) && existsSync(join(transformer, "config.json"))) found.set(id, { transformer });
    }
    return new Map([...found].filter(([id]) => id.length <= 100).sort(([a], [b]) => a.localeCompare(b)));
  }

  /** A MOSS-Image transformer checkpoint: its safetensors header names MOSS's video head (with or without ComfyUI's prefix). */
  private isMoss(path: string): boolean {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return false;
    }
    const key = `${path}\n${String(stat.size)}\n${String(stat.mtimeMs)}`;
    const known = this.mossFiles.get(key);
    if (known !== undefined) return known;
    const moss = readHeaderKeys(path).some((name) => name.replace(/^model\.diffusion_model\./, "") === "final_linear_video.weight");
    this.mossFiles.set(key, moss);
    return moss;
  }
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** The tensor names in a safetensors file's header; none when it is not one. */
function readHeaderKeys(path: string): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const prefix = Buffer.alloc(8);
    if (readSync(fd, prefix, 0, 8, 0) !== 8) return [];
    const length = Number(prefix.readBigUInt64LE());
    if (length <= 0 || length > MAX_HEADER_BYTES) return [];
    const header = Buffer.alloc(length);
    if (readSync(fd, header, 0, length, 8) !== length) return [];
    const parsed: unknown = JSON.parse(header.toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? Object.keys(parsed) : [];
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
