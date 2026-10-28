import { describe, expect, it } from "vitest";
import type { AgentSession, AssistantMessage, AssistantSnapshot } from "@relay/protocol";
import { listingDot, motionSignals, threadTool, type MotionInputs } from "./motion";

function snapshot(messages: AssistantMessage[], busy = false, sessionId = "s1"): AssistantSnapshot {
  return { rev: 1, messages, busy, sessionId };
}

const user = (id: string, at: number): AssistantMessage => ({ id, role: "user", text: "hi", at });
const reply = (id: string, at: number, text = "Hello"): AssistantMessage => ({ id, role: "assistant", text, at });

function inputs(change: Partial<MotionInputs> = {}): MotionInputs {
  return { snapshot: null, status: undefined, lastReplyAt: undefined, signedIn: {}, tool: null, call: null, turnFailed: false, ...change };
}

function session(id: string, change: Partial<AgentSession> = {}): AgentSession {
  return { id, provider: "omp", title: id, projectPath: `/tmp/${id}`, status: "idle", lastActivity: "", lastActivityAt: 0, canRespond: true, ...change };
}

describe("motionSignals", () => {
  it("is quiet for a thread the phone knows nothing about", () => {
    expect(motionSignals(inputs())).toEqual({ running: false, tool: null, waiting: false, failed: false, activityAt: null });
  });

  it("runs while the snapshot is busy (its reply streaming included) or the registry says working", () => {
    expect(motionSignals(inputs({ snapshot: snapshot([user("u", 1), reply("a", 2)], true) })).running).toBe(true);
    expect(motionSignals(inputs({ status: "working" })).running).toBe(true);
    expect(motionSignals(inputs({ status: "idle", snapshot: snapshot([user("u", 1)]) })).running).toBe(false);
  });

  it("runs on a call only while it thinks: speaking and hearing are not a running turn", () => {
    expect(motionSignals(inputs({ call: { state: "thinking", error: null } })).running).toBe(true);
    for (const state of ["listening", "hearing", "speaking", "connecting"] as const) {
      expect(motionSignals(inputs({ call: { state, error: null } })).running).toBe(false);
    }
    expect(motionSignals(inputs({ call: { state: "ended", error: "Lost the connection" } })).failed).toBe(true);
  });

  it("passes the tool through", () => {
    expect(motionSignals(inputs({ tool: "research" })).tool).toBe("research");
  });

  it("waits on needs-you and on an unanswered sign-in of the current turn", () => {
    expect(motionSignals(inputs({ status: "needs_you" })).waiting).toBe(true);
    const signin: AssistantMessage = { ...reply("a", 2, "Please sign in"), signin: { url: "https://x.test/login", host: "x.test" } };
    expect(motionSignals(inputs({ snapshot: snapshot([user("u", 1), signin]) })).waiting).toBe(true);
    expect(motionSignals(inputs({ snapshot: snapshot([user("u", 1), signin]), signedIn: { a: true } })).waiting).toBe(false);
    const submitted = { ...signin, signin: { url: "https://x.test/login", host: "x.test", submitted: true } };
    expect(motionSignals(inputs({ snapshot: snapshot([user("u", 1), submitted]) })).waiting).toBe(false);
    // An old sign-in Isaac has since talked past no longer counts.
    expect(motionSignals(inputs({ snapshot: snapshot([signin, user("u", 3)]) })).waiting).toBe(false);
  });

  it("fails on a refused turn and on an error row, until a newer turn", () => {
    expect(motionSignals(inputs({ turnFailed: true })).failed).toBe(true);
    const error: AssistantMessage = { id: "e", role: "error", text: "launch failed", at: 2 };
    expect(motionSignals(inputs({ snapshot: snapshot([user("u", 1), error]) })).failed).toBe(true);
    expect(motionSignals(inputs({ snapshot: snapshot([user("u", 1), error, user("u2", 3)]) })).failed).toBe(false);
  });

  it("dates activity by the newest shown row, else the registry's last reply", () => {
    const rows = [user("u", 5), reply("a", 9), { id: "st", role: "status", text: "job", at: 12 } as const];
    expect(motionSignals(inputs({ snapshot: snapshot(rows) })).activityAt).toBe(9);
    expect(motionSignals(inputs({ lastReplyAt: 42 })).activityAt).toBe(42);
  });
});

describe("threadTool", () => {
  it("reads the tool the working session runs", () => {
    expect(threadTool({ s1: session("s1", { status: "working", statusDetail: "web_search" }) }, "s1")).toBe("research");
    expect(threadTool({ s1: session("s1", { status: "working", statusDetail: "bash" }) }, "s1")).toBe("work");
  });

  it("ignores a stale tool name once the session stopped working", () => {
    expect(threadTool({ s1: session("s1", { status: "idle", statusDetail: "bash" }) }, "s1")).toBeNull();
  });

  it("falls back to the working subagents: research when any researches, else work", () => {
    const researching = { s1: session("s1", { status: "working" }), a: session("a", { parentId: "s1", status: "working", statusDetail: "read" }), b: session("b", { parentId: "s1", status: "working", statusDetail: "edit" }) };
    expect(threadTool(researching, "s1")).toBe("research");
    const working = { s1: session("s1"), b: session("b", { parentId: "s1", status: "working" }) };
    expect(threadTool(working, "s1")).toBe("work");
    expect(threadTool({ s1: session("s1"), b: session("b", { parentId: "s1", status: "idle", statusDetail: "read" }) }, "s1")).toBeNull();
    expect(threadTool({ b: session("b", { parentId: "other", status: "working" }) }, "s1")).toBeNull();
  });

  it("works while a background job runs, not after it ends", () => {
    const job = { id: "bg_1", type: "bash", label: "sleep 60", state: "running" as const, startedAt: 1 };
    expect(threadTool({ s1: session("s1", { backgroundJobs: [job] }) }, "s1")).toBe("work");
    expect(threadTool({ s1: session("s1", { backgroundJobs: [{ ...job, state: "done" }] }) }, "s1")).toBeNull();
  });

  it("is null without a session", () => {
    expect(threadTool({ s1: session("s1", { status: "working", statusDetail: "bash" }) }, null)).toBeNull();
    expect(threadTool({}, "")).toBeNull();
  });
});

describe("listingDot", () => {
  it("is the accent while working, orange while it needs Isaac, none otherwise", () => {
    expect(listingDot("working")).toBe("accent");
    expect(listingDot("needs_you")).toBe("orange");
    expect(listingDot("idle")).toBeNull();
    expect(listingDot(undefined)).toBeNull();
  });
});
