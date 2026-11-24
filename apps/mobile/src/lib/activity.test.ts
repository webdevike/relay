import { describe, expect, it } from "vitest";
import type { ActivityItem } from "@evaos/chat-core/activity";
import type { AgentSession } from "@relay/protocol";
import { runningCards, type SessionLinks } from "./activity";

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

const owned = (id: string, status: AgentSession["status"], title = `${id} auto-work`): AgentSession => ({ id, status, title, lastActivity: "" }) as AgentSession;

const NO_LINKS: SessionLinks = { threadSession: null, sessions: {} };
const chips = (items: ActivityItem[], links: SessionLinks = NO_LINKS, sessions: AgentSession[] = []) => runningCards(items, "assistant:nova", links, sessions);

describe("runningCards", () => {
  it("lists the thread's own in-progress work, waiting first, then newest", () => {
    const shown = chips([item("old", { startedAt: 1 }), item("new", { startedAt: 5 }), item("ask", { status: "waiting", startedAt: 2 })]);
    expect(shown.map((chip) => [chip.title, chip.waiting])).toEqual([["ask", true], ["new", false], ["old", false]]);
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

  it("lists every running helper, however long it has run (no age cutoff)", () => {
    const now = Date.now();
    const helper = (name: string, startedAt: number) => item(`helper:/s/T/${name}.jsonl`, { kind: "helper", title: name, startedAt, open: { to: "subagent", file: `/s/T/${name}.jsonl`, name } });
    const shown = chips([helper("Solstice", now - 33 * 60_000), helper("Diagram", now - 23 * 60_000), helper("Usage", now - 20 * 60_000)]);
    expect(shown.map((chip) => chip.title)).toEqual(["Usage", "Diagram", "Solstice"]);
  });

  describe("helper cards", () => {
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

    it("keeps each helper its own card when they share a parent fallback, and one card per mirrored session", () => {
      const shared = chips([helper("A"), helper("B")], links("T", top("T")));
      expect(shared.map((chip) => [chip.id, chip.sessionId])).toEqual([
        ["helper:/s/T/A.jsonl", "T"],
        ["helper:/s/T/B.jsonl", "T"],
      ]);
      expect(chips([helper("A"), item("T:A", { open: { to: "chat", thread: "session:T:A", session: "T:A" } })], links("T", sub("T", "A")))).toHaveLength(1);
    });
  });

  it("shows the host's model, vendor and log on a running card", () => {
    const card = chips([item("s1", { startedAt: 7, model: "claude-opus-5-5", vendor: "anthropic", thinking: "high", intent: "d", log: ["a", "b", "c", "d"] })])[0];
    expect(card).toMatchObject({ startedAt: 7, model: "opus-5-5 high", vendor: "anthropic", work: ["a", "b", "c", "d"] });
  });

  it("falls back on an older host: no model, no logo, the latest intent alone as the work", () => {
    expect(chips([item("s1", { intent: "Rendering shot 4" })])[0]).toMatchObject({ model: null, vendor: null, work: ["Rendering shot 4"] });
    expect(chips([item("s1")])[0]?.work).toEqual([]);
    // A model name alone still gives the logo away.
    expect(chips([item("s1", { model: "GPT-5" })])[0]).toMatchObject({ model: "GPT-5", vendor: "openai" });
  });

  it("reads an owned session the thread's items lack from its session item under another owner, else from the session itself", () => {
    const listed = chips([item("session:o1", { owner: "assistant:astra", startedAt: 3, model: "Claude Sonnet 5", log: ["x"] })], NO_LINKS, [owned("o1", "working")])[0];
    expect(listed).toMatchObject({ id: "owned:o1", startedAt: 3, model: "Sonnet 5", vendor: "anthropic", work: ["x"] });
    const bare = { ...owned("o2", "working"), model: "gpt-5.1-codex", modelVendor: "openai", thinkingLevel: "medium", lastActivity: "Ran the tests" } as AgentSession;
    const own = chips([], NO_LINKS, [bare])[0];
    expect(own).toMatchObject({ model: "gpt-5.1-codex medium", vendor: "openai", work: ["Ran the tests"] });
    expect(own).not.toHaveProperty("startedAt");
  });

  it("carries the session id a session card opens", () => {
    expect(chips([item("s1")])[0]?.sessionId).toBe("s1");
  });

  it("adds owned sessions only while they run, waiting ones as waiting, without the auto-work suffix", () => {
    const shown = chips([], NO_LINKS, [owned("a", "working"), owned("b", "waiting"), owned("c", "needs_permission"), owned("d", "idle", "Overnight: tidy"), owned("e", "ended")]);
    expect(shown.map((chip) => [chip.title, chip.waiting, chip.sessionId])).toEqual([
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
