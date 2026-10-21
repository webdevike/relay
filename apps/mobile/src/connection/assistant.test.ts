import { beforeEach, describe, expect, it } from "vitest";
import type { AssistantSnapshot } from "@relay/protocol";
import { agentTitle, threadOf, useAssistantStore } from "@/state/assistant";
import { createAssistantFrameRouter, type AssistantFrameRouter } from "./assistant";

function snapshot(rev: number, texts: string[], busy = false): AssistantSnapshot {
  return {
    rev,
    busy,
    sessionId: "eva-session",
    messages: texts.map((text, i) => ({ id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant", text, at: 1000 + i })),
  };
}

function thread(agent: string) {
  return threadOf(useAssistantStore.getState(), agent);
}

/** The store is the real one (reset per test); the router has no socket to talk to. */
let route: AssistantFrameRouter;

beforeEach(() => {
  useAssistantStore.setState({ agents: null, threads: {} });
  route = createAssistantFrameRouter(useAssistantStore.getState());
});

describe("assistant.agents", () => {
  it("stores the host's registry in its order and names a thread by it", () => {
    expect(agentTitle(useAssistantStore.getState().agents, "nova")).toBe("nova");
    const agents = [
      { id: "astra", title: "Astra" },
      { id: "nova", title: "Nova" },
    ];
    route({ t: "assistant.agents", agents });
    expect(useAssistantStore.getState().agents).toEqual(agents);
    expect(agentTitle(useAssistantStore.getState().agents, "nova")).toBe("Nova");
  });
});

describe("assistant.snapshot", () => {
  it("replaces the thread and ignores an older snapshot that arrives late", () => {
    route({ t: "assistant.snapshot", agent: "astra", snapshot: snapshot(2, ["hi", "hello"]) });
    expect(thread("astra").snapshot?.messages.map((m) => m.text)).toEqual(["hi", "hello"]);
    route({ t: "assistant.snapshot", agent: "astra", snapshot: snapshot(1, ["hi"]) });
    expect(thread("astra").snapshot?.rev).toBe(2);
    route({ t: "assistant.snapshot", agent: "astra", snapshot: snapshot(3, ["hi", "hello", "more"], true) });
    expect(thread("astra").snapshot?.busy).toBe(true);
  });

  it("keeps each agent's thread, revs, echo and sign-ins apart", () => {
    route({ t: "assistant.snapshot", agent: "astra", snapshot: snapshot(5, ["standup?", "at ten"]) });
    // Nova counts its own revs: a lower one than Astra's is still news.
    route({ t: "assistant.snapshot", agent: "nova", snapshot: snapshot(1, ["groceries"]) });
    expect(thread("astra").snapshot?.messages.map((m) => m.text)).toEqual(["standup?", "at ten"]);
    expect(thread("nova").snapshot?.messages.map((m) => m.text)).toEqual(["groceries"]);

    useAssistantStore.getState().setPending("nova", { text: "and milk", images: [] });
    expect(thread("nova").pending).toEqual({ text: "and milk", images: [], sinceRev: 1 });
    expect(thread("astra").pending).toBeNull();
    // Astra moving on does not retire Nova's echo.
    route({ t: "assistant.snapshot", agent: "astra", snapshot: snapshot(6, ["standup?", "at ten", "ok"]) });
    expect(thread("nova").pending?.text).toBe("and milk");
    route({ t: "assistant.snapshot", agent: "nova", snapshot: snapshot(2, ["groceries", "noted", "and milk"]) });
    expect(thread("nova").pending).toBeNull();

    // Message ids repeat across threads; a sign-in acked in one is not submitted in the other.
    useAssistantStore.getState().markSignedIn("astra", "m0");
    expect(thread("astra").signedIn).toEqual({ m0: true });
    expect(thread("nova").signedIn).toEqual({});
  });

  it("accepts a lower rev again after a welcome (the host restarted)", () => {
    route({ t: "assistant.snapshot", agent: "astra", snapshot: snapshot(9, ["hi", "hello"]) });
    route({ t: "welcome", state: { mac: { name: "Host", version: "1.0.0", accessibilityGranted: true, agentsAvailable: true }, agents: { rev: 0, sessions: [] } } });
    route({ t: "assistant.snapshot", agent: "astra", snapshot: snapshot(0, []) });
    expect(thread("astra").snapshot?.rev).toBe(0);
  });

  it("retires the optimistic echo once a snapshot lists the turn or moves past the rev it was sent at", () => {
    route({ t: "assistant.snapshot", agent: "astra", snapshot: snapshot(1, ["earlier"]) });
    useAssistantStore.getState().setPending("astra", { text: "ship it", images: [] });
    expect(thread("astra").pending).toEqual({ text: "ship it", images: [], sinceRev: 1 });
    route({ t: "assistant.snapshot", agent: "astra", snapshot: snapshot(1, ["earlier"]) });
    expect(thread("astra").pending?.text).toBe("ship it");
    route({ t: "assistant.snapshot", agent: "astra", snapshot: snapshot(2, ["earlier", "ok", "ship it"]) });
    expect(thread("astra").pending).toBeNull();

    useAssistantStore.getState().setPending("astra", { text: "again", images: [] });
    route({ t: "assistant.snapshot", agent: "astra", snapshot: snapshot(3, ["earlier", "ok", "ship it", "sure"]) });
    expect(thread("astra").pending).toBeNull();
  });

  it("keeps the pictures of an image-only echo until the rev moves, then retires it", () => {
    const photo = { image: { mimeType: "image/jpeg" as const, data: "abc" }, uri: "file:///a.jpg", width: 4, height: 3 };
    route({ t: "assistant.snapshot", agent: "astra", snapshot: snapshot(1, ["earlier", "ok", ""]) });
    useAssistantStore.getState().setPending("astra", { text: "", images: [photo] });
    // An older empty-text user message in the snapshot must not retire an image-only echo.
    route({ t: "assistant.snapshot", agent: "astra", snapshot: snapshot(1, ["earlier", "ok", ""]) });
    expect(thread("astra").pending?.images).toEqual([photo]);
    route({ t: "assistant.snapshot", agent: "astra", snapshot: snapshot(2, ["earlier", "ok", "", "seen"]) });
    expect(thread("astra").pending).toBeNull();
  });

  it("carries the session id and each message's image refs through the snapshot", () => {
    const withImages: AssistantSnapshot = {
      rev: 4,
      busy: false,
      sessionId: "eva-session",
      messages: [{ id: "m0", role: "assistant", text: "here", at: 1, images: [{ id: "img1", mimeType: "image/png", width: 10, height: 20 }] }],
    };
    route({ t: "assistant.snapshot", agent: "astra", snapshot: withImages });
    expect(thread("astra").snapshot?.sessionId).toBe("eva-session");
    expect(thread("astra").snapshot?.messages[0]?.images?.[0]?.id).toBe("img1");
  });

  it("keeps a message's signin handoff, submitted or not", () => {
    const signin = { url: "https://github.com/login", host: "github.com" };
    const withSignin: AssistantSnapshot = {
      rev: 1,
      busy: false,
      sessionId: "eva-session",
      messages: [
        { id: "m0", role: "assistant", text: "Sign in please.", at: 1, signin },
        { id: "m1", role: "assistant", text: "Done.", at: 2, signin: { ...signin, submitted: true } },
      ],
    };
    route({ t: "assistant.snapshot", agent: "astra", snapshot: withSignin });
    const stored = thread("astra").snapshot?.messages;
    expect(stored?.[0]?.signin).toEqual(signin);
    expect(stored?.[1]?.signin).toEqual({ ...signin, submitted: true });
  });

  it("remembers a sign-in the host acked until its snapshot carries submitted", () => {
    useAssistantStore.getState().markSignedIn("astra", "m0");
    useAssistantStore.getState().markSignedIn("astra", "m1");
    expect(thread("astra").signedIn).toEqual({ m0: true, m1: true });
  });
});

describe("other frames", () => {
  it("leave the threads alone", () => {
    route({ t: "assistant.snapshot", agent: "astra", snapshot: snapshot(1, ["hi"]) });
    route({ t: "pong", ts: 1, serverTs: 2 });
    route({ t: "ack", id: "a" });
    route({ t: "gate.status", gate: null });
    expect(thread("astra").snapshot?.rev).toBe(1);
    expect(useAssistantStore.getState().agents).toBeNull();
  });
});
