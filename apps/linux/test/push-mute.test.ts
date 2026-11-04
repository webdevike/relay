import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession, CanvasRoomInfo } from "@relay/protocol";
import { CanvasInvitations } from "../src/push/canvas-invites";
import { AttentionNotifier, type PushMessage } from "../src/push/notifier";
import { FilePushTokenStore } from "../src/push/token-store";
import type { SessionClock } from "../src/session";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "push-mute-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function store(): FilePushTokenStore {
  const s = new FilePushTokenStore(join(dir, "push-tokens.json"));
  s.register("phone-1", "ExponentPushToken[one]");
  s.register("phone-2", "ExponentPushToken[two]");
  return s;
}

describe("push mutes in the token store", () => {
  it("leaves a device out of the recipients of the assistants it muted, and only those", () => {
    const s = store();
    s.setMuted("phone-1", ["nova", "nova"]);
    expect([...s.tokens("nova").keys()]).toEqual(["phone-2"]);
    expect([...s.tokens("astra").keys()]).toEqual(["phone-1", "phone-2"]);
    expect([...s.tokens().keys()]).toEqual(["phone-1", "phone-2"]);
  });

  it("replaces the list, survives a restart, and keeps the file private", () => {
    const s = store();
    s.setMuted("phone-1", ["nova", "astra"]);
    s.setMuted("phone-1", ["astra"]);
    const again = new FilePushTokenStore(join(dir, "push-tokens.json"));
    expect([...again.tokens("nova").keys()]).toEqual(["phone-1", "phone-2"]);
    expect([...again.tokens("astra").keys()]).toEqual(["phone-2"]);
    expect(statSync(join(dir, "push-prefs.json")).mode & 0o777).toBe(0o600);
    again.setMuted("phone-1", []);
    expect([...again.tokens("astra").keys()]).toEqual(["phone-1", "phone-2"]);
  });

  it("forgets the mutes with the token", () => {
    const s = store();
    s.setMuted("phone-1", ["nova"]);
    s.unregister("phone-1");
    s.register("phone-1", "ExponentPushToken[one]");
    expect([...s.tokens("nova").keys()].sort()).toEqual(["phone-1", "phone-2"]);
  });
});

class FakeClock implements SessionClock {
  now(): number {
    return 1_000;
  }
  after(): () => void {
    return () => undefined;
  }
}

function session(id: string, extra: Partial<AgentSession> = {}): AgentSession {
  return { id, provider: "omp", title: id, projectPath: `/p/${id}`, status: "waiting", lastActivity: "asked", lastActivityAt: 0, canRespond: true, ...extra };
}

describe("pushes skip the devices that muted the assistant", () => {
  it("a session an assistant runs or started", async () => {
    const s = store();
    s.setMuted("phone-1", ["astra"]);
    const sent: PushMessage[] = [];
    const notifier = new AttentionNotifier({
      tokens: s,
      sender: {
        send: (messages) => {
          sent.push(...messages);
          return Promise.resolve(messages.map(() => ({ ok: true as const })));
        },
      },
      isViewing: () => false,
      clock: new FakeClock(),
      log: () => undefined,
    });
    notifier.seed([session("a", { status: "working", assistant: "astra", kind: "assistant" }), session("b", { status: "working", owner: "astra" }), session("c", { status: "working" })]);
    notifier.observe([session("a", { assistant: "astra", kind: "assistant" }), session("b", { owner: "astra" }), session("c")]);
    await Promise.resolve();
    expect(sent.map((m) => [m.to, m.data])).toEqual([
      ["ExponentPushToken[two]", { sessionId: "a" }],
      ["ExponentPushToken[two]", { sessionId: "b" }],
      ["ExponentPushToken[one]", { sessionId: "c" }],
      ["ExponentPushToken[two]", { sessionId: "c" }],
    ]);
  });

  it("a canvas invitation, once, for a live room that appears", async () => {
    const s = store();
    s.setMuted("phone-1", ["nova"]);
    const sent: PushMessage[] = [];
    const invitations = new CanvasInvitations({
      tokens: s,
      sender: {
        send: (messages) => {
          sent.push(...messages);
          return Promise.resolve(messages.map(() => ({ ok: true as const })));
        },
      },
      log: () => undefined,
    });
    const room = (over: Partial<CanvasRoomInfo> = {}): CanvasRoomInfo => ({
      id: "r1",
      slug: "mind-map",
      board: "Mind map",
      live: true,
      agent: { name: "Nova", color: "#7048e8" },
      chat: { assistant: "nova", title: "Sketch the onboarding flow" },
      humans: [],
      startedAt: 1,
      ...over,
    });
    invitations.seed([room({ id: "old" })]);
    invitations.observe([room({ id: "old" })]);
    await Promise.resolve();
    expect(sent).toEqual([]);
    invitations.observe([room({ id: "old" }), room()]);
    invitations.observe([room({ id: "old" }), room()]);
    await Promise.resolve();
    expect(sent).toEqual([
      {
        to: "ExponentPushToken[two]",
        title: "Join Nova",
        body: "on Mind map: Sketch the onboarding flow",
        data: { canvas: "mind-map" },
        threadId: "canvas:mind-map",
      },
    ]);
    // A room that ended before it was heard, and a chat that is no assistant's, still invite phones.
    invitations.observe([room({ id: "gone", live: false })]);
    invitations.observe([room({ id: "plain", slug: "plain", chat: {} })]);
    await Promise.resolve();
    expect(sent.map((m) => m.to)).toEqual(["ExponentPushToken[two]", "ExponentPushToken[one]", "ExponentPushToken[two]"]);
  });
});
