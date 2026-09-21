import { beforeEach, describe, expect, it } from "vitest";
import type { AgentSession, ClientMessage, MacState } from "@relay/protocol";
import { emptyAgentsData, useAgentsStore } from "@/state/agents";
import { createAgentFrameRouter, type AgentFrameRouter } from "./agents";

const mac: MacState = { name: "Host", version: "1.0.0", accessibilityGranted: true, agentsAvailable: true };

function session(id: string): AgentSession {
  return {
    id,
    provider: "claude-code",
    title: id,
    projectPath: `/tmp/${id}`,
    status: "idle",
    lastActivity: "did a thing",
    lastActivityAt: 1,
    canRespond: true,
  };
}

/** The store is the real one (reset per test); the socket is a list of frames the router sent. */
let sent: ClientMessage[];
let route: AgentFrameRouter;

beforeEach(() => {
  useAgentsStore.setState(emptyAgentsData);
  sent = [];
  route = createAgentFrameRouter(useAgentsStore.getState(), (message) => {
    sent.push(message);
  });
});

describe("session list", () => {
  it("applies an in-order delta without asking for anything", () => {
    route({ t: "welcome", state: { mac, agents: { rev: 3, sessions: [] } } });
    route({ t: "agents.delta", rev: 4, upsert: [session("a")] });
    expect(useAgentsStore.getState().order).toEqual(["a"]);
    expect(sent).toEqual([]);
  });

  it("asks for one snapshot on a gap and stops repeating until it lands", () => {
    route({ t: "welcome", state: { mac, agents: { rev: 3, sessions: [] } } });
    route({ t: "agents.delta", rev: 5, upsert: [session("a")] });
    route({ t: "agents.delta", rev: 6, upsert: [session("b")] });
    expect(useAgentsStore.getState().order).toEqual([]);
    expect(sent).toEqual([{ t: "agents.get" }]);

    route({ t: "agents.snapshot", rev: 6, sessions: [session("a"), session("b")] });
    route({ t: "agents.delta", rev: 9, remove: ["a"] });
    expect(sent).toEqual([{ t: "agents.get" }, { t: "agents.get" }]);
  });
});

describe("conversation", () => {
  it("appends in-order messages", () => {
    route({ t: "agent.conversation", sessionId: "a", rev: 0, messages: [] });
    route({ t: "agent.messages", sessionId: "a", rev: 1, append: [{ id: "m1", role: "user", text: "hi", at: 1 }] });
    expect(useAgentsStore.getState().conversations["a"]?.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(sent).toEqual([]);
  });

  it("re-subscribes once on a gap, then accepts the fresh conversation", () => {
    route({ t: "agent.conversation", sessionId: "a", rev: 0, messages: [] });
    route({ t: "agent.messages", sessionId: "a", rev: 2, append: [{ id: "m2", role: "user", text: "late", at: 2 }] });
    route({ t: "agent.messages", sessionId: "a", rev: 3, append: [{ id: "m3", role: "user", text: "later", at: 3 }] });
    expect(sent).toEqual([
      { t: "agent.unsubscribe", sessionId: "a" },
      { t: "agent.subscribe", sessionId: "a" },
    ]);
    expect(useAgentsStore.getState().conversations["a"]?.messages).toEqual([]);

    route({ t: "agent.conversation", sessionId: "a", rev: 0, messages: [{ id: "m1", role: "user", text: "hi", at: 1 }] });
    route({ t: "agent.messages", sessionId: "a", rev: 1, append: [{ id: "m2", role: "assistant", text: "hello", at: 2 }] });
    expect(useAgentsStore.getState().conversations["a"]?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(sent).toHaveLength(2);
  });

  it("grows a streaming message in place, settles it, and ignores updates for ids it does not hold", () => {
    route({ t: "agent.conversation", sessionId: "a", rev: 0, messages: [{ id: "m1", role: "user", text: "hi", at: 1 }] });
    route({ t: "agent.messages", sessionId: "a", rev: 1, append: [{ id: "m2", role: "assistant", text: "", at: 2, streaming: true }] });
    route({ t: "agent.message.update", sessionId: "a", id: "m2", text: "hel", streaming: true });
    expect(useAgentsStore.getState().conversations["a"]?.messages[1]).toEqual({ id: "m2", role: "assistant", text: "hel", at: 2, streaming: true });
    route({ t: "agent.message.update", sessionId: "a", id: "m2", text: "hello", streaming: false });
    expect(useAgentsStore.getState().conversations["a"]?.messages[1]).toEqual({ id: "m2", role: "assistant", text: "hello", at: 2 });
    route({ t: "agent.message.update", sessionId: "a", id: "ghost", text: "x", streaming: true });
    expect(useAgentsStore.getState().conversations["a"]?.messages).toHaveLength(2);
    expect(useAgentsStore.getState().conversations["a"]?.rev).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it("drops every conversation on welcome so a reconnect starts clean", () => {
    route({ t: "agent.conversation", sessionId: "a", rev: 4, messages: [{ id: "m1", role: "user", text: "hi", at: 1 }] });
    route({ t: "welcome", state: { mac, agents: { rev: 1, sessions: [session("a")] } } });
    expect(useAgentsStore.getState().conversations).toEqual({});
    expect(useAgentsStore.getState().order).toEqual(["a"]);
  });
});

describe("images", () => {
  it("routes an agent.image answer into the store", () => {
    route({ t: "agent.image", sessionId: "a", id: "img1", image: { mimeType: "image/png", data: "AAAA" } });
    route({ t: "agent.image", sessionId: "a", id: "img2", image: null });
    expect(useAgentsStore.getState().images["a"]).toEqual({ img1: "data:image/png;base64,AAAA", img2: null });
    expect(sent).toEqual([]);
  });
});
