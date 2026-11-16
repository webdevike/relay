import { describe, expect, it } from "vitest";
import {
  agentCallOf,
  agentRunOf,
  agentRunsByRow,
  agentsCaption,
  foldAgentRuns,
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
