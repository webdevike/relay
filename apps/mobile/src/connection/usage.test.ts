import { beforeEach, describe, expect, it } from "vitest";
import type { UsageSnapshot } from "@relay/protocol";
import { useUsageStore } from "@/state/usage";
import { createUsageFrameRouter, type UsageFrameRouter } from "./usage";

const snapshot: UsageSnapshot = {
  accounts: [
    {
      key: "work:anthropic",
      profile: "work",
      profileLabel: "Work",
      provider: "anthropic",
      email: "me@example.com",
      windows: [{ id: "anthropic:7d", label: "7 days", usedFraction: 0.78, resetsAt: 1, status: "ok" }],
      fetchedAt: 1,
      stale: false,
      error: null,
    },
  ],
  updatedAt: 1,
  refreshing: false,
};

/** The store is the real one (reset per test); the router has no socket to talk to. */
let route: UsageFrameRouter;

beforeEach(() => {
  useUsageStore.setState({ usage: null });
  route = createUsageFrameRouter(useUsageStore.getState());
});

describe("usage.snapshot", () => {
  it("replaces the snapshot", () => {
    route({ t: "usage.snapshot", usage: snapshot });
    expect(useUsageStore.getState().usage).toEqual(snapshot);
    route({ t: "usage.snapshot", usage: { ...snapshot, refreshing: true } });
    expect(useUsageStore.getState().usage?.refreshing).toBe(true);
  });
});

describe("other frames", () => {
  it("leave the snapshot alone", () => {
    route({ t: "usage.snapshot", usage: snapshot });
    route({ t: "pong", ts: 1, serverTs: 2 });
    route({ t: "ack", id: "a" });
    expect(useUsageStore.getState().usage).toEqual(snapshot);
  });
});
