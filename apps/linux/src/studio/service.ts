// Studio's queue: jobs go in with `create`, wait for a slot in their backend's pool (the GPU runs
// one LTX job at a time, first in first out; Codex three; Higgsfield two), run on that backend's
// runner, and end as an output asset in the store. While a job runs, every 2 s its progress and
// ETA tick from an estimate that each finished job calibrates. Every change goes to every device:
// `studio.job` for a job, `studio.removed` for a deleted job or upload, `studio.state` when uploads
// or backends change.
//
// Paid jobs (Higgsfield) only run on Isaac's tap: never from an agent, only with `confirmCredits`,
// and not when the host's fresh quote is above what he confirmed.

import { randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  studioJobActive,
  type ServerMessage,
  type StudioAsset,
  type StudioBackend,
  type StudioBackendId,
  type StudioJob,
  type StudioOp,
  type StudioOrigin,
  type StudioResult,
  type StudioSpec,
  type StudioState,
} from "@relay/protocol";
import type { DropBlob, StudioRelaying } from "../seams";
import type { SessionClock } from "../session";
import { BACKEND_BASE, baseEstimateMs, parseSize, STUDIO_BACKENDS, STUDIO_POOLS, validateSpec } from "./backends";
import type { StudioMedia } from "./media";
import { oneLine, type StudioRunInput, type StudioRunner } from "./runner";
import { settledJob, StudioStore } from "./store";

export const STUDIO_TICK_MS = 2000;
/** Progress never claims done before the output is in. */
const MAX_PROGRESS = 0.97;
export const GPU_NOTE = "Waiting for the GPU";
const SLOT_NOTE = "Waiting for a free slot";

export type StudioMessage = Extract<ServerMessage, { t: "studio.state" | "studio.job" | "studio.removed" }>;
type Result = Omit<StudioResult, "rid">;

export interface StudioServiceDeps {
  /** `$XDG_CONFIG_HOME/relay/studio` (`defaultStudioDir`). */
  readonly dir: string;
  readonly runners: Readonly<Record<StudioBackendId, StudioRunner>>;
  readonly media: StudioMedia;
  /** To every authenticated device. */
  readonly emit: (message: StudioMessage) => void;
  readonly clock: SessionClock;
  readonly log: (line: string) => void;
  /** A seed for a job whose spec has none; random by default. */
  readonly seed?: () => number;
}

/** A job holding a slot in its pool, from start until its runner settles (a cancelled one too). */
interface Running {
  readonly backend: StudioBackendId;
  readonly controller: AbortController;
  readonly startedAt: number;
  readonly estimateMs: number;
}

export class StudioService implements StudioRelaying {
  private readonly store: StudioStore;
  private readonly backends = new Map<StudioBackendId, StudioBackend>();
  private readonly running = new Map<string, Running>();
  private refreshing: Promise<void> | null = null;
  private cancelTick: (() => void) | null = null;
  private stopped = false;

  /** Throws when the store's index is unreadable. */
  constructor(private readonly deps: StudioServiceDeps) {
    this.store = new StudioStore(deps.dir, { now: () => deps.clock.now(), media: deps.media });
  }

  /** Reads the backends and starts the jobs that were queued before a restart. */
  start(): void {
    void this.refresh();
    this.pump();
  }

  /** Aborts running jobs (killing LTX's processes) and leaves them `running` in the index, so the next start fails them. */
  stop(): void {
    this.stopped = true;
    this.cancelTick?.();
    for (const slot of this.running.values()) slot.controller.abort();
  }

  state(): StudioState {
    return { jobs: [...this.store.jobs], uploads: [...this.store.uploads], backends: STUDIO_BACKENDS.flatMap((id) => this.backends.get(id) ?? []) };
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
          return await this.create(op.spec, op.origin);
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
      }
    } catch (error) {
      return { ok: false, error: oneLine(error) };
    }
  }

  private async create(spec: StudioSpec, origin: StudioOrigin): Promise<Result> {
    const backend = await this.backend(spec.backend);
    if (backend.paid && origin === "agent") return { ok: false, error: "Paid jobs need Isaac's confirm tap in Studio" };
    if (backend.paid && spec.confirmCredits === undefined) return { ok: false, error: "Paid jobs need a confirmed price; get a quote and confirm it" };
    const refused = this.refusal(spec, backend);
    if (refused !== null) return { ok: false, error: refused };
    let credits: number | undefined;
    if (backend.paid) {
      credits = await this.priceOf(spec);
      if (credits > (spec.confirmCredits ?? 0)) return { ok: false, error: `The price changed to ${String(credits)} credits; confirm again` };
    }
    const job: StudioJob = {
      id: randomUUID(),
      spec,
      state: "queued",
      origin,
      createdAt: this.deps.clock.now(),
      progress: 0,
      outputs: [],
      ...(backend.seed ? { seed: spec.seed ?? this.deps.seed?.() ?? randomInt(0, 2_147_483_647) } : {}),
      ...(credits === undefined ? {} : { credits }),
    };
    this.save(job);
    this.pump();
    return { ok: true, job: this.store.job(job.id) ?? job };
  }

  private async quote(spec: StudioSpec): Promise<Result> {
    const backend = await this.backend(spec.backend);
    if (!backend.paid) return { ok: true, credits: 0 };
    const refused = this.refusal(spec, backend);
    if (refused !== null) return { ok: false, error: refused };
    const credits = await this.priceOf(spec);
    return { ok: true, credits, ...(backend.balance === undefined ? {} : { balance: backend.balance }) };
  }

  private cancel(id: string): Result {
    const job = this.store.job(id);
    if (job === undefined) return { ok: false, error: "No such job" };
    if (!studioJobActive(job)) return { ok: false, error: "The job already ended" };
    const cancelled: StudioJob = { ...settledJob(job), state: "cancelled", finishedAt: this.deps.clock.now() };
    this.save(cancelled);
    // A running job keeps its slot until its runner has stopped (the GPU frees when LTX exits).
    this.running.get(id)?.controller.abort();
    this.pump();
    return { ok: true, job: cancelled };
  }

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

  private async upload(mimeType: string, data: string): Promise<Result> {
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0) return { ok: false, error: "The image is empty" };
    return this.keepUpload(await this.store.ingest({ bytes }, mimeType, "upload"));
  }

  /** A video's first or last frame (or a copy of an image) as a new upload. */
  private async frame(id: string, at: "first" | "last"): Promise<Result> {
    const found = this.store.asset(id);
    if (found === undefined) return { ok: false, error: "No such image or video" };
    if (found.asset.kind === "image") return this.keepUpload(await this.store.ingest({ bytes: readFileSync(found.path) }, found.asset.mimeType, "upload"));
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
    this.refreshing ??= Promise.all(
      STUDIO_BACKENDS.map(async (id) => {
        const backend = await this.deps.runners[id].describe().catch((error: unknown): StudioBackend => ({ ...BACKEND_BASE[id], reason: oneLine(error, 400) }));
        this.backends.set(id, backend);
      }),
    ).then(() => {
      this.refreshing = null;
      this.emitState();
    });
    return this.refreshing;
  }

  /** The backend as last read; waits for the first read. */
  private async backend(id: StudioBackendId): Promise<StudioBackend> {
    if (!this.backends.has(id)) await this.refresh();
    return this.backends.get(id) ?? BACKEND_BASE[id];
  }

  /** Why `spec` can't run now, or null. */
  private refusal(spec: StudioSpec, backend: StudioBackend): string | null {
    if (!backend.available) return `${backend.label} is unavailable${backend.reason === undefined ? "" : `: ${backend.reason}`}`;
    return validateSpec(spec, backend, (id) => this.store.asset(id)?.asset);
  }

  private async priceOf(spec: StudioSpec): Promise<number> {
    const runner = this.deps.runners[spec.backend];
    if (runner.quote === undefined) throw new Error(`${BACKEND_BASE[spec.backend].label} cannot price jobs`);
    return runner.quote(spec);
  }

  private estimateMs(spec: StudioSpec): number {
    return baseEstimateMs(spec) * this.store.calibration(spec.backend);
  }

  /** Starts every queued job (oldest first) whose pool has room, then updates what the rest wait for. */
  private pump(): void {
    if (this.stopped) return;
    for (const job of [...this.store.jobs].reverse()) {
      if (job.state !== "queued") continue;
      const { pool, max } = STUDIO_POOLS[job.spec.backend];
      const busy = [...this.running.values()].filter((slot) => STUDIO_POOLS[slot.backend].pool === pool).length;
      if (busy < max) this.begin(job);
    }
    this.updateWaiting();
  }

  private begin(job: StudioJob): void {
    const now = this.deps.clock.now();
    const slot: Running = { backend: job.spec.backend, controller: new AbortController(), startedAt: now, estimateMs: this.estimateMs(job.spec) };
    this.running.set(job.id, slot);
    const started: StudioJob = { ...settledJob(job), state: "running", startedAt: now, progress: 0, etaMs: slot.estimateMs };
    this.save(started);
    this.scheduleTick();
    void this.execute(started, slot);
  }

  private async execute(job: StudioJob, slot: Running): Promise<void> {
    const { spec } = job;
    try {
      const input: StudioRunInput = {
        spec,
        ...(job.seed === undefined ? {} : { seed: job.seed }),
        frames: Object.fromEntries(Object.entries(spec.frames ?? {}).flatMap(([name, id]) => (id === undefined ? [] : [[name, this.assetPath(id)] as const]))),
        refs: (spec.refs ?? []).map((id) => this.assetPath(id)),
        workDir: this.store.workDir(job.id),
        signal: slot.controller.signal,
        note: (text) => {
          const current = this.store.job(job.id);
          if (current?.state === "running" && current.note !== text) this.touch({ ...current, note: text });
        },
      };
      const output = await this.deps.runners[spec.backend].run(input);
      if (this.store.job(job.id)?.state !== "running") return;
      const size = parseSize(spec.resolution);
      const asset = await this.store.ingest({ path: output.path }, output.mimeType, "output", size === null ? undefined : { width: size[0], height: size[1] });
      const current = this.store.job(job.id);
      if (this.stopped || current?.state !== "running") {
        this.store.discard(asset.id);
        return;
      }
      const now = this.deps.clock.now();
      this.save({ ...settledJob(current), state: "done", progress: 1, finishedAt: now, outputs: [asset] });
      this.store.calibrate(spec.backend, (now - slot.startedAt) / baseEstimateMs(spec));
    } catch (error) {
      const current = this.store.job(job.id);
      if (this.stopped || current?.state !== "running") return;
      this.deps.log(`studio: ${spec.backend} job ${job.id} failed: ${oneLine(error)}`);
      this.save({ ...settledJob(current), state: "failed", error: oneLine(error), finishedAt: this.deps.clock.now() });
    } finally {
      if (!this.stopped) {
        this.store.clearWork(job.id);
        this.running.delete(job.id);
        if (BACKEND_BASE[spec.backend].paid) void this.refreshBalance(spec.backend);
        this.pump();
      }
    }
  }

  private assetPath(id: string): string {
    const found = this.store.asset(id);
    if (found === undefined) throw new Error("A frame or reference image was deleted before the job started");
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
      if (job?.state !== "running") continue;
      const elapsed = now - slot.startedAt;
      this.touch({ ...job, progress: Math.min(MAX_PROGRESS, elapsed / slot.estimateMs), etaMs: Math.max(0, slot.estimateMs - elapsed) });
    }
    this.updateWaiting();
    if (this.running.size > 0) this.scheduleTick();
  }

  /**
   * Notes and ETAs of queued jobs: an LTX job waits for the GPU through the running job and every
   * job ahead of it, so its ETA is all of that plus its own run. Others wait for a free slot.
   */
  private updateWaiting(): void {
    const now = this.deps.clock.now();
    let gpuFreeInMs = 0;
    for (const slot of this.running.values()) {
      if (slot.backend === "ltx") gpuFreeInMs += Math.max(0, slot.estimateMs - (now - slot.startedAt));
    }
    for (const job of [...this.store.jobs].reverse()) {
      if (job.state !== "queued") continue;
      if (job.spec.backend !== "ltx") {
        if (job.note !== SLOT_NOTE) this.touch({ ...job, note: SLOT_NOTE });
        continue;
      }
      gpuFreeInMs += this.estimateMs(job.spec);
      if (job.note !== GPU_NOTE || Math.abs((job.etaMs ?? 0) - gpuFreeInMs) >= 1000) this.touch({ ...job, note: GPU_NOTE, etaMs: gpuFreeInMs });
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

  private emitState(): void {
    this.deps.emit({ t: "studio.state", ...this.state() });
  }
}
