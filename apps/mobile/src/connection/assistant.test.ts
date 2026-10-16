import { beforeEach, describe, expect, it } from "vitest";
import type { AssistantSnapshot } from "@relay/protocol";
import { useAssistantStore } from "@/state/assistant";
import { createAssistantFrameRouter, type AssistantFrameRouter } from "./assistant";

function snapshot(rev: number, texts: string[], busy = false): AssistantSnapshot {
  return { rev, busy, messages: texts.map((text, i) => ({ id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant", text, at: 1000 + i })) };
}

/** The store is the real one (reset per test); the router has no socket to talk to. */
let route: AssistantFrameRouter;

beforeEach(() => {
  useAssistantStore.setState({ snapshot: null, pending: null });
  route = createAssistantFrameRouter(useAssistantStore.getState());
});

describe("assistant.snapshot", () => {
  it("replaces the thread and ignores an older snapshot that arrives late", () => {
    route({ t: "assistant.snapshot", snapshot: snapshot(2, ["hi", "hello"]) });
    expect(useAssistantStore.getState().snapshot?.messages.map((m) => m.text)).toEqual(["hi", "hello"]);
    route({ t: "assistant.snapshot", snapshot: snapshot(1, ["hi"]) });
    expect(useAssistantStore.getState().snapshot?.rev).toBe(2);
    route({ t: "assistant.snapshot", snapshot: snapshot(3, ["hi", "hello", "more"], true) });
    expect(useAssistantStore.getState().snapshot?.busy).toBe(true);
  });

  it("accepts a lower rev again after a welcome (the host restarted)", () => {
    route({ t: "assistant.snapshot", snapshot: snapshot(9, ["hi", "hello"]) });
    route({ t: "welcome", state: { mac: { name: "Host", version: "1.0.0", accessibilityGranted: true, agentsAvailable: true }, agents: { rev: 0, sessions: [] } } });
    route({ t: "assistant.snapshot", snapshot: snapshot(0, []) });
    expect(useAssistantStore.getState().snapshot?.rev).toBe(0);
  });

  it("retires the optimistic echo once a snapshot lists the turn or moves past the rev it was sent at", () => {
    route({ t: "assistant.snapshot", snapshot: snapshot(1, ["earlier"]) });
    useAssistantStore.getState().setPending("ship it");
    expect(useAssistantStore.getState().pending).toEqual({ text: "ship it", sinceRev: 1 });
    route({ t: "assistant.snapshot", snapshot: snapshot(1, ["earlier"]) });
    expect(useAssistantStore.getState().pending?.text).toBe("ship it");
    route({ t: "assistant.snapshot", snapshot: snapshot(2, ["earlier", "ok", "ship it"]) });
    expect(useAssistantStore.getState().pending).toBeNull();

    useAssistantStore.getState().setPending("again");
    route({ t: "assistant.snapshot", snapshot: snapshot(3, ["earlier", "ok", "ship it", "sure"]) });
    expect(useAssistantStore.getState().pending).toBeNull();
  });
});

describe("other frames", () => {
  it("leave the thread alone", () => {
    route({ t: "assistant.snapshot", snapshot: snapshot(1, ["hi"]) });
    route({ t: "pong", ts: 1, serverTs: 2 });
    route({ t: "ack", id: "a" });
    route({ t: "gate.status", gate: null });
    expect(useAssistantStore.getState().snapshot?.rev).toBe(1);
  });
});
