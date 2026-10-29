// Studio on disk: `$XDG_CONFIG_HOME/relay/studio/` (dir 0700) holds `index.json` (jobs and uploads,
// newest first; each asset's file names and token; the ETA calibration per backend) plus one file
// per asset, `<id>.<ext>`, and its preview `<id>.thumb.jpg` (files 0600). As with drops, a token
// lives only in the index and in the paths handed to devices, so a directory listing is not enough
// to fetch bytes over HTTP. `work/<name>/` holds runners' scratch files and is emptied on start.
// The index is read once at construction and rewritten (tmp + rename) after every lasting change;
// progress ticks stay in memory, since a restart fails running jobs anyway.

import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_STUDIO_JOBS, MAX_STUDIO_UPLOADS, StudioAsset, StudioBackendId, StudioJob, studioJobActive } from "@relay/protocol";
import { z } from "zod";
import { sameToken } from "../drops/serve";
import type { DropBlob } from "../seams";
import type { StudioMedia } from "./media";

const INDEX_FILE = "index.json";
export const RESTART_ERROR = "Stopped when the host restarted";
/** How much the newest run moves a backend's ETA calibration (an exponential moving average). */
const CALIBRATION_WEIGHT = 0.3;

const AssetFiles = z.object({
  /** Hex token that gates `/studio/<id>/<token>`. */
  token: z.string().regex(/^[0-9a-f]{64}$/),
  /** `<id>.<ext>` in the studio dir. */
  file: z.string().min(1),
  /** `<id>.thumb.jpg`, when ffmpeg could make one. */
  thumb: z.string().min(1).optional(),
});
type AssetFiles = z.infer<typeof AssetFiles>;

const IndexFile = z.object({
  jobs: z.array(StudioJob),
  uploads: z.array(StudioAsset),
  /** By asset id. */
  files: z.record(z.string(), AssetFiles),
  /** Per backend: how long jobs really took over `baseEstimateMs` (1 = as estimated). */
  calibration: z.record(StudioBackendId, z.number().positive()),
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

export class StudioStore {
  private readonly index: IndexFile;

  /** Running jobs come back failed (`RESTART_ERROR`), queued ones wait again. Throws on an unreadable index. */
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

  job(id: string): StudioJob | undefined {
    return this.index.jobs.find((job) => job.id === id);
  }

  /** An output or upload with the absolute path of its file. */
  asset(id: string): { readonly asset: StudioAsset; readonly path: string } | undefined {
    const asset = this.index.uploads.find((upload) => upload.id === id) ?? this.index.jobs.flatMap((job) => job.outputs).find((output) => output.id === id);
    const files = this.index.files[id];
    return asset === undefined || files === undefined ? undefined : { asset, path: join(this.dir, files.file) };
  }

  /**
   * Takes a file in as a new asset: moved when `source` is a path (it must be in the studio dir,
   * e.g. a runner's work dir), written when bytes; then sized, given a thumb and a token. `fallback`
   * is the size when ffprobe can't tell (an output's requested size); without one an unreadable
   * file is refused. The asset only lasts once `putJob` (as an output) or `addUpload` holds it;
   * `discard` drops it, and a restart prunes what nothing holds.
   */
  async ingest(
    source: { readonly path: string } | { readonly bytes: Uint8Array },
    mimeType: string,
    origin: StudioAsset["origin"],
    fallback?: { readonly width: number; readonly height: number },
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
      throw new Error(`Could not read the ${kind}`);
    }
    const thumb = `${id}.thumb.jpg`;
    const thumbed = await this.options.media.thumb(path, join(this.dir, thumb));
    if (thumbed) chmodSync(join(this.dir, thumb), 0o600);
    this.index.files[id] = { token, file, ...(thumbed ? { thumb } : {}) };
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

  /** Removes an ingested asset nothing holds (its job was cancelled or deleted meanwhile). */
  discard(id: string): void {
    this.unlink(id);
    this.persist();
  }

  /** Saves `job` (a new one goes first) and persists; returns the ids of finished jobs evicted past `MAX_STUDIO_JOBS`. */
  putJob(job: StudioJob): string[] {
    this.touchJob(job);
    const evicted: string[] = [];
    for (let i = this.index.jobs.length - 1; i >= 0 && this.index.jobs.length > MAX_STUDIO_JOBS; i--) {
      const old = this.index.jobs[i];
      if (old === undefined || studioJobActive(old)) continue;
      this.index.jobs.splice(i, 1);
      for (const output of old.outputs) this.unlink(output.id);
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

  /** Removes a job and its outputs' files; false when there is no such job. */
  removeJob(id: string): boolean {
    const at = this.index.jobs.findIndex((job) => job.id === id);
    if (at === -1) return false;
    const [job] = this.index.jobs.splice(at, 1);
    for (const output of job?.outputs ?? []) this.unlink(output.id);
    this.persist();
    return true;
  }

  /** Keeps an ingested upload first; returns the ids of the oldest ones evicted past `MAX_STUDIO_UPLOADS`. */
  addUpload(asset: StudioAsset): string[] {
    this.index.uploads.unshift(asset);
    const evicted = this.index.uploads.splice(MAX_STUDIO_UPLOADS);
    for (const old of evicted) this.unlink(old.id);
    this.persist();
    return evicted.map((old) => old.id);
  }

  /** Removes an upload and its files; false when there is no such upload. */
  removeUpload(id: string): boolean {
    const at = this.index.uploads.findIndex((upload) => upload.id === id);
    if (at === -1) return false;
    this.index.uploads.splice(at, 1);
    this.unlink(id);
    this.persist();
    return true;
  }

  open(id: string, token: string): DropBlob | null {
    const found = this.authorized(id, token);
    if (found === null) return null;
    const path = join(this.dir, found.files.file);
    if (!existsSync(path)) return null;
    return { path, name: found.files.file, mimeType: found.asset.mimeType, size: statSync(path).size };
  }

  /** The thumb JPEG; an image whose thumb ffmpeg couldn't make serves itself. */
  openThumb(id: string, token: string): DropBlob | null {
    const found = this.authorized(id, token);
    if (found === null) return null;
    const path = found.files.thumb === undefined ? null : join(this.dir, found.files.thumb);
    if (path !== null && existsSync(path)) return { path, name: `${id}.jpg`, mimeType: "image/jpeg", size: statSync(path).size };
    return found.asset.kind === "image" ? this.open(id, token) : null;
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

  /** The asset `id` and its files iff `token` is its token (compared in constant time). */
  private authorized(id: string, token: string): { readonly asset: StudioAsset; readonly files: AssetFiles } | null {
    const files = this.index.files[id];
    if (files === undefined || !sameToken(files.token, token)) return null;
    const asset = this.asset(id)?.asset;
    return asset === undefined ? null : { asset, files };
  }

  private unlink(id: string): void {
    const files = this.index.files[id];
    if (files === undefined) return;
    rmSync(join(this.dir, files.file), { force: true });
    if (files.thumb !== undefined) rmSync(join(this.dir, files.thumb), { force: true });
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the files map is keyed by asset id
    delete this.index.files[id];
  }

  private load(): IndexFile {
    const path = join(this.dir, INDEX_FILE);
    if (!existsSync(path)) return { jobs: [], uploads: [], files: {}, calibration: {} };
    const parsed = IndexFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) throw new Error(`${path}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    const now = this.options.now();
    const jobs = parsed.data.jobs.map((job): StudioJob => {
      if (job.state === "running") return { ...settledJob(job), state: "failed", error: RESTART_ERROR, finishedAt: now };
      if (job.state === "queued") return { ...settledJob(job), progress: 0 };
      return job;
    });
    // Files nothing holds: an output ingested just before a crash, or one whose job went meanwhile.
    const held = new Set([...parsed.data.uploads.map((upload) => upload.id), ...jobs.flatMap((job) => job.outputs.map((output) => output.id))]);
    const files: Record<string, AssetFiles> = {};
    for (const [id, record] of Object.entries(parsed.data.files)) {
      if (held.has(id)) {
        files[id] = record;
        continue;
      }
      rmSync(join(this.dir, record.file), { force: true });
      if (record.thumb !== undefined) rmSync(join(this.dir, record.thumb), { force: true });
    }
    return { ...parsed.data, jobs, files };
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
