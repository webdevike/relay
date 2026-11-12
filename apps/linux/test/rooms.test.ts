import { describe, expect, it } from "vitest";
import { MAX_ROOM_BYTES, MAX_ROOMS, ServerMessage, type RoomsCmd } from "@relay/protocol";
import { ROOMS_REPLAY_MS, RoomsRelay, type HostRoom } from "../src/rooms/relay";
import type { FrameSink } from "../src/seams";
import type { SessionClock } from "../src/session";

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

class Sink implements FrameSink {
  readonly received: ServerMessage[] = [];
  send(message: ServerMessage): void {
    // Every frame the host sends must be one the protocol allows.
    this.received.push(ServerMessage.parse(message));
  }
  close(): void {
    // A test socket has nothing to close.
  }
  last(): ServerMessage | undefined {
    return this.received.at(-1);
  }
}

const room = (id: string, startedAt: number, extra: Record<string, unknown> = {}): HostRoom => ({ id, title: id, phase: "open", startedAt, ...extra });

function setup(active: FrameSink | null = null) {
  const clock = new Clock();
  const logs: string[] = [];
  let activeSink = active;
  const relay = new RoomsRelay(clock, (line) => logs.push(line), () => activeSink, 60_000);
  const mini = new Sink();
  const book = new Sink();
  const phone = new Sink();
  return {
    clock,
    logs,
    relay,
    mini,
    book,
    phone,
    setActive: (s: FrameSink | null) => {
      activeSink = s;
    },
  };
}

const post: RoomsCmd = { op: "post", roomId: "r1", text: "hi" };

describe("rooms relay", () => {
  it("fans out room changes to phones that asked, never back to desktops", () => {
    const s = setup();
    s.relay.sync(s.mini, [room("r1", 1)]);
    s.relay.get(s.phone);
    expect(s.phone.last()).toEqual({ t: "rooms.state", rooms: [room("r1", 1)] });
    s.relay.upsert(s.mini, room("r1", 1, { title: "renamed" }));
    expect(s.phone.last()).toMatchObject({ t: "rooms.room", room: { id: "r1", title: "renamed" } });
    s.relay.sync(s.book, [room("r2", 5)]);
    expect(s.phone.last()).toMatchObject({ t: "rooms.state", rooms: [{ id: "r2" }, { id: "r1" }] });
    expect(s.mini.received).toEqual([]);
    expect(s.book.received).toEqual([]);
  });

  it("hands chat rooms (idle ones too) only to phones that asked for them", () => {
    const s = setup();
    const newPhone = new Sink();
    const chat = room("c1", 2, { kind: "chat", phase: "idle" });
    s.relay.sync(s.mini, [room("r1", 1), chat]);
    s.relay.get(s.phone);
    s.relay.get(newPhone, true);
    expect(s.phone.last()).toEqual({ t: "rooms.state", rooms: [room("r1", 1)] });
    expect(newPhone.last()).toEqual({ t: "rooms.state", rooms: [chat, room("r1", 1)] });
    s.relay.upsert(s.mini, { ...chat, phase: "open" });
    expect(s.phone.received).toHaveLength(1);
    expect(newPhone.last()).toMatchObject({ t: "rooms.room", room: { id: "c1", phase: "open" } });
  });

  it("routes a command to the owning desktop and answers with the phone's rid", () => {
    const s = setup();
    s.relay.sync(s.mini, [room("r0", 1)]);
    s.relay.sync(s.book, [room("r1", 2)]);
    s.relay.cmd(s.phone, "phone-7", post);
    expect(s.mini.received).toEqual([]);
    const sent = s.book.last();
    if (sent?.t !== "rooms.cmd") throw new Error("no cmd");
    expect(sent.cmd).toEqual(post);
    expect(sent.rid).not.toBe("phone-7");
    // A desktop that was not asked cannot answer it.
    s.relay.result(s.mini, sent.rid, { ok: true });
    expect(s.phone.received).toEqual([]);
    s.relay.result(s.book, sent.rid, { ok: true, value: 3 });
    expect(s.phone.received).toEqual([{ t: "rooms.res", rid: "phone-7", result: { ok: true, value: 3 } }]);
    // Answered once: the timeout later says nothing.
    s.clock.advance(60_000);
    expect(s.phone.received).toHaveLength(1);
  });

  it("sends create to the active desktop, else the one heard from last", () => {
    const s = setup();
    s.relay.sync(s.mini, []);
    s.clock.advance(10);
    s.relay.sync(s.book, []);
    const create: RoomsCmd = { op: "create", prompt: "make it", council: { effort: 3, source: "/src" } };
    s.relay.cmd(s.phone, "a", create);
    expect(s.book.last()).toMatchObject({ t: "rooms.cmd", cmd: { op: "create" } });
    s.setActive(s.mini);
    s.relay.cmd(s.phone, "b", create);
    expect(s.mini.last()).toMatchObject({ t: "rooms.cmd", cmd: { op: "create" } });
  });

  it("answers no-desktop when no Mac is connected", () => {
    const s = setup();
    s.relay.cmd(s.phone, "x", post);
    expect(s.phone.last()).toEqual({ t: "rooms.res", rid: "x", result: { ok: false, code: "no-desktop", message: "Open Relay on your Mac to use Rooms" } });
  });

  it("times out an unanswered command after 60 s", () => {
    const s = setup();
    s.relay.sync(s.mini, [room("r1", 1)]);
    s.relay.cmd(s.phone, "x", { op: "image", roomId: "r1", path: "/a.png", max: 1024 });
    s.clock.advance(59_999);
    expect(s.phone.received).toEqual([]);
    s.clock.advance(1);
    expect(s.phone.last()).toMatchObject({ t: "rooms.res", rid: "x", result: { ok: false, code: "timeout" } });
  });

  it("drops a desktop's rooms when it disconnects and tells the phones", () => {
    const s = setup();
    s.relay.sync(s.mini, [room("r1", 1)]);
    s.relay.sync(s.book, [room("r2", 2)]);
    s.relay.get(s.phone);
    s.relay.cmd(s.phone, "x", post);
    s.relay.drop(s.mini);
    expect(s.phone.received.slice(-2)).toEqual([
      { t: "rooms.res", rid: "x", result: { ok: false, code: "device-gone", message: "Your Mac disconnected before it answered" } },
      { t: "rooms.state", rooms: [room("r2", 2)] },
    ]);
  });

  it("refuses desktop frames from a phone and phone frames from a desktop", () => {
    const s = setup();
    s.relay.get(s.phone);
    s.relay.sync(s.phone, [room("fake", 9)]);
    s.relay.upsert(s.phone, room("fake", 9));
    s.relay.sync(s.mini, [room("r1", 1)]);
    s.relay.get(s.mini);
    expect(s.mini.received).toEqual([]);
    s.relay.get(s.phone);
    expect(s.phone.last()).toEqual({ t: "rooms.state", rooms: [room("r1", 1)] });
    expect(s.logs.filter((l) => l.includes("ignored"))).toHaveLength(3);
  });

  describe("a repeated phone rid (Try again), keyed by the phone's socket", () => {
    const cmds = (sink: Sink) => sink.received.filter((m) => m.t === "rooms.cmd");

    it("while the first is in flight: forwards once and answers both", () => {
      const s = setup();
      s.relay.sync(s.mini, [room("r1", 1)]);
      s.relay.cmd(s.phone, "p1", post);
      s.relay.cmd(s.phone, "p1", post);
      expect(cmds(s.mini)).toHaveLength(1);
      const sent = s.mini.last();
      if (sent?.t !== "rooms.cmd") throw new Error("no cmd");
      s.relay.result(s.mini, sent.rid, { ok: true, value: 1 });
      expect(s.phone.received).toEqual([
        { t: "rooms.res", rid: "p1", result: { ok: true, value: 1 } },
        { t: "rooms.res", rid: "p1", result: { ok: true, value: 1 } },
      ]);
    });

    it("after the answer: replays it for a few minutes without forwarding, then forgets", () => {
      const s = setup();
      s.relay.sync(s.mini, [room("r1", 1)]);
      s.relay.cmd(s.phone, "p1", post);
      const sent = s.mini.last();
      if (sent?.t !== "rooms.cmd") throw new Error("no cmd");
      s.relay.result(s.mini, sent.rid, { ok: true });
      s.clock.advance(ROOMS_REPLAY_MS - 1);
      s.relay.cmd(s.phone, "p1", post);
      expect(cmds(s.mini)).toHaveLength(1);
      expect(s.phone.received).toEqual([
        { t: "rooms.res", rid: "p1", result: { ok: true } },
        { t: "rooms.res", rid: "p1", result: { ok: true } },
      ]);
      s.clock.advance(1);
      s.relay.cmd(s.phone, "p1", post);
      expect(cmds(s.mini)).toHaveLength(2);
    });

    it("a different rid, or the same rid from another phone socket, forwards", () => {
      const s = setup();
      const other = new Sink();
      s.relay.sync(s.mini, [room("r1", 1)]);
      s.relay.cmd(s.phone, "p1", post);
      s.relay.cmd(s.phone, "p2", post);
      s.relay.cmd(other, "p1", post);
      expect(cmds(s.mini)).toHaveLength(3);
    });

    it("does not keep an answer that leaves the outcome unknown: a repeat after the host's timeout goes out again", () => {
      const s = setup();
      s.relay.sync(s.mini, [room("r1", 1)]);
      s.relay.cmd(s.phone, "p1", post);
      s.clock.advance(60_000);
      expect(s.phone.last()).toMatchObject({ t: "rooms.res", rid: "p1", result: { code: "timeout" } });
      s.relay.cmd(s.phone, "p1", post);
      expect(cmds(s.mini)).toHaveLength(2);
    });

    it("forgets a phone's rids when its socket drops", () => {
      const s = setup();
      s.relay.sync(s.mini, [room("r1", 1)]);
      s.relay.cmd(s.phone, "p1", post);
      const sent = s.mini.last();
      if (sent?.t !== "rooms.cmd") throw new Error("no cmd");
      s.relay.result(s.mini, sent.rid, { ok: true });
      s.relay.drop(s.phone);
      s.relay.cmd(s.phone, "p1", post);
      expect(cmds(s.mini)).toHaveLength(2);
    });
  });

  it("rejects an oversize room and keeps at most MAX_ROOMS per desktop", () => {
    const s = setup();
    s.relay.get(s.phone);
    s.phone.received.length = 0;
    s.relay.upsert(s.mini, room("big", 1, { blob: "x".repeat(MAX_ROOM_BYTES) }));
    expect(s.phone.received).toEqual([]);
    expect(s.logs.some((l) => l.includes("big"))).toBe(true);
    for (let i = 0; i <= MAX_ROOMS; i++) s.relay.upsert(s.mini, room(`r${String(i)}`, i));
    s.relay.get(s.phone);
    const state = s.phone.last();
    if (state?.t !== "rooms.state") throw new Error("no state");
    expect(state.rooms).toHaveLength(MAX_ROOMS);
    expect(state.rooms.some((r) => r.id === "r0")).toBe(false);
  });
});
