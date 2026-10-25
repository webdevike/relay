import { beforeEach, describe, expect, it } from "vitest";
import type { CatchUpCard } from "@relay/protocol";
import { useCatchUpStore } from "@/state/catchup";
import { createCatchUpFrameRouter, type CatchUpFrameRouter } from "./catchup";

const card = (id: string, read = false): CatchUpCard => ({ id, source: "slack", label: "#general", title: id, body: "", ts: "2026-10-24T00:00:00.000Z", importance: 2, read });

/** The store is the real one (reset per test); the router has no socket to talk to. */
let route: CatchUpFrameRouter;

beforeEach(() => {
  useCatchUpStore.setState({ items: null, unreadCount: 0, deferred: [] });
  route = createCatchUpFrameRouter(useCatchUpStore.getState());
});

describe("catchup.snapshot", () => {
  it("replaces the deck and its count", () => {
    route({ t: "catchup.snapshot", items: [card("a"), card("b", true)], unreadCount: 1 });
    expect(useCatchUpStore.getState().items?.map((c) => c.id)).toEqual(["a", "b"]);
    expect(useCatchUpStore.getState().unreadCount).toBe(1);
    route({ t: "catchup.snapshot", items: [], unreadCount: 0 });
    expect(useCatchUpStore.getState().items).toEqual([]);
  });

  it("leaves the session's kept-unread order alone", () => {
    useCatchUpStore.getState().defer("a");
    route({ t: "catchup.snapshot", items: [card("a")], unreadCount: 1 });
    expect(useCatchUpStore.getState().deferred).toEqual(["a"]);
  });
});

describe("local marks", () => {
  it("flip a card and recount until the host answers", () => {
    route({ t: "catchup.snapshot", items: [card("a"), card("b")], unreadCount: 2 });
    useCatchUpStore.getState().markLocal("a", true);
    expect(useCatchUpStore.getState().unreadCount).toBe(1);
    expect(useCatchUpStore.getState().items?.[0]?.read).toBe(true);
  });
});

describe("other frames", () => {
  it("leave the deck alone", () => {
    route({ t: "catchup.snapshot", items: [card("a")], unreadCount: 1 });
    route({ t: "pong", ts: 1, serverTs: 2 });
    route({ t: "ack", id: "a" });
    expect(useCatchUpStore.getState().unreadCount).toBe(1);
  });
});
