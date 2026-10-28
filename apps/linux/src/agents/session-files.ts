// omp chat transcripts and image blobs under the host's omp agent dir (`~/.omp/agent`), read raw
// for paired devices: `sessions/<dir>/<name>.jsonl` (top-level transcripts only; subagent
// transcripts nest one level deeper and are not listed) and `blobs/<sha256>[.<ext>]`.
// Every request names a single path segment, and symlinks are refused, so nothing outside those
// two dirs is ever opened.
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

export class SessionFiles {
  private readonly sessionsDir: string;
  private readonly blobsDir: string;

  constructor(agentDir: string = join(homedir(), ".omp", "agent")) {
    this.sessionsDir = join(agentDir, "sessions");
    this.blobsDir = join(agentDir, "blobs");
  }

  /** Every top-level transcript, newest first. */
  list(): SessionFile[] {
    const files: SessionFile[] = [];
    for (const dir of this.entries(this.sessionsDir)) {
      if (!dir.isDirectory() || !segment(dir.name)) continue;
      for (const file of this.entries(join(this.sessionsDir, dir.name))) {
        if (!file.isFile() || !segment(file.name) || !file.name.endsWith(".jsonl")) continue;
        const stats = lstat(join(this.sessionsDir, dir.name, file.name));
        if (stats !== null) files.push({ dir: dir.name, name: file.name, size: stats.size, mtime: stats.mtimeMs });
      }
    }
    return files.sort((a, b) => b.mtime - a.mtime);
  }

  /** Raw bytes from `offset`, at most `limit` and `MAX_SESSION_CHUNK`; null when the file is not an allowed transcript. */
  read(dir: string, name: string, offset: number, limit = MAX_SESSION_CHUNK): SessionChunk | null {
    const path = this.transcript(dir, name);
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

  /** The blob stored under `hash` (with or without an extension); null when there is none. */
  blob(hash: string): Blob | null {
    if (!HASH.test(hash)) return null;
    const path = BLOB_NAMES.map((ext) => join(this.blobsDir, hash + ext)).find((p) => lstat(p)?.isFile() === true);
    if (path === undefined) return null;
    const bytes = readFileSync(path);
    const mime = BLOB_MIME.find(([, matches]) => matches(bytes))?.[0] ?? "application/octet-stream";
    return { mime, data: bytes.toString("base64") };
  }

  /** The transcript of omp session `id` (`<stamp>_<id>.jsonl`); null when none exists. */
  fileForSessionId(id: string): { readonly dir: string; readonly name: string } | null {
    const suffix = `_${id}.jsonl`;
    const file = this.list().find((entry) => entry.name.endsWith(suffix));
    return file === undefined ? null : { dir: file.dir, name: file.name };
  }

  private transcript(dir: string, name: string): string | null {
    if (!segment(dir) || !segment(name) || !name.endsWith(".jsonl")) return null;
    if (lstat(join(this.sessionsDir, dir))?.isDirectory() !== true) return null;
    const path = join(this.sessionsDir, dir, name);
    return lstat(path)?.isFile() === true ? path : null;
  }

  private entries(dir: string): Dirent[] {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  }
}
