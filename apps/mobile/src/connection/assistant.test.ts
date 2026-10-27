import { beforeEach, describe, expect, it } from "vitest";
import type { AssistantAgent, AssistantSnapshot } from "@relay/protocol";
import { agentTitle, assistantsCaption, latestReply, STATUS_LABEL, threadOf, useAssistantStore } from "@/state/assistant";
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

  it("keeps each agent's scope, status and last reply, and replaces the list when the host pushes a fresh one", () => {
    const first: AssistantAgent[] = [
      { id: "astra", title: "Astra", scope: "eCard Systems work", status: "working", lastReply: { text: "Reviewing the PR.", at: 10 } },
      { id: "nova", title: "Nova", scope: "Personal", status: "not_started" },
    ];
    route({ t: "assistant.agents", agents: first });
    expect(useAssistantStore.getState().agents).toEqual(first);
    const second: AssistantAgent[] = [
      { id: "astra", title: "Astra", scope: "eCard Systems work", status: "needs_you", lastReply: { text: "Approve the deploy?", at: 20 } },
      { id: "nova", title: "Nova", scope: "Personal", status: "idle", lastReply: { text: "Flight moved to 9:40.", at: 15 } },
    ];
    route({ t: "assistant.agents", agents: second });
    expect(useAssistantStore.getState().agents).toEqual(second);
  });

  it("still takes a list from a host that sends only id and title", () => {
    route({ t: "assistant.agents", agents: [{ id: "astra", title: "Astra" }] });
    expect(useAssistantStore.getState().agents).toEqual([{ id: "astra", title: "Astra" }]);
    expect(assistantsCaption(useAssistantStore.getState().agents)).toBe("1 assistant");
  });

  it("leaves threads alone when the list changes", () => {
    route({ t: "assistant.snapshot", agent: "nova", snapshot: snapshot(1, ["hi"]) });
    route({ t: "assistant.agents", agents: [{ id: "nova", title: "Nova", status: "idle" }] });
    expect(thread("nova").snapshot?.rev).toBe(1);
  });
});

describe("Assistants summaries", () => {
  const agents: AssistantAgent[] = [
    { id: "astra", title: "Astra", status: "idle", lastReply: { text: "Standup is at 9:30.", at: 100 } },
    { id: "nova", title: "Nova", status: "idle", lastReply: { text: "**Flight** moved to [9:40](https://example.com).\nSecond line.", at: 200 } },
    { id: "sage", title: "Sage", status: "not_started" },
  ];

  it("picks the most recent last reply across agents", () => {
    expect(latestReply(agents)?.agent.id).toBe("nova");
    expect(latestReply([{ id: "sage", title: "Sage" }])).toBeNull();
    expect(latestReply(null)).toBeNull();
  });

  it("captions the home tile with that reply as one plain line led by who said it, else the agent count", () => {
    expect(assistantsCaption(agents)).toBe("Nova: Flight moved to 9:40.");
    expect(assistantsCaption([{ id: "a", title: "A" }, { id: "b", title: "B" }])).toBe("2 assistants");
    expect(assistantsCaption([])).toBe("No assistants yet");
    expect(assistantsCaption(null)).toBe("No assistants yet");
  });

  it("labels every status", () => {
    expect(STATUS_LABEL).toEqual({ working: "Working", needs_you: "Needs you", idle: "Idle", not_started: "Not started" });
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

  it("shows Isaac's turns without the desktop's or the phone's surface tag, and settles the echo by the shown words", () => {
    route({
      t: "assistant.snapshot",
      agent: "nova",
      snapshot: snapshot(1, ["<surface>Mac Mini - Relay Desktop</surface>\nbook the table", "done", "<surface>iPhone - Relay</surface>\nthanks", "np"]),
    });
    expect(thread("nova").snapshot?.messages.map((m) => m.text)).toEqual(["book the table", "done", "thanks", "np"]);
    // Older history: the desktop's tag from before it was Relay Desktop.
    useAssistantStore.getState().setPending("nova", { text: "and wine", images: [] });
    route({ t: "assistant.snapshot", agent: "nova", snapshot: snapshot(1, ["<surface>Mac Mini - EvaOS</surface>\nand wine"]) });
    expect(thread("nova").snapshot?.messages[0]?.text).toBe("and wine");
    expect(thread("nova").pending).toBeNull();
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
