import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession, GuestEntry } from "@relay/protocol";
import type { PushMessage } from "../src/push/notifier";
import type { SessionClock } from "../src/session";
import { CallMeError, CallMeService, type CallMeDeps } from "../src/callme/service";

/** Timers that run only when the test advances time. */
class ManualClock implements SessionClock {
  private at = 0;
  private timers: { due: number; fn: () => void }[] = [];
  now(): number {
    return this.at;
  }
  after(ms: number, fn: () => void): () => void {
    const timer = { due: this.at + ms, fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }
  advance(ms: number): void {
    const end = this.at + ms;
    for (;;) {
      const next = this.timers.filter((t) => t.due <= end).sort((a, b) => a.due - b.due)[0];
      if (next === undefined) break;
      this.timers = this.timers.filter((t) => t !== next);
      this.at = next.due;
      next.fn();
    }
    this.at = end;
  }
}

function session(id: string, status: AgentSession["status"], extra: Partial<AgentSession> = {}): AgentSession {
  return { id, provider: "omp", title: id, projectPath: "/x", status, lastActivity: "", lastActivityAt: 0, canRespond: true, ...extra };
}

let dir: string;
let runs: string;
let clock: ManualClock;
let sessions: AgentSession[];
let pushes: Omit<PushMessage, "to">[];
let cards: GuestEntry[];

function writeRun(id: string, state: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(join(runs, `${id}.json`), JSON.stringify({ id, owner: "nova", title: `Run ${id}`, state, ...extra }));
}

function service(path: string | null = null): CallMeService {
  const deps: CallMeDeps = {
    thread: (agent) =>
      agent === "nova"
        ? {
            id: "nova",
            title: "Nova",
            sessionId: () => "nova-session",
            say: () => Promise.resolve(),
          }
        : undefined,
    sessions: () => sessions,
    card: (_sessionId, _content, entry) => {
      cards.push(entry);
      return Promise.resolve(true);
    },
    push: (message) => pushes.push(message),
    runs,
    human: "Isaac",
    path,
    timing: { ringMs: 60_000, maxWaitMs: 3_600_000, pollMs: 1_000 },
    clock,
    log: () => undefined,
  };
  return new CallMeService(deps);
}

const rings = (): Omit<PushMessage, "to">[] => pushes.filter((push) => push.title?.endsWith("is calling") === true);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "callme-"));
  runs = join(dir, "runs");
  mkdirSync(runs);
  clock = new ManualClock();
  sessions = [session("nova-session", "working", { kind: "assistant", assistant: "nova" })];
  pushes = [];
  cards = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("call me when it's done", () => {
  it("attaches to the assistant's one running run and rings with its result when it finishes", async () => {
    writeRun("r1", "running");
    const calls = service();
    const request = await calls.add({ agent: "nova", about: "the waterfall options" });
    expect(request.target).toEqual({ kind: "run", id: "r1", title: "Run r1" });
    expect(cards.at(-1)?.work).toMatchObject({ id: `call:${request.id}`, state: "working" });
    clock.advance(5_000);
    expect(rings()).toHaveLength(0);

    const transcript = join(dir, "t.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Option B is cheapest." }] } })}\n`);
    writeRun("r1", "done", { sessionFile: transcript });
    clock.advance(1_000);
    expect(rings()).toHaveLength(1);
    expect(rings()[0]?.data).toMatchObject({ callRequest: request.id, agent: "nova" });

    const opener = calls.answer(request.id, "nova");
    expect(opener?.greeting).toBe("Hey Isaac, the thing you asked for is done: the waterfall options. Want any follow-ups?");
    expect(opener?.brief).toContain("Option B is cheapest.");
    expect(calls.list("nova", true)[0]?.state).toBe("connected");
    // Answered once: a second tap is an ordinary call.
    expect(calls.answer(request.id, "nova")).toBeNull();
  });

  it("asks the assistant to pick when several runs are going, and never asks Isaac", async () => {
    writeRun("r1", "running");
    writeRun("r2", "running");
    const calls = service();
    await expect(calls.add({ agent: "nova", about: "it" })).rejects.toBeInstanceOf(CallMeError);
    const picked = await calls.add({ agent: "nova", about: "it", on: "run:r2" });
    expect(picked.target).toMatchObject({ kind: "run", id: "r2" });
  });

  it("with no run going, waits for this turn, its background jobs and subagents", async () => {
    const calls = service();
    const request = await calls.add({ agent: "nova", about: "the summary", session: "nova-session" });
    expect(request.target).toMatchObject({ kind: "session", id: "nova-session" });
    sessions = [session("nova-session", "idle", { backgroundJobs: [{ id: "bg_1", type: "bash", label: "build", state: "running", startedAt: 0 }] })];
    calls.observeSessions();
    sessions = [session("nova-session", "idle"), session("child", "working", { parentId: "nova-session" })];
    calls.observeSessions();
    clock.advance(0);
    expect(rings()).toHaveLength(0);
    sessions = [session("nova-session", "idle", { lastActivity: "Summary sent" })];
    calls.observeSessions();
    expect(rings()).toHaveLength(1);
  });

  it("missed: one missed-call push and the result on the thread card, the ring withdrawn", async () => {
    const calls = service();
    const request = await calls.add({ agent: "nova", about: "the CI build", on: "manual" });
    expect(calls.settle(request.id, { status: "failed", result: "2 tests failed" })).toBe(true);
    clock.advance(60_000);
    const missed = pushes.filter((push) => push.title === "Missed call from Nova");
    expect(missed).toHaveLength(1);
    expect(missed[0]?.body).toBe("The CI build: didn't finish. 2 tests failed");
    expect(pushes.some((push) => "withdraw" in push.data && push.data.withdraw === `call:${request.id}`)).toBe(true);
    expect(cards.at(-1)).toMatchObject({ text: "Missed call. The CI build: didn't finish. 2 tests failed", work: { state: "done" } });
    clock.advance(10 * 60_000);
    expect(rings()).toHaveLength(1);
  });

  it("never mind the call: cancel takes it off the thread and nothing rings", async () => {
    const calls = service();
    const request = await calls.add({ agent: "nova", about: "the deploy", on: "manual" });
    expect(calls.cancel("nova", undefined)).toEqual([request.id]);
    expect(calls.settle(request.id, { status: "done", result: "" })).toBe(false);
    expect(rings()).toHaveLength(0);
    expect(cards.at(-1)).toMatchObject({ text: "Call cancelled: the deploy", work: { state: "failed" } });
  });

  it("keeps waiting across a host restart", async () => {
    const path = join(dir, "call-requests.json");
    writeRun("r1", "running");
    const first = service(path);
    const request = await first.add({ agent: "nova", about: "the render" });
    first.stop();
    const second = service(path);
    await second.resume();
    expect(second.list("nova", false).map((open) => open.id)).toEqual([request.id]);
    writeRun("r1", "done");
    clock.advance(1_000);
    expect(rings()).toHaveLength(1);
  });
});
