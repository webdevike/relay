// omp chat transcripts and image blobs under the host's omp dir (`~/.omp`), read raw for paired
// devices. Each store is an omp agent dir: the default `agent/` and every named profile's
// `profiles/<profile>/agent/`. In each: `sessions/<dir>/<name>.jsonl` (top-level transcripts only;
// subagent transcripts nest one level deeper and are not listed) and `blobs/<sha256>[.<ext>]`.
// Every request names single path segments, and symlinks are refused, so nothing outside those
// dirs is ever opened.
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, type Dirent, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionFile } from "@relay/protocol";
/** Largest raw slice one `session.chunk` carries (base64 on the wire). */
export const MAX_SESSION_CHUNK = 256 * 1024;
const HASH = /^[0-9a-f]{64}$/;
/** omp stores a blob as `<hash>` or `<hash>.<ext>`. */
const BLOB_NAMES = ["", ".png", ".jpg", ".jpeg", ".webp", ".gif"];
const BLOB_MIME: readonly [string, (bytes: Buffer) => boolean][] = [
  ["image/png", (b) => b.subarray(0, 4).toString("hex") === "89504e47"],
  ["image/jpeg", (b) => b.subarray(0, 3).toString("hex") === "ffd8ff"],
  ["image/gif", (b) => b.subarray(0, 4).toString("latin1") === "GIF8"],
  ["image/webp", (b) => b.subarray(8, 12).toString("latin1") === "WEBP"],
];
export interface SessionChunk {
  readonly data: string;
  readonly size: number;
}
export interface Blob {
  readonly mime: string;
  readonly data: string;
}
/** A transcript found by session id: its store's `profile` (absent for the default store) and absolute path. */
export interface SessionLocation {
  readonly profile?: string;
  readonly path: string;
}
/** A single, non-dot path segment. */
function segment(value: string): boolean {
  return value.length > 0 && !value.startsWith(".") && !value.includes("/") && !value.includes("\\") && !value.includes("\0");
}
function lstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}
function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
export class SessionFiles {
  constructor(private readonly ompDir: string = join(homedir(), ".omp")) {}
  /** Every top-level transcript of every store, newest first. */
  list(): SessionFile[] {
    const files: SessionFile[] = [];
    for (const profile of this.profiles()) {
      const sessionsDir = join(this.agentDir(profile), "sessions");
      const store = profile === undefined ? {} : { profile };
      for (const dir of entries(sessionsDir)) {
        if (!dir.isDirectory() || !segment(dir.name)) continue;
        for (const file of entries(join(sessionsDir, dir.name))) {
          if (!file.isFile() || !segment(file.name) || !file.name.endsWith(".jsonl")) continue;
          const stats = lstat(join(sessionsDir, dir.name, file.name));
          if (stats !== null) files.push({ ...store, dir: dir.name, name: file.name, size: stats.size, mtime: stats.mtimeMs });
        }
      }
    }
    return files.sort((a, b) => b.mtime - a.mtime);
  }
  /** Raw bytes from `offset`, at most `limit` and `MAX_SESSION_CHUNK`; null when the file is not an allowed transcript. */
  read(profile: string | undefined, dir: string, name: string, offset: number, limit = MAX_SESSION_CHUNK): SessionChunk | null {
    const path = this.transcript(profile, dir, name);
    if (path === null) return null;
    const fd = openSync(path, "r");
    try {
      const size = lstatSync(path).size;
      const buffer = Buffer.alloc(Math.max(0, Math.min(limit, MAX_SESSION_CHUNK, size - offset)));
      const read = readSync(fd, buffer, 0, buffer.length, offset);
      return { data: buffer.subarray(0, read).toString("base64"), size };
    } finally {
      closeSync(fd);
    }
  }
  /** The blob stored under `hash` (with or without an extension) in any store; null when there is none. */
  blob(hash: string): Blob | null {
    if (!HASH.test(hash)) return null;
    for (const profile of this.profiles()) {
      const blobsDir = join(this.agentDir(profile), "blobs");
      const path = BLOB_NAMES.map((ext) => join(blobsDir, hash + ext)).find((p) => lstat(p)?.isFile() === true);
      if (path === undefined) continue;
      const bytes = readFileSync(path);
      const mime = BLOB_MIME.find(([, matches]) => matches(bytes))?.[0] ?? "application/octet-stream";
      return { mime, data: bytes.toString("base64") };
    }
    return null;
  }
  /** The transcript of omp session `id` (`<stamp>_<id>.jsonl`) in any store; null when none exists. */
  fileForSessionId(id: string): SessionLocation | null {
    const suffix = `_${id}.jsonl`;
    const file = this.list().find((entry) => entry.name.endsWith(suffix));
    if (file === undefined) return null;
    const path = join(this.agentDir(file.profile), "sessions", file.dir, file.name);
    return file.profile === undefined ? { path } : { profile: file.profile, path };
  }
  /** `undefined` (the default store) followed by every named profile that has an agent dir. */
  private profiles(): (string | undefined)[] {
    const named = entries(join(this.ompDir, "profiles"))
      .filter((entry) => entry.isDirectory() && segment(entry.name) && lstat(this.agentDir(entry.name))?.isDirectory() === true)
      .map((entry) => entry.name);
    return [undefined, ...named];
  }
  private agentDir(profile: string | undefined): string {
    return profile === undefined ? join(this.ompDir, "agent") : join(this.ompDir, "profiles", profile, "agent");
  }
  private transcript(profile: string | undefined, dir: string, name: string): string | null {
    if (!segment(dir) || !segment(name) || !name.endsWith(".jsonl")) return null;
    if (profile !== undefined && (!segment(profile) || lstat(join(this.ompDir, "profiles", profile))?.isDirectory() !== true)) return null;
    const agentDir = this.agentDir(profile);
    if (lstat(agentDir)?.isDirectory() !== true || lstat(join(agentDir, "sessions"))?.isDirectory() !== true) return null;
    if (lstat(join(agentDir, "sessions", dir))?.isDirectory() !== true) return null;
    const path = join(agentDir, "sessions", dir, name);
    return lstat(path)?.isFile() === true ? path : null;
  }
}
