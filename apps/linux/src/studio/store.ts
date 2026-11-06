// Studio on disk: `$XDG_CONFIG_HOME/relay/studio/` (dir 0700) holds `index.json` (jobs and uploads,
// newest first; projects and saved references, oldest first; SAM 2.1's segments by image; each
// file's name, token and the backend's own copies elsewhere on disk; the ETA calibration per
// backend) plus one file per asset, `<id>.<ext>`, and its preview `<id>.thumb.jpg` (files 0600). A
// segment keeps its mask `<id>.mask.png` and its cut-out `<id>.cutout.png`. As with drops, a token
// lives only in the index and in the paths handed to devices, so a directory listing is not enough
// to fetch bytes over HTTP. `work/<name>/` holds runners' scratch files and is emptied on start.
// The index is read once at construction and rewritten (tmp + rename) after every lasting change;
// progress ticks stay in memory, since a restart fails running jobs anyway.
//
// Index versions: 1 had no projects, references or segments (every job is then Unsorted); 2 adds them.

import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  MAX_STUDIO_JOBS,
  MAX_STUDIO_UPLOADS,
  STUDIO_UNDO_MS,
  StudioAsset,
  StudioBackendId,
  StudioJob,
  StudioProject,
  StudioReference,
  StudioSegments,
  type StudioSegment,
} from "@relay/protocol";
import { z } from "zod";
import { sameToken } from "../drops/serve";
import type { DropBlob } from "../seams";
import type { StudioMedia } from "./media";

const INDEX_FILE = "index.json";
const INDEX_VERSION = 2;
export const RESTART_ERROR = "Stopped when the host restarted";
/** How much the newest run moves a backend's ETA calibration (an exponential moving average). */
const CALIBRATION_WEIGHT = 0.3;
const PNG = "image/png";

const AssetFiles = z.object({
  /** Hex token that gates `/studio/<id>/<token>`. */
  token: z.string().regex(/^[0-9a-f]{64}$/),
  /** `<id>.<ext>` in the studio dir. */
  file: z.string().min(1),
  /** `<id>.thumb.jpg`, when ffmpeg could make one (a segment's: its cut-out PNG). */
  thumb: z.string().min(1).optional(),
  /** A segment's mask: the file's type (an asset's is its own `mimeType`). */
  mimeType: z.string().min(1).optional(),
  /** A segment's thumb type; a JPEG when absent. */
  thumbType: z.string().min(1).optional(),
  /** The backend's own copies outside the studio dir (ComfyUI's output), deleted with the asset. */
  copies: z.array(z.string().min(1)).optional(),
});
type AssetFiles = z.infer<typeof AssetFiles>;

const IndexFile = z.object({
  version: z.number().int().optional(),
  jobs: z.array(StudioJob),
  uploads: z.array(StudioAsset),
  /** By asset (or segment) id. */
  files: z.record(z.string(), AssetFiles),
  /** Per backend: how long jobs really took over `baseEstimateMs` (1 = as estimated). */
  calibration: z.record(StudioBackendId, z.number().positive()),
  projects: z.array(StudioProject).default([]),
  references: z.array(StudioReference).default([]),
  /** By image asset id. */
  segments: z.record(z.string(), StudioSegments).default({}),
});
type IndexFile = z.infer<typeof IndexFile>;

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
};

export function defaultStudioDir(): string {
  const base = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(base, "relay", "studio");
}

/** `job` without the fields that only mean something while it waits or runs (`etaMs`, `note`). */
export function settledJob(job: StudioJob): StudioJob {
  const next = { ...job };
  delete next.etaMs;
  delete next.note;
  return next;
}

export interface StudioStoreOptions {
  readonly now: () => number;
  readonly media: StudioMedia;
}

/** What a purge of the trash changed: jobs that keep other outputs, and jobs left with none (gone). */
export interface Purged {
  readonly changed: StudioJob[];
  readonly removed: string[];
}

export class StudioStore {
  private readonly index: IndexFile;

  /**
   * Running jobs come back failed (`RESTART_ERROR`), queued ones wait again, and so do segment runs.
   * Trash timestamps are kept. Throws on an unreadable index.
   */
  constructor(
    private readonly dir: string,
    private readonly options: StudioStoreOptions,
  ) {
    this.index = this.load();
    rmSync(join(dir, "work"), { recursive: true, force: true });
    this.persist();
  }

  get jobs(): readonly StudioJob[] {
    return this.index.jobs;
  }

  get uploads(): readonly StudioAsset[] {
    return this.index.uploads;
  }

  get projects(): readonly StudioProject[] {
    return this.index.projects;
  }

  get references(): readonly StudioReference[] {
    return this.index.references;
  }

  job(id: string): StudioJob | undefined {
    return this.index.jobs.find((job) => job.id === id);
  }

  /** An output, upload or saved reference's image with the absolute path of its file. */
  asset(id: string): { readonly asset: StudioAsset; readonly path: string } | undefined {
    const asset =
      this.index.uploads.find((upload) => upload.id === id) ??
      this.output(id)?.asset ??
      this.index.references.find((reference) => reference.asset.id === id)?.asset;
    const files = this.index.files[id];
    return asset === undefined || files === undefined ? undefined : { asset, path: join(this.dir, files.file) };
  }

  /** A job's output and the job. */
  output(id: string): { readonly asset: StudioAsset; readonly job: StudioJob } | undefined {
    for (const job of this.index.jobs) {
      const asset = job.outputs.find((output) => output.id === id);
      if (asset !== undefined) return { asset, job };
    }
    return undefined;
  }

  /**
   * Takes a file in as a new asset: moved when `source` is a path (it must be in the studio dir,
   * e.g. a runner's work dir), written when bytes; then sized, given a thumb and a token. `fallback`
   * is the size when ffprobe can't tell (an output's requested size); without one an unreadable
   * file is refused. `copies` are the backend's own copies elsewhere, deleted with the asset. The
   * asset only lasts once `putJob` (as an output), `addUpload` or `addReference` holds it; `discard`
   * drops it, and a restart prunes what nothing holds.
   */
  async ingest(
    source: { readonly path: string } | { readonly bytes: Uint8Array },
    mimeType: string,
    origin: StudioAsset["origin"],
    fallback?: { readonly width: number; readonly height: number },
    copies: readonly string[] = [],
  ): Promise<StudioAsset> {
    const ext = EXTENSIONS[mimeType];
    if (ext === undefined) throw new Error(`Studio keeps no ${mimeType} files`);
    const kind = mimeType.startsWith("video/") ? "video" : "image";
    const id = randomUUID();
    const token = randomBytes(32).toString("hex");
    const file = `${id}.${ext}`;
    const path = join(this.dir, file);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if ("path" in source) renameSync(source.path, path);
    else writeFileSync(path, source.bytes, { mode: 0o600 });
    chmodSync(path, 0o600);
    const shape = await this.options.media.probe(path);
    const width = shape.width ?? fallback?.width;
    const height = shape.height ?? fallback?.height;
    if (width === undefined || height === undefined) {
      rmSync(path, { force: true });
      for (const copy of copies) rmSync(copy, { force: true });
      throw new Error(`Could not read the ${kind}`);
    }
    const thumb = `${id}.thumb.jpg`;
    const thumbed = await this.options.media.thumb(path, join(this.dir, thumb));
    if (thumbed) chmodSync(join(this.dir, thumb), 0o600);
    this.index.files[id] = { token, file, ...(thumbed ? { thumb } : {}), ...(copies.length > 0 ? { copies: [...copies] } : {}) };
    const base = `/studio/${id}/${token}`;
    return {
      id,
      kind,
      mimeType,
      width,
      height,
      // An image's "duration" from ffprobe is a frame time, not a length.
      ...(kind === "video" && shape.durationMs !== undefined ? { durationMs: shape.durationMs } : {}),
      size: statSync(path).size,
      path: base,
      thumb: `${base}/thumb`,
      origin,
      createdAt: this.options.now(),
    };
  }

  /** Removes an ingested asset nothing holds (its job was cancelled or deleted meanwhile), with its copies. */
  discard(id: string): void {
    this.forget(id);
    this.persist();
  }

  /**
   * Saves `job` (a new one goes first) and persists; returns the ids of failed or cancelled jobs evicted past
   * `MAX_STUDIO_JOBS`. Finished jobs are the library and are never evicted.
   */
  putJob(job: StudioJob): string[] {
    this.touchJob(job);
    const evicted: string[] = [];
    for (let i = this.index.jobs.length - 1; i >= 0 && this.index.jobs.length > MAX_STUDIO_JOBS; i--) {
      const old = this.index.jobs[i];
      if (old === undefined || (old.state !== "failed" && old.state !== "cancelled")) continue;
      this.index.jobs.splice(i, 1);
      for (const output of old.outputs) this.forget(output.id);
      evicted.push(old.id);
    }
    this.persist();
    return evicted;
  }

  /** Like `putJob` without writing the index: progress ticks and notes. */
  touchJob(job: StudioJob): void {
    const at = this.index.jobs.findIndex((candidate) => candidate.id === job.id);
    if (at === -1) this.index.jobs.unshift(job);
    else this.index.jobs[at] = job;
  }

  /** Removes a job and every copy of its outputs (store files, thumbs, backend copies, segments); false when there is no such job. */
  removeJob(id: string): boolean {
    const at = this.index.jobs.findIndex((job) => job.id === id);
    if (at === -1) return false;
    const [job] = this.index.jobs.splice(at, 1);
    for (const output of job?.outputs ?? []) this.forget(output.id);
    this.clearWork(id);
    this.persist();
    return true;
  }

  /** When the next trashed output is due for deletion; undefined when the trash is empty. */
  nextPurgeAt(): number | undefined {
    let next: number | undefined;
    for (const job of this.index.jobs)
      for (const output of job.outputs)
        if (output.deletedAt !== undefined) next = Math.min(next ?? Infinity, output.deletedAt + STUDIO_UNDO_MS);
    return next;
  }

  /** Deletes every copy of the outputs trashed at least `STUDIO_UNDO_MS` before `now`; a job left with none goes too. */
  purgeTrash(now: number): Purged {
    const changed: StudioJob[] = [];
    const removed: string[] = [];
    const due = (asset: StudioAsset): boolean => asset.deletedAt !== undefined && now - asset.deletedAt >= STUDIO_UNDO_MS;
    for (const job of [...this.index.jobs]) {
      if (!job.outputs.some(due)) continue;
      for (const output of job.outputs.filter(due)) this.forget(output.id);
      const outputs = job.outputs.filter((output) => !due(output));
      if (outputs.length === 0) {
        this.index.jobs.splice(this.index.jobs.indexOf(job), 1);
        this.clearWork(job.id);
        removed.push(job.id);
      } else {
        const next = { ...job, outputs };
        this.touchJob(next);
        changed.push(next);
      }
    }
    if (changed.length > 0 || removed.length > 0) this.persist();
    return { changed, removed };
  }

  /** Keeps an ingested upload first; returns the ids of the oldest ones evicted past `MAX_STUDIO_UPLOADS`. */
  addUpload(asset: StudioAsset): string[] {
    this.index.uploads.unshift(asset);
    const evicted = this.index.uploads.splice(MAX_STUDIO_UPLOADS);
    for (const old of evicted) this.forget(old.id);
    this.persist();
    return evicted.map((old) => old.id);
  }

  /** Removes an upload and its files; false when there is no such upload. */
  removeUpload(id: string): boolean {
    const at = this.index.uploads.findIndex((upload) => upload.id === id);
    if (at === -1) return false;
    this.index.uploads.splice(at, 1);
    this.forget(id);
    this.persist();
    return true;
  }

  project(id: string): StudioProject | undefined {
    return this.index.projects.find((project) => project.id === id);
  }

  /** Saves a project (a new one goes last). */
  putProject(project: StudioProject): void {
    const at = this.index.projects.findIndex((candidate) => candidate.id === project.id);
    if (at === -1) this.index.projects.push(project);
    else this.index.projects[at] = project;
    this.persist();
  }

  removeProject(id: string): void {
    this.index.projects = this.index.projects.filter((project) => project.id !== id);
    this.persist();
  }

  /** Keeps a reference whose asset was just ingested (last: references are oldest first). */
  addReference(reference: StudioReference): void {
    this.index.references.push(reference);
    this.persist();
  }

  /** Removes a reference and its own copy of the image; false when there is no such reference. */
  removeReference(id: string): boolean {
    const reference = this.index.references.find((candidate) => candidate.id === id);
    if (reference === undefined) return false;
    this.index.references = this.index.references.filter((candidate) => candidate !== reference);
    this.forget(reference.asset.id);
    this.persist();
    return true;
  }

  /** SAM 2.1's objects for an image, as last saved. */
  segments(asset: string): StudioSegments | undefined {
    return this.index.segments[asset];
  }

  /** Every image with segments, in the order they were asked for. */
  get allSegments(): readonly StudioSegments[] {
    return Object.values(this.index.segments);
  }

  /** Saves an image's segments (replacing the files of segments it no longer has) and persists. */
  putSegments(segments: StudioSegments): void {
    const kept = new Set(segments.segments.map((segment) => segment.id));
    for (const old of this.index.segments[segments.asset]?.segments ?? []) if (!kept.has(old.id)) this.unlinkFiles(old.id);
    this.index.segments[segments.asset] = segments;
    this.persist();
  }

  /** The mask PNG of segment `id` and the image it belongs to. */
  segmentMask(id: string): { readonly asset: string; readonly path: string } | undefined {
    for (const entry of Object.values(this.index.segments)) {
      if (!entry.segments.some((segment) => segment.id === id)) continue;
      const files = this.index.files[id];
      return files === undefined ? undefined : { asset: entry.asset, path: join(this.dir, files.file) };
    }
    return undefined;
  }

  /**
   * Takes a SAM 2.1 result in: the mask and cut-out PNGs move into the studio dir (they must be in it, e.g. a work
   * dir) under one new token. It only lasts once `putSegments` holds it.
   */
  ingestSegment(found: { readonly label: string; readonly box: readonly [number, number, number, number]; readonly area: number; readonly mask: string; readonly cutout: string }): StudioSegment {
    const id = randomUUID();
    const token = randomBytes(32).toString("hex");
    const file = `${id}.mask.png`;
    const thumb = `${id}.cutout.png`;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    renameSync(found.mask, join(this.dir, file));
    renameSync(found.cutout, join(this.dir, thumb));
    chmodSync(join(this.dir, file), 0o600);
    chmodSync(join(this.dir, thumb), 0o600);
    this.index.files[id] = { token, file, thumb, mimeType: PNG, thumbType: PNG };
    const clamp = (value: number): number => Math.min(1, Math.max(0, value));
    const base = `/studio/${id}/${token}`;
    return {
      id,
      label: found.label.slice(0, 60) || "Object",
      box: [clamp(found.box[0]), clamp(found.box[1]), clamp(found.box[2]), clamp(found.box[3])],
      area: clamp(found.area),
      mask: base,
      thumb: `${base}/thumb`,
    };
  }

  open(id: string, token: string): DropBlob | null {
    const found = this.authorized(id, token);
    if (found === null) return null;
    const path = join(this.dir, found.files.file);
    if (!existsSync(path)) return null;
    return { path, name: found.files.file, mimeType: found.mimeType, size: statSync(path).size };
  }

  /** The thumb (a JPEG, a segment's cut-out PNG); an image whose thumb ffmpeg couldn't make serves itself. */
  openThumb(id: string, token: string): DropBlob | null {
    const found = this.authorized(id, token);
    if (found === null) return null;
    const path = found.files.thumb === undefined ? null : join(this.dir, found.files.thumb);
    if (path !== null && existsSync(path)) {
      const mimeType = found.files.thumbType ?? "image/jpeg";
      return { path, name: `${id}.${EXTENSIONS[mimeType] ?? "jpg"}`, mimeType, size: statSync(path).size };
    }
    return found.mimeType.startsWith("image/") ? this.open(id, token) : null;
  }

  /** Real time over `baseEstimateMs` for `backend`; 1 until a job has finished there. */
  calibration(backend: StudioBackendId): number {
    return this.index.calibration[backend] ?? 1;
  }

  /** Folds one finished job (`ratio` = real time over its base estimate) into the backend's calibration. */
  calibrate(backend: StudioBackendId, ratio: number): void {
    const clamped = Math.min(5, Math.max(0.2, ratio));
    const factor = this.calibration(backend);
    this.index.calibration[backend] = factor + CALIBRATION_WEIGHT * (clamped - factor);
    this.persist();
  }

  /** An empty scratch dir inside the studio dir (so outputs move in with a rename). */
  workDir(name: string): string {
    const dir = join(this.dir, "work", name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  clearWork(name: string): void {
    rmSync(join(this.dir, "work", name), { recursive: true, force: true });
  }

  /** The files of `id` (an asset or a segment) and their type iff `token` is its token (compared in constant time). */
  private authorized(id: string, token: string): { readonly files: AssetFiles; readonly mimeType: string } | null {
    const files = this.index.files[id];
    if (files === undefined || !sameToken(files.token, token)) return null;
    if (files.mimeType !== undefined) return this.segmentMask(id) === undefined ? null : { files, mimeType: files.mimeType };
    const asset = this.asset(id)?.asset;
    return asset === undefined ? null : { files, mimeType: asset.mimeType };
  }

  /** Deletes an asset's every copy: its file, thumb, the backend's copies and its segments' files. */
  private forget(id: string): void {
    this.unlinkFiles(id);
    const segments = this.index.segments[id];
    if (segments === undefined) return;
    for (const segment of segments.segments) this.unlinkFiles(segment.id);
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the segments map is keyed by asset id
    delete this.index.segments[id];
  }

  private unlinkFiles(id: string): void {
    const files = this.index.files[id];
    if (files === undefined) return;
    removeFiles(this.dir, files);
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the files map is keyed by asset id
    delete this.index.files[id];
  }

  private load(): IndexFile {
    const path = join(this.dir, INDEX_FILE);
    if (!existsSync(path))
      return { version: INDEX_VERSION, jobs: [], uploads: [], files: {}, calibration: {}, projects: [], references: [], segments: {} };
    const parsed = IndexFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) throw new Error(`${path}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    const now = this.options.now();
    const jobs = parsed.data.jobs.map((job): StudioJob => {
      if (job.state === "running") return { ...settledJob(job), state: "failed", error: RESTART_ERROR, finishedAt: now };
      if (job.state === "queued") return { ...settledJob(job), progress: 0 };
      return job;
    });
    const images = new Set([
      ...parsed.data.uploads.map((upload) => upload.id),
      ...jobs.flatMap((job) => job.outputs.map((output) => output.id)),
      ...parsed.data.references.map((reference) => reference.asset.id),
    ]);
    // Segments of an image that is gone go with it; a run the restart stopped waits again.
    const segments: Record<string, StudioSegments> = {};
    for (const [asset, entry] of Object.entries(parsed.data.segments)) {
      if (images.has(asset)) segments[asset] = entry.state === "running" ? { ...entry, state: "queued" } : entry;
    }
    // Files nothing holds: an output ingested just before a crash, or one whose job went meanwhile.
    const held = new Set([...images, ...Object.values(segments).flatMap((entry) => entry.segments.map((segment) => segment.id))]);
    const files: Record<string, AssetFiles> = {};
    for (const [id, record] of Object.entries(parsed.data.files)) {
      if (held.has(id)) files[id] = record;
      else removeFiles(this.dir, record);
    }
    return { ...parsed.data, version: INDEX_VERSION, jobs, files, segments };
  }

  private persist(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, INDEX_FILE);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.index), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  }
}

function removeFiles(dir: string, files: AssetFiles): void {
  rmSync(join(dir, files.file), { force: true });
  if (files.thumb !== undefined) rmSync(join(dir, files.thumb), { force: true });
  for (const copy of files.copies ?? []) rmSync(copy, { force: true });
}
