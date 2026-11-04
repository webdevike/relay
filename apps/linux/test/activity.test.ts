import { describe, expect, it } from "vitest";
import type { AgentSession, Artifact, CanvasRoomInfo, ServerMessage } from "@relay/protocol";
import { ACTIVITY_POLL_MS, ACTIVITY_SETTLE_MS, ActivityService, type ActivityServiceDeps } from "../src/activity/service";
import { canvasItems, harnessItems, helperItems, sessionItems } from "../src/activity/sources";
import type { HerdrAgent } from "../src/agents/herdr";

const NOW = Date.parse("2026-11-04T14:00:00Z");

function session(over: Partial<AgentSession> & Pick<AgentSession, "id">): AgentSession {
  return { provider: "omp", title: over.id, projectPath: "/Eva", status: "idle", lastActivity: "", lastActivityAt: NOW - 1000, canRespond: true, ...over };
}

function helper(path: string, over: Partial<NonNullable<Artifact["subagent"]>> = {}, lastSeen = NOW - 1000): Artifact {
  return {
    id: `subagent:${path}`,
    kind: "subagent",
    title: "Builder",
    path,
    mentions: 1,
    firstSeen: NOW - 60_000,
    lastSeen,
    sources: [],
    addedBy: "extractor",
    subagent: { state: "running", startedAt: NOW - 60_000, ...over },
  };
}

describe("sources", () => {
  it("lists working and blocked sessions under their owner, with the question Isaac is asked", () => {
    const items = sessionItems(
      [
        session({ id: "nova", status: "working", assistant: "nova", lastActivity: "Reading tickets", model: "Opus" }),
        session({ id: "auto", status: "needs_permission", owner: "astra", title: "ENG-1 auto-work", statusDetail: "bash" }),
        session({ id: "chat", status: "waiting", title: "Fix the thing" }),
        session({ id: "idle", status: "idle" }),
        session({ id: "sub", status: "working", parentId: "nova" }),
      ],
      (id) => (id === "chat" ? "Which branch?" : null),
    );
    expect(items.map((i) => [i.id, i.owner, i.status, i.intent])).toEqual([
      ["session:nova", "assistant:nova", "working", "Reading tickets"],
      ["session:auto", "assistant:astra", "waiting", "bash"],
      ["session:chat", "session:chat", "waiting", "Which branch?"],
    ]);
    expect(items[0]).toMatchObject({ kind: "session", model: "Opus", open: { to: "chat", thread: "assistant:nova", session: "nova" } });
  });

  it("lists helpers with their intent line and a transcript target; a quiet running one reads done", () => {
    const items = helperItems(
      [
        { thread: "assistant:nova", item: helper("/s/n/Builder.jsonl", { line: "Editing the panel" }) },
        { thread: "assistant:nova", item: helper("/s/n/Old.jsonl", {}, NOW - 31 * 60_000) },
        { thread: "assistant:astra", item: helper("/s/a/Done.jsonl", { state: "failed", endedAt: NOW - 5000 }) },
      ],
      NOW,
    );
    expect(items.map((i) => [i.id, i.status, i.intent])).toEqual([
      ["helper:/s/n/Builder.jsonl", "working", "Editing the panel"],
      ["helper:/s/n/Old.jsonl", "done", ""],
      ["helper:/s/a/Done.jsonl", "failed", ""],
    ]);
    expect(items[0]?.open).toEqual({ to: "subagent", file: "/s/n/Builder.jsonl", name: "Builder" });
  });

  it("lists herdr panes that are not omp as harnesses, working, blocked or idle", () => {
    const agent = (over: Partial<HerdrAgent>): HerdrAgent => ({ agent: "claude", agent_status: "working", pane_id: "w1:p1", cwd: "/Eva/work/harness-demo", terminal_title_stripped: "✳ Mac Mini haiku file", ...over });
    const items = harnessItems([agent({}), agent({ agent: "muse", agent_status: "idle", pane_id: "w1:p2", terminal_title_stripped: "" }), agent({ agent: "codex", agent_status: "blocked", pane_id: "w1:p3" }), agent({ agent: "omp", pane_id: "w1:p4" }), agent({ agent_status: "unknown", pane_id: "w1:p5" })], NOW);
    expect(items.map((i) => [i.id, i.status, i.title, i.intent])).toEqual([
      ["harness:w1:p1", "working", "Mac Mini haiku file", "claude in harness-demo"],
      ["harness:w1:p2", "done", "harness-demo", "muse in harness-demo, idle"],
      ["harness:w1:p3", "waiting", "Mac Mini haiku file", "codex in harness-demo"],
    ]);
    expect(items[0]?.open).toEqual({ to: "terminal", pane: "w1:p1" });
  });

  it("lists canvas rooms under the chat they came from, with a live room's spend", () => {
    const room = (over: Partial<CanvasRoomInfo>): CanvasRoomInfo => ({ id: "r", slug: "roadmap", board: "Roadmap", live: true, agent: { name: "Astra", color: "#112233" }, chat: { assistant: "astra" }, humans: ["Isaac"], startedAt: NOW - 5000, ...over });
    const items = canvasItems([room({}), room({ slug: "old", live: false, board: "", chat: { sessionId: "s1" }, humans: [], endedAt: NOW - 100 })], (slug) => (slug === "roadmap" ? 0.42 : undefined));
    expect(items[0]).toMatchObject({ id: "canvas:roadmap", owner: "assistant:astra", status: "working", intent: "Astra with Isaac", cost: 0.42, open: { to: "canvas", slug: "roadmap" } });
    expect(items[1]).toMatchObject({ id: "canvas:old", owner: "session:s1", status: "done", title: "old", updatedAt: NOW - 100 });
    expect(items[1]).not.toHaveProperty("cost");
  });
});

interface Rig {
  readonly service: ActivityService;
  readonly sent: Extract<ServerMessage, { t: "activity.snapshot" }>[];
  sessions: AgentSession[];
  harnesses: HerdrAgent[] | Error;
  now: number;
  /** Runs what is due after `ms`, as the clock would. */
  tick(ms: number): Promise<void>;
}

function rig(): Rig {
  const timers: { at: number; fn: () => void }[] = [];
  const r: Rig = {
    sent: [],
    sessions: [],
    harnesses: [],
    now: NOW,
    service: undefined as unknown as ActivityService,
    async tick(ms) {
      r.now += ms;
      for (const timer of timers.splice(0).sort((a, b) => a.at - b.at)) {
        if (timer.at <= r.now) timer.fn();
        else timers.push(timer);
      }
      // The service's read awaits herdr's answer: let those promises settle, no wall clock.
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
  };
  const deps: ActivityServiceDeps = {
    sessions: () => r.sessions,
    question: () => null,
    helpers: () => [],
    harnesses: () => (r.harnesses instanceof Error ? Promise.reject(r.harnesses) : Promise.resolve(r.harnesses)),
    rooms: () => [],
    roomCost: () => undefined,
    broadcast: (message) => {
      if (message.t === "activity.snapshot") r.sent.push(message);
    },
    clock: {
      now: () => r.now,
      after: (ms, fn) => {
        const timer = { at: r.now + ms, fn };
        timers.push(timer);
        return () => timers.splice(timers.indexOf(timer), 1);
      },
    },
    log: () => undefined,
  };
  Object.assign(r, { service: new ActivityService(deps) });
  return r;
}

describe("ActivityService", () => {
  it("pushes a snapshot only when the list changed, and a session that goes idle finishes", async () => {
    const r = rig();
    r.sessions = [session({ id: "s", status: "working", lastActivity: "Editing" })];
    r.service.poke();
    await r.tick(ACTIVITY_SETTLE_MS);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.items[0]).toMatchObject({ id: "session:s", status: "working", intent: "Editing" });
    // Nothing new: nothing pushed.
    r.service.poke();
    await r.tick(ACTIVITY_SETTLE_MS);
    expect(r.sent).toHaveLength(1);
    r.sessions = [session({ id: "s", status: "waiting", lastActivity: "Editing", statusDetail: "Which branch?" })];
    r.service.poke();
    await r.tick(ACTIVITY_SETTLE_MS);
    expect(r.sent.at(-1)?.items[0]).toMatchObject({ status: "waiting", intent: "Which branch?" });
    r.sessions = [session({ id: "s", status: "idle" })];
    r.service.poke();
    await r.tick(ACTIVITY_SETTLE_MS);
    expect(r.sent.at(-1)?.items[0]).toMatchObject({ status: "done" });
  });

  it("keeps harnesses as they were while herdr does not answer, and ends them once it says they are gone", async () => {
    const r = rig();
    r.harnesses = [{ agent: "claude", agent_status: "working", pane_id: "w1:p3", cwd: "/Eva/work/demo", terminal_title_stripped: "demo-claude" }];
    r.service.start();
    await r.tick(ACTIVITY_SETTLE_MS);
    expect(r.sent.at(-1)?.items.map((i) => [i.id, i.status])).toEqual([["harness:w1:p3", "working"]]);
    r.harnesses = new Error("herdr down");
    await r.tick(ACTIVITY_POLL_MS);
    expect(r.service.snapshot().map((i) => [i.id, i.status])).toEqual([["harness:w1:p3", "working"]]);
    r.harnesses = [];
    await r.tick(ACTIVITY_POLL_MS);
    expect(r.service.snapshot().map((i) => [i.id, i.status])).toEqual([["harness:w1:p3", "done"]]);
    r.service.stop();
  });

  it("answers activity.get with the current list even when nothing changed", async () => {
    const r = rig();
    r.sessions = [session({ id: "s", status: "working" })];
    r.service.get();
    await r.tick(0);
    r.service.get();
    await r.tick(0);
    expect(r.sent).toHaveLength(2);
  });
});
