import { describe, expect, it } from "vitest";
import type { CatchUpCard } from "@relay/protocol";
import { deckCards, markRead } from "./catchup";

const card = (id: string, read = false): CatchUpCard => ({ id, source: "work", label: id, title: id, body: "", ts: "2026-10-24T00:00:00.000Z", importance: 2, read });
const ids = (cards: readonly CatchUpCard[]) => cards.map((c) => c.id);

describe("deckCards", () => {
  it("keeps the host's order and drops read cards", () => {
    expect(ids(deckCards([card("a"), card("b", true), card("c")], []))).toEqual(["a", "c"]);
  });

  it("moves cards kept unread to the back, in the order they were kept", () => {
    const items = [card("a"), card("b"), card("c"), card("d")];
    expect(ids(deckCards(items, ["b"]))).toEqual(["a", "c", "d", "b"]);
    expect(ids(deckCards(items, ["c", "a"]))).toEqual(["b", "d", "c", "a"]);
  });

  it("ignores kept ids that are gone or read", () => {
    expect(ids(deckCards([card("a"), card("b", true)], ["b", "zz"]))).toEqual(["a"]);
  });

  it("is empty when everything is read", () => {
    expect(deckCards([card("a", true)], ["a"])).toEqual([]);
  });
});

describe("markRead", () => {
  it("flips one card and recounts", () => {
    const { items, unreadCount } = markRead([card("a"), card("b")], "b", true);
    expect(items.map((c) => c.read)).toEqual([false, true]);
    expect(unreadCount).toBe(1);
    expect(markRead(items, "b", false).unreadCount).toBe(2);
    expect(markRead(items, "missing", true).unreadCount).toBe(1);
  });
});
