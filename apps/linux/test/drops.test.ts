import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_DROPS } from "@relay/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_KEPT_BYTES, DEFAULT_KEPT_DROPS, dropLimitsFromEnv, FileDropStore } from "../src/drops/store";
import type { DropChange } from "../src/seams";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-drops-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("FileDropStore", () => {
  it("classifies a lone URL as a link and anything else as text", () => {
    const store = new FileDropStore(freshDir());
    const link = store.putText("phone", "  https://example.com/a?b=1 \n");
    expect(link.kind).toBe("link");
    expect(link.title).toBe("https://example.com/a?b=1");
    expect(link.text).toBe("  https://example.com/a?b=1 \n");

    expect(store.putText("phone", "see https://example.com now").kind).toBe("text");
    expect(store.putText("phone", "ftp://example.com/x").kind).toBe("text");
    expect(store.putText("phone", "example.com").kind).toBe("text");
    expect(() => store.putText("phone", "   \n")).toThrow();
  });

  it("titles text with the first non-empty line, cut to 120 chars", () => {
    const store = new FileDropStore(freshDir());
    const long = "x".repeat(200);
    const drop = store.putText("host", `\n\n  ${long}\nsecond line`);
    expect(drop.title).toBe("x".repeat(120));
    expect(drop.text).toBe(`\n\n  ${long}\nsecond line`);
  });

  it("titles a copied prompt without its surface tag, keeping the text as copied", () => {
    const store = new FileDropStore(freshDir());
    const desktop = store.putText("host", "<surface>Mac Mini - Relay Desktop</surface>\nfix the dock");
    expect(desktop.title).toBe("fix the dock");
    expect(desktop.text).toBe("<surface>Mac Mini - Relay Desktop</surface>\nfix the dock");
    expect(store.putText("phone", "<surface>iPhone - Relay</surface>\nship it").title).toBe("ship it");
  });

  it("round-trips a blob through open with the right token only", () => {
    const store = new FileDropStore(freshDir());
    const drop = store.putBlob("host", { name: "shot.png", mimeType: "image/png", bytes: PNG });
    expect(drop.kind).toBe("image");
    expect(drop.title).toBe("shot.png");
    expect(drop.file?.size).toBe(PNG.length);
    const [, , id, token] = drop.file?.path.split("/") ?? [];
    expect(id).toBe(drop.id);

    const blob = store.open(drop.id, token ?? "");
    expect(blob).not.toBeNull();
    expect(blob?.mimeType).toBe("image/png");
    expect(blob?.name).toBe("shot.png");
    expect(blob?.size).toBe(PNG.length);
    expect(new Uint8Array(readFileSync(blob?.path ?? ""))).toEqual(PNG);

    expect(store.open(drop.id, "0".repeat(64))).toBeNull();
    expect(store.open(drop.id, "short")).toBeNull();
    expect(store.open("nope", token ?? "")).toBeNull();

    const text = store.putText("host", "hello");
    expect(store.open(text.id, token ?? "")).toBeNull();

    const file = store.putBlob("phone", { name: "a.bin", mimeType: "application/octet-stream", bytes: new Uint8Array([7]) });
    expect(file.kind).toBe("file");
  });

  it("lists only the newest MAX_DROPS but keeps older drops serving", () => {
    const dir = freshDir();
    const store = new FileDropStore(dir);
    const oldest = store.putBlob("host", { name: "old.bin", mimeType: "application/octet-stream", bytes: new Uint8Array([1]) });
    const token = oldest.file?.path.split("/")[3] ?? "";
    const oldestPath = store.open(oldest.id, token)?.path ?? "";
    expect(existsSync(oldestPath)).toBe(true);

    for (let i = 0; i < MAX_DROPS - 1; i += 1) store.putText("host", `drop ${i}`);
    expect(store.list()).toHaveLength(MAX_DROPS);
    expect(store.list().at(-1)?.id).toBe(oldest.id);

    const removed: string[] = [];
    store.onChange = (change: DropChange): void => {
      if (change.kind === "removed") removed.push(change.id);
    };
    const newest = store.putText("host", "one more");
    expect(store.list()).toHaveLength(MAX_DROPS);
    expect(store.list()[0]?.id).toBe(newest.id);
    expect(store.list().some((drop) => drop.id === oldest.id)).toBe(false);
    // Out of the devices' lists, but an old chat bubble's embed still loads.
    expect(removed).toEqual([oldest.id]);
    expect(store.open(oldest.id, token)?.path).toBe(oldestPath);
    expect(existsSync(oldestPath)).toBe(true);
    // And it survives a restart.
    expect(new FileDropStore(dir).open(oldest.id, token)).not.toBeNull();
  });

  it("evicts the oldest drop past maxDrops and deletes its blob", () => {
    const store = new FileDropStore(freshDir(), { maxDrops: 3 });
    const oldest = store.putBlob("host", { name: "old.bin", mimeType: "application/octet-stream", bytes: new Uint8Array([1]) });
    const oldestPath = store.open(oldest.id, oldest.file?.path.split("/")[3] ?? "")?.path ?? "";
    store.putText("host", "a");
    store.putText("host", "b");
    const removed: string[] = [];
    store.onChange = (change: DropChange): void => {
      if (change.kind === "removed") removed.push(change.id);
    };
    store.putText("host", "c");
    expect(store.list()).toHaveLength(3);
    expect(existsSync(oldestPath)).toBe(false);
    expect(removed).toEqual([oldest.id]);
  });

  it("evicts the oldest drops past maxBytes, never the one just added", () => {
    const store = new FileDropStore(freshDir(), { maxBytes: 10 });
    const blob = (name: string, size: number) => store.putBlob("host", { name, mimeType: "application/octet-stream", bytes: new Uint8Array(size).fill(1) });
    const a = blob("a", 4);
    const b = blob("b", 4);
    expect(store.list().map((drop) => drop.id)).toEqual([b.id, a.id]);
    const c = blob("c", 4);
    expect(store.list().map((drop) => drop.id)).toEqual([c.id, b.id]);
    const big = blob("big", 20);
    expect(store.list().map((drop) => drop.id)).toEqual([big.id]);
  });

  it("reads its limits from $RELAY_MAX_DROPS and $RELAY_MAX_DROPS_MB", () => {
    expect(dropLimitsFromEnv({})).toEqual({ maxDrops: DEFAULT_KEPT_DROPS, maxBytes: DEFAULT_KEPT_BYTES });
    expect(DEFAULT_KEPT_DROPS).toBe(1000);
    expect(DEFAULT_KEPT_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(dropLimitsFromEnv({ RELAY_MAX_DROPS: "50", RELAY_MAX_DROPS_MB: "512" })).toEqual({ maxDrops: 50, maxBytes: 512 * 1024 * 1024 });
    expect(() => dropLimitsFromEnv({ RELAY_MAX_DROPS: "1.5" })).toThrow(/RELAY_MAX_DROPS/);
    expect(() => dropLimitsFromEnv({ RELAY_MAX_DROPS_MB: "lots" })).toThrow(/RELAY_MAX_DROPS_MB/);
  });

  it("removes drops with their blob and reports unknown ids", () => {
    const store = new FileDropStore(freshDir());
    const drop = store.putBlob("phone", { name: "x", mimeType: "image/jpeg", bytes: PNG });
    const path = store.open(drop.id, drop.file?.path.split("/")[3] ?? "")?.path ?? "";
    expect(store.remove(drop.id)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(store.list()).toHaveLength(0);
    expect(store.remove(drop.id)).toBe(false);
    expect(store.remove("missing")).toBe(false);
  });

  it("fires onChange after each put and remove", () => {
    const store = new FileDropStore(freshDir());
    const changes: DropChange[] = [];
    store.onChange = (change): void => {
      changes.push(change);
    };
    const drop = store.putText("phone", "hi");
    store.remove(drop.id);
    expect(changes).toEqual([
      { kind: "added", drop },
      { kind: "removed", id: drop.id },
    ]);
  });

  it("persists the index for a second store on the same dir", () => {
    const dir = freshDir();
    const first = new FileDropStore(dir);
    const text = first.putText("host", "keep me");
    const blob = first.putBlob("host", { name: "shot.png", mimeType: "image/png", bytes: PNG });
    const token = blob.file?.path.split("/")[3] ?? "";

    const second = new FileDropStore(dir);
    expect(second.list().map((drop) => drop.id)).toEqual([blob.id, text.id]);
    expect(second.open(blob.id, token)?.size).toBe(PNG.length);
    expect(second.open(blob.id, "0".repeat(64))).toBeNull();
  });

  it("starts empty without a dir and rejects a malformed index", () => {
    const dir = freshDir();
    expect(new FileDropStore(join(dir, "missing")).list()).toEqual([]);
    writeFileSync(join(dir, "index.json"), "{\"not\": \"an array\"}");
    expect(() => new FileDropStore(dir)).toThrow(/index\.json/);
  });
});
