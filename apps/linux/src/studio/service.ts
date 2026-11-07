// Studio's queue and library: jobs go in with `create` (`count` of them at once, one batch), wait for
// a slot in their backend's pool (the Mac's GPU runs one LTX, MOSS, Kontext, ComfyUI or SAM job at a
// time, first in first out; Codex three; Higgsfield two), run on that backend's runner, and end as an
// output asset in the store. While a job runs, every 2 s its progress and ETA tick from an estimate
// that each finished job calibrates. Every change goes to every device: `studio.job` for a job,
// `studio.removed` for a deleted job or upload, `studio.library` when projects or references change,
// `studio.segments` for SAM 2.1's objects in an image, `studio.state` when uploads or backends change.
//
// The GPU is shared with work outside Relay through the machine-wide lock (`gpu-lock.ts`): LTX and
// MOSS-Image take it in their own scripts, the service takes it around Kontext, ComfyUI and SAM runs.
//
// Trash: a trashed output is hidden and restorable for STUDIO_UNDO_MS; then (on a timer, and on start
// for what came due while the host was down) every copy of it is deleted: the store file and thumb,
// the backend's own copies the runner reported, its segments. A job left with no outputs goes too.
//
// Paid jobs (Higgsfield) only run on Isaac's tap: never from an agent, only with `confirmCredits`,
// one at a time, and not when the host's fresh quote is above what he confirmed.

import { randomInt, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_STUDIO_PROJECTS,
  MAX_STUDIO_REFERENCES,
  MAX_STUDIO_SEGMENTS,
  STUDIO_UNSORTED,
  studioJobActive,
  type ServerMessage,
  type StudioAsset,
  type StudioBackend,
  type StudioBackendId,
  type StudioJob,
  type StudioOp,
  type StudioResult,
  type StudioSegments,
  type StudioSpec,
  type StudioState,
} from "@relay/protocol";
import type { DropBlob, StudioRelaying } from "../seams";
import type { SessionClock } from "../session";
import {
  BACKEND_BASE,
  baseEstimateMs,
  parseSize,
  STUDIO_BACKENDS,
  STUDIO_POOLS,
  validateSpec,
} from "./backends";
import { gpuLockHolder, type GpuLock } from "./gpu-lock";
import type { StudioMedia } from "./media";
import { oneLine, type StudioRunInput, type StudioRunner, type StudioRunOutput } from "./runner";
import { settledJob, StudioStore } from "./store";

export const STUDIO_TICK_MS = 2000;
/** Progress never claims done before the output is in. */
const MAX_PROGRESS = 0.97;
export const GPU_NOTE = "Waiting for the GPU";
/** A running job waiting for the machine-wide GPU lock (another GPU user holds it). */
export const GPU_BUSY_NOTE = "Waiting for the GPU (another job is using it)";
/** A queued GPU job held back while a call is transcribed live on this Mac. */
export const MEETING_NOTE = "Waiting for the meeting to end";
const SLOT_NOTE = "Waiting for a free slot";
/** Backends `rescan` re-reads: their presets and model files (ComfyUI's, MOSS-Image fine-tunes) live on this Mac's disk. */
const RESCANNED: readonly StudioBackendId[] = ["moss", "comfyui", "comfyui-video"];
/**
 * Local GPU backends whose runs the service holds the machine-wide GPU lock for. LTX (draft.py) and MOSS-Image
 * (moss.py) take it themselves, ComfyUI video runs on the GPU box, Codex and Higgsfield off the Mac, crops on the CPU.
 */
const HOST_LOCKED: readonly StudioBackendId[] = ["kontext", "comfyui", "sam"];
/** Backends whose result is the masked object already (a cutout) or not an edit (a crop): no composite after. */
const UNMASKED: readonly StudioBackendId[] = ["sam", "crop"];
/** A SAM 2.1 segment run, model load included. */
const SEGMENT_ESTIMATE_MS = 20_000;
const MAX_SEED = 2_147_483_647;

export type StudioMessage = Extract<
  ServerMessage,
  { t: "studio.state" | "studio.job" | "studio.removed" | "studio.library" | "studio.segments" }
>;
type Result = Omit<StudioResult, "rid">;
type CreateOp = Extract<StudioOp, { kind: "create" }>;

/** One object SAM 2.1 found: box and area as fractions of the image, the mask and cut-out PNGs in the run's dir. */
export interface SegmentFile {
  readonly label: string;
  readonly box: readonly [number, number, number, number];
  readonly area: number;
  readonly mask: string;
  readonly cutout: string;
}

/** SAM 2.1's object finder (`SamRunner`). */
export interface StudioSegmenter {
  segment(image: string, outDir: string, signal: AbortSignal): Promise<readonly SegmentFile[]>;
}

export interface StudioServiceDeps {
  /** `$XDG_CONFIG_HOME/relay/studio` (`defaultStudioDir`). */
  readonly dir: string;
  readonly runners: Readonly<Record<StudioBackendId, StudioRunner>>;
  readonly segmenter: StudioSegmenter;
  /** The machine-wide GPU lock (`FlockGpuLock` on `~/.cache/eva-gpu.lock`). */
  readonly gpuLock: GpuLock;
  readonly media: StudioMedia;
  /** To every authenticated device. */
  readonly emit: (message: StudioMessage) => void;
  readonly clock: SessionClock;
  readonly log: (line: string) => void;
  /** True while a call is transcribed live: new GPU jobs wait (running ones finish). Call `resume()` when it turns false. */
  readonly gpuHeld?: () => boolean;
  /** A seed for a job whose spec has none; random by default. */
  readonly seed?: () => number;
}

/** A job (or segment run) holding a slot in its pool, from start until its runner settles (a cancelled one too). */
interface Running {
  readonly backend: StudioBackendId;
  readonly controller: AbortController;
  /** When its own work began: the start, or the moment it got the GPU lock after waiting. */
  startedAt: number;
  readonly estimateMs: number;
  /** Waiting for the machine-wide GPU lock: no progress, no ETA. */
  blocked: boolean;
}

export class StudioService implements StudioRelaying {
  private readonly store: StudioStore;
  private readonly backends = new Map<StudioBackendId, StudioBackend>();
  /** By job id, or `segment-<asset id>` for a segment run. */
  private readonly running = new Map<string, Running>();
  private refreshing: Promise<void> | null = null;
  private cancelTick: (() => void) | null = null;
  private cancelPurge: (() => void) | null = null;
  private stopped = false;

  /** Throws when the store's index is unreadable. */
  constructor(private readonly deps: StudioServiceDeps) {
    this.store = new StudioStore(deps.dir, { now: () => deps.clock.now(), media: deps.media });
  }

  /** Reads the backends, deletes the trash that came due while stopped, and starts the jobs that were queued before a restart. */
  start(): void {
    void this.refresh();
    this.purge();
    this.pump();
  }

  /** `gpuHeld` changed: start what it held back, or mark the queue as waiting for the meeting. */
  resume(): void {
    this.pump();
  }

  /** Aborts running jobs (killing LTX's processes) and leaves them `running` in the index, so the next start fails them. */
  stop(): void {
    this.stopped = true;
    this.cancelTick?.();
    this.cancelPurge?.();
    for (const slot of this.running.values()) slot.controller.abort();
  }

  state(): StudioState {
    return {
      jobs: [...this.store.jobs],
      uploads: [...this.store.uploads],
      backends: STUDIO_BACKENDS.flatMap((id) => this.backends.get(id) ?? []),
      projects: [...this.store.projects],
      references: [...this.store.references],
    };
  }

  open(id: string, token: string): DropBlob | null {
    return this.store.open(id, token);
  }

  openThumb(id: string, token: string): DropBlob | null {
    return this.store.openThumb(id, token);
  }

  async handle(op: StudioOp): Promise<Result> {
    try {
      switch (op.kind) {
        case "create":
          return await this.create(op);
        case "quote":
          return await this.quote(op.spec);
        case "cancel":
          return this.cancel(op.id);
        case "delete":
          return this.remove(op.id);
        case "upload":
          return await this.upload(op.image.mimeType, op.image.data);
        case "frame":
          return await this.frame(op.asset, op.at);
        case "refresh":
          await this.refresh();
          return { ok: true };
        case "favorite":
          return this.editOutputs(op.assets, (asset) => {
            if (op.value) return { ...asset, favorite: true };
            const next = { ...asset };
            delete next.favorite;
            return next;
          });
        case "move":
          return this.move(op.assets, op.project);
        case "trash":
          return this.trash(op.assets);
        case "restore":
          return this.restore(op.assets);
        case "project.create":
          return this.createProject(op.name, op.id);
        case "project.rename":
          return this.renameProject(op.id, op.name);
        case "project.delete":
          return this.deleteProject(op.id);
        case "reference.create":
          return await this.createReference(op.asset, op.referenceKind, op.name);
        case "reference.delete":
          if (!this.store.removeReference(op.id)) return { ok: false, error: "No such reference" };
          this.emitLibrary();
          return { ok: true };
        case "segment":
          return await this.segment(op.asset);
      }
    } catch (error) {
      return { ok: false, error: oneLine(error) };
    }
  }

  private async create(op: CreateOp): Promise<Result> {
    const { spec, origin } = op;
    const count = op.count ?? 1;
    const backend = await this.backend(spec.backend);
    if (backend.paid && origin === "agent")
      return { ok: false, error: "Paid jobs need Isaac's confirm tap in Studio" };
    if (backend.paid && spec.confirmCredits === undefined)
      return { ok: false, error: "Paid jobs need a confirmed price; get a quote and confirm it" };
    if (backend.paid && count > 1) return { ok: false, error: "Paid jobs run one at a time; make one" };
    const refused = this.refusal(spec, backend);
    if (refused !== null) return { ok: false, error: refused };
    const project = op.project === STUDIO_UNSORTED ? undefined : op.project;
    if (project !== undefined && this.store.project(project) === undefined)
      return { ok: false, error: "That project is gone; pick another" };
    if (op.parent !== undefined && this.store.asset(op.parent.asset) === undefined)
      return { ok: false, error: "The image it was made from is gone" };
    let credits: number | undefined;
    if (backend.paid) {
      credits = await this.priceOf(spec);
      if (credits > (spec.confirmCredits ?? 0))
        return {
          ok: false,
          error: `The price changed to ${String(credits)} credits; confirm again`,
        };
    }
    const seed = backend.seed
      ? (spec.seed ?? this.deps.seed?.() ?? randomInt(0, MAX_SEED + 1))
      : undefined;
    const batch = count > 1 ? randomUUID() : undefined;
    const now = this.deps.clock.now();
    const ids: string[] = [];
    for (let index = 0; index < count; index++) {
      const job: StudioJob = {
        id: randomUUID(),
        spec,
        state: "queued",
        origin,
        createdAt: now,
        progress: 0,
        outputs: [],
        ...(seed === undefined ? {} : { seed: (seed + index) % (MAX_SEED + 1) }),
        ...(credits === undefined ? {} : { credits }),
        ...(project === undefined ? {} : { project }),
        ...(op.parent === undefined ? {} : { parent: op.parent }),
        ...(batch === undefined ? {} : { batch: { id: batch, index, count } }),
      };
      ids.push(job.id);
      this.save(job);
    }
    this.pump();
    const jobs = ids.flatMap((id) => this.store.job(id) ?? []);
    return { ok: true, jobs, ...(jobs[0] === undefined ? {} : { job: jobs[0] }) };
  }

  private async quote(spec: StudioSpec): Promise<Result> {
    const backend = await this.backend(spec.backend);
    if (!backend.paid) return { ok: true, credits: 0 };
    const refused = this.refusal(spec, backend);
    if (refused !== null) return { ok: false, error: refused };
    const credits = await this.priceOf(spec);
    return {
      ok: true,
      credits,
      ...(backend.balance === undefined ? {} : { balance: backend.balance }),
    };
  }

  private cancel(id: string): Result {
    const job = this.store.job(id);
    if (job === undefined) return { ok: false, error: "No such job" };
    if (!studioJobActive(job)) return { ok: false, error: "The job already ended" };
    const cancelled: StudioJob = {
      ...settledJob(job),
      state: "cancelled",
      finishedAt: this.deps.clock.now(),
    };
    this.save(cancelled);
    // A running job keeps its slot until its runner has stopped (the GPU frees when LTX exits).
    this.running.get(id)?.controller.abort();
    this.pump();
    return { ok: true, job: cancelled };
  }

  /** Deletes a finished job (every copy of its outputs) or an upload now. */
  private remove(id: string): Result {
    const job = this.store.job(id);
    if (job !== undefined) {
      if (studioJobActive(job)) return { ok: false, error: "Cancel the job before deleting it" };
      this.store.removeJob(id);
      this.deps.emit({ t: "studio.removed", id });
      return { ok: true };
    }
    if (!this.store.removeUpload(id)) return { ok: false, error: "No such job or upload" };
    this.deps.emit({ t: "studio.removed", id });
    this.emitState();
    return { ok: true };
  }

  /**
   * Applies `change` to each named output (after deleting what came due in the trash) and saves the jobs that
   * changed. Refused when none of them is an output.
   */
  private editOutputs(ids: readonly string[], change: (asset: StudioAsset) => StudioAsset): Result {
    this.purge();
    const wanted = new Set(ids);
    let found = 0;
    for (const job of [...this.store.jobs]) {
      if (!job.outputs.some((output) => wanted.has(output.id))) continue;
      const outputs = job.outputs.map((output) => {
        if (!wanted.has(output.id)) return output;
        found++;
        return change(output);
      });
      if (JSON.stringify(outputs) !== JSON.stringify(job.outputs)) this.save({ ...job, outputs });
    }
    return found === 0 ? { ok: false, error: ids.length === 1 ? "That image is gone" : "Those images are gone" } : { ok: true };
  }

  private move(ids: readonly string[], target: string): Result {
    const project = target === STUDIO_UNSORTED ? undefined : target;
    if (project !== undefined && this.store.project(project) === undefined)
      return { ok: false, error: "That project is gone; pick another" };
    this.purge();
    const wanted = new Set(ids);
    const jobs = this.store.jobs.filter((job) => job.outputs.some((output) => wanted.has(output.id)));
    if (jobs.length === 0) return { ok: false, error: ids.length === 1 ? "That image is gone" : "Those images are gone" };
    for (const job of jobs) {
      if (job.project === project) continue;
      const next = { ...job };
      if (project === undefined) delete next.project;
      else next.project = project;
      this.save(next);
    }
    return { ok: true };
  }

  private trash(ids: readonly string[]): Result {
    const now = this.deps.clock.now();
    const result = this.editOutputs(ids, (asset) => (asset.deletedAt === undefined ? { ...asset, deletedAt: now } : asset));
    this.schedulePurge();
    return result;
  }

  /** Brings trashed outputs back while their undo window lasts; past it they are deleted already (or now). */
  private restore(ids: readonly string[]): Result {
    const result = this.editOutputs(ids, (asset) => {
      const next = { ...asset };
      delete next.deletedAt;
      return next;
    });
    if (!result.ok) return { ok: false, error: ids.length === 1 ? "Too late to undo; the image is deleted" : "Too late to undo; the images are deleted" };
    this.schedulePurge();
    return result;
  }

  /** Deletes every copy of the outputs whose undo window has passed, tells every device, and waits for the next. */
  private purge(): void {
    if (this.stopped) return;
    const { changed, removed } = this.store.purgeTrash(this.deps.clock.now());
    for (const job of changed) this.deps.emit({ t: "studio.job", job });
    for (const id of removed) this.deps.emit({ t: "studio.removed", id });
    this.schedulePurge();
  }

  private schedulePurge(): void {
    this.cancelPurge?.();
    this.cancelPurge = null;
    const at = this.store.nextPurgeAt();
    if (at === undefined || this.stopped) return;
    this.cancelPurge = this.deps.clock.after(Math.max(0, at - this.deps.clock.now()), () => {
      this.cancelPurge = null;
      this.purge();
    });
  }

  private createProject(name: string, id: string = randomUUID()): Result {
    if (id === STUDIO_UNSORTED || this.store.project(id) !== undefined) return { ok: false, error: "That project already exists" };
    if (this.store.projects.length >= MAX_STUDIO_PROJECTS)
      return { ok: false, error: `Studio keeps at most ${String(MAX_STUDIO_PROJECTS)} projects` };
    const project = { id, name: name.trim(), createdAt: this.deps.clock.now() };
    this.store.putProject(project);
    this.emitLibrary();
    return { ok: true, project };
  }

  private renameProject(id: string, name: string): Result {
    const found = this.store.project(id);
    if (found === undefined) return { ok: false, error: "No such project" };
    const project = { ...found, name: name.trim() };
    this.store.putProject(project);
    this.emitLibrary();
    return { ok: true, project };
  }

  /** Deletes a project; its jobs go to Unsorted. */
  private deleteProject(id: string): Result {
    if (this.store.project(id) === undefined) return { ok: false, error: "No such project" };
    for (const job of this.store.jobs.filter((candidate) => candidate.project === id)) {
      const next = { ...job };
      delete next.project;
      this.save(next);
    }
    this.store.removeProject(id);
    this.emitLibrary();
    return { ok: true };
  }

  /** Saves an image as a Style or Character: the host's own copy, which outlives the image. */
  private async createReference(id: string, kind: "style" | "character", name: string): Promise<Result> {
    const found = this.store.asset(id);
    if (found?.asset.kind !== "image") return { ok: false, error: "No such image" };
    if (this.store.references.length >= MAX_STUDIO_REFERENCES)
      return { ok: false, error: `Studio keeps at most ${String(MAX_STUDIO_REFERENCES)} references` };
    const asset = await this.store.ingest({ bytes: readFileSync(found.path) }, found.asset.mimeType, "upload", {
      width: found.asset.width,
      height: found.asset.height,
    });
    const reference = { id: randomUUID(), kind, name: name.trim(), asset, createdAt: this.deps.clock.now() };
    this.store.addReference(reference);
    this.emitLibrary();
    return { ok: true, reference };
  }

  /** SAM 2.1's objects in an image: the kept result, the run in line, or a new run queued for the GPU. */
  private async segment(id: string): Promise<Result> {
    const found = this.store.asset(id);
    if (found?.asset.kind !== "image") return { ok: false, error: "No such image" };
    const current = this.store.segments(id);
    if (current !== undefined && current.state !== "failed") return { ok: true, segments: current };
    const sam = await this.backend("sam");
    if (!sam.available)
      return { ok: false, error: `${sam.label} is unavailable${sam.reason === undefined ? "" : `: ${sam.reason}`}` };
    this.putSegments({ asset: id, state: "queued", segments: [] });
    this.pump();
    return { ok: true, segments: this.store.segments(id) ?? { asset: id, state: "queued", segments: [] } };
  }

  private async upload(mimeType: string, data: string): Promise<Result> {
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0) return { ok: false, error: "The image is empty" };
    return this.keepUpload(await this.store.ingest({ bytes }, mimeType, "upload"));
  }

  /** A video's first or last frame (or a copy of an image) as a new upload. */
  private async frame(id: string, at: "first" | "last"): Promise<Result> {
    const found = this.store.asset(id);
    if (found === undefined) return { ok: false, error: "No such image or video" };
    if (found.asset.kind === "image")
      return this.keepUpload(
        await this.store.ingest(
          { bytes: readFileSync(found.path) },
          found.asset.mimeType,
          "upload",
        ),
      );
    const scratch = `frame-${randomUUID()}`;
    try {
      const dest = join(this.store.workDir(scratch), "frame.png");
      await this.deps.media.frame(found.path, at, dest);
      return this.keepUpload(await this.store.ingest({ path: dest }, "image/png", "upload"));
    } finally {
      this.store.clearWork(scratch);
    }
  }

  private keepUpload(asset: StudioAsset): Result {
    this.store.addUpload(asset);
    this.emitState();
    return { ok: true, asset };
  }

  /** Re-reads every backend (one refresh at a time; a call during one joins it), then pushes `studio.state`. */
  private refresh(): Promise<void> {
    this.refreshing ??= Promise.all(STUDIO_BACKENDS.map((id) => this.describe(id))).then(() => {
      this.refreshing = null;
      this.emitState();
    });
    return this.refreshing;
  }

  /**
   * A device opened Studio (`studio.list`): re-reads the backends whose offer follows files on this
   * Mac (ComfyUI presets and the model files they name), so a preset folder or a checkpoint dropped
   * in since shows up without a Refresh; pushes `studio.state` only when one changed. Cheap and
   * local, unlike a full refresh (Codex's token, Higgsfield's balance). Skipped during a refresh.
   */
  rescan(): Promise<void> {
    if (this.refreshing !== null) return this.refreshing;
    return Promise.all(
      RESCANNED.map(async (id) => {
        const before = JSON.stringify(this.backends.get(id));
        await this.describe(id);
        return JSON.stringify(this.backends.get(id)) !== before;
      }),
    ).then((changed) => {
      if (changed.some(Boolean)) this.emitState();
    });
  }

  private async describe(id: StudioBackendId): Promise<void> {
    const backend = await this.deps.runners[id]
      .describe()
      .catch((error: unknown): StudioBackend => ({ ...BACKEND_BASE[id], reason: oneLine(error, 400) }));
    this.backends.set(id, backend);
  }

  /** The backend as last read; waits for the first read. */
  private async backend(id: StudioBackendId): Promise<StudioBackend> {
    if (!this.backends.has(id)) await this.refresh();
    return this.backends.get(id) ?? BACKEND_BASE[id];
  }

  /** Why `spec` can't run now, or null. */
  private refusal(spec: StudioSpec, backend: StudioBackend): string | null {
    if (!backend.available)
      return `${backend.label} is unavailable${backend.reason === undefined ? "" : `: ${backend.reason}`}`;
    const invalid = validateSpec(spec, backend, (id) => this.store.asset(id)?.asset);
    if (invalid !== null || spec.mask === undefined) return invalid;
    const mask = this.store.segmentMask(spec.mask);
    if (mask === undefined) return "The selected object is gone; pick it again";
    if (spec.refs?.[0] !== mask.asset) return "The selected object belongs to another image";
    return null;
  }

  private async priceOf(spec: StudioSpec): Promise<number> {
    const runner = this.deps.runners[spec.backend];
    if (runner.quote === undefined)
      throw new Error(`${BACKEND_BASE[spec.backend].label} cannot price jobs`);
    return runner.quote(spec);
  }

  private estimateMs(spec: StudioSpec): number {
    return baseEstimateMs(spec, this.backends.get(spec.backend)) * this.store.calibration(spec.backend);
  }

  private busy(pool: string): number {
    return [...this.running.values()].filter((slot) => STUDIO_POOLS[slot.backend].pool === pool).length;
  }

  /**
   * Starts what has room in its pool: segment runs first (they take seconds, and Isaac waits for them in the
   * editor), then queued jobs oldest first; then updates what the rest wait for.
   */
  private pump(): void {
    if (this.stopped) return;
    const sam = STUDIO_POOLS.sam;
    for (const entry of this.store.allSegments) {
      if (entry.state !== "queued") continue;
      if ((sam.pool === "gpu" && this.deps.gpuHeld?.() === true) || this.busy(sam.pool) >= sam.max) break;
      this.beginSegment(entry.asset);
    }
    for (const job of [...this.store.jobs].reverse()) {
      if (job.state !== "queued") continue;
      const { pool, max } = STUDIO_POOLS[job.spec.backend];
      if (pool === "gpu" && this.deps.gpuHeld?.() === true) continue;
      if (this.busy(pool) < max) this.begin(job);
    }
    this.updateWaiting();
  }

  private begin(job: StudioJob): void {
    const now = this.deps.clock.now();
    const slot: Running = {
      backend: job.spec.backend,
      controller: new AbortController(),
      startedAt: now,
      estimateMs: this.estimateMs(job.spec),
      blocked: false,
    };
    this.running.set(job.id, slot);
    const started: StudioJob = {
      ...settledJob(job),
      state: "running",
      startedAt: now,
      progress: 0,
      etaMs: slot.estimateMs,
    };
    this.save(started);
    this.scheduleTick();
    void this.execute(started, slot);
  }

  private async execute(job: StudioJob, slot: Running): Promise<void> {
    const { spec } = job;
    /** The backend's own copies of an output not yet in the store: deleted unless the output is kept. */
    let copies: readonly string[] = [];
    try {
      const mask = spec.mask === undefined ? undefined : this.store.segmentMask(spec.mask)?.path;
      if (spec.mask !== undefined && mask === undefined) throw new Error("The selected object is gone; pick it again");
      const input: StudioRunInput = {
        spec,
        ...(job.seed === undefined ? {} : { seed: job.seed }),
        frames: Object.fromEntries(
          Object.entries(spec.frames ?? {}).flatMap(([name, id]) =>
            id === undefined ? [] : [[name, this.assetPath(id)] as const],
          ),
        ),
        refs: (spec.refs ?? []).map((id) => this.assetPath(id)),
        ...(mask === undefined ? {} : { mask }),
        workDir: this.store.workPath(job.id),
        signal: slot.controller.signal,
        note: (text) => {
          const current = this.store.job(job.id);
          if (current?.state === "running" && current.note !== text)
            this.touch({ ...current, note: text });
        },
        blocked: (waiting) => {
          const current = this.store.job(job.id);
          if (current?.state !== "running" || slot.blocked === waiting) return;
          slot.blocked = waiting;
          const rest: StudioJob = { ...current };
          delete rest.note;
          delete rest.etaMs;
          if (waiting) {
            this.touch({ ...rest, progress: 0, note: GPU_BUSY_NOTE });
          } else {
            slot.startedAt = this.deps.clock.now();
            this.touch({ ...rest, progress: 0, etaMs: slot.estimateMs });
          }
        },
      };
      const release = HOST_LOCKED.includes(spec.backend)
        ? await this.deps.gpuLock.acquire({ holder: gpuLockHolder(spec.backend), signal: slot.controller.signal, waiting: input.blocked })
        : null;
      let output: StudioRunOutput;
      try {
        // Created only now: the GPU wait above can last minutes, and the dir must exist when the backend writes.
        this.store.workDir(job.id);
        output = await this.deps.runners[spec.backend].run(input);
      } finally {
        await release?.();
      }
      copies = output.copies ?? [];
      if (this.store.job(job.id)?.state !== "running") return;
      const source = input.refs[0];
      if (mask !== undefined && source !== undefined && !UNMASKED.includes(spec.backend)) {
        // The engine edited the whole image; only the selected object takes the edit.
        const masked = join(input.workDir, "masked.png");
        input.note("Keeping the edit inside the selection");
        await this.deps.media.compositeMasked(source, output.path, mask, masked);
        output = { ...output, path: masked, mimeType: "image/png" };
      }
      const size = parseSize(spec.resolution);
      const asset = await this.store.ingest(
        { path: output.path },
        output.mimeType,
        "output",
        size === null ? undefined : { width: size[0], height: size[1] },
        copies,
      );
      copies = [];
      const current = this.store.job(job.id);
      if (this.stopped || current?.state !== "running") {
        this.store.discard(asset.id);
        return;
      }
      const now = this.deps.clock.now();
      this.save({
        ...settledJob(current),
        state: "done",
        progress: 1,
        finishedAt: now,
        outputs: [asset],
      });
      this.store.calibrate(spec.backend, (now - slot.startedAt) / baseEstimateMs(spec, this.backends.get(spec.backend)));
    } catch (error) {
      const current = this.store.job(job.id);
      if (this.stopped || current?.state !== "running") return;
      this.deps.log(`studio: ${spec.backend} job ${job.id} failed: ${oneLine(error)}`);
      this.save({
        ...settledJob(current),
        state: "failed",
        error: oneLine(error),
        finishedAt: this.deps.clock.now(),
      });
    } finally {
      for (const copy of copies) rmSync(copy, { force: true });
      if (!this.stopped) {
        this.store.clearWork(job.id);
        this.running.delete(job.id);
        if (BACKEND_BASE[spec.backend].paid) void this.refreshBalance(spec.backend);
        this.pump();
      }
    }
  }

  private beginSegment(asset: string): void {
    const key = `segment-${asset}`;
    const slot: Running = {
      backend: "sam",
      controller: new AbortController(),
      startedAt: this.deps.clock.now(),
      estimateMs: SEGMENT_ESTIMATE_MS,
      blocked: false,
    };
    this.running.set(key, slot);
    this.putSegments({ asset, state: "running", segments: [] });
    void this.runSegment(asset, key, slot);
  }

  /** One SAM 2.1 run under the GPU lock; its masks and cut-outs become served files kept with the image. */
  private async runSegment(asset: string, key: string, slot: Running): Promise<void> {
    const stillRunning = (): boolean => !this.stopped && this.store.segments(asset)?.state === "running";
    try {
      const found = this.store.asset(asset);
      if (found === undefined) throw new Error("The image is gone");
      const workDir = this.store.workPath(key);
      const release = await this.deps.gpuLock.acquire({
        holder: gpuLockHolder("sam segments"),
        signal: slot.controller.signal,
        waiting: () => undefined,
      });
      let files: readonly SegmentFile[];
      try {
        this.store.workDir(key);
        files = await this.deps.segmenter.segment(found.path, workDir, slot.controller.signal);
      } finally {
        await release();
      }
      if (!stillRunning()) return;
      const segments = files.slice(0, MAX_STUDIO_SEGMENTS).map((file) => this.store.ingestSegment(file));
      this.putSegments({ asset, state: "done", segments });
    } catch (error) {
      if (!stillRunning()) return;
      this.deps.log(`studio: segmenting ${asset} failed: ${oneLine(error)}`);
      this.putSegments({ asset, state: "failed", segments: [], error: oneLine(error, 2000) });
    } finally {
      if (!this.stopped) {
        this.store.clearWork(key);
        this.running.delete(key);
        this.pump();
      }
    }
  }

  private assetPath(id: string): string {
    const found = this.store.asset(id);
    if (found === undefined)
      throw new Error("A frame or reference image was deleted before the job started");
    return found.path;
  }

  private async refreshBalance(id: StudioBackendId): Promise<void> {
    const balance = await this.deps.runners[id].balance?.();
    const backend = this.backends.get(id);
    if (balance === undefined || backend === undefined || this.stopped) return;
    this.backends.set(id, { ...backend, balance });
    this.emitState();
  }

  private scheduleTick(): void {
    if (this.cancelTick !== null || this.stopped) return;
    this.cancelTick = this.deps.clock.after(STUDIO_TICK_MS, () => {
      this.cancelTick = null;
      this.tick();
    });
  }

  /** Progress and ETA of each running job from its estimate, and the queue's waits. */
  private tick(): void {
    const now = this.deps.clock.now();
    for (const [id, slot] of this.running) {
      const job = this.store.job(id);
      if (job?.state !== "running" || slot.blocked) continue;
      const elapsed = now - slot.startedAt;
      this.touch({
        ...job,
        progress: Math.min(MAX_PROGRESS, elapsed / slot.estimateMs),
        etaMs: Math.max(0, slot.estimateMs - elapsed),
      });
    }
    this.updateWaiting();
    if (this.running.size > 0) this.scheduleTick();
  }

  /**
   * Notes and ETAs of queued jobs: a GPU job waits for the GPU through the running job, the segment runs in
   * line and every job ahead of it, so its ETA is all of that plus its own run. Others wait for a free slot.
   */
  private updateWaiting(): void {
    const now = this.deps.clock.now();
    let gpuFreeInMs = 0;
    for (const slot of this.running.values()) {
      if (STUDIO_POOLS[slot.backend].pool === "gpu")
        gpuFreeInMs += Math.max(0, slot.estimateMs - (now - slot.startedAt));
    }
    gpuFreeInMs += SEGMENT_ESTIMATE_MS * this.store.allSegments.filter((entry) => entry.state === "queued").length;
    for (const job of [...this.store.jobs].reverse()) {
      if (job.state !== "queued") continue;
      if (STUDIO_POOLS[job.spec.backend].pool !== "gpu") {
        if (job.note !== SLOT_NOTE) this.touch({ ...job, note: SLOT_NOTE });
        continue;
      }
      gpuFreeInMs += this.estimateMs(job.spec);
      if (this.deps.gpuHeld?.() === true) {
        if (job.note !== MEETING_NOTE) this.touch({ ...job, note: MEETING_NOTE });
        continue;
      }
      if (job.note !== GPU_NOTE || Math.abs((job.etaMs ?? 0) - gpuFreeInMs) >= 1000)
        this.touch({ ...job, note: GPU_NOTE, etaMs: gpuFreeInMs });
    }
  }

  /** Persists a lasting change to `job` and tells every device (and which old jobs it evicted). */
  private save(job: StudioJob): void {
    const evicted = this.store.putJob(job);
    this.deps.emit({ t: "studio.job", job });
    for (const id of evicted) this.deps.emit({ t: "studio.removed", id });
  }

  /** A passing change (progress, ETA, note): kept in memory and sent, not written. */
  private touch(job: StudioJob): void {
    this.store.touchJob(job);
    this.deps.emit({ t: "studio.job", job });
  }

  private putSegments(segments: StudioSegments): void {
    this.store.putSegments(segments);
    this.deps.emit({ t: "studio.segments", ...segments });
  }

  private emitLibrary(): void {
    this.deps.emit({ t: "studio.library", projects: [...this.store.projects], references: [...this.store.references] });
  }

  private emitState(): void {
    this.deps.emit({ t: "studio.state", ...this.state() });
  }
}
