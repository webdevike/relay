import { beforeEach, describe, expect, it } from "vitest";
import type { Drop } from "@relay/protocol";
import { useDropsStore } from "@/state/drops";
import { createDropFrameRouter, type DropFrameRouter } from "./drops";

function drop(id: string, createdAt: number, text = id): Drop {
  return { id, kind: "text", origin: "phone", createdAt, title: text, text };
}

const ids = (): string[] => useDropsStore.getState().drops.map((d) => d.id);

/** The store is the real one (reset per test); the router has no socket to talk to. */
let route: DropFrameRouter;

beforeEach(() => {
  useDropsStore.setState({ drops: [] });
  route = createDropFrameRouter(useDropsStore.getState());
});

describe("drop.list", () => {
  it("replaces the list and orders it newest first", () => {
    route({ t: "drop.new", drop: drop("stale", 99) });
    route({ t: "drop.list", drops: [drop("old", 1), drop("new", 3), drop("mid", 2)] });
    expect(ids()).toEqual(["new", "mid", "old"]);
  });
});

describe("drop.new", () => {
  it("inserts by createdAt, not arrival order", () => {
    route({ t: "drop.list", drops: [drop("b", 2)] });
    route({ t: "drop.new", drop: drop("a", 1) });
    route({ t: "drop.new", drop: drop("c", 3) });
    expect(ids()).toEqual(["c", "b", "a"]);
  });

  it("replaces an existing drop by id", () => {
    route({ t: "drop.list", drops: [drop("a", 1, "first"), drop("b", 2)] });
    route({ t: "drop.new", drop: drop("a", 1, "second") });
    expect(useDropsStore.getState().drops.map((d) => d.text)).toEqual(["b", "second"]);
  });
});

describe("drop.removed", () => {
  it("removes by id and ignores unknown ids", () => {
    route({ t: "drop.list", drops: [drop("a", 1), drop("b", 2)] });
    route({ t: "drop.removed", id: "a" });
    route({ t: "drop.removed", id: "nope" });
    expect(ids()).toEqual(["b"]);
  });
});

describe("other frames", () => {
  it("leaves the store alone", () => {
    route({ t: "drop.list", drops: [drop("a", 1)] });
    route({ t: "pong", ts: 1, serverTs: 2 });
    route({ t: "agents.delta", rev: 1, remove: ["a"] });
    route({ t: "ack", id: "a" });
    expect(ids()).toEqual(["a"]);
  });
});
