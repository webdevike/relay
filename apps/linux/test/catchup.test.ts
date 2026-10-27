import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatchUpItem, CatchUpSnapshot } from "@relay/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CATCHUP_READ_TTL_MS, CatchUpService } from "../src/catchup/service";
import { handleCatchUpBounce } from "../src/catchup/http";

const item = (id: string, importance: 1 | 2 | 3, ts: string): CatchUpItem => ({ id, source: "work", label: id, title: `title ${id}`, body: "", ts, importance });

let dir: string;
let feedPath: string;
let statePath: string;
let notesPath: string | null;
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

let delivered: { agent: string; text: string }[];
let deliverResult: Promise<void>;

function service(): CatchUpService {
  return new CatchUpService({
    feedPath,
    statePath,
    notesPath,
    emit: (snapshot) => {
      emitted.push(snapshot);
      onEmit?.(snapshot);
    },
    deliver: (agent, text) => {
      delivered.push({ agent, text });
      return deliverResult;
    },
    knows: (agent) => agent === "astra" || agent === "nova",
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
  notesPath = join(dir, "eva", "agents", "nova", "catchup-notes.jsonl");
  emitted = [];
  onEmit = null;
  logged = [];
  now = Date.parse("2026-10-24T12:00:00Z");
  delivered = [];
  deliverResult = Promise.resolve();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("CatchUpService", () => {
  it("keeps the feed's order (the builder's), and counts unread", () => {
    writeFeed([item("a", 1, "2026-10-24T10:00:00Z"), item("b", 3, "2026-10-20T10:00:00Z"), item("c", 3, "2026-10-23T10:00:00Z")]);
    const snapshot = service().snapshot();
    expect(snapshot.items.map((card) => card.id)).toEqual(["a", "b", "c"]);
    expect(snapshot.items.every((card) => !card.read)).toBe(true);
    expect(snapshot.unreadCount).toBe(3);
  });

  it("shows a card quoting Isaac's prompt without its surface tag", () => {
    writeFeed([
      { ...item("a", 2, "2026-10-24T10:00:00Z"), title: "<surface>Mac Mini - Relay Desktop</surface>\nfix the dock", body: "<surface>Mac Mini - Relay Desktop</surface>\nfix the dock please", why: "<surface>iPhone - Relay</surface>\nyou asked" },
      { ...item("b", 2, "2026-10-24T09:00:00Z"), title: "<surface>iPhone - Relay</surface>", body: "<surface>iPhone - Relay</surface>\nship it" },
    ]);
    const [a, b] = service().snapshot().items;
    expect([a?.title, a?.body, a?.why]).toEqual(["fix the dock", "fix the dock please", "you asked"]);
    // A title that was only a tag falls back to the label.
    expect([b?.title, b?.body]).toEqual(["b", "ship it"]);
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
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ read: { a: "2026-10-24T12:00:00.000Z" }, handed: {}, bounced: {} });

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
      writeFeed([item("b", 3, "2026-10-24T11:00:00Z"), item("a", 2, "2026-10-24T10:00:00Z")]);
      const snapshot = await promise;
      expect(snapshot.items.map((card) => card.id)).toEqual(["b", "a"]);
    } finally {
      deck.stop();
    }
  });

  it("hands a card to an assistant: read and handed at once, the message carries the card, the note and how to bounce", async () => {
    writeFeed([{ ...item("a", 2, "2026-10-24T10:00:00Z"), body: "**Todd** asked", url: "https://example.com/a", assistant: "astra" }]);
    const deck = service();
    expect(deck.handoff("a", "zed")).toBe(false);
    expect(deck.handoff("missing", "astra")).toBe(false);
    expect(deck.handoff("a", "astra", "  ask Todd first  ")).toBe(true);
    expect(emitted.at(-1)?.items[0]).toMatchObject({ id: "a", read: true, handedTo: "astra" });
    expect(delivered).toHaveLength(1);
    const text = delivered[0]?.text ?? "";
    expect(text).toContain("[Catch Up handoff] a: title a");
    expect(text).toContain("**Todd** asked");
    expect(text).toContain("Link: https://example.com/a");
    expect(text).toContain("Isaac's note: ask Todd first");
    expect(text).toContain("needs his approval first");
    expect(text).toContain('bun ~/Eva/.omp/tools/catchup.ts bounce a "<reason>"');
    await deliverResult;
    expect(logged.some((line) => line.includes("handed a to astra"))).toBe(true);
  });

  it("puts a card back in the deck when delivery fails", async () => {
    writeFeed([item("a", 2, "2026-10-24T10:00:00Z")]);
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Promise<void> resolver
    const { promise, reject } = Promise.withResolvers<void>();
    deliverResult = promise;
    const deck = service();
    expect(deck.handoff("a", "nova")).toBe(true);
    expect(deck.snapshot().unreadCount).toBe(0);
    reject(new Error("agent_launch_failed"));
    await promise.catch(() => undefined);
    await Promise.resolve();
    expect(deck.snapshot().items[0]).toMatchObject({ id: "a", read: false });
    expect(deck.snapshot().items[0]?.handedTo).toBeUndefined();
  });

  it("takes a bounce: unread, no longer handed, first in the deck with its reason, until Isaac reads it", () => {
    writeFeed([item("a", 3, "2026-10-24T10:00:00Z"), item("b", 1, "2026-10-20T10:00:00Z")]);
    const deck = service();
    deck.handoff("b", "astra");
    now += 60_000;
    expect(deck.bounce("missing", "astra", "x")).toBe(false);
    expect(deck.bounce("b", "astra", "  personal, not eCard  ")).toBe(true);
    const first = deck.snapshot().items[0];
    expect(first).toMatchObject({ id: "b", read: false, bounce: { agent: "astra", reason: "personal, not eCard", at: "2026-10-24T12:01:00.000Z" } });
    expect(first?.handedTo).toBeUndefined();
    // A restarted host still has it; reading it closes the bounce and the deck goes back to its order.
    const again = service();
    expect(again.snapshot().items[0]?.id).toBe("b");
    expect(again.mark("b", true)).toBe(true);
    expect(again.snapshot().items.map((card) => card.id)).toEqual(["a", "b"]);
    expect(again.snapshot().items[1]?.bounce).toBeUndefined();
  });

  it("appends Isaac's note with the card's fields as one JSON line, and leaves the card in the deck", () => {
    writeFeed([
      { ...item("a", 2, "2026-10-24T10:00:00Z"), kind: "move", workspace: "ecardsystems", assistant: "astra" },
      item("b", 1, "2026-10-20T10:00:00Z"),
    ]);
    const deck = service();
    expect(deck.note("a", "  stale eCard moves are noise  ", "not-actionable")).toBe(true);
    now += 60_000;
    expect(deck.note("b", "", "needs-me")).toBe(true);
    expect(deck.note("missing", "x")).toBe(false);
    expect(deck.note("a", "   ")).toBe(false);
    const lines = readFileSync(notesPath ?? "", "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as unknown);
    expect(lines).toEqual([
      { at: "2026-10-24T12:00:00.000Z", cardId: "a", source: "work", label: "a", title: "title a", kind: "move", workspace: "ecardsystems", assistant: "astra", signal: "not-actionable", text: "stale eCard moves are noise" },
      { at: "2026-10-24T12:01:00.000Z", cardId: "b", source: "work", label: "b", title: "title b", signal: "needs-me", text: "" },
    ]);
    expect(emitted).toEqual([]);
    expect(deck.snapshot().unreadCount).toBe(2);
    notesPath = null;
    expect(service().note("a", "x")).toBe(false);
  });
});

describe("POST /catchup/bounce", () => {
  const post = (body: unknown) => new Request("http://127.0.0.1/catchup/bounce", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

  it("bounces from loopback with a valid body, refuses everything else", async () => {
    writeFeed([item("a", 2, "2026-10-24T10:00:00Z")]);
    const deck = service();
    expect((await handleCatchUpBounce(null, post({}), "127.0.0.1")).status).toBe(404);
    expect((await handleCatchUpBounce(deck, post({ id: "a", agent: "astra", reason: "x" }), "192.168.4.40")).status).toBe(403);
    expect((await handleCatchUpBounce(deck, post("nope"), "127.0.0.1")).status).toBe(400);
    expect((await handleCatchUpBounce(deck, post({ id: "a", agent: "astra", reason: " " }), "127.0.0.1")).status).toBe(400);
    expect((await handleCatchUpBounce(deck, post({ id: "zz", agent: "astra", reason: "x" }), "127.0.0.1")).status).toBe(404);
    const ok = await handleCatchUpBounce(deck, post({ id: "a", agent: "nova", reason: "needs your decision" }), "::1");
    expect(ok.status).toBe(200);
    expect(deck.snapshot().items[0]?.bounce?.reason).toBe("needs your decision");
  });
});
