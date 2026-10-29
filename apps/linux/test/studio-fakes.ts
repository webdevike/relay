// Fakes for the Studio suites (studio*.test.ts, session.test.ts): a clock that only moves when told,
// ffmpeg that writes placeholder bytes, and runners whose jobs finish when the test says so.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StudioBackend, StudioBackendId, StudioSpec } from "@relay/protocol";
import { BACKEND_BASE } from "../src/studio/backends";
import type { StudioMedia } from "../src/studio/media";
import type { StudioRunInput, StudioRunner, StudioRunOutput } from "../src/studio/runner";
import { StudioService, type StudioMessage } from "../src/studio/service";
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
}

/** Images probe 100x200, mp4s 480x848 and 5 s; thumbs and frames are placeholder bytes. */
export function fakeMedia(): FakeMedia {
  const frameCalls: { src: string; at: string }[] = [];
  return {
    frameCalls,
    probe: (path) => Promise.resolve(path.endsWith(".mp4") ? { width: 480, height: 848, durationMs: 5000 } : { width: 100, height: 200, durationMs: 40 }),
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
  };
}

export interface FakeRun {
  readonly input: StudioRunInput;
  /** Writes an output into the job's work dir and resolves. */
  succeed(): void;
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
      succeed: () => {
        const path = join(input.workDir, video ? "out.mp4" : "out.png");
        writeFileSync(path, video ? MP4 : PNG);
        resolve({ path, mimeType: video ? "video/mp4" : "image/png" });
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

export interface StudioHarness {
  readonly dir: string;
  readonly clock: FakeClock;
  readonly sent: StudioMessage[];
  readonly runners: Record<StudioBackendId, FakeRunner>;
  readonly media: FakeMedia;
  readonly service: StudioService;
}

/** A started service on `dir` with fake runners (every backend available), seed 42. */
export function studioHarness(dir: string): StudioHarness {
  const clock = new FakeClock();
  const sent: StudioMessage[] = [];
  const backends = availableBackends();
  const runners: Record<StudioBackendId, FakeRunner> = {
    ltx: new FakeRunner(backends.ltx),
    "codex-image": new FakeRunner(backends["codex-image"]),
    "codex-edit": new FakeRunner(backends["codex-edit"]),
    higgsfield: new FakeRunner(backends.higgsfield),
  };
  const media = fakeMedia();
  const service = new StudioService({
    dir,
    runners,
    media,
    emit: (message) => sent.push(message),
    clock,
    log: () => undefined,
    seed: () => 42,
  });
  service.start();
  return { dir, clock, sent, runners, media, service };
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
  return { mode: "video", backend: "ltx", prompt: "a fox in snow", aspect: "9:16", resolution: "480x848", seconds: 5, ...over };
}

export function imageSpec(over: Partial<StudioSpec> = {}): StudioSpec {
  return { mode: "image", backend: "codex-image", prompt: "a red kite", aspect: "9:16", resolution: "1088x1920", ...over };
}

export function paidSpec(over: Partial<StudioSpec> = {}): StudioSpec {
  return { mode: "video", backend: "higgsfield", model: "kling3_0", prompt: "a slow pan", aspect: "9:16", resolution: "std", seconds: 5, ...over };
}
