// The seam between the Studio service and the backends that make things: LTX on the GPU
// (`ltx.ts`), MOSS-Image (`moss.ts`), Kontext (`kontext.ts`), ComfyUI presets (`comfyui.ts`), Codex
// images (`codex.ts`), Higgsfield (`higgsfield.ts`), SAM 2.1 cutouts (`sam.ts`), crops (`crop.ts`).
// Tests swap in fakes.

import type { StudioBackend, StudioFrameSlot, StudioSpec } from "@relay/protocol";

export interface StudioRunInput {
  readonly spec: StudioSpec;
  /** The seed to run with; set iff the backend honors seeds. */
  readonly seed?: number;
  /** Absolute paths of the spec's keyframes. */
  readonly frames: Readonly<Partial<Record<StudioFrameSlot, string>>>;
  /** Absolute paths of the spec's reference images, in order. */
  readonly refs: readonly string[];
  /** `spec.mask`'s mask PNG (grayscale, the size of `refs[0]`, white = the object), when the spec names one. */
  readonly mask?: string;
  /** An empty scratch dir for this job inside the studio dir; the output goes here. Removed after. */
  readonly workDir: string;
  /** Aborted when Isaac cancels the job or the host stops. */
  readonly signal: AbortSignal;
  /** Shows a short status line on the job ("Uploading frames"). */
  readonly note: (text: string) => void;
  /**
   * LTX and MOSS: another process holds the machine-wide GPU lock (`~/.cache/eva-gpu.lock`, taken by
   * draft.py and moss.py) and this job waits for it (true), or it just got the lock (false). The job shows
   * "Waiting for the GPU (another job is using it)" and its ETA restarts once the GPU is free. The service
   * calls it the same way while it takes that lock itself for Kontext, ComfyUI and SAM (`gpu-lock.ts`).
   */
  readonly blocked: (waiting: boolean) => void;
}

export interface StudioRunOutput {
  /** The output file, inside `workDir`. */
  readonly path: string;
  readonly mimeType: string;
  /**
   * Absolute paths of the backend's own copies outside the studio dir that outlive the run (ComfyUI keeps every
   * output in its `output/` dir). The host deletes them with the asset, so nothing of a deleted image stays on disk.
   */
  readonly copies?: readonly string[];
}

export interface StudioRunner {
  /** The backend as clients see it now: availability (and why not), models, balance. Never rejects. */
  describe(): Promise<StudioBackend>;
  /** Makes one output. Rejects with a one-line reason, or once `signal` aborts. */
  run(input: StudioRunInput): Promise<StudioRunOutput>;
  /** Paid backends: what `spec` costs in credits. Free to ask. Rejects with a one-line reason. */
  quote?(spec: StudioSpec): Promise<number>;
  /** Paid backends: credits left, when it can tell. Never rejects. */
  balance?(): Promise<number | undefined>;
}

/** An error's message squeezed to one line of at most `max` characters, for `error` and `reason`. */
export function oneLine(error: unknown, max = 600): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}
