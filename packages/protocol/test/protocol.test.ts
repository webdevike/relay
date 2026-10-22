import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import client from "../fixtures/client-messages.json";
import server from "../fixtures/server-messages.json";
import { MAX_CALL_AUDIO_BASE64, MAX_SIGNIN_FIELD, authProof, fromHex, hmacSha256, parseClientMessage, parseServerMessage, toHex } from "../src";

const sha256 = (d: Uint8Array) => webcrypto.subtle.digest("SHA-256", d);

describe("fixtures", () => {
  it("every client fixture parses and round-trips", () => {
    for (const m of client) {
      const r = parseClientMessage(JSON.stringify(m));
      expect(r.ok, JSON.stringify(m)).toBe(true);
      if (r.ok) expect(r.value).toEqual(m);
    }
  });
  it("every server fixture parses and round-trips", () => {
    for (const m of server) {
      const r = parseServerMessage(JSON.stringify(m));
      expect(r.ok, JSON.stringify(m)).toBe(true);
      if (r.ok) expect(r.value).toEqual(m);
    }
  });
});

describe("rejections", () => {
  it("rejects wrong protocol version, malformed pin, empty input batch, and cross-direction frames", () => {
    expect(parseClientMessage(JSON.stringify({ t: "hello", v: 2, deviceId: "d", deviceName: "n", platform: "ios" })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: "pair.confirm", pin: "12345" })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: "input", events: [] })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: "welcome" })).ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ t: "cmd", id: "x", cmd: { kind: "key.press", key: "return" } })).ok).toBe(false);
    expect(parseServerMessage("{not json").ok).toBe(false);
  });
});

describe("agent sessions", () => {
  const base = { id: "s", provider: "omp", title: "t", projectPath: "/p", status: "working", lastActivity: "", lastActivityAt: 1, canRespond: true };
  it("carries a subagent's parentId, stays valid without one, and rejects an empty one", () => {
    const frame = (session: object) => JSON.stringify({ t: "agents.snapshot", rev: 1, sessions: [session] });
    const child = parseServerMessage(frame({ ...base, id: "Worker", parentId: "s" }));
    expect(child.ok && child.value.t === "agents.snapshot" ? child.value.sessions[0]?.parentId : undefined).toBe("s");
    const top = parseServerMessage(frame(base));
    expect(top.ok && top.value.t === "agents.snapshot" ? top.value.sessions[0]?.parentId : "missing").toBeUndefined();
    expect(parseServerMessage(frame({ ...base, parentId: "" })).ok).toBe(false);
  });
  it("accepts the assistant kind with its registry id, and rejects an unknown kind or a malformed id", () => {
    const frame = (session: object) => JSON.stringify({ t: "agents.snapshot", rev: 1, sessions: [session] });
    const nova = parseServerMessage(frame({ ...base, id: "nova-1", title: "Nova", kind: "assistant", assistant: "nova" }));
    expect(nova.ok && nova.value.t === "agents.snapshot" ? [nova.value.sessions[0]?.kind, nova.value.sessions[0]?.assistant] : undefined).toEqual(["assistant", "nova"]);
    expect(parseServerMessage(frame({ ...base, kind: "robot" })).ok).toBe(false);
    expect(parseServerMessage(frame({ ...base, kind: "assistant", assistant: "Nova" })).ok).toBe(false);
  });
});

describe("assistant agents", () => {
  it("addresses get, turn and signin to an optional agent id, and lists the agents", () => {
    expect(parseClientMessage(JSON.stringify({ t: "assistant.get" })).ok).toBe(true);
    const get = parseClientMessage(JSON.stringify({ t: "assistant.get", agent: "nova" }));
    expect(get.ok && get.value.t === "assistant.get" ? get.value.agent : undefined).toBe("nova");
    expect(parseClientMessage(JSON.stringify({ t: "assistant.get", agent: "" })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: "assistant.get", agent: "9lives" })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: "cmd", id: "c", cmd: { kind: "assistant.turn", agent: "astra", text: "hi" } })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ t: "cmd", id: "c", cmd: { kind: "assistant.turn", agent: "Astra", text: "hi" } })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: "assistant.agents" })).ok).toBe(true);
    const list = parseServerMessage(JSON.stringify({ t: "assistant.agents", agents: [{ id: "astra", title: "Astra" }, { id: "nova", title: "Nova" }] }));
    expect(list.ok && list.value.t === "assistant.agents" ? list.value.agents.map((agent) => agent.id) : []).toEqual(["astra", "nova"]);
    expect(parseServerMessage(JSON.stringify({ t: "assistant.agents", agents: [{ id: "astra", title: "" }] })).ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ t: "assistant.snapshot", snapshot: { rev: 0, busy: false, sessionId: "", messages: [] } })).ok).toBe(false);
  });

  it("carries scope, status and last reply per agent, all optional, and rejects an unknown status", () => {
    const parse = (agent: object) => parseServerMessage(JSON.stringify({ t: "assistant.agents", agents: [{ id: "astra", title: "Astra", ...agent }] }));
    const rich = parse({ scope: "eCard Systems work", status: "working", lastReply: { text: "On it.", at: 5 } });
    expect(rich.ok && rich.value.t === "assistant.agents" ? rich.value.agents[0] : undefined).toEqual({ id: "astra", title: "Astra", scope: "eCard Systems work", status: "working", lastReply: { text: "On it.", at: 5 } });
    for (const status of ["working", "needs_you", "idle", "not_started"]) expect(parse({ status }).ok, status).toBe(true);
    expect(parse({}).ok).toBe(true);
    expect(parse({ status: "busy" }).ok).toBe(false);
    expect(parse({ lastReply: { text: "x" } }).ok).toBe(false);
  });
});

describe("assistant thread", () => {
  it("assistant.turn needs text or images, assistant.snapshot carries every role", () => {
    const turn = (cmd: object) => parseClientMessage(JSON.stringify({ t: "cmd", id: "c", cmd: { kind: "assistant.turn", ...cmd } })).ok;
    expect(turn({ text: "  " })).toBe(true); // the host nacks an empty turn; the wire shape allows it for image turns
    expect(turn({ text: "", images: [{ mimeType: "image/png", data: "AAAA" }] })).toBe(true);
    expect(turn({ text: "hi", images: [] })).toBe(false);
    expect(turn({ text: "hi", images: Array.from({ length: 5 }, () => ({ mimeType: "image/png", data: "AAAA" })) })).toBe(false);
    expect(turn({ text: "hi", images: [{ mimeType: "image/gif", data: "AAAA" }] })).toBe(false);
    const messages = ["user", "assistant", "card", "status", "error"].map((role, i) => ({ id: `m-${i}`, role, text: role, at: i + 1 }));
    const r = parseServerMessage(JSON.stringify({ t: "assistant.snapshot", agent: "astra", snapshot: { rev: 2, busy: true, sessionId: "eva-1", messages } }));
    expect(r.ok && r.value.t === "assistant.snapshot" ? r.value.snapshot.messages.length : 0).toBe(5);
    const withImages = parseServerMessage(
      JSON.stringify({ t: "assistant.snapshot", agent: "astra", snapshot: { rev: 2, busy: false, sessionId: "eva-1", messages: [{ id: "m", role: "assistant", text: "", at: 1, images: [{ id: "i1", mimeType: "image/png" }] }] } }),
    );
    expect(withImages.ok && withImages.value.t === "assistant.snapshot" ? withImages.value.snapshot.messages[0]?.images?.[0]?.id : undefined).toBe("i1");
    expect(parseServerMessage(JSON.stringify({ t: "assistant.snapshot", agent: "astra", snapshot: { rev: 2, busy: false, messages: [] } })).ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ t: "assistant.snapshot", agent: "astra", snapshot: { rev: -1, busy: false, sessionId: "", messages: [] } })).ok).toBe(false);
  });
  it("assistant.signin carries credentials, and a message may carry a signin handoff", () => {
    const signin = (cmd: object) => parseClientMessage(JSON.stringify({ t: "cmd", id: "c", cmd: { kind: "assistant.signin", messageId: "m1", url: "https://github.com/login", username: "isaac", password: "pw", ...cmd } })).ok;
    expect(signin({})).toBe(true);
    expect(signin({ password: "" })).toBe(false);
    expect(signin({ password: "x".repeat(MAX_SIGNIN_FIELD + 1) })).toBe(false);
    expect(signin({ messageId: "" })).toBe(false);
    expect(signin({ url: undefined })).toBe(false);
    const frame = (message: object) => parseServerMessage(JSON.stringify({ t: "assistant.snapshot", agent: "astra", snapshot: { rev: 1, busy: false, sessionId: "eva-1", messages: [{ id: "m", role: "assistant", text: "Sign in", at: 1, ...message }] } }));
    const parsed = frame({ signin: { url: "https://github.com/login", host: "github.com" } });
    expect(parsed.ok && parsed.value.t === "assistant.snapshot" ? parsed.value.snapshot.messages[0]?.signin : null).toEqual({ url: "https://github.com/login", host: "github.com" });
    expect(frame({ signin: { url: "https://github.com/login", host: "github.com", submitted: true } }).ok).toBe(true);
    expect(frame({ signin: { url: "https://github.com/login" } }).ok).toBe(false);
  });
});

describe("hmac", () => {
  it("matches RFC 4231 test case 2", async () => {
    const mac = await hmacSha256(new TextEncoder().encode("Jefe"), new TextEncoder().encode("what do ya want for nothing?"), sha256);
    expect(toHex(mac)).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });
  it("authProof is deterministic and keyed", async () => {
    const secret = toHex(new Uint8Array(32).fill(7));
    const a = await authProof(secret, "nonce-1", sha256);
    expect(a).toBe(await authProof(secret, "nonce-1", sha256));
    expect(a).not.toBe(await authProof(secret, "nonce-2", sha256));
    expect(a).not.toBe(await authProof(toHex(new Uint8Array(32).fill(8)), "nonce-1", sha256));
  });
  it("hex helpers reject odd or non-hex input", () => {
    expect(() => fromHex("abc")).toThrow();
    expect(() => fromHex("zz")).toThrow();
    expect(toHex(fromHex("00ff10"))).toBe("00ff10");
  });
});

describe("habit gate", () => {
  const status = {
    locked: true,
    blocked: true,
    reason: "planned break",
    active: { kind: "habit", id: "draw", startedAt: "2026-10-13T15:00:00.000Z", endsAt: "2026-10-13T15:10:00.000Z" },
    habits: [{ id: "draw", name: "Draw", minutes: 10, photo: true }],
    tasks: [{ id: "taxes", name: "File taxes", minutes: null, done: false }],
    canFinish: false,
    remainingSeconds: 420,
    plan: { date: "2026-10-13", breaks: [{ at: "2026-10-13T15:00:00.000Z", done: false }], source: "calendar" },
  };
  it("carries the CLI status and drops fields the phone does not use", () => {
    const parsed = parseServerMessage(JSON.stringify({ t: "gate.status", gate: { ...status, history: [{ id: "walk" }], lockedAt: "x" } }));
    expect(parsed.ok && parsed.value.t === "gate.status" ? parsed.value.gate : null).toEqual(status);
    expect(parseServerMessage(JSON.stringify({ t: "gate.status", gate: null })).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify({ t: "gate.status", gate: { ...status, active: { kind: "chore", id: "x", startedAt: "a", endsAt: "b" } } })).ok).toBe(false);
  });
  it("takes start, done with an optional photo, and override with a reason", () => {
    const cmd = (body: object) => JSON.stringify({ t: "cmd", id: "c", cmd: body });
    expect(parseClientMessage(cmd({ kind: "gate.start", id: "walk" })).ok).toBe(true);
    expect(parseClientMessage(cmd({ kind: "gate.done", id: "walk" })).ok).toBe(true);
    expect(parseClientMessage(cmd({ kind: "gate.done", id: "draw", photo: { mimeType: "image/jpeg", data: "AAAA" } })).ok).toBe(true);
    expect(parseClientMessage(cmd({ kind: "gate.override", reason: "on call" })).ok).toBe(true);
    expect(parseClientMessage(cmd({ kind: "gate.override", reason: "   " })).ok).toBe(false);
    expect(parseClientMessage(cmd({ kind: "gate.start", id: "" })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: "gate.get" })).ok).toBe(true);
  });
});

describe("tool approvals", () => {
  const approval = { id: "call-1", toolName: "bash", command: "git push --force", destructive: "force push", requiresBiometric: true };

  it("approve and deny commands parse, confirmation optional", () => {
    for (const cmd of [
      { kind: "agent.approve", sessionId: "s-1", approvalId: "call-1", confirmed: "biometric" },
      { kind: "agent.approve", sessionId: "s-1", approvalId: "call-1" },
      { kind: "agent.deny", sessionId: "s-1", approvalId: "call-1" },
    ]) {
      const r = parseClientMessage(JSON.stringify({ t: "cmd", id: "c-1", cmd }));
      expect(r.ok, JSON.stringify(cmd)).toBe(true);
    }
    expect(parseClientMessage(JSON.stringify({ t: "cmd", id: "c-1", cmd: { kind: "agent.approve", sessionId: "s-1", approvalId: "call-1", confirmed: "yes" } })).ok).toBe(false);
  });

  it("approval frames round-trip", () => {
    for (const m of [
      { t: "agent.approval", sessionId: "s-1", approval },
      { t: "agent.approval.resolved", sessionId: "s-1", id: "call-1" },
      { t: "nack", id: "c-1", error: { code: "biometric_required", message: "needs Face ID" } },
    ]) {
      const r = parseServerMessage(JSON.stringify(m));
      expect(r.ok, JSON.stringify(m)).toBe(true);
      if (r.ok) expect(r.value).toEqual(m);
    }
  });
});

describe("inbox frames", () => {
  const approval = { id: "call-1", toolName: "bash", command: "git push --force", destructive: "force push", requiresBiometric: true };
  const items = [
    { id: "approval:call-1", kind: "approval", sessionId: "s-1", title: "ENG-6243 needs approval", body: "git push --force", at: 1, approval },
    { id: "ask:a-1", kind: "ask", sessionId: "s-1", title: "ENG-6227 asked you", body: "Apply both nits?", at: 2, more: 1, ask: { id: "a-1", questionId: "q-1", question: "Apply both nits?", options: ["Yes", "No"] } },
    { id: "gate:2026-10-14", kind: "alert", title: "Break due", body: "Walk", at: 3, silent: true },
    { id: "digest:4", kind: "alert", title: "Morning digest", body: "2 need you, 5 updates", at: 4, passive: true },
  ];

  it("inbox.item and inbox.resolve round-trip both ways", () => {
    for (const item of items) {
      for (const parse of [parseClientMessage, parseServerMessage]) {
        const r = parse(JSON.stringify({ t: "inbox.item", item }));
        expect(r.ok, item.id).toBe(true);
        if (r.ok) expect(r.value).toEqual({ t: "inbox.item", item });
      }
    }
    for (const frame of [
      { t: "inbox.resolve", id: "approval:call-1", by: "phone", answer: "Approved" },
      { t: "inbox.resolve", id: "ask:a-1", by: "mac" },
    ]) {
      for (const parse of [parseClientMessage, parseServerMessage]) {
        const r = parse(JSON.stringify(frame));
        expect(r.ok, JSON.stringify(frame)).toBe(true);
        if (r.ok) expect(r.value).toEqual(frame);
      }
    }
  });

  it("rejects an approval item with no approval, an ask with five options or none, and an unknown resolver", () => {
    expect(parseClientMessage(JSON.stringify({ t: "inbox.item", item: { id: "approval:x", kind: "approval", title: "t", body: "b", at: 1 } })).ok).toBe(false);
    const ask = (options: string[]) => ({ id: "ask:x", kind: "ask", title: "t", body: "b", at: 1, ask: { id: "x", questionId: "q", question: "?", options } });
    expect(parseClientMessage(JSON.stringify({ t: "inbox.item", item: ask(["a", "b", "c", "d", "e"]) })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: "inbox.item", item: ask([]) })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: "inbox.resolve", id: "x", by: "watch" })).ok).toBe(false);
  });
});

describe("call frames", () => {
  const roundTrip = (parse: typeof parseClientMessage | typeof parseServerMessage, frame: object) => {
    const r = parse(JSON.stringify(frame));
    expect(r.ok, JSON.stringify(frame)).toBe(true);
    if (r.ok) expect(r.value).toEqual(frame);
  };

  it("phone frames: start, audio, mute and end round-trip", () => {
    roundTrip(parseClientMessage, { t: "call.start", callId: "c-1", agent: "astra" });
    roundTrip(parseClientMessage, { t: "call.audio", callId: "c-1", pcm: "AAAA" });
    roundTrip(parseClientMessage, { t: "call.mute", callId: "c-1", muted: true });
    roundTrip(parseClientMessage, { t: "call.end", callId: "c-1" });
  });

  it("host frames: every state, audio with its generation, and flush round-trip", () => {
    for (const state of ["connecting", "listening", "hearing", "thinking", "speaking", "ended"]) {
      roundTrip(parseServerMessage, { t: "call.state", callId: "c-1", agent: "nova", state });
    }
    roundTrip(parseServerMessage, { t: "call.state", callId: "c-1", agent: "nova", state: "thinking", text: "what time is it" });
    roundTrip(parseServerMessage, { t: "call.state", callId: "c-1", agent: "nova", state: "ended", error: "speech models unavailable" });
    roundTrip(parseServerMessage, { t: "call.audio", callId: "c-1", gen: 2, pcm: "AAAA" });
    roundTrip(parseServerMessage, { t: "call.flush", callId: "c-1", gen: 3 });
  });

  it("rejects a malformed agent, an empty or oversized frame, an unknown state, a negative generation and wrong-direction frames", () => {
    expect(parseClientMessage(JSON.stringify({ t: "call.start", callId: "c-1", agent: "Astra" })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: "call.start", callId: "", agent: "astra" })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: "call.audio", callId: "c-1", pcm: "" })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: "call.audio", callId: "c-1", pcm: "A".repeat(MAX_CALL_AUDIO_BASE64 + 1) })).ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ t: "call.state", callId: "c-1", agent: "astra", state: "ringing" })).ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ t: "call.audio", callId: "c-1", gen: -1, pcm: "AAAA" })).ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ t: "call.start", callId: "c-1", agent: "astra" })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: "call.flush", callId: "c-1", gen: 1 })).ok).toBe(false);
  });

  it("assistant rows may say they were spoken on a call", () => {
    const r = parseServerMessage(JSON.stringify({ t: "assistant.snapshot", agent: "astra", snapshot: { rev: 1, busy: false, sessionId: "s", messages: [{ id: "m", role: "user", text: "what time is it", at: 1, voice: true }] } }));
    expect(r.ok && r.value.t === "assistant.snapshot" ? r.value.snapshot.messages[0]?.voice : undefined).toBe(true);
  });
});
