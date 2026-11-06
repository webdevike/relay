import { describe, expect, it } from "vitest";
import type { OpenAsk } from "@relay/protocol";
import { askBadges, askSheet, MAX_ASK_BADGES, pruneHidden, visibleAsks } from "./openAsks";

const ask = (id: string, at: number, over: Partial<OpenAsk> = {}): OpenAsk => ({ id, source: "replies", label: id, question: `${id}?`, replies: ["Yes", "No"], at, ...over });
const NONE: ReadonlySet<string> = new Set();

describe("visibleAsks", () => {
  it("shows nothing for a host that sends no asks", () => {
    expect(visibleAsks(undefined, null, null, NONE)).toEqual([]);
  });

  it("orders newest first", () => {
    expect(visibleAsks([ask("0000000a", 1), ask("0000000b", 3), ask("0000000c", 2)], null, null, NONE).map((a) => a.id)).toEqual(["0000000b", "0000000c", "0000000a"]);
  });

  it("drops the ask whose card already shows for the thread's session", () => {
    const card = ask("0000000a", 1, { source: "ask", sessionId: "S", askId: "k1" });
    const other = ask("0000000b", 2, { source: "ask", sessionId: "T", askId: "k1" });
    expect(visibleAsks([card, other], { sessionId: "S", askId: "k1" }, null, NONE).map((a) => a.id)).toEqual(["0000000b"]);
    expect(visibleAsks([card], { sessionId: "S", askId: "k2" }, null, NONE)).toHaveLength(1);
  });

  it("drops the ask whose replies show as inline chips under the newest row", () => {
    const asks = [ask("0000000a", 1, { messageId: "m1" }), ask("0000000b", 2, { messageId: "m2" }), ask("0000000c", 3, { source: "session" })];
    expect(visibleAsks(asks, null, "m2", NONE).map((a) => a.id)).toEqual(["0000000c", "0000000a"]);
    expect(visibleAsks(asks, null, null, NONE)).toHaveLength(3);
  });

  it("drops ids closed on this phone", () => {
    expect(visibleAsks([ask("0000000a", 1), ask("0000000b", 2)], null, null, new Set(["0000000b"])).map((a) => a.id)).toEqual(["0000000a"]);
  });
});

describe("askBadges", () => {
  it(`badges at most ${String(MAX_ASK_BADGES)} and counts the rest`, () => {
    const asks = [1, 2, 3, 4, 5].map((n) => ask(`0000000${String(n)}`, n));
    expect(askBadges(asks)).toEqual({ badges: asks.slice(0, 3), more: 2 });
    expect(askBadges(asks.slice(0, 2))).toEqual({ badges: asks.slice(0, 2), more: 0 });
  });
});

describe("pruneHidden", () => {
  it("forgets ids the host dropped and keeps the set when nothing changed", () => {
    const hidden: ReadonlySet<string> = new Set(["0000000a", "0000000b"]);
    expect([...pruneHidden(hidden, [ask("0000000a", 1)])]).toEqual(["0000000a"]);
    expect(pruneHidden(hidden, [ask("0000000a", 1), ask("0000000b", 2)])).toBe(hidden);
    expect(pruneHidden(hidden, undefined).size).toBe(0);
    expect(pruneHidden(NONE, undefined)).toBe(NONE);
  });
});

describe("askSheet", () => {
  it("puts a session ask's default first, marked, and says it goes with it", () => {
    const sheet = askSheet(ask("0000000a", 1, { source: "session", question: "Book 7:10?", replies: ["7:10", "7:40", "Skip"], default: "7:40" }));
    expect(sheet.message).toBe("Book 7:10?\n\nGoing with 7:40 unless you say otherwise.");
    expect(sheet.choices).toEqual([
      { label: "7:40 (default)", reply: "7:40" },
      { label: "7:10", reply: "7:10" },
      { label: "Skip", reply: "Skip" },
    ]);
  });

  it("shows the question and the replies as they are without a default", () => {
    const sheet = askSheet(ask("0000000a", 1, { question: "Ship it?" }));
    expect(sheet).toEqual({ message: "Ship it?", choices: [{ label: "Yes", reply: "Yes" }, { label: "No", reply: "No" }] });
  });
});
