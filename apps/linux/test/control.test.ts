import { describe, expect, it } from "vitest";
import { ClientMessage, ControlPresence, ServerMessage, type ControlResult } from "@relay/protocol";
import { controlStatus, handleControlRequest } from "../src/control/http";
import { ControlRelay } from "../src/control/relay";
import type { FrameSink } from "../src/seams";
import type { SessionClock } from "../src/session";

const TOKEN = "a".repeat(64);

class Clock implements SessionClock {
  current = 1_000_000;
  private timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
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
    for (const t of this.timers.filter((t) => !t.cancelled && t.at <= this.current)) t.fn();
  }
}

/**
 * A Relay Desktop on the other end of a socket: answers `control.req` the way the app's control
 * API does, for `describe`, `settings.get/set/undo` and the catalog, with its own screen text.
 */
class FakeDesktop implements FrameSink {
  readonly received: ServerMessage[] = [];
  readonly settings: Record<string, unknown> = { "theme.mode": "dark" };
  private undo: { key: string; value: unknown } | null = null;
  /** Answers arrive a tick later, like a real socket; false leaves requests unanswered. */
  answers = true;

  constructor(
    private readonly relay: () => ControlRelay,
    readonly screen: string,
  ) {}

  send(message: ServerMessage): void {
    // Every frame the host sends must be one the protocol allows.
    this.received.push(ServerMessage.parse(message));
    if (message.t !== "control.req" || !this.answers) return;
    const result = this.run(message.action, message.params);
    const res = ClientMessage.parse({ t: "control.res", rid: message.rid, result });
    if (res.t !== "control.res") throw new Error("wrong frame");
    queueMicrotask(() => {
      this.relay().result(this, res.rid, res.result);
    });
  }

  close(): void {
    this.answers = false;
  }

  private run(action: string, params: unknown): ControlResult {
    const p = (params ?? {}) as { key?: string; value?: unknown };
    switch (action) {
      case "@actions":
        return { ok: true, value: [{ id: "describe" }, { id: "settings.set" }] };
      case "describe":
        return { ok: true, value: { text: this.screen } };
      case "settings.get":
        return { ok: true, value: { key: p.key, value: this.settings[p.key ?? ""] } };
      case "settings.set": {
        const key = p.key ?? "";
        this.undo = { key, value: this.settings[key] };
        this.settings[key] = p.value;
        return { ok: true, value: { key, value: p.value, previous: this.undo.value } };
      }
      case "settings.undo": {
        if (this.undo === null) return { ok: false, code: "nothing-to-undo", message: "No change to undo" };
        this.settings[this.undo.key] = this.undo.value;
        const back = this.undo;
        this.undo = null;
        return { ok: true, value: back };
      }
      default:
        return { ok: false, code: "unknown-action", message: `No action ${action}` };
    }
  }
}

const presence = (name: string, idleMs: number | null, extra: Partial<ControlPresence> = {}): ControlPresence =>
  ControlPresence.parse({ t: "control.presence", name, instance: "stable", idleMs, page: "chat", focused: false, remote: false, ...extra });

interface Setup {
  readonly clock: Clock;
  readonly relay: ControlRelay;
  readonly mini: FakeDesktop;
  readonly book: FakeDesktop;
}

function setup(): Setup {
  const clock = new Clock();
  const relay = new ControlRelay(TOKEN, clock, () => undefined, 5_000);
  const mini = new FakeDesktop(() => relay, "Mini: Dashboard");
  const book = new FakeDesktop(() => relay, "MacBook: Settings > Theme");
  return { clock, relay, mini, book };
}

/** The Mini's own app on loopback, the MacBook in remote mode over Tailscale. */
function connectBoth(s: Setup, miniIdle: number | null, bookIdle: number | null): void {
  s.relay.presence({ sink: s.mini, device: "relay-desktop", loopback: true }, presence("Isaacs-Mac-mini", miniIdle));
  s.relay.presence({ sink: s.book, device: "relay-desktop-Isaacs-MacBook-Pro.local", loopback: false }, presence("Isaacs-MacBook-Pro", bookIdle, { remote: true }));
}

interface PostInit {
  remote?: string;
  token?: string;
  origin?: string;
  host?: string;
}

function post(body: unknown, init: PostInit = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${init.token ?? TOKEN}` };
  if (init.origin !== undefined) headers["origin"] = init.origin;
  const request = new Request(`http://${init.host ?? "127.0.0.1:7817"}/control/run`, { method: "POST", headers, body: JSON.stringify(body) });
  return { request, remote: init.remote ?? "127.0.0.1" };
}

async function run(relay: ControlRelay, body: unknown) {
  const { request, remote } = post(body);
  const res = await handleControlRequest(relay, request, "/control/run", remote);
  return { status: res.status, json: (await res.json()) as ControlResult & { device: { id: string; name: string } | null } };
}

describe("remote control routing", () => {
  it("sends `active` to the desktop Isaac used last, on the host's clock", async () => {
    const s = setup();
    connectBoth(s, 600_000, 2_000);
    const r = await run(s.relay, { action: "describe" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, value: { text: "MacBook: Settings > Theme" }, device: { name: "Isaacs-MacBook-Pro" } });
    expect(s.mini.received).toEqual([]);
    // He goes back to the Mini: it is active now.
    s.clock.advance(10_000);
    s.relay.presence({ sink: s.mini, device: "relay-desktop", loopback: true }, presence("Isaacs-Mac-mini", 0));
    expect((await run(s.relay, { action: "describe" })).json).toMatchObject({ value: { text: "Mini: Dashboard" } });
    const devices = s.relay.devices();
    expect(devices.map((d) => [d.id, d.local, d.active])).toEqual([
      ["relay-desktop", true, true],
      ["relay-desktop-Isaacs-MacBook-Pro.local", false, false],
    ]);
  });

  it("falls back to the Mini's desktop when no input was heard anywhere", async () => {
    const s = setup();
    s.relay.presence({ sink: s.book, device: "relay-desktop-book", loopback: false }, presence("Isaacs-MacBook-Pro", null, { remote: true }));
    s.relay.presence({ sink: s.mini, device: "relay-desktop", loopback: true }, presence("Isaacs-Mac-mini", null));
    expect((await run(s.relay, { action: "describe" })).json).toMatchObject({ value: { text: "Mini: Dashboard" }, device: { id: "relay-desktop" } });
    // Remote mode on this very Mac (a thin client test instance) is not the Mini's own app.
    const t = setup();
    t.relay.presence({ sink: t.book, device: "relay-desktop-x", loopback: true }, presence("Isaacs-MacBook-Pro", null, { remote: true }));
    expect(t.relay.devices()[0]).toMatchObject({ local: false, active: true });
  });

  it("targets a device by id or name, and says which ones exist when the target is unknown", async () => {
    const s = setup();
    connectBoth(s, 1_000, 2_000);
    expect((await run(s.relay, { target: "isaacs-macbook-pro", action: "describe" })).json).toMatchObject({ value: { text: "MacBook: Settings > Theme" } });
    expect((await run(s.relay, { target: "relay-desktop", action: "describe" })).json).toMatchObject({ value: { text: "Mini: Dashboard" } });
    const unknown = await run(s.relay, { target: "ipad", action: "describe" });
    expect(unknown.status).toBe(404);
    expect(unknown.json).toMatchObject({ ok: false, code: "no-device", device: null });
    expect(JSON.stringify(unknown.json)).toContain("relay-desktop-Isaacs-MacBook-Pro.local");
    const none = setup();
    expect((await run(none.relay, { action: "describe" })).json).toMatchObject({ ok: false, code: "no-device" });
  });

  it("round-trips settings.set and settings.undo on the active desktop only", async () => {
    const s = setup();
    connectBoth(s, 60_000, 1_000);
    const set = await run(s.relay, { action: "settings.set", params: { key: "theme.mode", value: "light" }, scope: "agent:nova" });
    expect(set.json).toMatchObject({ ok: true, value: { key: "theme.mode", value: "light", previous: "dark" } });
    expect(s.book.settings["theme.mode"]).toBe("light");
    expect(s.mini.settings["theme.mode"]).toBe("dark");
    // The scope (the Undo toast's agent) and params reach the desktop as sent.
    expect(s.book.received[0]).toMatchObject({ t: "control.req", action: "settings.set", scope: "agent:nova", params: { key: "theme.mode", value: "light" } });
    expect((await run(s.relay, { action: "settings.get", params: { key: "theme.mode" } })).json).toMatchObject({ value: { value: "light" } });
    expect((await run(s.relay, { action: "settings.undo" })).json).toMatchObject({ ok: true, value: { key: "theme.mode", value: "dark" } });
    expect(s.book.settings["theme.mode"]).toBe("dark");
    // A destructive action's confirm goes through untouched; the desktop's own rules decide.
    await run(s.relay, { action: "app.quit", confirm: true });
    expect(s.book.received.at(-1)).toMatchObject({ action: "app.quit", confirm: true });
  });

  it("fails a request when its desktop goes away or never answers, and ignores answers from other sockets", async () => {
    const s = setup();
    connectBoth(s, 50_000, 1_000);
    s.book.answers = false;
    const gone = s.relay.run({ target: "active", action: "describe" });
    const req = s.book.received.at(-1);
    if (req?.t !== "control.req") throw new Error("no request sent");
    // The Mini answering the MacBook's rid changes nothing.
    s.relay.result(s.mini, req.rid, { ok: true, value: "forged" });
    s.relay.drop(s.book);
    const goneAnswer = await gone;
    expect(goneAnswer.result).toMatchObject({ ok: false, code: "device-gone" });
    expect(controlStatus(goneAnswer.result)).toBe(502);
    // With the MacBook gone, the Mini is active; a silent desktop times out.
    s.mini.answers = false;
    const late = s.relay.run({ target: "active", action: "describe" });
    s.clock.advance(5_000);
    const lateAnswer = await late;
    expect(lateAnswer).toMatchObject({ result: { ok: false, code: "device-timeout" }, device: { id: "relay-desktop" } });
    expect(controlStatus(lateAnswer.result)).toBe(504);
  });
});

describe("remote control access", () => {
  it("refuses other machines, web pages, a foreign Host and a missing or wrong token", async () => {
    const s = setup();
    connectBoth(s, 1, 1);
    const body = { action: "describe" };
    const status = async (init: PostInit, relay: ControlRelay | null = s.relay) => {
      const { request, remote } = post(body, init);
      return (await handleControlRequest(relay, request, "/control/run", remote)).status;
    };
    expect(await status({ remote: "100.79.119.8" })).toBe(403); // a phone on the tailnet
    expect(await status({ remote: "192.168.1.20" })).toBe(403);
    expect(await status({ origin: "https://evil.example" })).toBe(403);
    expect(await status({ host: "evil.example:7817" })).toBe(403);
    expect(await status({ token: "b".repeat(64) })).toBe(401);
    expect(await status({ token: "nope" })).toBe(401);
    expect(await status({}, null)).toBe(404);
    expect(s.book.received).toEqual([]);
    expect(s.mini.received).toEqual([]);
    expect(await status({})).toBe(200);
  });

  it("lists the devices for a caller with the token", async () => {
    const s = setup();
    connectBoth(s, 9_000, 3_000);
    const get = (token: string) =>
      handleControlRequest(s.relay, new Request("http://127.0.0.1:7817/control/devices", { headers: { authorization: `Bearer ${token}` } }), "/control/devices", "::1");
    expect((await get("c".repeat(64))).status).toBe(401);
    const res = await get(TOKEN);
    expect(await res.json()).toMatchObject({
      ok: true,
      value: { active: "relay-desktop-Isaacs-MacBook-Pro.local", devices: [{ name: "Isaacs-MacBook-Pro", lastInputAt: 1_000_000 - 3_000 }, { name: "Isaacs-Mac-mini" }] },
    });
  });

  it("is not a frame any client can send: a phone's control.req does not parse", () => {
    expect(ClientMessage.safeParse({ t: "control.req", rid: "r1", action: "describe" }).success).toBe(false);
    expect(ClientMessage.safeParse({ t: "control.res", rid: "r1", result: { ok: true } }).success).toBe(true);
  });
});
