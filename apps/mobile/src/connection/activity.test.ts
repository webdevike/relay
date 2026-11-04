import { beforeEach, describe, expect, it } from "vitest";
import type { ActivityItem } from "@relay/protocol";
import { useActivityStore } from "@/state/activity";
import { createActivityFrameRouter, type ActivityFrameRouter } from "./activity";

const item: ActivityItem = {
  id: "helper:1",
  kind: "helper",
  owner: "assistant:nova",
  title: "Check the deploy",
  status: "working",
  intent: "Reading the logs",
  startedAt: 1,
  updatedAt: 2,
  open: { to: "chat", thread: "assistant:nova" },
};

let route: ActivityFrameRouter;

beforeEach(() => {
  useActivityStore.setState({ items: [] });
  route = createActivityFrameRouter(useActivityStore.getState());
});

describe("createActivityFrameRouter", () => {
  it("stores the host's list and replaces it on the next snapshot", () => {
    route({ t: "activity.snapshot", items: [item] });
    expect(useActivityStore.getState().items).toEqual([item]);
    route({ t: "activity.snapshot", items: [] });
    expect(useActivityStore.getState().items).toEqual([]);
  });

  it("ignores other frames", () => {
    route({ t: "activity.snapshot", items: [item] });
    route({ t: "pong" } as never);
    expect(useActivityStore.getState().items).toEqual([item]);
  });
});
