import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Drop, DropOrigin } from "@relay/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ClipboardWatcher, RESTART_DELAY_MS } from "../src/drops/clipboard";
import type { DropBlob, DropBox, DropChange } from "../src/seams";

class RecordingDrops implements DropBox {
  onChange: ((change: DropChange) => void) | null = null;
  readonly texts: string[] = [];
  readonly blobs: { name: string; mimeType: string; size: number }[] = [];
  onText: (() => void) | null = null;

  list(): readonly Drop[] {
    return [];
  }
  putText(_origin: DropOrigin, text: string): Drop {
    this.texts.push(text);
    this.onText?.();
    return { id: String(this.texts.length), kind: "text", origin: "host", createdAt: 0, title: text };
  }
  putBlob(_origin: DropOrigin, blob: { readonly name: string; readonly mimeType: string; readonly bytes: Uint8Array }): Drop {
    this.blobs.push({ name: blob.name, mimeType: blob.mimeType, size: blob.bytes.length });
    return { id: "b", kind: "file", origin: "host", createdAt: 0, title: blob.name };
  }
  remove(): boolean {
    return false;
  }
  open(): DropBlob | null {
    return null;
  }
}

/** A fake selection: types listed by `--list-types`, bytes per `--type`. */
interface Selection {
  types: string[];
  content: Record<string, string | Uint8Array>;
}

function harness(selection: () => Selection) {
  const drops = new RecordingDrops();
  const logs: string[] = [];
  const timers: { ms: number; fn: () => void }[] = [];
  let spawned = 0;
  let exit: ((reason: string) => void) | null = null;
  let change: (() => void) | null = null;
  const watcher = new ClipboardWatcher({
    drops,
    log: (line) => logs.push(line),
    paste: (args) => {
      const current = selection();
      if (args[0] === "--list-types") return Promise.resolve(new TextEncoder().encode(current.types.join("\n")));
      const type = args[args.length - 1] ?? "";
      const value = current.content[type] ?? "";
      return Promise.resolve(typeof value === "string" ? new TextEncoder().encode(value) : value);
    },
    watch: (onChange, onExit) => {
      spawned += 1;
      change = onChange;
      exit = onExit;
      return { kill: () => undefined };
    },
    after: (ms, fn) => {
      timers.push({ ms, fn });
      return () => undefined;
    },
  });
  return {
    drops,
    logs,
    watcher,
    timers,
    spawnedCount: () => spawned,
    fireChange: () => change?.(),
    fireExit: (reason: string) => exit?.(reason),
  };
}

const text = (value: string): Selection => ({ types: ["text/plain", "text/plain;charset=utf-8", "STRING"], content: { "text/plain": value } });

describe("ClipboardWatcher", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("records copied text once, even when the same text is copied twice", async () => {
    let current = text("hello");
    const h = harness(() => current);
    await h.watcher.capture();
    await h.watcher.capture();
    current = text("world");
    await h.watcher.capture();
    expect(h.drops.texts).toEqual(["hello", "world"]);
  });

  it("prefers an image over the text alternative and names it by type", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const h = harness(() => ({ types: ["text/plain", "image/png"], content: { "text/plain": "shot", "image/png": png } }));
    await h.watcher.capture();
    expect(h.drops.texts).toEqual([]);
    expect(h.drops.blobs).toHaveLength(1);
    expect(h.drops.blobs[0]).toMatchObject({ mimeType: "image/png", size: 4 });
    expect(h.drops.blobs[0]?.name).toMatch(/^clipboard-.*\.png$/);
  });

  it("turns a single copied file into a blob named after it, but leaves multi-file lists as text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-clip-"));
    dirs.push(dir);
    const path = join(dir, "notes.txt");
    writeFileSync(path, "abc");
    const uri = `file://${path}`;
    let current: Selection = { types: ["text/uri-list", "text/plain"], content: { "text/uri-list": `${uri}\r\n`, "text/plain": path } };
    const h = harness(() => current);
    await h.watcher.capture();
    expect(h.drops.blobs).toEqual([{ name: "notes.txt", mimeType: "text/plain", size: 3 }]);
    current = { types: ["text/uri-list", "text/plain"], content: { "text/uri-list": `${uri}\r\n${uri}\r\n`, "text/plain": `${path} ${path}` } };
    await h.watcher.capture();
    expect(h.drops.texts).toEqual([`${path} ${path}`]);
  });

  it("skips password manager selections, empty text, and selections with no text type", async () => {
    const h = harness(() => ({ types: ["text/plain", "x-kde-passwordManagerHint"], content: { "text/plain": "hunter2" } }));
    await h.watcher.capture();
    const blank = harness(() => text("   \n"));
    await blank.watcher.capture();
    const html = harness(() => ({ types: ["text/html"], content: { "text/html": "<b>x</b>" } }));
    await html.watcher.capture();
    expect(h.drops.texts).toEqual([]);
    expect(blank.drops.texts).toEqual([]);
    expect(html.drops.texts).toEqual([]);
  });

  it("captures on each change signal and respawns the watcher after it exits, not after stop", async () => {
    let current = text("one");
    const h = harness(() => current);
    h.watcher.start();
    expect(h.spawnedCount()).toBe(1);
    const recorded = Promise.withResolvers<undefined>();
    h.drops.onText = () => {
      recorded.resolve(undefined);
    };
    h.fireChange();
    await recorded.promise;
    expect(h.drops.texts).toEqual(["one"]);
    h.fireExit("boom");
    expect(h.timers[0]?.ms).toBe(RESTART_DELAY_MS);
    h.timers[0]?.fn();
    expect(h.spawnedCount()).toBe(2);
    current = text("two");
    h.watcher.stop();
    h.fireExit("killed");
    expect(h.timers).toHaveLength(1);
    expect(h.logs.some((line) => line.includes("boom"))).toBe(true);
  });
});
