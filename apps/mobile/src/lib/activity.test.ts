import { describe, expect, it } from "vitest";
import type { ActivityItem } from "@evaos/chat-core/activity";
import type { AgentSession } from "@relay/protocol";
import { runningChips, type SessionLinks } from "./activity";

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

const owned = (id: string, status: AgentSession["status"], title = `${id} auto-work`): AgentSession => ({ id, status, title }) as AgentSession;

const NO_LINKS: SessionLinks = { threadSession: null, sessions: {} };
const chips = (items: ActivityItem[], links: SessionLinks = NO_LINKS, sessions: AgentSession[] = []) => runningChips(items, "assistant:nova", links, sessions);

describe("runningChips", () => {
  it("lists the thread's own in-progress work, waiting first, then newest", () => {
    const shown = chips([item("old", { startedAt: 1 }), item("new", { startedAt: 5 }), item("ask", { status: "waiting", startedAt: 2 })]);
    expect(shown.map((chip) => [chip.label, chip.waiting])).toEqual([["ask", true], ["new", false], ["old", false]]);
  });

  it("leaves out finished work, other owners and the thread's own chat, keeps helpers", () => {
    const shown = chips([
      item("helper", { kind: "helper", open: { to: "subagent", file: "/x", name: "h" } }),
      item("done", { status: "done" }),
      item("failed", { status: "failed" }),
      item("other", { owner: "assistant:astra" }),
      item("self", { open: { to: "chat", thread: "assistant:nova" } }),
      item("harness", { kind: "harness", open: { to: "terminal", pane: "p1" } }),
    ]);
    expect(shown.map((chip) => chip.id).sort()).toEqual(["harness", "helper"]);
  });

  it("shows every running item once, with no cap", () => {
    const items = [1, 2, 3, 4, 5].map((n) => item(`s${String(n)}`, { startedAt: n }));
    expect(chips([...items, item("dup", { open: { to: "chat", thread: "session:s5", session: "s5" } })])).toHaveLength(5);
    expect(chips(items).map((chip) => chip.id)).toEqual(["s5", "s4", "s3", "s2", "s1"]);
  });

  it("points a helper chip at the subagent session mirrored under the thread's session", () => {
    const helper = item("helper:/s/T/Scout.jsonl", { kind: "helper", open: { to: "subagent", file: "/s/T/Scout.jsonl", name: "Scout" } });
    const mirrored = { id: "T:Scout", parentId: "T" } as AgentSession;
    expect(chips([helper], { threadSession: "T", sessions: { "T:Scout": mirrored } })[0]?.sessionId).toBe("T:Scout");
    expect(chips([helper], { threadSession: "T", sessions: {} })[0]?.sessionId).toBeUndefined();
    expect(chips([helper], { threadSession: null, sessions: { "T:Scout": mirrored } })[0]?.sessionId).toBeUndefined();
  });

  it("carries the session id a session chip opens", () => {
    expect(chips([item("s1")])[0]?.sessionId).toBe("s1");
  });

  it("adds owned sessions only while they run, waiting ones as waiting, without the auto-work suffix", () => {
    const shown = chips([], NO_LINKS, [owned("a", "working"), owned("b", "waiting"), owned("c", "needs_permission"), owned("d", "idle", "Overnight: tidy"), owned("e", "ended")]);
    expect(shown.map((chip) => [chip.label, chip.waiting, chip.sessionId])).toEqual([
      ["b", true, "b"],
      ["c", true, "c"],
      ["a", false, "a"],
    ]);
  });

  it("shows an owned session the activity list already has once", () => {
    const shown = chips([item("s1")], NO_LINKS, [owned("s1", "working")]);
    expect(shown.map((chip) => chip.id)).toEqual(["s1"]);
  });
});
