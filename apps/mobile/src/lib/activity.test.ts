import { describe, expect, it } from "vitest";
import type { ActivityItem } from "@evaos/chat-core/activity";
import { activityBadges } from "./activity";

const item = (id: string, over: Partial<ActivityItem> = {}): ActivityItem => ({
  id,
  kind: "session",
  owner: "assistant:nova",
  title: id,
  status: "working",
  intent: "",
  startedAt: 1,
  updatedAt: 1,
  open: { to: "chat", thread: `session:${id}`, session: id },
  ...over,
});

describe("activityBadges", () => {
  it("lists the thread's own in-progress work, waiting first, then newest", () => {
    const { shown, more } = activityBadges(
      [item("old", { startedAt: 1 }), item("new", { startedAt: 5 }), item("ask", { status: "waiting", startedAt: 2 })],
      "assistant:nova",
    );
    expect(shown.map((badge) => [badge.label, badge.waiting])).toEqual([["ask", true], ["new", false], ["old", false]]);
    expect(more).toBe(0);
  });

  it("leaves out helpers, finished work, other owners and the thread's own chat", () => {
    const { shown } = activityBadges(
      [
        item("helper", { kind: "helper" }),
        item("done", { status: "done" }),
        item("failed", { status: "failed" }),
        item("other", { owner: "assistant:astra" }),
        item("self", { open: { to: "chat", thread: "assistant:nova" } }),
        item("harness", { kind: "harness", open: { to: "terminal", pane: "p1" } }),
      ],
      "assistant:nova",
    );
    expect(shown.map((badge) => badge.id)).toEqual(["harness"]);
  });

  it("folds past three into a count", () => {
    const items = [1, 2, 3, 4, 5].map((n) => item(`s${String(n)}`, { startedAt: n }));
    const { shown, more } = activityBadges(items, "assistant:nova");
    expect(shown.map((badge) => badge.id)).toEqual(["s5", "s4", "s3"]);
    expect(more).toBe(2);
  });
});
