import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { activeMention, assigneeFor, findMention, insertMention, suggest, type Mentionable } from "../src/mentions";
import { RESTORE_MESSAGE, parseRestore, planRestore, restoreMessage } from "../src/carry";
import { DRAG_THRESHOLD, OffsetMemory, anchorAtPoint, clampOffset } from "../src/pindrag";
import { moveThread, openThread, setAssignee, snapThreads, threadsOf } from "../src/threads";
import { HISTORY_KEEP, clock, describeEntry, idPattern, lastDeleted, parseHistory, parseSince, historyLine, rotated, sinceYourLastTurn, summarizeHistory, type HistoryEntry } from "../src/history";

const people: Mentionable[] = [
  { id: "astra", name: "Astra", hint: "eCard Systems work" },
  { id: "nova", name: "Nova", joined: true },
  { id: "polaris", name: "Polaris" },
  { id: "mara voss", name: "Mara Voss", joined: true },
];

describe("findMention", () => {
  it("finds @name at any position, in any case", () => {
    expect(findMention("@astra do this", people)?.candidate.id).toBe("astra");
    expect(findMention("can you, @NOVA, look?", people)?.candidate.id).toBe("nova");
    expect(findMention("thanks @Polaris.", people)?.candidate.id).toBe("polaris");
  });
  it("matches a name with a space and gives its span", () => {
    const m = findMention("ask @Mara Voss to tighten", people);
    expect(m?.candidate.id).toBe("mara voss");
    expect("ask @Mara Voss to tighten".slice(m?.start, m?.end)).toBe("@Mara Voss");
  });
  it("ignores emails, longer words and unknown names", () => {
    expect(findMention("mail me@astra now", people)).toBeNull();
    expect(findMention("@astrank", people)).toBeNull();
    expect(findMention("@astra.x", people)).toBeNull();
    expect(findMention("@nobody here", people)).toBeNull();
  });
  it("takes the first mention", () => {
    expect(findMention("@polaris then @astra", people)?.candidate.id).toBe("polaris");
  });
});

describe("assigneeFor", () => {
  it("is the mention, else the thread's assignee, else nobody", () => {
    expect(assigneeFor("@astra hi", people, "nova")).toBe("astra");
    expect(assigneeFor("and then?", people, "nova")).toBe("nova");
    expect(assigneeFor("and then?", people, undefined)).toBeNull();
  });
});

describe("the @ menu", () => {
  it("opens on @ and follows the query", () => {
    expect(activeMention("hello @", 7)).toEqual({ query: "", start: 6, end: 7 });
    expect(activeMention("hello @as", 9)).toEqual({ query: "as", start: 6, end: 9 });
    expect(activeMention("hello @as there", 15)).toBeNull();
    expect(activeMention("me@as", 5)).toBeNull();
  });
  it("lists by prefix, joined first among equals, and inserts the name", () => {
    expect(suggest("", people).map((c) => c.id)).toEqual(["nova", "mara voss", "astra", "polaris"]);
    expect(suggest("a", people).map((c) => c.id)).toEqual(["astra", "nova", "mara voss", "polaris"]);
    expect(suggest("po", people).map((c) => c.id)).toEqual(["polaris"]);
    expect(suggest("zz", people)).toEqual([]);
    const active = activeMention("ask @as please", 7);
    if (active === null) throw new Error("no menu");
    const next = insertMention("ask @as please", active, { id: "astra", name: "Astra" });
    expect(next).toEqual({ text: "ask @Astra please", caret: 11 });
  });
});

describe("thread assignee", () => {
  it("is stored, moved and kept in the snapshot", () => {
    const doc = new Y.Doc();
    const threads = threadsOf(doc);
    const first = { id: "m1", kind: "human" as const, name: "Isaac", color: "#000", text: "hi", ts: 1 };
    expect(openThread(threads, "t1", { x: 1, y: 2 }, first, "astra")).toBe(true);
    expect(snapThreads(threads)[0]?.assignee).toBe("astra");
    setAssignee(threads, "t1", null);
    expect(snapThreads(threads)[0]?.assignee).toBeUndefined();
    setAssignee(threads, "t1", "nova");
    expect(snapThreads(threads)[0]?.assignee).toBe("nova");
    expect(moveThread(threads, "t1", { node: "n1", x: 5, y: 6 })).toBe(true);
    expect(snapThreads(threads)[0]?.anchor).toEqual({ node: "n1", x: 5, y: 6 });
    moveThread(threads, "t1", { x: 50, y: 60 });
    expect(snapThreads(threads)[0]?.anchor).toEqual({ x: 50, y: 60 });
    expect(moveThread(threads, "gone", { x: 0, y: 0 })).toBe(false);
  });
});

describe("carry", () => {
  const carry = { page: "page-2", viewport: { x: -10, y: 20, zoom: 0.75 }, selection: ["a", "b"], thread: "t1" };
  it("round-trips through the message", () => {
    expect(parseRestore(restoreMessage(carry))).toEqual(carry);
    expect(restoreMessage(carry).type).toBe(RESTORE_MESSAGE);
  });
  it("refuses anything malformed", () => {
    expect(parseRestore(null)).toBeNull();
    expect(parseRestore({ type: "other", carry })).toBeNull();
    expect(parseRestore({ type: RESTORE_MESSAGE, carry: { ...carry, page: "" } })).toBeNull();
    expect(parseRestore({ type: RESTORE_MESSAGE, carry: { ...carry, viewport: { x: 1, y: 1, zoom: 0 } } })).toBeNull();
    expect(parseRestore({ type: RESTORE_MESSAGE, carry: { page: "p", viewport: null, selection: [1, "x"], thread: 7 } })).toEqual({ page: "p", viewport: null, selection: ["x"], thread: null });
  });
  it("plans the page move", () => {
    expect(planRestore(carry, "page-2", ["page-1", "page-2"])).toEqual({ page: null, applies: true });
    expect(planRestore(carry, "page-1", ["page-1", "page-2"])).toEqual({ page: "page-2", applies: true });
    expect(planRestore(carry, "page-1", ["page-1"])).toEqual({ page: null, applies: false });
  });
});

describe("pin drag", () => {
  const boxes = new Map([
    ["frame", { x: 0, y: 0, w: 1000, h: 800 }],
    ["card", { x: 100, y: 100, w: 200, h: 100 }],
  ]);
  it("lands on the smallest card under the drop, else on the board", () => {
    expect(anchorAtPoint({ x: 150.4, y: 120.6 }, boxes)).toEqual({ node: "card", x: 50, y: 21 });
    expect(anchorAtPoint({ x: 600, y: 500 }, boxes)).toEqual({ node: "frame", x: 600, y: 500 });
    expect(anchorAtPoint({ x: 2000, y: 5 }, boxes)).toEqual({ x: 2000, y: 5 });
    expect(DRAG_THRESHOLD).toBeGreaterThan(0);
  });
  it("keeps a dragged popover on screen", () => {
    const base = { x: 400, y: 100, w: 320, h: 200 };
    const bounds = { w: 1000, h: 600 };
    expect(clampOffset(base, { dx: 0, dy: 0 }, bounds)).toEqual({ dx: 0, dy: 0 });
    expect(clampOffset(base, { dx: 900, dy: 900 }, bounds)).toEqual({ dx: 1000 - 320 - 8 - 400, dy: 600 - 200 - 8 - 100 });
    expect(clampOffset(base, { dx: -900, dy: -900 }, bounds)).toEqual({ dx: 8 - 400, dy: 8 - 100 });
    expect(clampOffset(base, { dx: 5, dy: 5 }, { w: 100, h: 100 })).toEqual({ dx: 8 - 400, dy: 8 - 100 });
  });
  it("remembers offsets per thread", () => {
    const memory = new OffsetMemory();
    expect(memory.get("t1")).toEqual({ dx: 0, dy: 0 });
    memory.set("t1", { dx: 10, dy: -4 });
    expect(memory.get("t1")).toEqual({ dx: 10, dy: -4 });
    memory.set("t1", { dx: 0, dy: 0 });
    expect(memory.get("t1")).toEqual({ dx: 0, dy: 0 });
  });
});

describe("board history", () => {
  const at = (h: number, m: number): number => new Date(2026, 10, 5, h, m).getTime();
  const del = (id: string, label: string, ts: number, page = "page-2"): HistoryEntry => ({ ts, who: "Isaac", role: "human", op: "delete", kind: "node", id, label, page, saved: { id, type: "note" } });
  const titles = new Map([["page-2", "Page 2"]]);
  it("folds six deletions into one line with the id pattern", () => {
    const entries = ["Root", "A", "B", "C", "D", "E"].map((l, i) => del(`mm-${String(i + 1)}`, l, at(21, 54)));
    const lines = summarizeHistory(entries, titles);
    expect(lines).toEqual([`Isaac deleted 6 cards (mm-*: "Root": "A": "B") on Page 2 at 21:54`]);
    expect(idPattern(["mm-1", "mm-2"])).toBe("mm-*");
    expect(idPattern(["a", "b"])).toBeNull();
  });
  it("names a single change and a count of repeats", () => {
    const one = summarizeHistory([{ ts: at(9, 5), who: "Nova", role: "agent", op: "move", kind: "node", id: "n1", label: "Root", page: "page-1" }], titles);
    expect(one).toEqual([`Nova moved card n1 "Root" on page-1 at 09:05`]);
    expect(clock(at(9, 5))).toBe("09:05");
    expect(describeEntry({ ts: at(9, 5), who: "Nova", role: "agent", op: "update", kind: "node", id: "n1", label: "", page: "page-2", count: 3 }, titles)).toBe("Nova changed card n1 on Page 2 (3 times) at 09:05");
  });
  it("tells an agent what others did since its last turn, not what it did itself", () => {
    const entries = [
      del("mm-1", "Root", at(21, 50)),
      { ts: at(21, 55), who: "Isaac", role: "human" as const, op: "delete" as const, kind: "node" as const, id: "mm-2", label: "Leaf", page: "page-2" },
      { ts: at(21, 56), who: "Nova", role: "agent" as const, op: "add" as const, kind: "node" as const, id: "x", label: "Mine", page: "page-1" },
    ];
    const text = sinceYourLastTurn(entries, at(21, 52), "Nova", titles);
    expect(text).toContain("Isaac deleted card mm-2");
    expect(text).not.toContain("Mine");
    expect(text).not.toContain('"Root" on Page 2 at 21:50 -');
    expect(sinceYourLastTurn(entries, at(22, 0), "Nova", titles)).toBe("");
  });
  it("finds what to restore, and round-trips lines", () => {
    const entries = parseHistory(`${historyLine(del("mm-1", "Root", 1))}not json\n${historyLine(del("mm-1", "Root again", 2))}`);
    expect(entries).toHaveLength(2);
    expect(lastDeleted(entries, "mm-1")?.label).toBe("Root again");
    expect(lastDeleted(entries, "mm-1", "page-9")).toBeNull();
    expect(lastDeleted(entries, "zzz")).toBeNull();
  });
  it("rotates only past its slack, keeping the newest", () => {
    const lines = Array.from({ length: Math.floor(HISTORY_KEEP * 1.25) + 1 }, (_, i) => String(i));
    expect(rotated(lines.slice(0, 10))).toBeNull();
    const kept = rotated(lines);
    expect(kept).toHaveLength(HISTORY_KEEP);
    expect(kept?.at(-1)).toBe(lines.at(-1));
  });
  it("reads --since", () => {
    const now = at(12, 0);
    expect(parseSince("30m", now)).toBe(now - 30 * 60_000);
    expect(parseSince("2h", now)).toBe(now - 2 * 3_600_000);
    expect(parseSince("1700000000000", now)).toBe(1_700_000_000_000);
    expect(parseSince("2026-11-05T21:00", now)).toBe(new Date("2026-11-05T21:00").getTime());
    expect(parseSince("soonish", now)).toBeNull();
  });
});
