// Fakes for the Studio suites (studio*.test.ts, session.test.ts): a clock that only moves when told,
// ffmpeg that writes placeholder bytes, runners whose jobs finish when the test says so, a GPU lock
// another process can hold, and a SAM 2.1 that finds two objects.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StudioBackend, StudioBackendId, StudioSpec } from "@relay/protocol";
import { BACKEND_BASE } from "../src/studio/backends";
import type { GpuLock, GpuLockRequest } from "../src/studio/gpu-lock";
import type { StudioMedia } from "../src/studio/media";
import type { StudioRunInput, StudioRunner, StudioRunOutput } from "../src/studio/runner";
import { StudioService, type SegmentFile, type StudioMessage, type StudioSegmenter } from "../src/studio/service";
import type { SessionClock } from "../src/session";

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
export const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4]);

export class FakeClock implements SessionClock {
  private timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  private current = 1_000_000;
  now(): number {
    return this.current;
  }
  after(ms: number, fn: () => void): () => void {
    const timer = { at: this.current + ms, fn, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }
  /** Moves time on and runs the timers due by then (once each; a timer set meanwhile waits for the next call). */
  advance(ms: number): void {
    this.current += ms;
    const due = this.timers.filter((timer) => !timer.cancelled && timer.at <= this.current);
    this.timers = this.timers.filter((timer) => !due.includes(timer));
    for (const timer of due) timer.fn();
  }
}

export interface FakeMedia extends StudioMedia {
  readonly frameCalls: { readonly src: string; readonly at: string }[];
  readonly coverCalls: {
    readonly src: string;
    readonly dest: string;
    readonly width: number;
    readonly height: number;
  }[];
  readonly compositeCalls: { readonly source: string; readonly edited: string; readonly mask: string; readonly out: string }[];
}

/** Images probe 100x200, mp4s 480x848 and 5 s; thumbs, frames, crops and composites are placeholder bytes. */
export function fakeMedia(): FakeMedia {
  const frameCalls: { src: string; at: string }[] = [];
  const coverCalls: { src: string; dest: string; width: number; height: number }[] = [];
  const compositeCalls: { source: string; edited: string; mask: string; out: string }[] = [];
  return {
    frameCalls,
    coverCalls,
    compositeCalls,
    probe: (path) =>
      Promise.resolve(
        path.endsWith(".mp4")
          ? { width: 480, height: 848, durationMs: 5000 }
          : { width: 100, height: 200, durationMs: 40 },
      ),
    thumb: (_src, dest) => {
      writeFileSync(dest, JPEG);
      return Promise.resolve(true);
    },
    frame: (src, at, dest) => {
      frameCalls.push({ src, at });
      writeFileSync(dest, PNG);
      return Promise.resolve();
    },
    jpeg: () => Promise.resolve(JPEG),
    cover: (src, dest, width, height) => {
      coverCalls.push({ src, dest, width, height });
      writeFileSync(dest, PNG);
      return Promise.resolve();
    },
    compositeMasked: (source, edited, mask, out) => {
      compositeCalls.push({ source, edited, mask, out });
      writeFileSync(out, PNG);
      return Promise.resolve();
    },
    crop: (_src, dest) => {
      writeFileSync(dest, PNG);
      return Promise.resolve();
    },
  };
}

export interface FakeRun {
  readonly input: StudioRunInput;
  /** Writes an output into the job's work dir and resolves, reporting `copies` as the backend's own copies. */
  succeed(copies?: readonly string[]): void;
  fail(message: string): void;
}

/** A runner whose jobs wait for the test; it never stops on abort by itself (the test plays the runner). */
export class FakeRunner implements StudioRunner {
  readonly runs: FakeRun[] = [];
  readonly quotes: StudioSpec[] = [];
  price = 10;
  credits = 100;

  constructor(public backend: StudioBackend) {}

  describe(): Promise<StudioBackend> {
    return Promise.resolve(this.backend);
  }

  run(input: StudioRunInput): Promise<StudioRunOutput> {
    const { promise, resolve, reject } = Promise.withResolvers<StudioRunOutput>();
    const video = this.backend.mode === "video";
    this.runs.push({
      input,
      succeed: (copies) => {
        const path = join(input.workDir, video ? "out.mp4" : "out.png");
        writeFileSync(path, video ? MP4 : PNG);
        resolve({ path, mimeType: video ? "video/mp4" : "image/png", ...(copies === undefined ? {} : { copies }) });
      },
      fail: (message) => {
        reject(new Error(message));
      },
    });
    return promise;
  }

  quote(spec: StudioSpec): Promise<number> {
    this.quotes.push(spec);
    return Promise.resolve(this.price);
  }

  balance(): Promise<number | undefined> {
    return Promise.resolve(this.credits);
  }
}

export function availableBackends(): Record<StudioBackendId, StudioBackend> {
  return {
    ltx: { ...BACKEND_BASE.ltx, available: true },
    "codex-image": { ...BACKEND_BASE["codex-image"], available: true },
    "codex-edit": { ...BACKEND_BASE["codex-edit"], available: true },
    moss: {
      ...BACKEND_BASE.moss,
      available: true,
      models: [
        {
          id: "moss-image",
          name: "MOSS-Image",
          mode: "image",
          resolutions: [{ id: "768x1344", label: "Portrait", aspect: "9:16" }],
          seconds: [],
          frames: [],
          refs: 0,
          estimateMs: 120_000,
          inputs: [{ kind: "choice", id: "turbo", label: "Turbo", options: [{ id: "on", label: "On" }, { id: "off", label: "Off" }], default: "on" }],
        },
      ],
    },
    kontext: { ...BACKEND_BASE.kontext, available: true },
    comfyui: {
      ...BACKEND_BASE.comfyui,
      available: true,
      models: [
        {
          id: "angles",
          name: "Angles",
          mode: "image",
          resolutions: [{ id: "1mp", label: "1 MP", aspect: "1:1" }],
          seconds: [],
          frames: [],
          refs: 1,
          estimateMs: 60_000,
          inputs: [
            { kind: "choice", id: "angle", label: "Angle", options: [{ id: "left", label: "Left" }, { id: "top", label: "Top" }], default: "left" },
            { kind: "number", id: "strength", label: "Strength", min: 0, max: 1, step: 0.1, default: 0.8 },
          ],
        },
      ],
    },
    "comfyui-video": { ...BACKEND_BASE["comfyui-video"], available: true },
    sam: { ...BACKEND_BASE.sam, available: true },
    crop: { ...BACKEND_BASE.crop, available: true },
    higgsfield: {
      ...BACKEND_BASE.higgsfield,
      available: true,
      balance: 100,
      models: [
        {
          id: "kling3_0",
          name: "Kling v3.0",
          mode: "video",
          resolutions: [{ id: "std", label: "Standard", aspect: "9:16" }],
          seconds: [5, 10],
          frames: ["start", "end"],
        },
      ],
    },
  };
}

/**
 * The machine-wide GPU lock without the file: one holder at a time; `holdElsewhere()` plays another process
 * (LTX's draft.py, say) holding it, so acquires wait and say so until `freeElsewhere()`.
 */
export class FakeGpuLock implements GpuLock {
  /** Each holder line, in the order the lock was granted. */
  readonly granted: string[] = [];
  held = 0;
  /** The most holders at once (1 when it serialises). */
  maxHeld = 0;
  private elsewhere = false;
  private readonly waiters: (() => void)[] = [];

  holdElsewhere(): void {
    this.elsewhere = true;
  }

  freeElsewhere(): void {
    this.elsewhere = false;
    for (const wake of this.waiters.splice(0)) wake();
  }

  async acquire(request: GpuLockRequest): Promise<() => Promise<void>> {
    let said = false;
    while (this.elsewhere || this.held > 0) {
      if (this.elsewhere && !said) {
        said = true;
        request.waiting(true);
      }
      const { promise, resolve } = Promise.withResolvers<undefined>();
      this.waiters.push(() => {
        resolve(undefined);
      });
      await promise;
    }
    if (said) request.waiting(false);
    this.held++;
    this.maxHeld = Math.max(this.maxHeld, this.held);
    this.granted.push(request.holder);
    return () => {
      this.held--;
      for (const wake of this.waiters.splice(0)) wake();
      return Promise.resolve();
    };
  }
}

export interface FakeSegmentRun {
  readonly image: string;
  readonly outDir: string;
  /** Writes two objects' masks and cut-outs into the run's dir and resolves. */
  finish(): void;
  fail(message: string): void;
}

/** SAM 2.1 whose runs wait for the test. */
export class FakeSegmenter implements StudioSegmenter {
  readonly runs: FakeSegmentRun[] = [];

  segment(image: string, outDir: string): Promise<readonly SegmentFile[]> {
    const { promise, resolve, reject } = Promise.withResolvers<readonly SegmentFile[]>();
    this.runs.push({
      image,
      outDir,
      finish: () => {
        const files = [
          { label: "Object 1", box: [0.1, 0.2, 0.5, 0.6] as const, area: 0.3 },
          { label: "Background", box: [0, 0, 1, 1] as const, area: 0.7 },
        ].map((found, index) => {
          const mask = join(outDir, `segment-${String(index)}-mask.png`);
          const cutout = join(outDir, `segment-${String(index)}-cutout.png`);
          writeFileSync(mask, PNG);
          writeFileSync(cutout, PNG);
          return { ...found, mask, cutout };
        });
        resolve(files);
      },
      fail: (message) => {
        reject(new Error(message));
      },
    });
    return promise;
  }
}

export interface StudioHarness {
  readonly dir: string;
  readonly clock: FakeClock;
  readonly sent: StudioMessage[];
  readonly runners: Record<StudioBackendId, FakeRunner>;
  readonly media: FakeMedia;
  readonly lock: FakeGpuLock;
  readonly segmenter: FakeSegmenter;
  readonly service: StudioService;
}

/**
 * A started service on `dir` with fake runners (every backend available; `real` swaps in real runners for
 * some), a fake GPU lock and SAM 2.1, seed 42.
 */
export function studioHarness(
  dir: string,
  gpuHeld?: () => boolean,
  real: Partial<Record<StudioBackendId, StudioRunner>> = {},
): StudioHarness {
  const clock = new FakeClock();
  const sent: StudioMessage[] = [];
  const backends = availableBackends();
  const runners: Record<StudioBackendId, FakeRunner> = {
    ltx: new FakeRunner(backends.ltx),
    "codex-image": new FakeRunner(backends["codex-image"]),
    "codex-edit": new FakeRunner(backends["codex-edit"]),
    moss: new FakeRunner(backends.moss),
    kontext: new FakeRunner(backends.kontext),
    comfyui: new FakeRunner(backends.comfyui),
    "comfyui-video": new FakeRunner(backends["comfyui-video"]),
    sam: new FakeRunner(backends.sam),
    crop: new FakeRunner(backends.crop),
    higgsfield: new FakeRunner(backends.higgsfield),
  };
  const media = fakeMedia();
  const lock = new FakeGpuLock();
  const segmenter = new FakeSegmenter();
  const service = new StudioService({
    dir,
    runners: { ...runners, ...real },
    segmenter,
    gpuLock: lock,
    media,
    emit: (message) => sent.push(message),
    clock,
    log: () => undefined,
    seed: () => 42,
    ...(gpuHeld === undefined ? {} : { gpuHeld }),
  });
  service.start();
  return { dir, clock, sent, runners, media, lock, segmenter, service };
}

/** Lets pending promise callbacks (runner settlements, ingest) run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const { promise, resolve } = Promise.withResolvers<undefined>();
    setImmediate(() => {
      resolve(undefined);
    });
    await promise;
  }
}

export function ltxSpec(over: Partial<StudioSpec> = {}): StudioSpec {
  return {
    mode: "video",
    backend: "ltx",
    prompt: "a fox in snow",
    aspect: "9:16",
    resolution: "480x848",
    seconds: 5,
    ...over,
  };
}

export function imageSpec(over: Partial<StudioSpec> = {}): StudioSpec {
  return {
    mode: "image",
    backend: "codex-image",
    prompt: "a red kite",
    aspect: "9:16",
    resolution: "1088x1920",
    ...over,
  };
}

export function paidSpec(over: Partial<StudioSpec> = {}): StudioSpec {
  return {
    mode: "video",
    backend: "higgsfield",
    model: "kling3_0",
    prompt: "a slow pan",
    aspect: "9:16",
    resolution: "std",
    seconds: 5,
    ...over,
  };
}
