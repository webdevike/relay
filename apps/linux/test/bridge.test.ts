import { describe, expect, it, vi } from "vitest";
import { accountLabel } from "@relay/protocol";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { OmpBridgeProvider, otherHostServing } from "../src/agents/bridge";
import { AgentsDeltaTracker } from "../src/agents/delta-tracker";

/** Feeds extension frames straight into the provider, past the unix socket. */
function connect(provider: OmpBridgeProvider): (frame: object) => void {
  return link(provider).send;
}

/** `connect`, plus what the host wrote to this socket and a way to close it as the omp exiting would. */
function link(provider: OmpBridgeProvider): { send: (frame: object) => void; written: () => Record<string, unknown>[]; close: () => void } {
  const written: string[] = [];
  const socket = {
    write: (bytes: Uint8Array) => {
      written.push(Buffer.from(bytes).toString("utf8"));
      return bytes.length;
    },
    end: () => undefined,
  };
  const connection = { socket, buffer: "", outbound: null, session: null, sessionFile: null, pending: new Map(), gate: undefined, pid: null, herdrPane: null, retired: false, gone: Promise.withResolvers<void>() };
  const inner = provider as unknown as { connections: Set<unknown>; receive(connection: unknown, chunk: Uint8Array): void; drop(connection: unknown): void };
  inner.connections.add(connection);
  return {
    send: (frame) => {
      inner.receive(connection, Buffer.from(`${JSON.stringify(frame)}\n`));
    },
    written: () => written.join("").split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>),
    close: () => {
      inner.drop(connection);
    },
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

describe("ask resolves", () => {
  it("reports answered from the extension's flag, else whether a device answered it through this host", async () => {
    const provider = new OmpBridgeProvider("/unused.sock", () => undefined, null);
    const resolved: [string, boolean][] = [];
    provider.onChange = (change) => {
      if (change.kind === "ask.resolved") resolved.push([change.id, change.answered]);
    };
    const { send, written } = link(provider);
    send(hello);
    send({ t: "ask.request", id: "k1", questions: [{ id: "q1", question: "Ship it?", options: [{ label: "Yes" }] }] });
    send({ t: "ask.resolved", id: "k1", answered: false });
    // An older extension sends no flag: answered only when a device answered it here.
    send({ t: "ask.resolved", id: "k2" });
    const answering = provider.answerAsk("s1", "k3", [{ id: "q1", selectedOptions: ["Yes"] }]);
    send({ t: "result", id: written().at(-1)?.["id"], ok: true });
    await answering;
    send({ t: "ask.resolved", id: "k3" });
    send({ t: "ask.resolved", id: "k4", answered: true });
    expect(resolved).toEqual([
      ["k1", false],
      ["k2", false],
      ["k3", true],
      ["k4", true],
    ]);
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

describe("another host on the bridge socket", () => {
  const socketPath = (): string => join(mkdtempSync(join(tmpdir(), "bridge-pid-")), "agents.sock");

  it("is a live relay host whose pid file sits beside the socket; a gone, own or unrelated pid is not", () => {
    const socket = socketPath();
    expect(otherHostServing(socket)).toBeNull();
    writeFileSync(`${socket}.pid`, String(process.pid));
    expect(otherHostServing(socket)).toBeNull();
    // A process that looks like a host: its command line has `serve`.
    const host = spawn("sleep", ["30"], { argv0: "relay-host serve" });
    try {
      writeFileSync(`${socket}.pid`, String(host.pid));
      expect(otherHostServing(socket)).toBe(host.pid);
    } finally {
      host.kill();
    }
    writeFileSync(`${socket}.pid`, String(host.pid));
    return new Promise<void>((resolve) => {
      host.once("exit", () => {
        expect(otherHostServing(socket)).toBeNull();
        resolve();
      });
    });
  });

  it("ignores a live pid that is some other program", () => {
    const socket = socketPath();
    const other = spawn("sleep", ["30"]);
    try {
      writeFileSync(`${socket}.pid`, String(other.pid));
      expect(otherHostServing(socket)).toBeNull();
    } finally {
      other.kill();
    }
  });
});

describe("one omp per transcript", () => {
  const file = "/Users/a/.omp/agent/sessions/-Relay/x_s1.jsonl";
  const thread = { ...hello, title: "Relay", kind: "assistant", assistant: "relay", sessionFile: file };
  const copy = { ...hello, title: "Initialize Relay thread memory", kind: "manual", sessionFile: file };

  function setup() {
    const logs: string[] = [];
    const closed: string[] = [];
    const provider = new OmpBridgeProvider("/unused.sock", (line) => logs.push(line), null, (pane) => {
      closed.push(pane);
      return Promise.resolve();
    });
    let published = 0;
    provider.onChange = (change) => {
      if (change.kind === "sessions") published += 1;
    };
    return { provider, logs, closed, published: () => published };
  }

  it("closes the pane of an untagged copy when the assistant thread registers on the same transcript, and lists only the thread", () => {
    const h = setup();
    const restored = link(h.provider);
    restored.send({ ...copy, pid: 720, herdrPane: "w1:p1" });
    expect(h.provider.sessions.map((s) => s.kind)).toEqual(["manual"]);
    const resumed = link(h.provider);
    resumed.send({ ...thread, pid: 961, herdrPane: "w2:p1" });
    expect(h.closed).toEqual(["w1:p1"]);
    expect(h.provider.sessions).toHaveLength(1);
    expect(h.provider.sessions[0]).toMatchObject({ id: "s1", kind: "assistant", assistant: "relay" });
    expect(h.provider.sessionForFile(file)?.kind).toBe("assistant");
    // The closed copy's last words change nothing, and its exit is quiet.
    const before = h.published();
    restored.send({ t: "status", status: "idle", lastActivity: "", lastActivityAt: 9 });
    restored.close();
    expect(h.published()).toBe(before);
    expect(h.provider.sessions[0]?.kind).toBe("assistant");
    expect(h.logs.filter((line) => line.includes("ended"))).toEqual([]);
  });

  it("keeps the omp already on the transcript and closes a second one, rather than trading them every reconnect", () => {
    const h = setup();
    link(h.provider).send({ ...thread, pid: 720, herdrPane: "w1:p1" });
    const second = link(h.provider);
    second.send({ ...thread, pid: 961, herdrPane: "w2:p1" });
    expect(h.closed).toEqual(["w2:p1"]);
    expect(h.provider.sessions).toHaveLength(1);
    // It reconnecting before it exits does not take the session over either.
    link(h.provider).send({ ...thread, pid: 961, herdrPane: "w2:p1" });
    expect(h.provider.sessions).toHaveLength(1);
    expect(h.logs.filter((line) => line.includes("closing omp"))).toHaveLength(2);
  });

  it("lets the same omp reconnect over its old socket, as before", () => {
    const h = setup();
    link(h.provider).send({ ...thread, pid: 720 });
    link(h.provider).send({ ...thread, pid: 720 });
    link(h.provider).send(thread);
    expect(h.closed).toEqual([]);
    expect(h.provider.sessions).toHaveLength(1);
  });

  it("close() shuts a session's omp through its pane, else through its bridge, and unlists it at once", async () => {
    const h = setup();
    const inPane = link(h.provider);
    inPane.send({ ...copy, pid: 720, herdrPane: "w1:p1" });
    const closing = h.provider.close("s1");
    expect(h.provider.sessions).toEqual([]);
    inPane.close();
    await closing;
    expect(h.closed).toEqual(["w1:p1"]);

    const bare = link(h.provider);
    bare.send({ ...copy, sessionId: "s2", pid: 800 });
    const ending = h.provider.close("s2");
    expect(bare.written().map((frame) => frame["t"])).toEqual(["end"]);
    bare.close();
    await ending;
    await h.provider.close("nobody");
  });
});
