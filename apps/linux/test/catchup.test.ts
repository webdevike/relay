import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatchUpItem, CatchUpSnapshot } from "@relay/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CATCHUP_READ_TTL_MS, CatchUpService } from "../src/catchup/service";

const item = (id: string, importance: 1 | 2 | 3, ts: string): CatchUpItem => ({ id, source: "work", label: id, title: `title ${id}`, body: "", ts, importance });

let dir: string;
let feedPath: string;
let statePath: string;
let emitted: CatchUpSnapshot[];
let onEmit: ((snapshot: CatchUpSnapshot) => void) | null;
let logged: string[];
let now: number;

/** Atomic replace, the way catchup-build writes the feed. */
function writeFeed(items: CatchUpItem[] | string): void {
  const tmp = `${feedPath}.tmp`;
  writeFileSync(tmp, typeof items === "string" ? items : JSON.stringify({ items }));
  renameSync(tmp, feedPath);
}

function service(): CatchUpService {
  return new CatchUpService({
    feedPath,
    statePath,
    emit: (snapshot) => {
      emitted.push(snapshot);
      onEmit?.(snapshot);
    },
    log: (line) => logged.push(line),
    now: () => now,
  });
}

const readMarks = (): string[] => Object.keys(z.object({ read: z.record(z.string()) }).parse(JSON.parse(readFileSync(statePath, "utf8"))).read).sort();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "catchup-"));
  // The feed's directory exists before the builder first writes, as work/elysia does.
  mkdirSync(join(dir, "elysia"));
  feedPath = join(dir, "elysia", "catchup.json");
  statePath = join(dir, "config", "catchup-state.json");
  emitted = [];
  onEmit = null;
  logged = [];
  now = Date.parse("2026-10-24T12:00:00Z");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("CatchUpService", () => {
  it("orders by importance then newest, and counts unread", () => {
    writeFeed([item("a", 1, "2026-10-24T10:00:00Z"), item("b", 3, "2026-10-20T10:00:00Z"), item("c", 3, "2026-10-23T10:00:00Z")]);
    const snapshot = service().snapshot();
    expect(snapshot.items.map((card) => card.id)).toEqual(["c", "b", "a"]);
    expect(snapshot.items.every((card) => !card.read)).toBe(true);
    expect(snapshot.unreadCount).toBe(3);
  });

  it("marks read and unread, persists 0600, and emits only on change", () => {
    writeFeed([item("a", 2, "2026-10-24T10:00:00Z"), item("b", 2, "2026-10-23T10:00:00Z")]);
    const deck = service();
    expect(deck.mark("a", true)).toBe(true);
    expect(emitted.at(-1)?.unreadCount).toBe(1);
    expect(emitted.at(-1)?.items.find((card) => card.id === "a")?.read).toBe(true);
    expect(deck.mark("a", true)).toBe(false);
    expect(deck.mark("missing", true)).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ read: { a: "2026-10-24T12:00:00.000Z" } });

    // A restarted host remembers; read: false clears it.
    const again = service();
    expect(again.snapshot().unreadCount).toBe(1);
    expect(again.mark("a", false)).toBe(true);
    expect(again.snapshot().unreadCount).toBe(2);
  });

  it("keeps read marks for ids that leave the feed until they are 30 days old", () => {
    writeFeed([item("old", 2, "2026-09-01T00:00:00Z"), item("new", 2, "2026-10-24T00:00:00Z"), item("x", 2, "2026-10-24T00:00:00Z")]);
    const deck = service();
    deck.mark("old", true);
    now += 1000;
    deck.mark("new", true);
    writeFeed([item("x", 2, "2026-10-24T00:00:00Z")]);
    deck.reload();
    deck.mark("x", true);
    expect(readMarks()).toEqual(["new", "old", "x"]);
    deck.mark("x", false);
    now += CATCHUP_READ_TTL_MS;
    deck.mark("x", true);
    expect(readMarks()).toEqual(["new", "x"]);
  });

  it("treats a missing feed as empty and keeps the last good items when the feed turns invalid", () => {
    const deck = service();
    expect(deck.snapshot()).toEqual({ items: [], unreadCount: 0 });
    writeFeed([item("a", 2, "2026-10-24T10:00:00Z")]);
    deck.reload();
    expect(emitted.at(-1)?.unreadCount).toBe(1);
    writeFeed(JSON.stringify({ items: [{ id: "a" }] }));
    deck.reload();
    expect(deck.snapshot().unreadCount).toBe(1);
    expect(logged.some((line) => line.includes("invalid"))).toBe(true);
    expect(emitted).toHaveLength(1);
  });

  // Real fs.watch on a temp dir: the platform's file events are what is under test, so no fake clock.
  it("watches the feed and emits when the builder replaces it", async () => {
    writeFeed([item("a", 2, "2026-10-24T10:00:00Z")]);
    const deck = service();
    const { promise, resolve } = Promise.withResolvers<CatchUpSnapshot>();
    onEmit = resolve;
    deck.start();
    try {
      writeFeed([item("a", 2, "2026-10-24T10:00:00Z"), item("b", 3, "2026-10-24T11:00:00Z")]);
      const snapshot = await promise;
      expect(snapshot.items.map((card) => card.id)).toEqual(["b", "a"]);
    } finally {
      deck.stop();
    }
  });
});
