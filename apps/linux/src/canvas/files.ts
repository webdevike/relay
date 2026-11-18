// The boards folder for Relay Desktops on other Macs (protocol canvas-files.ts): a thin client keeps
// no boards of its own and reads and writes these files through `canvas.file.req`, so every Mac
// opens the same board. Board files are `<slug>.json` in `dir`; images are any file under `dir`
// named by a relative `src` (never absolute, never `..`). A write through the frames tells every
// watching desktop at once with the writer's origin; a change made on this Mac (an agent, a live
// room, the Mini's own app) reaches them through a folder watch with origin null.

import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { BoardConflict, writeBoardFile } from "@relay/canvas-live/board-file";
import {
  MAX_CANVAS_ASSET_BYTES,
  type CanvasFileEntry,
  type CanvasFileReq,
  type CanvasFileRes,
} from "@relay/protocol";

const SLUG = /^[a-z0-9-]{1,80}$/;
const BOARD = /^([a-z0-9-]{1,80})\.json$/;

export type CanvasFileResult = Omit<CanvasFileRes, "t" | "rid">;

/** What a session needs of the boards folder. */
export interface CanvasFilesRelaying {
  /** Answers one request. Never throws. */
  handle(req: CanvasFileReq): Promise<CanvasFileResult>;
  /** Set by the server: a board changed (`slug`), or one came or went (null). */
  onChange: ((slug: string | null, origin: string | null) => void) | null;
}

export interface CanvasFilesServiceDeps {
  readonly dir: string;
  readonly log: (line: string) => void;
  /** How long the folder watch waits for a burst of writes to settle (tests pass less). */
  readonly debounceMs?: number;
}

const hash = (text: string): string => createHash("sha1").update(text).digest("hex");

function refuse(code: NonNullable<CanvasFileRes["code"]>, error: string): CanvasFileResult {
  return { ok: false, code, error };
}

export class CanvasFilesService implements CanvasFilesRelaying {
  onChange: ((slug: string | null, origin: string | null) => void) | null = null;
  /** The hash of what the frames last wrote per board, so the folder watch does not tell it twice. */
  private readonly written = new Map<string, string | null>();
  /** Boards known to exist, to tell a new or removed board (null) from an edit (slug). */
  private readonly known = new Set<string>();
  private readonly pending = new Set<string>();
  private watcher: FSWatcher | null = null;
  private timer: Timer | undefined;

  constructor(private readonly deps: CanvasFilesServiceDeps) {}

  /** Starts the folder watch; a missing folder is made first. */
  async start(): Promise<void> {
    await mkdir(this.deps.dir, { recursive: true });
    for (const name of await readdir(this.deps.dir)) {
      const m = BOARD.exec(name);
      if (m) this.known.add(m[1]!);
    }
    try {
      this.watcher = watch(this.deps.dir, (_event, name) => {
        const m = name === null ? null : BOARD.exec(String(name));
        if (!m) return;
        this.pending.add(m[1]!);
        this.timer ??= setTimeout(() => void this.flush(), this.deps.debounceMs ?? 250);
      });
    } catch (error) {
      this.deps.log(
        `canvas files: cannot watch ${this.deps.dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.watcher?.close();
    this.watcher = null;
  }

  async handle(req: CanvasFileReq): Promise<CanvasFileResult> {
    try {
      return await this.run(req);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT") return refuse("not-found", "No such file.");
      this.deps.log(
        `canvas files: ${req.op} ${req.slug ?? req.src ?? ""} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return refuse("internal", error instanceof Error ? error.message : String(error));
    }
  }

  private board(slug: string | undefined): string | null {
    return slug !== undefined && SLUG.test(slug) ? join(this.deps.dir, `${slug}.json`) : null;
  }

  /** `src` under the boards folder, or null for an absolute path or one that leaves it. */
  private asset(src: string | undefined): string | null {
    if (src === undefined || isAbsolute(src) || src.includes("\0")) return null;
    const rel = normalize(src);
    if (rel === ".." || rel.startsWith(`..${sep}`) || rel === "." || rel === "") return null;
    return join(this.deps.dir, rel);
  }

  private async run(req: CanvasFileReq): Promise<CanvasFileResult> {
    const origin = req.origin ?? null;
    switch (req.op) {
      case "list": {
        const files: CanvasFileEntry[] = [];
        let names: string[];
        try {
          names = await readdir(this.deps.dir);
        } catch {
          return { ok: true, files };
        }
        for (const name of names) {
          const m = BOARD.exec(name);
          if (!m) continue;
          try {
            const abs = join(this.deps.dir, name);
            const [text, info] = await Promise.all([readFile(abs, "utf8"), stat(abs)]);
            files.push({ slug: m[1]!, text, modifiedMs: info.mtimeMs });
          } catch {
            // Gone between the listing and the read.
          }
        }
        return { ok: true, files };
      }
      case "read":
      case "exists": {
        const file = this.board(req.slug);
        if (file === null) return refuse("invalid", "Not a board name.");
        let text: string | null;
        try {
          text = await readFile(file, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          text = null;
        }
        return req.op === "read" ? { ok: true, text } : { ok: true, exists: text !== null };
      }
      case "write": {
        const file = this.board(req.slug);
        if (file === null || req.text === undefined)
          return refuse("invalid", "A write needs a board name and its text.");
        const slug = req.slug!;
        try {
          // Under the board's lock, which the Mini's own desktop takes too (board-file.ts).
          await writeBoardFile(file, req.text, { ifRevision: req.ifRevision });
        } catch (error) {
          if (error instanceof BoardConflict) return refuse("conflict", error.message);
          throw error;
        }
        this.written.set(slug, hash(req.text));
        const isNew = !this.known.has(slug);
        this.known.add(slug);
        this.onChange?.(isNew ? null : slug, origin);
        return { ok: true };
      }
      case "remove": {
        const file = this.board(req.slug);
        if (file === null) return refuse("invalid", "Not a board name.");
        try {
          await unlink(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        this.written.set(req.slug!, null);
        if (this.known.delete(req.slug!)) this.onChange?.(null, origin);
        return { ok: true };
      }
      case "history": {
        const file = this.board(req.slug);
        if (file === null || req.text === undefined)
          return refuse("invalid", "History needs a board name and a line.");
        await appendFile(
          file.replace(/\.json$/, ".history.jsonl"),
          req.text.endsWith("\n") ? req.text : `${req.text}\n`,
        );
        return { ok: true };
      }
      case "asset.read": {
        const file = this.asset(req.src);
        if (file === null) return refuse("invalid", "Not a file in the boards folder.");
        const info = await stat(file);
        if (info.size > MAX_CANVAS_ASSET_BYTES)
          return refuse("too-large", "That image is too large to send.");
        return { ok: true, data: (await readFile(file)).toString("base64") };
      }
      case "asset.write": {
        const file = this.asset(req.src);
        if (file === null || req.data === undefined)
          return refuse("invalid", "A write needs a file in the boards folder and its bytes.");
        const bytes = Buffer.from(req.data, "base64");
        if (bytes.length > MAX_CANVAS_ASSET_BYTES)
          return refuse("too-large", "That image is too large to send.");
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, bytes);
        await rename(tmp, file);
        return { ok: true };
      }
    }
  }

  /** Tells the watchers about boards changed on this Mac, skipping what the frames just wrote. */
  private async flush(): Promise<void> {
    this.timer = undefined;
    const slugs = [...this.pending];
    this.pending.clear();
    let listChanged = false;
    const changed: string[] = [];
    for (const slug of slugs) {
      let text: string | null;
      try {
        text = await readFile(join(this.deps.dir, `${slug}.json`), "utf8");
      } catch {
        text = null;
      }
      const mine = this.written.get(slug);
      this.written.delete(slug);
      const existed = this.known.has(slug);
      if (text === null) this.known.delete(slug);
      else this.known.add(slug);
      if (mine !== undefined && mine === (text === null ? null : hash(text))) continue;
      if (text === null) {
        if (existed) listChanged = true;
      } else if (existed) changed.push(slug);
      else listChanged = true;
    }
    if (listChanged) this.onChange?.(null, null);
    for (const slug of changed) this.onChange?.(slug, null);
  }
}
