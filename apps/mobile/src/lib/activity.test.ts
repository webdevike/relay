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

  describe("helper chips", () => {
    const helper = (name: string, dir = "/s/T") => item(`helper:${dir}/${name}.jsonl`, { kind: "helper", open: { to: "subagent", file: `${dir}/${name}.jsonl`, name } });
    const sub = (parent: string, name: string) => ({ id: `${parent}:${name}`, parentId: parent }) as AgentSession;
    const top = (id: string) => ({ id }) as AgentSession;
    const links = (threadSession: string | null, ...list: AgentSession[]): SessionLinks => ({ threadSession, sessions: Object.fromEntries(list.map((session) => [session.id, session])) });

    it("opens the subagent session mirrored under the thread's session", () => {
      expect(chips([helper("Scout")], links("T", sub("T", "Scout")))[0]?.sessionId).toBe("T:Scout");
    });

    it("opens the mirror listed under another session, preferring the one its path names", () => {
      const only = links("T", top("T"), top("O1"), sub("O1", "Lane"));
      expect(chips([helper("Lane", "/s/O1")], only)[0]?.sessionId).toBe("O1:Lane");
      expect(chips([helper("Lane", "/s/elsewhere")], only)[0]?.sessionId).toBe("O1:Lane");
      const two = links("T", top("O1"), top("O2"), sub("O1", "Lane"), sub("O2", "Lane"));
      expect(chips([helper("Lane", "/s/2026_O2")], two)[0]?.sessionId).toBe("O2:Lane");
    });

    it("opens the parent session when no transcript is mirrored: the one its path names, else the thread's", () => {
      expect(chips([helper("Lane", "/s/2026_O1")], links("T", top("T"), top("O1")))[0]?.sessionId).toBe("O1");
      expect(chips([helper("Lane")], links("T", top("T")))[0]?.sessionId).toBe("T");
      const ambiguous = links("T", top("O1"), top("O2"), sub("O1", "Lane"), sub("O2", "Lane"));
      expect(chips([helper("Lane", "/s/x")], ambiguous)[0]?.sessionId).toBe("T");
    });

    it("has no session only with no thread session and no parent at all", () => {
      expect(chips([helper("Lane")], links(null))[0]?.sessionId).toBeUndefined();
    });

    it("keeps each helper its own chip when they share a parent fallback, and one chip per mirrored session", () => {
      const shared = chips([helper("A"), helper("B")], links("T", top("T")));
      expect(shared.map((chip) => [chip.id, chip.sessionId])).toEqual([
        ["helper:/s/T/A.jsonl", "T"],
        ["helper:/s/T/B.jsonl", "T"],
      ]);
      expect(chips([helper("A"), item("T:A", { open: { to: "chat", thread: "session:T:A", session: "T:A" } })], links("T", sub("T", "A")))).toHaveLength(1);
    });
  });

  it("carries the activity item's eta, and an owned session's from its session item", () => {
    const eta = { from: 0, totalMs: 10, lowMs: 5, highMs: 20, typicalMs: 10, runs: 3, confidence: "rough", overrunning: false } as const;
    expect(chips([item("s1", { eta })])[0]?.eta).toBe(eta);
    expect(chips([item("s1")])[0]).not.toHaveProperty("eta");
    const shown = chips([item("session:o1", { owner: "assistant:astra", eta })], NO_LINKS, [owned("o1", "working")]);
    expect(shown[0]?.eta).toBe(eta);
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
