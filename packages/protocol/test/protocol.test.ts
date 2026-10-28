import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import client from "../fixtures/client-messages.json";
import server from "../fixtures/server-messages.json";
import {
  CatchUpFeed,
  CatchUpItem,
  MAX_CALL_AUDIO_BASE64,
  MAX_LIVE_SDP,
  MAX_SIGNIN_FIELD,
  QUICK_REACTIONS,
  ReactionEmoji,
  assistantReactionThread,
  authProof,
  fromHex,
  hmacSha256,
  parseClientMessage,
  parseServerMessage,
  reactionExcerpt,
  reactionKey,
  reactionRole,
  sessionReactionThread,
  toHex,
  toggleReaction,
} from "../src";

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
  it("carries background jobs and the handoff flag, and rejects an unknown job state or an empty label", () => {
    const frame = (session: object) => JSON.stringify({ t: "agents.snapshot", rev: 1, sessions: [session] });
    const job = { id: "bg_3", type: "bash", label: "bun test --watch", state: "running", startedAt: 1 };
    const busy = parseServerMessage(frame({ ...base, backgroundJobs: [job, { ...job, id: "bg_4", state: "failed" }], handingOff: true }));
    expect(busy.ok && busy.value.t === "agents.snapshot" ? busy.value.sessions[0]?.backgroundJobs?.map((j) => j.state) : undefined).toEqual(["running", "failed"]);
    expect(busy.ok && busy.value.t === "agents.snapshot" ? busy.value.sessions[0]?.handingOff : undefined).toBe(true);
    const quiet = parseServerMessage(frame(base));
    expect(quiet.ok && quiet.value.t === "agents.snapshot" ? [quiet.value.sessions[0]?.backgroundJobs, quiet.value.sessions[0]?.handingOff] : "missing").toEqual([undefined, undefined]);
    expect(parseServerMessage(frame({ ...base, backgroundJobs: [{ ...job, state: "paused" }] })).ok).toBe(false);
    expect(parseServerMessage(frame({ ...base, backgroundJobs: [{ ...job, label: "" }] })).ok).toBe(false);
  });
  it("carries the session's goal, and rejects an empty objective or fractional tokens", () => {
    const frame = (session: object) => JSON.stringify({ t: "agents.snapshot", rev: 1, sessions: [session] });
    const goal = { objective: "ship the goal strip", paused: true, tokensUsed: 12_000 };
    const set = parseServerMessage(frame({ ...base, goal }));
    expect(set.ok && set.value.t === "agents.snapshot" ? set.value.sessions[0]?.goal : undefined).toEqual(goal);
    const none = parseServerMessage(frame(base));
    expect(none.ok && none.value.t === "agents.snapshot" ? none.value.sessions[0]?.goal : "missing").toBeUndefined();
    expect(parseServerMessage(frame({ ...base, goal: { ...goal, objective: "" } })).ok).toBe(false);
    expect(parseServerMessage(frame({ ...base, goal: { ...goal, tokensUsed: 1.5 } })).ok).toBe(false);
  });
});

describe("agent options", () => {
  it("carries a skill's argument hint on entries and subcommands, and stays valid without one", () => {
    const options = {
      t: "agent.options",
      sessionId: "s",
      models: [],
      skills: [
        { name: "handoff", description: "Hand off", command: "/handoff", takesText: true, hint: "[focus instructions]" },
        {
          name: "goal",
          description: "Goal mode",
          command: "/goal",
          takesText: true,
          choices: [{ name: "set", description: "Set the goal", command: "/goal set", takesText: true, hint: "<objective>" }],
        },
        { name: "review", description: "", command: "/review", takesText: true },
      ],
    };
    const parsed = parseServerMessage(JSON.stringify(options));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.t !== "agent.options") return;
    expect(parsed.value.skills.map((skill) => skill.hint)).toEqual(["[focus instructions]", undefined, undefined]);
    expect(parsed.value.skills[1]?.choices?.[0]?.hint).toBe("<objective>");
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

  it("carries a designed portrait beside the seed, and drops one it cannot read rather than the agent", () => {
    const first = (agent: object) => {
      const list = parseServerMessage(JSON.stringify({ t: "assistant.agents", agents: [{ id: "nova", title: "Nova", avatar: "nova-17", ...agent }] }));
      return list.ok && list.value.t === "assistant.agents" ? list.value.agents[0] : undefined;
    };
    const portrait = { style: "micah", seed: "nova-17", options: { glasses: ["round"], glassesProbability: 100 }, colors: { paper: "#e7f5ff", accent: "#f76707" } };
    expect(first({ portrait })).toEqual({ id: "nova", title: "Nova", avatar: "nova-17", portrait });
    expect(first({ portrait: { style: "pixel-art", seed: "nova-17" } })).toEqual({ id: "nova", title: "Nova", avatar: "nova-17" });
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
  it("a message may carry two to four short replies", () => {
    const frame = (replies: unknown) => parseServerMessage(JSON.stringify({ t: "assistant.snapshot", agent: "nova", snapshot: { rev: 1, busy: false, sessionId: "s", messages: [{ id: "m", role: "assistant", text: "Push it?", at: 1, replies }] } }));
    const parsed = frame(["Yes, push it", "Not yet"]);
    expect(parsed.ok && parsed.value.t === "assistant.snapshot" ? parsed.value.snapshot.messages[0]?.replies : null).toEqual(["Yes, push it", "Not yet"]);
    expect(frame(["a", "b", "c", "d"]).ok).toBe(true);
    expect(frame(["x".repeat(24), "b"]).ok).toBe(true);
    expect(frame(["only one"]).ok).toBe(false);
    expect(frame(["a", "b", "c", "d", "e"]).ok).toBe(false);
    expect(frame(["x".repeat(25), "b"]).ok).toBe(false);
    expect(frame(["", "b"]).ok).toBe(false);
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

describe("catch up", () => {
  const item = { id: "slack:abc123", source: "slack", label: "#release-management", title: "Todd asked about the release", body: "**Todd** · can you check?", url: "https://ecardplatform.slack.com/archives/C1/p1", ts: "2026-10-23T18:58:00Z", importance: 3 };

  it("lists and marks", () => {
    expect(parseClientMessage(JSON.stringify({ t: "catchup.list" })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ t: "catchup.mark", id: "slack:abc123", read: true })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ t: "catchup.mark", id: "slack:abc123", read: false })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ t: "catchup.mark", id: "", read: true })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: "catchup.mark", id: "x" })).ok).toBe(false);
  });

  it("snapshot carries cards with read state and the unread count", () => {
    const frame = { t: "catchup.snapshot", items: [{ ...item, read: false }, { ...item, id: "work:ENG-1", source: "work", url: undefined, read: true }], unreadCount: 1 };
    const parsed = parseServerMessage(JSON.stringify(frame));
    expect(parsed.ok && parsed.value.t === "catchup.snapshot" ? parsed.value.unreadCount : null).toBe(1);
    expect(parseServerMessage(JSON.stringify({ t: "catchup.snapshot", items: [], unreadCount: 0 })).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify({ ...frame, unreadCount: -1 })).ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ ...frame, items: [item] })).ok).toBe(false); // read missing
  });

  it("feed items need a known source, ISO time, importance 1-3 and an http(s) url", () => {
    expect(CatchUpFeed.safeParse({ items: [item] }).success).toBe(true);
    expect(CatchUpItem.safeParse({ ...item, url: undefined }).success).toBe(true);
    expect(CatchUpItem.safeParse({ ...item, ts: "2026-10-23T18:58:00.000-04:00" }).success).toBe(true);
    expect(CatchUpItem.safeParse({ ...item, source: "gmail" }).success).toBe(false);
    expect(CatchUpItem.safeParse({ ...item, ts: "yesterday" }).success).toBe(false);
    expect(CatchUpItem.safeParse({ ...item, importance: 4 }).success).toBe(false);
    expect(CatchUpItem.safeParse({ ...item, importance: 0 }).success).toBe(false);
    expect(CatchUpItem.safeParse({ ...item, url: "file:///Users/ike/notes.md" }).success).toBe(false);
  });

  it("hands off to an assistant with an optional note, and takes a bounce with a reason", () => {
    const client = (frame: object) => parseClientMessage(JSON.stringify(frame)).ok;
    expect(client({ t: "catchup.handoff", id: "slack:abc123", agent: "astra" })).toBe(true);
    expect(client({ t: "catchup.handoff", id: "slack:abc123", agent: "nova", note: "ask Todd first" })).toBe(true);
    expect(client({ t: "catchup.handoff", id: "slack:abc123", agent: "Astra" })).toBe(false);
    expect(client({ t: "catchup.handoff", id: "slack:abc123" })).toBe(false);
    expect(client({ t: "catchup.handoff", id: "slack:abc123", agent: "astra", note: "x".repeat(2001) })).toBe(false);
    expect(client({ t: "catchup.bounce", id: "slack:abc123", agent: "astra", reason: "personal, not eCard" })).toBe(true);
    expect(client({ t: "catchup.bounce", id: "slack:abc123", agent: "astra", reason: "  " })).toBe(false);
  });

  it("cards carry the default assistant, who they were handed to and a bounce", () => {
    expect(CatchUpItem.safeParse({ ...item, assistant: "astra" }).success).toBe(true);
    const card = { ...item, assistant: "astra", read: false, bounce: { agent: "astra", reason: "needs your decision", at: "2026-10-25T12:00:00.000Z" } };
    expect(parseServerMessage(JSON.stringify({ t: "catchup.snapshot", items: [card, { ...item, id: "b", read: true, handedTo: "nova" }], unreadCount: 1 })).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify({ t: "catchup.snapshot", items: [{ ...card, bounce: { agent: "astra", reason: "", at: "x" } }], unreadCount: 1 })).ok).toBe(false);
  });

  it("takes a note with a signal, text or both, and answers whether it was saved", () => {
    const client = (frame: object) => parseClientMessage(JSON.stringify(frame));
    expect(client({ t: "catchup.note", id: "slack:abc123", signal: "not-actionable" }).ok).toBe(true);
    expect(client({ t: "catchup.note", id: "slack:abc123", text: "always show Todd's release asks" }).ok).toBe(true);
    expect(client({ t: "catchup.note", id: "slack:abc123", signal: "needs-me", text: "I sign off releases" }).ok).toBe(true);
    const bare = client({ t: "catchup.note", id: "slack:abc123", signal: "fyi" });
    expect(bare.ok && bare.value.t === "catchup.note" ? bare.value.text : null).toBe("");
    expect(client({ t: "catchup.note", id: "slack:abc123", signal: "noise" }).ok).toBe(false);
    expect(client({ t: "catchup.note", id: "", text: "x" }).ok).toBe(false);
    expect(client({ t: "catchup.note", id: "slack:abc123", text: "x".repeat(2001) }).ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ t: "catchup.noted", id: "slack:abc123", ok: true })).ok).toBe(true);
    expect(CatchUpItem.safeParse({ ...item, why: "Todd asked you directly", kind: "dm", workspace: "ecardplatform" }).success).toBe(true);
  });
});

describe("reactions", () => {
  const client = (frame: object) => parseClientMessage(JSON.stringify(frame)).ok;

  it("keys a bubble by role and omp timestamp, threads by assistant or session", () => {
    expect(reactionKey("assistant", 1761580800123.7)).toBe("assistant@1761580800123");
    expect(reactionRole("assistant@1")).toBe("assistant");
    expect(reactionRole("user@1")).toBe("user");
    expect(assistantReactionThread("astra")).toBe("assistant:astra");
    expect(sessionReactionThread({ id: "s1" })).toBe("session:s1");
    expect(sessionReactionThread({ id: "s1", kind: "assistant", assistant: "nova" })).toBe("assistant:nova");
    expect(sessionReactionThread({ id: "s1", kind: "manual" })).toBe("session:s1");
  });

  it("toggles: the same emoji clears, another replaces", () => {
    expect(toggleReaction(null, "👍")).toBe("👍");
    expect(toggleReaction("👍", "👍")).toBeNull();
    expect(toggleReaction("👍", "❤️")).toBe("❤️");
  });

  it("takes every quick pick and other single emoji, not text", () => {
    for (const emoji of [...QUICK_REACTIONS, "🔥", "👍🏽", "👨‍👩‍👧", "🇺🇸", "1️⃣", "🙏"]) expect(ReactionEmoji.safeParse(emoji).success, emoji).toBe(true);
    for (const bad of ["", "ok", "a👍", "👍 ", "#", "️"]) expect(ReactionEmoji.safeParse(bad).success, bad).toBe(false);
  });

  it("cuts the excerpt to one untagged line", () => {
    expect(reactionExcerpt("<surface>phone - Relay</surface>\nhello\n\n  world  ")).toBe("hello world");
    expect(reactionExcerpt("x".repeat(300))).toHaveLength(200);
  });

  it("parses get, set, clear and the snapshot", () => {
    expect(client({ t: "reactions.get", thread: "assistant:astra" })).toBe(true);
    expect(client({ t: "reactions.get", thread: "session:2026-10-27_abc" })).toBe(true);
    expect(client({ t: "reactions.get", thread: "astra" })).toBe(false);
    expect(client({ t: "reactions.get", thread: "assistant:Astra" })).toBe(false);
    expect(client({ t: "reaction.set", thread: "assistant:astra", message: "assistant@1761580800123", emoji: "👍", excerpt: "Done." })).toBe(true);
    expect(client({ t: "reaction.set", thread: "assistant:astra", message: "tool@1", emoji: "👍", excerpt: "" })).toBe(false);
    expect(client({ t: "reaction.set", thread: "assistant:astra", message: "user@1", emoji: "yes", excerpt: "" })).toBe(false);
    expect(client({ t: "reaction.set", thread: "assistant:astra", message: "user@1", emoji: "👍", excerpt: "x".repeat(201) })).toBe(false);
    expect(client({ t: "reaction.clear", thread: "session:s1", message: "user@1" })).toBe(true);
    const snapshot = {
      t: "reactions.snapshot",
      thread: "assistant:astra",
      reactions: { "assistant@1": { isaac: { emoji: "❓", excerpt: "Why?", at: 2 } }, "user@1": { isaac: { emoji: "👍", excerpt: "ok", at: 3 }, astra: { emoji: "❤️", excerpt: "ok", at: 4 } } },
    };
    expect(parseServerMessage(JSON.stringify(snapshot)).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify({ ...snapshot, reactions: { "x@1": { isaac: { emoji: "❓", excerpt: "", at: 2 } } } })).ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ ...snapshot, reactions: { "user@1": { Isaac: { emoji: "❓", excerpt: "", at: 2 } } } })).ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ ...snapshot, reactions: { "user@1": { emoji: "❓", excerpt: "", at: 2 } } })).ok).toBe(false);
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
    roundTrip(parseClientMessage, { t: "call.end", callId: "c-1", reason: "The microphone sent no audio (taps 0)" });
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

describe("live call frames", () => {
  const roundTrip = (parse: typeof parseClientMessage | typeof parseServerMessage, frame: object) => {
    const r = parse(JSON.stringify(frame));
    expect(r.ok, JSON.stringify(frame)).toBe(true);
    if (r.ok) expect(r.value).toEqual(frame);
  };

  it("phone start with its SDP offer and end round-trip; the host answers with OpenAI's SDP and states", () => {
    roundTrip(parseClientMessage, { t: "live.start", callId: "l-1", agent: "nova", sdp: "v=0\r\n" });
    roundTrip(parseClientMessage, { t: "live.end", callId: "l-1" });
    roundTrip(parseClientMessage, { t: "live.end", callId: "l-1", reason: "ICE failed" });
    roundTrip(parseServerMessage, { t: "live.answer", callId: "l-1", agent: "nova", sessionId: "live_u1_x", sdp: "v=0\r\n" });
    for (const state of ["connecting", "listening", "thinking", "ended"]) roundTrip(parseServerMessage, { t: "live.state", callId: "l-1", agent: "nova", state });
    roundTrip(parseServerMessage, { t: "live.state", callId: "l-1", agent: "nova", state: "thinking", text: "what's on my calendar" });
    roundTrip(parseServerMessage, { t: "live.state", callId: "l-1", agent: "nova", state: "ended", error: "No OpenAI key on this host", fallback: true });
  });

  it("rejects an empty or oversized SDP, an unknown state and wrong-direction frames", () => {
    expect(parseClientMessage(JSON.stringify({ t: "live.start", callId: "l-1", agent: "nova", sdp: "" })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: "live.start", callId: "l-1", agent: "nova", sdp: "v".repeat(MAX_LIVE_SDP + 1) })).ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ t: "live.state", callId: "l-1", agent: "nova", state: "speaking" })).ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ t: "live.start", callId: "l-1", agent: "nova", sdp: "v=0" })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: "live.answer", callId: "l-1", agent: "nova", sessionId: "s", sdp: "v=0" })).ok).toBe(false);
  });
});

describe("live canvas", () => {
  const agent = { name: "Nova", color: "#8b5cf6", avatar: "/canvas/avatar/nova" };
  const entry = { kind: "turn", roomId: "r-1", slug: "artifacts", board: "Artifacts", agent, human: { name: "Isaac", text: "tighten it" }, text: "Done." };

  it("asks for rooms and access, and refuses a malformed slug", () => {
    expect(parseClientMessage(JSON.stringify({ t: "canvas.get" })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ t: "canvas.open", slug: "artifacts" })).ok).toBe(true);
    for (const slug of ["Artifacts", "", "a/b", "x".repeat(81)]) expect(parseClientMessage(JSON.stringify({ t: "canvas.open", slug })).ok, slug).toBe(false);
    expect(parseServerMessage(JSON.stringify({ t: "canvas.open", slug: "artifacts" })).ok).toBe(false);
  });

  it("carries a canvas row on agent and assistant messages, and drops one it cannot read rather than the row", () => {
    const r = parseServerMessage(JSON.stringify({ t: "agent.messages", sessionId: "s", rev: 1, append: [{ id: "m", role: "system", text: "Isaac: tighten it", at: 1, canvas: entry }] }));
    expect(r.ok && r.value.t === "agent.messages" ? r.value.append[0]?.canvas : undefined).toEqual(entry);
    const bad = parseServerMessage(JSON.stringify({ t: "assistant.snapshot", agent: "nova", snapshot: { rev: 1, busy: false, sessionId: "s", messages: [{ id: "m", role: "card", text: "x", at: 1, canvas: { ...entry, kind: "party" } }] } }));
    expect(bad.ok && bad.value.t === "assistant.snapshot" ? bad.value.snapshot.messages[0] : undefined).toEqual({ id: "m", role: "card", text: "x", at: 1 });
  });

  it("rejects an agent color that is not #rrggbb and a room without its agent", () => {
    const room = { id: "r", slug: "a", board: "A", live: true, agent, chat: {}, humans: [], startedAt: 1 };
    expect(parseServerMessage(JSON.stringify({ t: "canvas.rooms", rev: 1, rooms: [room] })).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify({ t: "canvas.rooms", rev: 1, rooms: [{ ...room, agent: { ...agent, color: "violet" } }] })).ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ t: "canvas.rooms", rev: 1, rooms: [{ ...room, agent: undefined }] })).ok).toBe(false);
  });
});
