// The drop box on disk: `$XDG_CONFIG_HOME/relay/drops/` (dir 0700) holds `index.json`, the
// history newest first, plus one extensionless blob file per image/file drop named by the drop
// id. The blob token lives only in the index and in the `DropFile.path` handed to phones, so a
// leaked directory listing is not enough to fetch bytes over HTTP. The index is read once at
// construction and rewritten (tmp + rename) after every mutation, like the other file stores.

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Drop, MAX_DROP_BYTES, MAX_DROP_TEXT, MAX_DROPS, type DropOrigin } from "@relay/protocol";
import { z } from "zod";
import type { DropBlob, DropBox, DropChange } from "../seams";

/** Longest `Drop.title`; the phone shows one line. */
const MAX_TITLE = 120;
const INDEX_FILE = "index.json";

const DropRecord = z.object({
  drop: Drop,
  /** Hex token that gates `open`; present iff `file` is. */
  token: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** Blob file name inside the drops dir. */
  file: z.string().min(1).optional(),
});
type DropRecord = z.infer<typeof DropRecord>;
const IndexFile = z.array(DropRecord).max(MAX_DROPS);

export function defaultDropsDir(): string {
  const base = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(base, "relay", "drops");
}

export class FileDropStore implements DropBox {
  onChange: ((change: DropChange) => void) | null = null;
  private records: DropRecord[];

  constructor(private readonly dir: string = defaultDropsDir()) {
    this.records = this.load();
  }

  list(): readonly Drop[] {
    return this.records.map((record) => record.drop);
  }

  putText(origin: DropOrigin, text: string): Drop {
    if (text.length > MAX_DROP_TEXT) throw new Error(`text exceeds ${MAX_DROP_TEXT} characters`);
    const trimmed = text.trim();
    if (trimmed === "") throw new Error("empty text");
    const link = isLink(trimmed);
    const drop: Drop = {
      id: randomUUID(),
      kind: link ? "link" : "text",
      origin,
      createdAt: Date.now(),
      title: link ? trimmed : firstLine(trimmed),
      text,
    };
    this.add({ drop });
    return drop;
  }

  putBlob(origin: DropOrigin, blob: { readonly name: string; readonly mimeType: string; readonly bytes: Uint8Array }): Drop {
    if (blob.bytes.length === 0) throw new Error("empty blob");
    if (blob.bytes.length > MAX_DROP_BYTES) throw new Error(`blob exceeds ${MAX_DROP_BYTES} bytes`);
    const id = randomUUID();
    const token = randomBytes(32).toString("hex");
    const drop: Drop = {
      id,
      kind: blob.mimeType.startsWith("image/") ? "image" : "file",
      origin,
      createdAt: Date.now(),
      title: blob.name.slice(0, MAX_TITLE),
      file: { name: blob.name, mimeType: blob.mimeType, size: blob.bytes.length, path: `/drops/${id}/${token}` },
    };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, id);
    writeFileSync(file, blob.bytes, { mode: 0o600 });
    chmodSync(file, 0o600);
    this.add({ drop, token, file: id });
    return drop;
  }

  remove(id: string): boolean {
    const index = this.records.findIndex((record) => record.drop.id === id);
    if (index === -1) return false;
    const [record] = this.records.splice(index, 1);
    if (record !== undefined) this.unlink(record);
    this.persist();
    this.onChange?.({ kind: "removed", id });
    return true;
  }

  open(id: string, token: string): DropBlob | null {
    const record = this.records.find((candidate) => candidate.drop.id === id);
    if (record?.token === undefined || record.file === undefined || record.drop.file === undefined) return null;
    const expected = Buffer.from(record.token, "utf8");
    const given = Buffer.from(token, "utf8");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const { name, mimeType, size } = record.drop.file;
    return { path: join(this.dir, record.file), name, mimeType, size };
  }

  /** Prepends `record`, evicts past `MAX_DROPS`, persists, then reports evictions and the add. */
  private add(record: DropRecord): void {
    this.records.unshift(record);
    const evicted = this.records.splice(MAX_DROPS);
    for (const old of evicted) this.unlink(old);
    this.persist();
    for (const old of evicted) this.onChange?.({ kind: "removed", id: old.drop.id });
    this.onChange?.({ kind: "added", drop: record.drop });
  }

  private unlink(record: DropRecord): void {
    if (record.file !== undefined) rmSync(join(this.dir, record.file), { force: true });
  }

  private load(): DropRecord[] {
    const path = join(this.dir, INDEX_FILE);
    if (!existsSync(path)) return [];
    const parsed = IndexFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) throw new Error(`${path}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    return parsed.data;
  }

  private persist(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, INDEX_FILE);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.records, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  }
}

/** True when the whole (already trimmed) text is one http(s) URL with no whitespace inside. */
function isLink(trimmed: string): boolean {
  if (/\s/.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** The first non-empty line, cut to `MAX_TITLE`. `trimmed` is non-empty, so a line exists. */
function firstLine(trimmed: string): string {
  const line = trimmed.split("\n").find((candidate) => candidate.trim() !== "") ?? trimmed;
  return line.trim().slice(0, MAX_TITLE);
}
