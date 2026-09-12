import { describe, expect, it } from "vitest";
import type { AgentSession } from "@relay/protocol";
import { AttentionNotifier, REMINDER_MS, type PushMessage, type PushOutcome } from "../src/push/notifier";
import type { SessionClock } from "../src/session";

class FakeClock implements SessionClock {
  private timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  private current = 1_000;
  now(): number {
    return this.current;
  }
  after(ms: number, fn: () => void): () => void {
    const timer = { at: this.current + ms, fn, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }
  advance(ms: number): void {
    this.current += ms;
    const due = this.timers.filter((timer) => !timer.cancelled && timer.at <= this.current);
    this.timers = this.timers.filter((timer) => !due.includes(timer));
    for (const timer of due) timer.fn();
  }
}

class MemoryTokens {
  readonly map = new Map<string, string>();
  tokens(): ReadonlyMap<string, string> {
    return this.map;
  }
  unregister(deviceId: string): void {
    this.map.delete(deviceId);
  }
}

function session(id: string, status: AgentSession["status"], extra: Partial<AgentSession> = {}): AgentSession {
  return { id, provider: "omp", title: id, projectPath: `/p/${id}`, status, lastActivity: "asked a question", lastActivityAt: 0, canRespond: true, ...extra };
}

function harness(outcome: (message: PushMessage) => PushOutcome = () => ({ ok: true })) {
  const clock = new FakeClock();
  const tokens = new MemoryTokens();
  tokens.map.set("phone-1", "ExponentPushToken[one]");
  const sent: PushMessage[][] = [];
  const viewing = new Set<string>();
  const logs: string[] = [];
  const notifier = new AttentionNotifier({
    tokens,
    sender: {
      send: (messages) => {
        sent.push([...messages]);
        return Promise.resolve(messages.map(outcome));
      },
    },
    isViewing: (deviceId, sessionId) => viewing.has(`${deviceId}/${sessionId}`),
    clock,
    log: (line) => logs.push(line),
  });
  return { clock, tokens, sent, viewing, logs, notifier };
}

describe("AttentionNotifier", () => {
  it("pushes once when a session starts waiting, not while it keeps working", () => {
    const h = harness();
    h.notifier.seed([session("a", "working")]);
    h.notifier.observe([session("a", "working", { lastActivity: "editing" })]);
    expect(h.sent).toEqual([]);
    h.notifier.observe([session("a", "waiting")]);
    h.notifier.observe([session("a", "needs_permission", { statusDetail: "bash" })]);
    expect(h.sent).toEqual([[{ to: "ExponentPushToken[one]", title: "a", body: "asked a question", data: { sessionId: "a" } }]]);
  });

  it("does not announce sessions that were already waiting at startup", () => {
    const h = harness();
    h.notifier.seed([session("a", "waiting")]);
    h.notifier.observe([session("a", "waiting")]);
    expect(h.sent).toEqual([]);
  });

  it("describes a permission prompt with its detail", () => {
    const h = harness();
    h.notifier.observe([session("a", "needs_permission", { statusDetail: "bash: rm -rf dist" })]);
    expect(h.sent[0]?.[0]?.body).toBe("Needs permission: bash: rm -rf dist");
  });

  it("skips a phone that has the session open, and every phone when none is registered", () => {
    const h = harness();
    h.viewing.add("phone-1/a");
    h.notifier.observe([session("a", "waiting")]);
    expect(h.sent).toEqual([]);
    h.tokens.map.clear();
    h.notifier.observe([session("b", "waiting")]);
    expect(h.sent).toEqual([]);
  });

  it("reminds every REMINDER_MS while still waiting, and stops once answered or gone", () => {
    const h = harness();
    h.notifier.observe([session("a", "waiting"), session("b", "waiting")]);
    expect(h.sent).toHaveLength(2);
    h.clock.advance(REMINDER_MS);
    expect(h.sent).toHaveLength(4);
    expect(h.sent[2]?.[0]?.title).toBe("a is still waiting");
    h.notifier.observe([session("a", "working"), session("b", "waiting")]);
    h.clock.advance(REMINDER_MS);
    expect(h.sent).toHaveLength(5);
    expect(h.sent[4]?.[0]?.data.sessionId).toBe("b");
    h.notifier.observe([]);
    h.clock.advance(REMINDER_MS * 3);
    expect(h.sent).toHaveLength(5);
  });

  it("does not remind a phone that opened the session in the meantime", () => {
    const h = harness();
    h.notifier.observe([session("a", "waiting")]);
    h.viewing.add("phone-1/a");
    h.clock.advance(REMINDER_MS);
    expect(h.sent).toHaveLength(1);
  });

  it("drops a token the push service reports as unregistered", async () => {
    const h = harness(() => ({ ok: false, error: "gone", unregistered: true }));
    h.notifier.observe([session("a", "waiting")]);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.tokens.map.size).toBe(0);
    expect(h.logs).toEqual(["push to phone-1 failed: gone"]);
  });
});
