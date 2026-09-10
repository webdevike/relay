import { describe, expect, it } from "vitest";
import { applyDelta, applySnapshot, appendMessages, emptyAgentsData, setConversation } from "./agents";
import type { AgentMessage, AgentSession } from "@relay/protocol";

function session(id: string, lastActivityAt: number, status: AgentSession["status"] = "idle"): AgentSession {
  return {
    id,
    provider: "claude-code",
    title: id,
    projectPath: `/tmp/${id}`,
    status,
    lastActivity: "did a thing",
    lastActivityAt,
    canRespond: true,
  };
}

function message(id: string, at: number): AgentMessage {
  return { id, role: "user", text: id, at };
}

describe("applySnapshot", () => {
  it("orders sessions by lastActivityAt descending", () => {
    const data = applySnapshot(emptyAgentsData, 1, [session("a", 100), session("b", 300), session("c", 200)]);
    expect(data.order).toEqual(["b", "c", "a"]);
    expect(data.rev).toBe(1);
  });

  it("puts sessions that need the user ahead of newer ones", () => {
    const data = applySnapshot(emptyAgentsData, 1, [
      session("fresh", 400),
      session("asking", 100, "waiting"),
      session("blocked", 50, "needs_permission"),
      session("busy", 300, "working"),
    ]);
    expect(data.order).toEqual(["asking", "blocked", "fresh", "busy"]);
  });

  it("replaces the prior session set entirely", () => {
    const first = applySnapshot(emptyAgentsData, 1, [session("a", 100)]);
    const second = applySnapshot(first, 5, [session("b", 200)]);
    expect(second.sessions["a"]).toBeUndefined();
    expect(second.order).toEqual(["b"]);
  });
});

describe("applyDelta", () => {
  it("upserts and re-sorts by recency", () => {
    const base = applySnapshot(emptyAgentsData, 1, [session("a", 100), session("b", 200)]);
    const { data, ok } = applyDelta(base, 2, [session("a", 300)], undefined);
    expect(ok).toBe(true);
    expect(data.order).toEqual(["a", "b"]);
    expect(data.sessions["a"]?.lastActivityAt).toBe(300);
  });

  it("removes sessions", () => {
    const base = applySnapshot(emptyAgentsData, 1, [session("a", 100), session("b", 200)]);
    const { data, ok } = applyDelta(base, 2, undefined, ["a"]);
    expect(ok).toBe(true);
    expect(data.order).toEqual(["b"]);
    expect(data.sessions["a"]).toBeUndefined();
  });

  it("rejects a gap and leaves state unchanged", () => {
    const base = applySnapshot(emptyAgentsData, 1, [session("a", 100)]);
    const { data, ok } = applyDelta(base, 3, [session("b", 200)], undefined);
    expect(ok).toBe(false);
    expect(data).toBe(base);
  });
});

describe("appendMessages", () => {
  it("appends when rev is exactly one past the known rev", () => {
    const base = setConversation(emptyAgentsData, "s1", 1, [message("m1", 10)]);
    const { data, ok } = appendMessages(base, "s1", 2, [message("m2", 20)]);
    expect(ok).toBe(true);
    expect(data.conversations["s1"]?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("rejects a gap and leaves state unchanged", () => {
    const base = setConversation(emptyAgentsData, "s1", 1, [message("m1", 10)]);
    const { data, ok } = appendMessages(base, "s1", 5, [message("m2", 20)]);
    expect(ok).toBe(false);
    expect(data).toBe(base);
  });

  it("rejects appending to a conversation that has not been loaded", () => {
    const { data, ok } = appendMessages(emptyAgentsData, "s1", 1, [message("m1", 10)]);
    expect(ok).toBe(false);
    expect(data).toBe(emptyAgentsData);
  });
});
