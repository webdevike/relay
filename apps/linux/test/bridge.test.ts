import { describe, expect, it } from "vitest";
import { accountLabel } from "@relay/protocol";
import { OmpBridgeProvider } from "../src/agents/bridge";
import { AgentsDeltaTracker } from "../src/agents/delta-tracker";

/** Feeds extension frames straight into the provider, past the unix socket. */
function connect(provider: OmpBridgeProvider): (frame: object) => void {
  const connection = { socket: null, buffer: "", outbound: null, session: null, sessionFile: null, pending: new Map(), gate: undefined };
  const inner = provider as unknown as { connections: Set<unknown>; receive(connection: unknown, chunk: Uint8Array): void };
  inner.connections.add(connection);
  return (frame) => {
    inner.receive(connection, Buffer.from(`${JSON.stringify(frame)}\n`));
  };
}

const hello = { t: "hello", sessionId: "s1", provider: "omp", title: "Eva", projectPath: "/Users/ike/Eva", status: "idle", lastActivity: "", lastActivityAt: 1, canRespond: true };

describe("session account", () => {
  it("passes the hello frame's profile through and keeps it when a status omits it", () => {
    const logs: string[] = [];
    const provider = new OmpBridgeProvider("/unused.sock", (line) => logs.push(line), null);
    const send = connect(provider);
    send({ ...hello, account: { profile: "personal" } });
    expect(provider.sessions[0]?.account).toEqual({ profile: "personal" });
    expect(logs.at(-1)).toContain("on personal");

    send({ t: "status", status: "working", lastActivity: "", lastActivityAt: 2, account: { profile: "personal", email: "ikey2244@gmail.com" } });
    expect(provider.sessions[0]?.account).toEqual({ profile: "personal", email: "ikey2244@gmail.com" });

    send({ t: "status", status: "idle", lastActivity: "", lastActivityAt: 3 });
    expect(provider.sessions[0]?.account?.email).toBe("ikey2244@gmail.com");
  });

  it("labels the current profile as Work", () => {
    expect(accountLabel({ profile: "current", email: "iweber@ecardsystems.com" })).toBe("Work · iweber@ecardsystems.com");
    expect(accountLabel({ profile: "work" })).toBe("Work");
    expect(accountLabel({ profile: "personal", email: "ikey2244@gmail.com" })).toBe("Personal · ikey2244@gmail.com");
  });
});

describe("session activity", () => {
  const job = { id: "bg_1", type: "bash", label: "bun test --watch", state: "running", startedAt: 5 };

  it("passes background jobs and the handoff flag through, and drops them when a status omits them", () => {
    const logs: string[] = [];
    const provider = new OmpBridgeProvider("/unused.sock", (line) => logs.push(line), null);
    const send = connect(provider);
    send({ ...hello, backgroundJobs: [job], handingOff: true });
    expect(provider.sessions[0]?.backgroundJobs).toEqual([job]);
    expect(provider.sessions[0]?.handingOff).toBe(true);

    send({ t: "status", status: "working", lastActivity: "", lastActivityAt: 2, backgroundJobs: [{ ...job, state: "done" }] });
    expect(provider.sessions[0]?.backgroundJobs?.[0]?.state).toBe("done");
    expect(provider.sessions[0]?.handingOff).toBeUndefined();

    send({ t: "status", status: "idle", lastActivity: "", lastActivityAt: 3 });
    expect(provider.sessions[0]?.backgroundJobs).toBeUndefined();
  });

  it("drops a status whose job is malformed", () => {
    const logs: string[] = [];
    const provider = new OmpBridgeProvider("/unused.sock", (line) => logs.push(line), null);
    const send = connect(provider);
    send(hello);
    send({ t: "status", status: "working", lastActivity: "", lastActivityAt: 2, backgroundJobs: [{ ...job, state: "paused" }] });
    expect(provider.sessions[0]?.status).toBe("idle");
    expect(logs.at(-1)).toContain("malformed frame");
  });

  it("publishes a delta when only the jobs or the handoff flag change", () => {
    const tracker = new AgentsDeltaTracker();
    const base = { id: "s1", provider: "omp", title: "Eva", projectPath: "/p", status: "working" as const, lastActivity: "", lastActivityAt: 1, canRespond: true };
    tracker.seed([base]);
    expect(tracker.apply([{ ...base, handingOff: true }])).toMatchObject({ upsert: [{ handingOff: true }] });
    expect(tracker.apply([{ ...base, handingOff: true }])).not.toHaveProperty("upsert");
    const running = { ...job, state: "running" as const };
    expect(tracker.apply([{ ...base, handingOff: true, backgroundJobs: [running] }])).toHaveProperty("upsert");
    expect(tracker.apply([{ ...base, handingOff: true, backgroundJobs: [{ ...running, state: "done" as const }] }])).toHaveProperty("upsert");
  });

  it("passes the goal through, follows it on every status, and publishes when only it changes", () => {
    const provider = new OmpBridgeProvider("/unused.sock", () => undefined, null);
    const send = connect(provider);
    const goal = { objective: "ship the strip", paused: false, tokensUsed: 1200 };
    send({ ...hello, goal });
    expect(provider.sessions[0]?.goal).toEqual(goal);
    send({ t: "status", status: "working", lastActivity: "", lastActivityAt: 2, goal: { ...goal, paused: true } });
    expect(provider.sessions[0]?.goal?.paused).toBe(true);
    // Met or dropped: the extension stops sending it.
    send({ t: "status", status: "idle", lastActivity: "", lastActivityAt: 3 });
    expect(provider.sessions[0]?.goal).toBeUndefined();

    const tracker = new AgentsDeltaTracker();
    const base = { id: "s1", provider: "omp", title: "Eva", projectPath: "/p", status: "working" as const, lastActivity: "", lastActivityAt: 1, canRespond: true };
    tracker.seed([base]);
    expect(tracker.apply([{ ...base, goal }])).toMatchObject({ upsert: [{ goal }] });
    expect(tracker.apply([{ ...base, goal }])).not.toHaveProperty("upsert");
    expect(tracker.apply([{ ...base, goal: { ...goal, tokensUsed: 5000 } }])).toHaveProperty("upsert");
    expect(tracker.apply([base])).toHaveProperty("upsert");
  });
});
