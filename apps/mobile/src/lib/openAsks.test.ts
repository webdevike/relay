import { describe, expect, it } from "vitest";
import type { AssistantMessage, OpenAsk } from "@relay/protocol";
import { askBadges, askCards, askRowTarget, defaultNote, isAskRow, MAX_ASK_BADGES, pruneHidden, visibleAsks, waitingMessageIds, withAskRows } from "./openAsks";

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

describe("thread rows for asks", () => {
  const msg = (id: string, at: number): AssistantMessage => ({ id, role: "assistant", text: id, at });
  const ids = new Set(["m1", "m2"]);

  it("scrolls to the ask's bubble while it is loaded, else to its inline card", () => {
    const a = ask("0000000a", 5, { messageId: "m2" });
    expect(askRowTarget(a, ids)).toBe("m2");
    expect(askRowTarget(ask("0000000b", 5, { messageId: "gone" }), ids)).toBe("ask-card:0000000b");
    expect(askRowTarget(ask("0000000c", 5, { source: "session" }), ids)).toBe("ask-card:0000000c");
  });

  it("marks bubbles with an open, unhidden ask as waiting", () => {
    const asks = [ask("0000000a", 1, { messageId: "m1" }), ask("0000000b", 2, { messageId: "m2" }), ask("0000000c", 3, { messageId: "gone" }), ask("0000000d", 4, { source: "session" })];
    expect([...waitingMessageIds(asks, new Set(["0000000b"]), ids)]).toEqual(["m1"]);
    expect(waitingMessageIds(undefined, NONE, ids).size).toBe(0);
  });

  it("draws only asks without a loaded bubble as cards", () => {
    const asks = [ask("0000000a", 1, { messageId: "m1" }), ask("0000000c", 3, { messageId: "gone" }), ask("0000000d", 4, { source: "session" })];
    expect(askCards(asks, ids).map((a) => a.id)).toEqual(["0000000c", "0000000d"]);
  });

  it("places a card where it was asked, and after the last message when it is the newest", () => {
    const messages = [msg("m1", 10), msg("m2", 20), msg("m3", 30)];
    const merged = withAskRows(messages, [ask("0000000b", 25, { source: "session" }), ask("0000000a", 15, { source: "session" }), ask("0000000c", 99, { source: "session" })]);
    expect(merged.map((m) => m.id)).toEqual(["m1", "ask-card:0000000a", "m2", "ask-card:0000000b", "m3", "ask-card:0000000c"]);
    expect(merged.filter((m) => isAskRow(m.id)).every((m) => m.role === "card")).toBe(true);
    expect(withAskRows(messages, [])).toEqual(messages);
  });
});

describe("defaultNote", () => {
  it("says what a session ask goes with, only when the default is one of its answers", () => {
    expect(defaultNote(ask("0000000a", 1, { source: "session", replies: ["7:10", "7:40"], default: "7:40" }))).toBe("Going with 7:40 unless you say otherwise.");
    expect(defaultNote(ask("0000000a", 1, { replies: ["Yes"] }))).toBeNull();
    expect(defaultNote(ask("0000000a", 1, { replies: ["Yes"], default: "Maybe" }))).toBeNull();
  });
});
