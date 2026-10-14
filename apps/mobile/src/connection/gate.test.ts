import { beforeEach, describe, expect, it } from "vitest";
import type { GateStatus } from "@relay/protocol";
import { useGateStore } from "@/state/gate";
import { createGateFrameRouter, type GateFrameRouter } from "./gate";

const locked: GateStatus = {
  locked: true,
  blocked: true,
  reason: "planned break",
  active: null,
  habits: [{ id: "walk", name: "Walk", minutes: 15, photo: false }],
  tasks: [],
  canFinish: false,
  remainingSeconds: null,
};

/** The store is the real one (reset per test); the router has no socket to talk to. */
let route: GateFrameRouter;

beforeEach(() => {
  useGateStore.setState({ gate: null });
  route = createGateFrameRouter(useGateStore.getState());
});

describe("gate.status", () => {
  it("replaces the gate, and null clears it", () => {
    route({ t: "gate.status", gate: locked });
    expect(useGateStore.getState().gate).toEqual(locked);
    route({ t: "gate.status", gate: { ...locked, locked: false, blocked: false } });
    expect(useGateStore.getState().gate?.locked).toBe(false);
    route({ t: "gate.status", gate: null });
    expect(useGateStore.getState().gate).toBeNull();
  });
});

describe("other frames", () => {
  it("leave the gate alone", () => {
    route({ t: "gate.status", gate: locked });
    route({ t: "pong", ts: 1, serverTs: 2 });
    route({ t: "ack", id: "a" });
    route({ t: "drop.removed", id: "x" });
    expect(useGateStore.getState().gate).toEqual(locked);
  });
});
