// Feeds every Wayland clipboard change into the drop box, so what Isaac copies on the desktop is
// on the phone before he picks it up. `wl-paste --watch` only tells us that the selection
// changed; the content is then read back with plain `wl-paste` calls, which keeps the parsing
// here and the watcher process trivial. Text becomes a text/link drop, an image or a single
// copied file becomes a blob. Selections flagged by a password manager
// (`x-kde-passwordManagerHint`) never leave the machine, and the same content copied twice in a
// row is recorded once.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_DROP_BYTES, MAX_DROP_TEXT } from "@relay/protocol";
import type { DropBox } from "../seams";

export const RESTART_DELAY_MS = 5_000;
const PASSWORD_HINT = "x-kde-passwordManagerHint";
const IMAGE_PREFERENCE = ["image/png", "image/jpeg", "image/webp"] as const;

/** Runs `wl-paste` with `args` and resolves its stdout; rejects when it exits non-zero. */
export type Paste = (args: readonly string[]) => Promise<Uint8Array>;

export interface ClipboardWatcherDeps {
  readonly drops: DropBox;
  readonly paste: Paste;
  readonly log: (line: string) => void;
  /** Spawns the long-running `wl-paste --watch` process; `onChange` fires per selection, `onExit` once. */
  readonly watch: (onChange: () => void, onExit: (reason: string) => void) => { kill(): void };
  readonly after: (ms: number, fn: () => void) => () => void;
}

export async function systemPaste(args: readonly string[]): Promise<Uint8Array> {
  const child = Bun.spawn(["wl-paste", ...args], { stdout: "pipe", stderr: "ignore" });
  const [bytes, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited]);
  // wl-paste exits 1 with "Nothing is copied" on an empty selection; treat that as no content.
  if (code !== 0) return new Uint8Array();
  return new Uint8Array(bytes);
}

/** `wl-paste --watch echo` prints one line per selection change; the line is the signal. */
export function systemWatch(onChange: () => void, onExit: (reason: string) => void): { kill(): void } {
  const child = Bun.spawn(["wl-paste", "--watch", "echo", "change"], { stdout: "pipe", stderr: "pipe" });
  void (async () => {
    for await (const chunk of child.stdout) {
      if (chunk.length > 0) onChange();
    }
  })();
  void child.exited.then(async (code) => {
    const stderr = (await new Response(child.stderr).text()).trim();
    onExit(stderr === "" ? `exit ${code}` : stderr);
  });
  return { kill: () => { child.kill(); } };
}

export class ClipboardWatcher {
  private process: { kill(): void } | null = null;
  private cancelRestart: (() => void) | null = null;
  private stopped = false;
  private lastKey: string | null = null;
  /** Captures run one at a time; a change during a capture queues exactly one more. */
  private capturing = false;
  private pending = false;

  constructor(private readonly deps: ClipboardWatcherDeps) {}

  start(): void {
    this.stopped = false;
    // `wl-paste --watch` reports the current selection once at startup; if it is already the
    // newest text drop (typical after a daemon restart) it must not be recorded again.
    const newest = this.deps.drops.list()[0];
    if (newest?.text !== undefined) this.lastKey = textKey(newest.text);
    this.spawn();
  }

  stop(): void {
    this.stopped = true;
    this.cancelRestart?.();
    this.cancelRestart = null;
    this.process?.kill();
    this.process = null;
  }

  /** Reads the current selection and records it; exposed for tests and the first read at start. */
  async capture(): Promise<void> {
    if (this.capturing) {
      this.pending = true;
      return;
    }
    this.capturing = true;
    try {
      await this.captureOnce();
    } catch (error) {
      this.deps.log(`clipboard: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.capturing = false;
    }
    if (this.pending) {
      this.pending = false;
      await this.capture();
    }
  }

  private spawn(): void {
    if (this.stopped) return;
    this.process = this.deps.watch(
      () => {
        void this.capture();
      },
      (reason) => {
        this.process = null;
        if (this.stopped) return;
        this.deps.log(`clipboard watcher exited (${reason}); restarting in ${RESTART_DELAY_MS / 1000}s`);
        this.cancelRestart = this.deps.after(RESTART_DELAY_MS, () => {
          this.cancelRestart = null;
          this.spawn();
        });
      },
    );
  }

  private async captureOnce(): Promise<void> {
    const types = new TextDecoder()
      .decode(await this.deps.paste(["--list-types"]))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (types.length === 0 || types.includes(PASSWORD_HINT)) return;

    const image = IMAGE_PREFERENCE.find((candidate) => types.includes(candidate));
    if (image !== undefined) {
      const bytes = await this.deps.paste(["--type", image]);
      if (bytes.length === 0 || bytes.length > MAX_DROP_BYTES) return;
      if (!this.fresh(`${image}:${digest(bytes)}`)) return;
      const ext = image === "image/png" ? "png" : image === "image/jpeg" ? "jpg" : "webp";
      this.deps.drops.putBlob("host", { name: `clipboard-${stamp()}.${ext}`, mimeType: image, bytes });
      return;
    }

    if (types.includes("text/uri-list")) {
      const path = singleFile(new TextDecoder().decode(await this.deps.paste(["--type", "text/uri-list"])));
      if (path !== null) {
        const size = statSync(path).size;
        if (size === 0 || size > MAX_DROP_BYTES) return;
        if (!this.fresh(`file:${path}:${size}`)) return;
        this.deps.drops.putBlob("host", { name: basename(path), mimeType: mimeOf(path), bytes: new Uint8Array(readFileSync(path)) });
        return;
      }
    }

    const textType = types.find((candidate) => candidate === "text/plain" || candidate.startsWith("text/plain;"));
    if (textType === undefined) return;
    const text = new TextDecoder().decode(await this.deps.paste(["--no-newline", "--type", textType]));
    if (text.trim() === "" || text.length > MAX_DROP_TEXT) return;
    if (!this.fresh(textKey(text))) return;
    this.deps.drops.putText("host", text);
  }

  /** False when `key` matches the previous capture; remembers it otherwise. */
  private fresh(key: string): boolean {
    if (this.lastKey === key) return false;
    this.lastKey = key;
    return true;
  }
}

function textKey(text: string): string {
  return `text:${digest(new TextEncoder().encode(text))}`;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** The one regular file a `text/uri-list` selection points at, or null (several, none, not a file). */
function singleFile(uriList: string): string | null {
  const uris = uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const uri = uris[0];
  if (uris.length !== 1 || !uri?.startsWith("file://")) return null;
  try {
    const path = fileURLToPath(uri);
    return statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  zip: "application/zip",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

/** Type guessed from the extension; unknown ones go as octet-stream so the phone offers Share. */
function mimeOf(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
