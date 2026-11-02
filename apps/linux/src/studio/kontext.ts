// Local FLUX.1 Kontext dev image edits on the Mac's GPU: `mflux-generate-kontext` from the mflux uv
// tool, on the community Q8 conversion in the Hugging Face cache. One reference image plus a prompt
// ("same character, new pose"). The CLI runs in its own process group like LTX, so a cancel signals
// the whole group. The model is read from the cache only (HF_HUB_OFFLINE), never downloaded mid-job.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StudioBackend } from "@relay/protocol";
import { BACKEND_BASE, parseSize } from "./backends";
import { LTX_KILL_GRACE_MS, runProcessGroup } from "./ltx";
import type { StudioRunInput, StudioRunner, StudioRunOutput } from "./runner";

export const KONTEXT_MODEL = "mflux-community/flux-1-dev-kontext-mflux-q8";
export const KONTEXT_STEPS = 24;
export const KONTEXT_GUIDANCE = 2.5;
const PATH_PREFIX = "/opt/homebrew/bin:/usr/local/bin";
/** tqdm's bar redraw, e.g. `| 7/24 [00:41<01:40, 5.9s/it]`. */
const STEP_LINE = /\|\s*(\d+)\/(\d+)\s*\[/;

/** The CLI's argv for one job, writing the image to `out`. */
export function kontextArgv(bin: string, input: Pick<StudioRunInput, "spec" | "seed" | "refs">, out: string): [string, ...string[]] {
  const { spec, seed, refs } = input;
  const size = parseSize(spec.resolution);
  if (size === null) throw new Error(`Kontext has no size ${spec.resolution}`);
  const ref = refs[0];
  if (ref === undefined) throw new Error("Kontext needs a reference image");
  const argv: [string, ...string[]] = [
    bin,
    "--model", KONTEXT_MODEL,
    "--base-model", "dev-kontext",
    "--image-path", ref,
    "--prompt", spec.prompt,
    "--width", String(size[0]),
    "--height", String(size[1]),
    "--steps", String(KONTEXT_STEPS),
    "--guidance", String(KONTEXT_GUIDANCE),
  ];
  if (seed !== undefined) argv.push("--seed", String(seed));
  argv.push("--output", out);
  return argv;
}

export interface KontextPaths {
  /** `mflux-generate-kontext`. */
  readonly bin: string;
  /** The model's `snapshots` dir in the Hugging Face cache. */
  readonly snapshots: string;
}

export function defaultKontextPaths(env: NodeJS.ProcessEnv = process.env): KontextPaths {
  const hfHome = env["HF_HOME"] ?? join(homedir(), ".cache", "huggingface");
  return {
    bin: env["RELAY_STUDIO_KONTEXT_BIN"] ?? join(homedir(), ".local", "share", "uv", "tools", "mflux", "bin", "mflux-generate-kontext"),
    snapshots: join(hfHome, "hub", `models--${KONTEXT_MODEL.replace("/", "--")}`, "snapshots"),
  };
}

export class KontextRunner implements StudioRunner {
  constructor(
    private readonly paths: KontextPaths = defaultKontextPaths(),
    private readonly graceMs = LTX_KILL_GRACE_MS,
  ) {}

  describe(): Promise<StudioBackend> {
    const down = (reason: string): StudioBackend => ({ ...BACKEND_BASE.kontext, available: false, reason });
    if (!existsSync(this.paths.bin)) return Promise.resolve(down(`Kontext is not set up on this host (no mflux at ${this.paths.bin})`));
    const cached = existsSync(this.paths.snapshots) && readdirSync(this.paths.snapshots).length > 0;
    if (!cached) return Promise.resolve(down(`Kontext is not set up on this host (${KONTEXT_MODEL} is not in the Hugging Face cache)`));
    return Promise.resolve({ ...BACKEND_BASE.kontext, available: true });
  }

  async run(input: StudioRunInput): Promise<StudioRunOutput> {
    const out = join(input.workDir, "out.png");
    input.note("Loading FLUX Kontext");
    await runProcessGroup(kontextArgv(this.paths.bin, input, out), {
      env: { ...process.env, PATH: `${PATH_PREFIX}:${process.env["PATH"] ?? "/usr/bin:/bin"}`, HF_HUB_OFFLINE: "1" },
      signal: input.signal,
      graceMs: this.graceMs,
      onLine: (line) => {
        const step = STEP_LINE.exec(line);
        if (step !== null) input.note(`Step ${step[1]} of ${step[2]}`);
      },
    });
    if (!existsSync(out)) throw new Error("Kontext finished without writing an image");
    return { path: out, mimeType: "image/png" };
  }
}
