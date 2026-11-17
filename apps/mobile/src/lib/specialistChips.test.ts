import { describe, expect, it } from "vitest";
import type { AgentRun, AssistantMessage } from "@relay/protocol";
import { specialistRuns } from "./specialistChips";

const NOW = 10_000_000;
const MIN = 60_000;
const run = (id: string, over: Partial<AgentRun> = {}): AgentRun => ({
  run: id,
  agent: "web-researcher",
  status: "running",
  startedAt: NOW - MIN,
  ...over,
});
const user = (id: string): AssistantMessage => ({ id, role: "user", text: "go", at: 1 });
const status = (id: string, agents: AgentRun[]): AssistantMessage => ({ id, role: "status", text: "", at: 1, agents });
const reply = (id: string, agents: AgentRun[]): AssistantMessage => ({ id, role: "assistant", text: "ok", at: 1, agents });

describe("specialistRuns", () => {
  it("shows a run from the moment it starts, then done once its reply finishes it", () => {
    const asked = [user("u1"), status("s1", [run("r1")])];
    expect(specialistRuns(asked, NOW).map((r) => r.status)).toEqual(["running"]);
    const answered = [...asked, reply("a1", [run("r1", { status: "done", seconds: 29 })])];
    expect(specialistRuns(answered, NOW)).toEqual([
      expect.objectContaining({ run: "r1", status: "done", seconds: 29 }),
    ]);
  });

  it("goes from running to failed, keeping the error", () => {
    const rows = [user("u1"), status("s1", [run("r1")]), reply("a1", [run("r1", { status: "failed", error: "timeout", seconds: 5 })])];
    expect(specialistRuns(rows, NOW)).toEqual([expect.objectContaining({ status: "failed", error: "timeout" })]);
  });

  it("gathers runs from every row, newest first", () => {
    const rows = [
      user("u1"),
      reply("a1", [run("r1", { startedAt: NOW - 3 * MIN, status: "done", seconds: 10 })]),
      user("u2"),
      status("s2", [run("r2", { startedAt: NOW - 2 * MIN }), run("r3", { agent: "design-critic" })]),
    ];
    expect(specialistRuns(rows, NOW).map((r) => r.run)).toEqual(["r3", "r2", "r1"]);
  });

  it("drops a finished run once it ended long ago, and a running one gone stale", () => {
    const rows = [
      user("u1"),
      reply("a1", [run("old", { startedAt: NOW - 120 * MIN, status: "done", seconds: 30 })]),
      status("s1", [run("stuck", { startedAt: NOW - 90 * MIN }), run("fresh")]),
    ];
    expect(specialistRuns(rows, NOW).map((r) => r.run)).toEqual(["fresh"]);
  });

  it("is empty with no runs", () => {
    expect(specialistRuns([user("u1"), reply("a1", [])], NOW)).toEqual([]);
  });
});
