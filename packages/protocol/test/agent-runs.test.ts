import { agentModelLine, modelName } from "../src/agent-runs";
import { describe, expect, it } from "vitest";
import {
  agentBadge,
  agentCallOf,
  agentRunKey,
  agentRunOf,
  agentRunsByRow,
  agentsCaption,
  foldAgentRuns,
  liveAgentRuns,
  recentAgentRuns,
  settleAgentRuns,
  expireAgentRuns,
  AGENT_RUN_MAX_MS,
  type AgentRun,
} from "../src/agent-runs";

const research = {
  agent: "web-researcher",
  run: "r-1",
  status: "done",
  request: { question: "Who maintains effect?", depth: "quick" },
  reply: {
    question: "Who maintains effect?",
    answer: "Effectful Technologies.",
    citations: [
      { url: "https://a", quote: "q1", verified: true, checked: "page", via: "read" },
      { url: "https://b", quote: "q2", verified: false, checked: "none", via: "read" },
    ],
    route: "primary",
    toolCalls: [{ name: "search" }],
    model: "m",
    attempts: 1,
    cost: 0.004,
    seconds: 29,
  },
  text: "Effectful Technologies.",
  requestedAt: "2026-11-16T20:00:00.000Z",
  seconds: 29.4,
  cost: 0.004,
};

describe("agentCallOf", () => {
  it("reads omp's xd device write and the MCP tool by name, ignoring other writes", () => {
    const content = JSON.stringify({ agent: "web-researcher", request: { question: "q" } });
    expect(
      agentCallOf("write", { path: "xd://mcp__relay_agents_ask", content, i: "Asking" }),
    ).toEqual({
      tool: "agents_ask",
      agent: "web-researcher",
      request: { question: "q" },
    });
    expect(agentCallOf("mcp__relay_agents_result", { run: "r-1" })).toEqual({
      tool: "agents_result",
      run: "r-1",
    });
    expect(
      agentCallOf("write", { path: "xd://mcp__relay_describe", content: "{}" }),
    ).toBeUndefined();
    expect(agentCallOf("write", { path: "notes/agents_ask", content: "{}" })).toBeUndefined();
    expect(agentCallOf("bash", { command: "agents_ask" })).toBeUndefined();
  });
});

describe("agentRunOf", () => {
  const ask = { tool: "agents_ask" as const, agent: "web-researcher", request: { question: "q" } };

  it("a call still out is running from its start; an agents_result still out says nothing", () => {
    expect(agentRunOf(ask, undefined, 1000)).toEqual({
      agent: "web-researcher",
      status: "running",
      request: { question: "q" },
      startedAt: 1000,
    });
    expect(
      agentRunOf({ tool: "agents_result", run: "r-1" }, { text: null, isError: false }),
    ).toBeUndefined();
  });

  it("a done run keeps the typed reply minus bookkeeping, counts verified sources and starts at the request", () => {
    const run = agentRunOf(ask, { text: JSON.stringify(research, null, 2), isError: false }, 5)!;
    expect(run).toMatchObject({
      agent: "web-researcher",
      run: "r-1",
      status: "done",
      seconds: 29.4,
      cost: 0.004,
      sources: 1,
      text: "Effectful Technologies.",
    });
    expect(run.startedAt).toBe(Date.parse("2026-11-16T20:00:00.000Z"));
    expect(Object.keys(run.reply as object).sort()).toEqual(["answer", "citations", "question"]);
  });

  it("a refused call fails with its error; plain error text works too", () => {
    const refused = {
      text: `Error: ${JSON.stringify({ error: "web-researcher rejects this request: question is missing", schema: {} })}`,
      isError: true,
    };
    expect(agentRunOf(ask, refused, 7)).toMatchObject({
      status: "failed",
      error: "web-researcher rejects this request: question is missing",
      startedAt: 7,
    });
    expect(
      agentRunOf(ask, { text: "error: atomic-agents is not installed", isError: true }),
    ).toMatchObject({ status: "failed", error: "atomic-agents is not installed" });
    expect(
      agentRunOf(
        { tool: "agents_result", run: "r-9" },
        { text: "error: no request r-9", isError: true },
      ),
    ).toBeUndefined();
  });
});

const running: AgentRun = {
  agent: "web-researcher",
  run: "r-1",
  status: "running",
  startedAt: 1_000,
};

describe("foldAgentRuns", () => {
  it("one run per id with the latest state and the first start; runs without an id stay apart", () => {
    const done: AgentRun = {
      agent: "web-researcher",
      run: "r-1",
      status: "done",
      seconds: 120,
      startedAt: 9_000,
    };
    const other: AgentRun = { agent: "design-critic", status: "running" };
    expect(foldAgentRuns([running, other, done])).toEqual([{ ...done, startedAt: 1_000 }, other]);
  });
});

describe("liveAgentRuns: a chat's badges from start to finish", () => {
  const asked: AgentRun = { agent: "web-researcher", status: "running", startedAt: 1_000 };

  it("an ask still out is one running badge; its result turns the same badge done", () => {
    expect(liveAgentRuns([asked])).toEqual([asked]);
    const answered: AgentRun = { ...asked, run: "r-1", status: "done", seconds: 29 };
    expect(liveAgentRuns([answered])).toEqual([answered]);
  });

  it("an ask that came back running is finished by agents_result in the transcript, one badge per run", () => {
    const back: AgentRun = { ...asked, run: "r-1" };
    const result: AgentRun = { agent: "web-researcher", run: "r-1", status: "failed", error: "timed out", startedAt: 50_000 };
    expect(liveAgentRuns([back, result])).toEqual([{ ...result, startedAt: 1_000 }]);
  });

  it("the service finishes a run the transcript still shows running, keeping the transcript's reply", () => {
    const back: AgentRun = { ...asked, run: "r-1", request: { question: "q" } };
    const service: AgentRun = { agent: "web-researcher", run: "r-1", status: "done", seconds: 64, cost: 0.02, startedAt: 900 };
    expect(liveAgentRuns([back], [service])).toEqual([{ ...back, status: "done", seconds: 64, cost: 0.02, startedAt: 900 }]);
  });

  it("a service run joins the ask still waiting for its run id instead of showing twice", () => {
    const service: AgentRun = { agent: "web-researcher", run: "r-9", status: "running", startedAt: 1_200 };
    expect(liveAgentRuns([asked], [service])).toEqual([{ ...asked, run: "r-9", startedAt: 1_200 }]);
  });

  it("a done or failed run never goes back to running when the service snapshot is older", () => {
    const done: AgentRun = { ...asked, run: "r-1", status: "done", seconds: 12 };
    const stale: AgentRun = { agent: "web-researcher", run: "r-1", status: "running", startedAt: 1_000 };
    expect(liveAgentRuns([done], [stale])).toEqual([done]);
    expect(liveAgentRuns([{ ...done, status: "failed" }], [stale])[0]!.status).toBe("failed");
  });

  it("runs the transcript never showed are added; newest first, the one just asked (no start) on top", () => {
    const old: AgentRun = { agent: "diagram", run: "r-0", status: "done", startedAt: 500, seconds: 3 };
    const fresh: AgentRun = { agent: "design-critic", status: "running" };
    expect(liveAgentRuns([asked, fresh], [old]).map((r) => r.agent)).toEqual(["design-critic", "web-researcher", "diagram"]);
  });
});

describe("settleAgentRuns: a running badge against the service's whole record", () => {
  const min = 60_000;
  const now = 100 * min;
  const out: AgentRun = { agent: "prop-render", run: "r-1", status: "running", startedAt: now - 54 * min };

  it("a run the service finished while nobody polled reads done, keeping the transcript's request", () => {
    const withRequest: AgentRun = { ...out, request: { subject: "turbine" } };
    const service: AgentRun = { agent: "prop-render", run: "r-1", status: "done", seconds: 98, startedAt: now - 54 * min };
    expect(settleAgentRuns([withRequest], { runs: [service], now })).toEqual([
      { ...withRequest, status: "done", seconds: 98 },
    ]);
    expect(settleAgentRuns([out], { runs: [{ ...service, status: "failed", error: "crashed" }], now })[0]).toMatchObject({
      status: "failed",
      error: "crashed",
    });
  });

  it("a run still out on the service stays running within its time limit; finished badges are left alone", () => {
    const young: AgentRun = { ...out, startedAt: now - 5 * min };
    const service: AgentRun = { agent: "prop-render", run: "r-1", status: "running", startedAt: now - 5 * min };
    expect(settleAgentRuns([young], { runs: [service], now })[0]!.status).toBe("running");
    const done: AgentRun = { ...out, status: "done" };
    expect(settleAgentRuns([done], { runs: [], now })).toEqual([done]);
  });

  it("a run past its time limit fails even when the service still lists it running or the list cannot judge it", () => {
    const service: AgentRun = { agent: "prop-render", run: "r-1", status: "running", startedAt: now - 54 * min };
    expect(settleAgentRuns([out], { runs: [service], now })[0]).toMatchObject({ status: "failed", error: expect.any(String) });
    expect(settleAgentRuns([out], { runs: [], now, since: now - 10 * min })[0]!.status).toBe("failed");
    expect(settleAgentRuns([{ ...out, startedAt: now - 5 * min }], { runs: [], now, since: now - 1 * min })[0]!.status).toBe("running");
  });

  it("a run id the service never recorded fails; one older than a cut-off list is not judged yet", () => {
    const young: AgentRun = { ...out, startedAt: now - 15 * min };
    expect(settleAgentRuns([young], { runs: [], now })[0]).toMatchObject({ status: "failed", error: expect.any(String) });
    expect(settleAgentRuns([young], { runs: [], now, since: now - 10 * min })[0]!.status).toBe("running");
    expect(settleAgentRuns([young], { runs: [], now, since: now - 60 * min })[0]!.status).toBe("failed");
  });

  it("expireAgentRuns fails only running badges past the limit and keeps every other object", () => {
    const old: AgentRun = { agent: "a", run: "o", status: "running", startedAt: now - AGENT_RUN_MAX_MS - 1 };
    const fresh: AgentRun = { agent: "a", run: "f", status: "running", startedAt: now - 1 * min };
    const noStart: AgentRun = { agent: "a", status: "running" };
    const done: AgentRun = { agent: "a", run: "d", status: "done", startedAt: now - 90 * min };
    const [a, b, c, d] = expireAgentRuns([old, fresh, noStart, done], now);
    expect(a).toMatchObject({ status: "failed" });
    expect(b).toBe(fresh);
    expect(c).toBe(noStart);
    expect(d).toBe(done);
  });

  it("an ask that never got a run id fails once it is old, not while it may still be answering", () => {
    const asking: AgentRun = { agent: "prop-render", status: "running", startedAt: now - 2 * min };
    expect(settleAgentRuns([asking], { runs: [], now })[0]!.status).toBe("running");
    expect(settleAgentRuns([{ ...asking, startedAt: now - 11 * min }], { runs: [], now })[0]!.status).toBe("failed");
  });

  it("after settling, the badge strip drops what finished long ago and shows the rest done", () => {
    const service: AgentRun = { agent: "prop-render", run: "r-1", status: "done", seconds: 98, startedAt: now - 54 * min };
    const fresh: AgentRun = { agent: "prop-render", run: "r-2", status: "running", startedAt: now - 2 * min };
    const strip = recentAgentRuns(settleAgentRuns([out, fresh], { runs: [service, { ...fresh }], now }), now);
    expect(strip.map((r) => [r.run, r.status])).toEqual([["r-2", "running"]]);
  });
});

describe("agentBadge", () => {
  it("running ticks from the start, done and failed show how long it took, no clock when unknown", () => {
    const asked: AgentRun = { agent: "prop-render", status: "running", startedAt: 1_000 };
    expect(agentBadge(asked, 13_000)).toEqual({ state: "running", label: "Prop render", clock: "0:12" });
    expect(agentBadge({ agent: "prop-render", status: "running" }, 13_000).clock).toBe("0:00");
    expect(agentBadge({ ...asked, status: "done", seconds: 29.4 }, 99_000)).toEqual({ state: "done", label: "Prop render", clock: "29s" });
    expect(agentBadge({ ...asked, status: "failed", seconds: 64 }, 0).clock).toBe("1m 4s");
    expect(agentBadge({ ...asked, status: "failed", error: "x" }, 0)).toEqual({ state: "failed", label: "Prop render", clock: null });
  });

  it("a badge is keyed by its run id, else by agent and start", () => {
    expect(agentRunKey({ agent: "diagram", run: "r-1", status: "done" })).toBe("r-1");
    expect(agentRunKey({ agent: "diagram", status: "running", startedAt: 5 })).toBe("diagram@5");
  });
});

describe("recentAgentRuns", () => {
  const min = 60_000;
  it("keeps runs still out and runs that ended in the last 30 minutes; drops older ones and stale runs", () => {
    const now = 200 * min;
    const asking: AgentRun = { agent: "a", status: "running" };
    const out: AgentRun = { agent: "b", status: "running", startedAt: now - 59 * min };
    const stale: AgentRun = { agent: "c", status: "running", startedAt: now - 61 * min };
    // Started 40 min ago and ran 15: ended 25 min ago.
    const endedLately: AgentRun = { agent: "d", status: "done", startedAt: now - 40 * min, seconds: 15 * 60 };
    const endedLong: AgentRun = { agent: "e", status: "failed", startedAt: now - 31 * min };
    const noStart: AgentRun = { agent: "f", status: "done", seconds: 3 };
    expect(recentAgentRuns([asking, out, stale, endedLately, endedLong, noStart], now).map((r) => r.agent)).toEqual(["a", "b", "d"]);
  });
});

describe("agentsCaption", () => {
  it("running names who is on it with a clock; done says who answered, how long and how many sources", () => {
    expect(agentsCaption([running], 13_000)).toBe("Web researcher is on it · 0:12");
    expect(agentsCaption([{ ...running, status: "done", seconds: 29.4, sources: 3 }], 0)).toBe(
      "Answered with Web researcher · 29s · 3 sources",
    );
    expect(
      agentsCaption(
        [
          { ...running, status: "done", seconds: 29, sources: 1 },
          { agent: "design-critic", status: "done", seconds: 18 },
        ],
        0,
      ),
    ).toBe("Answered with Web researcher and Design critic · 47s · 1 source");
    expect(
      agentsCaption(
        [
          { ...running, status: "done", seconds: 3 },
          { agent: "gmail", status: "failed", error: "x" },
        ],
        0,
      ),
    ).toBe("Answered with Web researcher · 3s · Gmail failed");
  });
});

describe("agentRunsByRow", () => {
  type Row = "user" | "reply" | AgentRun | "other";
  const kind = (row: Row) => (row === "other" ? undefined : row);

  it("each turn's runs land on its last reply, or on its last call while no reply came yet", () => {
    const done: AgentRun = { ...running, status: "done" };
    const other: AgentRun = {
      agent: "design-critic",
      run: "r-2",
      status: "running",
      startedAt: 2_000,
    };
    const rows: Row[] = [
      "user",
      "reply",
      running,
      "other",
      done,
      "reply",
      "user",
      "reply",
      "user",
      other,
    ];
    const placed = agentRunsByRow(rows, kind);
    expect([...placed.keys()]).toEqual([5, 9]);
    expect(placed.get(5)).toEqual([{ ...done, startedAt: 1_000 }]);
    expect(placed.get(9)).toEqual([other]);
  });

  it("a run finished by agents_result in a later turn reads done on the earlier turn too", () => {
    const done: AgentRun = { ...running, status: "done", seconds: 90 };
    const placed = agentRunsByRow<Row>(["user", running, "reply", "user", done, "reply"], kind);
    expect(placed.get(2)).toEqual([{ ...done, startedAt: 1_000 }]);
    expect(placed.get(5)).toEqual([{ ...done, startedAt: 1_000 }]);
    expect(agentsCaption(placed.get(2)!, 500_000)).toBe("Answered with Web researcher · 1m 30s");
  });
});

describe("the Model row", () => {
  it("names a model id as Isaac reads it", () => {
    expect(modelName("anthropic/claude-haiku-5-5")).toBe("Claude Haiku 5.5");
    expect(modelName("anthropic/claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5");
    expect(modelName("openrouter/moonshotai/kimi-k3.1-pro")).toBe("Kimi K3.1 Pro");
    expect(modelName("openai/gpt-6.1-sol")).toBe("GPT-6.1 Sol");
    expect(modelName("openai/gpt-6-1-sol")).toBe("GPT-6.1 Sol");
  });

  it("adds the thinking level, marks the backup model, and stays empty without a model (a blind trial arm)", () => {
    expect(agentModelLine({ model: "anthropic/claude-haiku-5-5", thinking: "high" })).toBe("Claude Haiku 5.5 · high thinking");
    expect(agentModelLine({ model: "anthropic/claude-haiku-5-5", thinking: "off" })).toBe("Claude Haiku 5.5");
    expect(agentModelLine({ model: "openrouter/moonshotai/kimi-k3.1-pro", fellBack: true })).toBe("Kimi K3.1 Pro (backup)");
    expect(agentModelLine({})).toBeNull();
  });
});
