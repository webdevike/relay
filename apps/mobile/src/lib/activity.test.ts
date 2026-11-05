import { describe, expect, it } from "vitest";
import type { ActivityItem } from "@evaos/chat-core/activity";
import { activityBadges, runningSessionIds } from "./activity";

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
    const shown = activityBadges(
      [item("old", { startedAt: 1 }), item("new", { startedAt: 5 }), item("ask", { status: "waiting", startedAt: 2 })],
      "assistant:nova",
    );
    expect(shown.map((badge) => [badge.label, badge.waiting])).toEqual([["ask", true], ["new", false], ["old", false]]);
  });

  it("leaves out finished work, other owners and the thread's own chat, keeps helpers", () => {
    const shown = activityBadges(
      [
        item("helper", { kind: "helper", open: { to: "subagent", file: "/x", name: "h" } }),
        item("done", { status: "done" }),
        item("failed", { status: "failed" }),
        item("other", { owner: "assistant:astra" }),
        item("self", { open: { to: "chat", thread: "assistant:nova" } }),
        item("harness", { kind: "harness", open: { to: "terminal", pane: "p1" } }),
      ],
      "assistant:nova",
    );
    expect(shown.map((badge) => badge.id).sort()).toEqual(["harness", "helper"]);
  });

  it("shows every running item once, with no cap", () => {
    const items = [1, 2, 3, 4, 5].map((n) => item(`s${String(n)}`, { startedAt: n }));
    expect(activityBadges([...items, item("dup", { open: { to: "chat", thread: "session:s5", session: "s5" } })], "assistant:nova")).toHaveLength(5);
    expect(activityBadges(items, "assistant:nova").map((badge) => badge.id)).toEqual(["s5", "s4", "s3", "s2", "s1"]);
  });

  it("carries the session id a session chip opens", () => {
    expect(activityBadges([item("s1")], "assistant:nova")[0]?.sessionId).toBe("s1");
  });
});

describe("runningSessionIds", () => {
  it("names the running sessions so the header chips skip them", () => {
    const ids = runningSessionIds([item("s1"), item("s2", { status: "done" }), item("h", { kind: "helper" })], "assistant:nova");
    expect([...ids]).toEqual(["s1"]);
  });
});
