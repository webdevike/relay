import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentRun } from "@relay/protocol";
import { agentRunDetail, agentsTone, sessionAgentRuns } from "./agentRuns";

const run = (over: Partial<AgentRun> = {}): AgentRun => ({
  agent: "web-researcher",
  status: "done",
  ...over,
});

describe("agentsTone", () => {
  it("is running while any run works, failed only when every run failed, else done", () => {
    expect(agentsTone([run(), run({ status: "running" })])).toBe("running");
    expect(agentsTone([run({ status: "failed" })])).toBe("failed");
    expect(agentsTone([run(), run({ status: "failed" })])).toBe("done");
  });
});

describe("sessionAgentRuns", () => {
  const user = (id: string): AgentMessage => ({ id, role: "user", text: "hi", at: 1 });
  const reply = (id: string, text = "Done."): AgentMessage => ({
    id,
    role: "assistant",
    text,
    at: 2,
  });
  const tool = (id: string, agentRun?: AgentRun): AgentMessage => ({
    id,
    role: "tool",
    text: "",
    at: 2,
    tool: { name: "write", summary: "" },
    ...(agentRun === undefined ? {} : { agentRun }),
  });

  it("keys a turn's runs on its last reply, and on its last call while it has none", () => {
    const rows = [
      user("u1"),
      tool("t1", run({ run: "r1" })),
      reply("a1", "Let me check."),
      tool("t2", run({ agent: "design-critic" })),
      reply("a2"),
      user("u2"),
      tool("t3", run({ status: "running" })),
      reply("a3", ""),
    ];
    const map = sessionAgentRuns(rows);
    expect([...map.keys()]).toEqual(["a2", "t3"]);
    expect(map.get("a2")?.map((r) => r.agent)).toEqual(["web-researcher", "design-critic"]);
  });

  it("is empty for a transcript without agents calls", () => {
    expect(sessionAgentRuns([user("u1"), tool("t1"), reply("a1")]).size).toBe(0);
  });
});

describe("agentRunDetail", () => {
  it("reads the question, answer, citations, other fields and the cost line", () => {
    const detail = agentRunDetail(
      run({
        request: { question: "Best enclosure?", depth: "quick" },
        reply: {
          answer: "Acasis.",
          citations: [
            { url: "https://a.example", quote: "fast", verified: true },
            { url: "https://b.example" },
            { quote: "no url" },
          ],
          confidence: "high",
        },
        text: "Acasis.",
        seconds: 29.4,
        cost: 0.004,
      }),
    );
    expect(detail).toEqual({
      asked: "Best enclosure?",
      answer: "Acasis.",
      citations: [
        { url: "https://a.example", quote: "fast", verified: true },
        { url: "https://b.example" },
      ],
      fields: ["confidence: high"],
      meta: "29s · $0.004",
    });
  });

  it("shows a request without a question as JSON, and no cost line while running", () => {
    expect(
      agentRunDetail(run({ status: "running", request: { url: "https://x.example" } })),
    ).toEqual({
      asked: '{"url":"https://x.example"}',
      answer: null,
      citations: [],
      fields: [],
      meta: null,
    });
  });
});
