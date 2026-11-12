import { beforeEach, describe, expect, it, vi } from "vitest";

const written = vi.hoisted(() => new Map<string, string>());
vi.mock("./storage", () => ({
  fileStorage: {
    getItem: (name: string) => Promise.resolve(written.get(name) ?? null),
    setItem: (name: string, value: string) => {
      written.set(name, value);
    },
    removeItem: (name: string) => {
      written.delete(name);
    },
  },
}));

import { MAX_DISMISSED_CARDS } from "@relay/protocol";
import { dismissKey, isCardHidden } from "@/lib/dismissedCards";
import { useDismissedCardsStore } from "./dismissedCards";

const store = () => useDismissedCardsStore.getState();
const saved = (): unknown => {
  const file: unknown = JSON.parse(written.get("relay-dismissed-cards") ?? "{}");
  return typeof file === "object" && file !== null && "state" in file ? file.state : undefined;
};

beforeEach(() => {
  useDismissedCardsStore.setState({ ids: [], pending: [], hostUp: false, synced: false });
  written.clear();
});

describe("dismissed cards on this phone", () => {
  it("persists what was dismissed (and what waits to go up) but not the connection's state", async () => {
    store().apply("canvas:m1", true);
    store().apply("work:w1#running", true);
    store().setHostUp(true);
    expect(saved()).toEqual({ ids: ["canvas:m1", "work:w1#running"], pending: ["canvas:m1", "work:w1#running"] });
    // A restart: memory is empty, the file is what is left, and it is read back before the host says anything.
    const file = written.get("relay-dismissed-cards") ?? "";
    useDismissedCardsStore.setState({ ids: [], pending: [], hostUp: false, synced: false });
    written.set("relay-dismissed-cards", file);
    await useDismissedCardsStore.persist.rehydrate();
    expect(isCardHidden(store().ids, "canvas:m1", false)).toBe(true);
    expect(isCardHidden(store().ids, "work:w1", true)).toBe(true);
    expect(store().pending).toEqual(["canvas:m1", "work:w1#running"]);
    expect(store().hostUp).toBe(false);
  });

  it("restoring a dismissal (Undo) takes it out of the set and out of what waits to go up", () => {
    store().apply("room:r:ready", true);
    store().apply("room:r:ready", false);
    expect(store().ids).toEqual([]);
    expect(store().pending).toEqual([]);
    expect(saved()).toEqual({ ids: [], pending: [] });
  });

  it("keeps the newest MAX_DISMISSED_CARDS", () => {
    for (let i = 0; i < MAX_DISMISSED_CARDS + 3; i++) store().apply(`work:${i}`, true);
    expect(store().ids).toHaveLength(MAX_DISMISSED_CARDS);
    expect(store().ids[0]).toBe("work:3");
  });
});

describe("dismissed cards and the host", () => {
  it("the host's set replaces the phone's, and only what was dismissed unsynced goes up, once", () => {
    store().apply("canvas:m1", true);
    store().apply("meeting:r1", true);
    const up = store().setHost(["canvas:m1", "signin:nova:m9"]);
    expect(up).toEqual(["meeting:r1"]);
    expect(store().ids).toEqual(["canvas:m1", "signin:nova:m9", "meeting:r1"]);
    expect(store().pending).toEqual([]);
    expect(store().synced).toBe(true);
    expect(store().setHost(["canvas:m1", "signin:nova:m9", "meeting:r1"])).toEqual([]);
  });

  it("a card another device restored comes back; a dismissal made while synced is not pending", () => {
    store().setHost(["canvas:m1"]);
    store().apply("room:r:ready", true);
    expect(store().pending).toEqual([]);
    store().setHost([]);
    expect(store().ids).toEqual([]);
  });

  it("losing the host keeps what is dismissed but stops treating the set as synced", () => {
    store().setHost(["canvas:m1"]);
    store().clearHost();
    expect(store().synced).toBe(false);
    expect(store().ids).toEqual(["canvas:m1"]);
    store().apply("meeting:r1", true);
    expect(store().pending).toEqual(["meeting:r1"]);
  });
});

describe("a running card comes back when its work is done", () => {
  it("hides under its running entry only while it runs; a finished dismissal holds for good", () => {
    store().apply(dismissKey("work:w1", true), true);
    const ids = store().ids;
    expect(isCardHidden(ids, "work:w1", true)).toBe(true);
    expect(isCardHidden(ids, "work:w1", false)).toBe(false);
    store().apply(dismissKey("work:w1", false), true);
    expect(isCardHidden(store().ids, "work:w1", false)).toBe(true);
    expect(isCardHidden(store().ids, "work:w1", true)).toBe(true);
    expect(isCardHidden(store().ids, "work:w2", true)).toBe(false);
  });

  it("a card desktop dismissed under its plain id stays hidden in every state", () => {
    store().setHost(["work:w1"]);
    expect(isCardHidden(store().ids, "work:w1", true)).toBe(true);
    expect(isCardHidden(store().ids, "work:w1", false)).toBe(true);
  });
});
