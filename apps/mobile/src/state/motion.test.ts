import { describe, expect, it } from "vitest";
import type { AgentSession, AssistantMessage, AssistantSnapshot } from "@relay/protocol";
import { motionSignals, sessionWorking, type MotionInputs } from "./motion";

function snapshot(messages: AssistantMessage[], busy = false, sessionId = "s1"): AssistantSnapshot {
  return { rev: 1, messages, busy, sessionId };
}

const user = (id: string, at: number): AssistantMessage => ({ id, role: "user", text: "hi", at });
const reply = (id: string, at: number, text = "Hello"): AssistantMessage => ({ id, role: "assistant", text, at });

function inputs(change: Partial<MotionInputs> = {}): MotionInputs {
  return {
    snapshot: null,
    pending: false,
    status: undefined,
    lastReplyAt: undefined,
    signedIn: {},
    working: false,
    call: null,
    turnFailed: false,
    ...change,
  };
}

function session(id: string, change: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    provider: "omp",
    title: id,
    projectPath: `/tmp/${id}`,
    status: "idle",
    lastActivity: "",
    lastActivityAt: 0,
    canRespond: true,
    ...change,
  };
}

describe("motionSignals", () => {
  it("is quiet for a thread the phone knows nothing about", () => {
    expect(motionSignals(inputs())).toEqual({
      running: false,
      working: false,
      talking: false,
      listening: false,
      waiting: false,
      failed: false,
      activityAt: null,
    });
  });

  it("runs while the snapshot is busy or the registry says working", () => {
    expect(motionSignals(inputs({ snapshot: snapshot([user("u", 1)], true) })).running).toBe(true);
    expect(motionSignals(inputs({ status: "working" })).running).toBe(true);
    expect(motionSignals(inputs({ status: "idle", snapshot: snapshot([user("u", 1)]) })).running).toBe(false);
  });

  it("talks while the newest row is a reply streaming words", () => {
    const streaming = snapshot([user("u", 1), reply("a", 2)], true);
    expect(motionSignals(inputs({ snapshot: streaming })).talking).toBe(true);
    // Settled, still empty, or Isaac's turn newest: not talking.
    expect(motionSignals(inputs({ snapshot: snapshot([user("u", 1), reply("a", 2)]) })).talking).toBe(false);
    expect(motionSignals(inputs({ snapshot: snapshot([user("u", 1), reply("a", 2, "  ")], true) })).talking).toBe(false);
    expect(motionSignals(inputs({ snapshot: snapshot([reply("a", 1), user("u", 2)], true) })).talking).toBe(false);
  });

  it("does not take the previous reply for a stream while a sent turn is still pending", () => {
    const before = snapshot([user("u", 1), reply("a", 2)], true);
    expect(motionSignals(inputs({ snapshot: before, pending: true })).talking).toBe(false);
  });

  it("ignores status rows when finding the newest", () => {
    const rows = [user("u", 1), reply("a", 2), { id: "st", role: "status", text: "job", at: 3 } as const];
    const signals = motionSignals(inputs({ snapshot: snapshot(rows, true) }));
    expect(signals.talking).toBe(true);
    expect(signals.activityAt).toBe(2);
  });

  it("follows the call: speaking talks, hearing listens, thinking runs, an error fails", () => {
    expect(motionSignals(inputs({ call: { state: "speaking", error: null } })).talking).toBe(true);
    expect(motionSignals(inputs({ call: { state: "hearing", error: null } })).listening).toBe(true);
    expect(motionSignals(inputs({ call: { state: "thinking", error: null } })).running).toBe(true);
    expect(motionSignals(inputs({ call: { state: "listening", error: null } }))).toMatchObject({ running: false, talking: false, listening: false });
    expect(motionSignals(inputs({ call: { state: "ended", error: "Lost the connection" } })).failed).toBe(true);
  });

  it("waits on needs-you and on an unanswered sign-in of the current turn", () => {
    expect(motionSignals(inputs({ status: "needs_you" })).waiting).toBe(true);
    const signin: AssistantMessage = { ...reply("a", 2, "Please sign in"), signin: { url: "https://x.test/login", host: "x.test" } };
    expect(motionSignals(inputs({ snapshot: snapshot([user("u", 1), signin]) })).waiting).toBe(true);
    expect(motionSignals(inputs({ snapshot: snapshot([user("u", 1), signin]), signedIn: { a: true } })).waiting).toBe(false);
    const submitted = { ...signin, signin: { url: "https://x.test/login", host: "x.test", submitted: true } };
    expect(motionSignals(inputs({ snapshot: snapshot([user("u", 1), submitted]) })).waiting).toBe(false);
    // An old sign-in Isaac has since talked past no longer holds the portrait.
    expect(motionSignals(inputs({ snapshot: snapshot([signin, user("u", 3)]) })).waiting).toBe(false);
  });

  it("fails on a refused turn and on an error row, until a newer turn", () => {
    expect(motionSignals(inputs({ turnFailed: true })).failed).toBe(true);
    const error: AssistantMessage = { id: "e", role: "error", text: "launch failed", at: 2 };
    expect(motionSignals(inputs({ snapshot: snapshot([user("u", 1), error]) })).failed).toBe(true);
    expect(motionSignals(inputs({ snapshot: snapshot([user("u", 1), error, user("u2", 3)]) })).failed).toBe(false);
  });

  it("dates activity by the newest row, else the registry's last reply", () => {
    expect(motionSignals(inputs({ snapshot: snapshot([user("u", 5), reply("a", 9)]) })).activityAt).toBe(9);
    expect(motionSignals(inputs({ lastReplyAt: 42 })).activityAt).toBe(42);
  });

  it("passes working through", () => {
    expect(motionSignals(inputs({ working: true })).working).toBe(true);
  });
});

describe("sessionWorking", () => {
  it("is true while a subagent of the session works", () => {
    const sessions = { s1: session("s1"), sub: session("sub", { parentId: "s1", status: "working" }) };
    expect(sessionWorking(sessions, "s1")).toBe(true);
    expect(sessionWorking({ ...sessions, sub: session("sub", { parentId: "s1", status: "idle" }) }, "s1")).toBe(false);
  });

  it("is true while a background job of the session runs, not after it ends", () => {
    const job = { id: "bg_1", type: "bash", label: "sleep 60", state: "running" as const, startedAt: 1 };
    expect(sessionWorking({ s1: session("s1", { backgroundJobs: [job] }) }, "s1")).toBe(true);
    expect(sessionWorking({ s1: session("s1", { backgroundJobs: [{ ...job, state: "done" }] }) }, "s1")).toBe(false);
  });

  it("is false without a session", () => {
    expect(sessionWorking({ s1: session("s1", { status: "working" }) }, null)).toBe(false);
    expect(sessionWorking({}, "")).toBe(false);
  });

  it("ignores other sessions' subagents", () => {
    expect(sessionWorking({ sub: session("sub", { parentId: "other", status: "working" }) }, "s1")).toBe(false);
  });
});
