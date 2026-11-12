import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@relay/protocol";
import { runningRoom } from "@/rooms/fixtures";
import { useRoomsStore } from "@/state/rooms";
import { createRoomsFrameRouter, PendingRooms, refusedRequest, requestOutcome, type RoomsFrameRouter } from "./rooms";

const mac = { name: "Host", version: "0.2.50", accessibilityGranted: true, agentsAvailable: true };
const welcome = (features?: string[]): ServerMessage => ({ t: "welcome", state: { mac, agents: { rev: 0, sessions: [] } }, ...(features ? { features } : {}) });

let pending: PendingRooms;
let route: RoomsFrameRouter;

beforeEach(() => {
  vi.useFakeTimers();
  useRoomsStore.getState().clear();
  pending = new PendingRooms(1000);
  route = createRoomsFrameRouter(useRoomsStore.getState(), pending);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("welcome", () => {
  it("says whether the host relays rooms, every time", () => {
    route(welcome(["rooms"]));
    expect(useRoomsStore.getState()).toMatchObject({ supported: true, resumes: false });
    route(welcome(["rooms", "rooms.resume"]));
    expect(useRoomsStore.getState()).toMatchObject({ supported: true, resumes: true });
    route(welcome());
    expect(useRoomsStore.getState()).toMatchObject({ supported: false, resumes: false });
    // Pause / resume ride on Rooms: the resume feature alone sends nothing.
    route(welcome(["query", "rooms.resume"]));
    expect(useRoomsStore.getState()).toMatchObject({ supported: false, resumes: false });
    route(welcome(["rooms", "rooms.resume", "rooms.chat"]));
    expect(useRoomsStore.getState()).toMatchObject({ supported: true, resumes: true, chats: true, decides: false });
    route(welcome(["rooms", "rooms.chat", "rooms.decide"]));
    expect(useRoomsStore.getState()).toMatchObject({ chats: true, decides: true });
    route(welcome(["rooms"]));
    expect(useRoomsStore.getState()).toMatchObject({ chats: false, decides: false });
  });
});

describe("rooms frames", () => {
  it("rooms.state replaces the list and rooms.room patches one", () => {
    route({ t: "rooms.state", rooms: [runningRoom()] as never });
    expect(useRoomsStore.getState().rooms.map((r) => r.id)).toEqual(["maul-1"]);
    route({ t: "rooms.room", room: { ...runningRoom(), title: "New title" } });
    expect(useRoomsStore.getState().rooms[0]?.title).toBe("New title");
  });
});

describe("rooms.res", () => {
  const sent: string[] = [];
  const start = (rid: string) =>
    pending.start(rid, () => {
      sent.push(rid);
    });

  beforeEach(() => {
    sent.length = 0;
  });

  it("settles the command waiting on its rid, with the desktop's answer", () => {
    const request = start("r1");
    expect(sent).toEqual(["r1"]);
    route({ t: "rooms.res", rid: "r1", result: { ok: true, value: "maul-2" } });
    expect(request.getSnapshot().matches("answered")).toBe(true);
    expect(request.getSnapshot().context.result).toEqual({ ok: true, value: "maul-2" });
  });

  it("carries a refusal through", async () => {
    const request = start("r2");
    route({ t: "rooms.res", rid: "r2", result: { ok: false, code: "no-desktop", message: "No Relay Desktop is connected." } });
    expect(request.getSnapshot().value).toBe("failed");
    expect(await requestOutcome(request)).toEqual({ ok: false, code: "no-desktop", message: "No Relay Desktop is connected." });
  });

  it("ignores an answer nobody waits for", () => {
    expect(() => {
      route({ t: "rooms.res", rid: "late", result: { ok: true } });
    }).not.toThrow();
  });

  it("a command the desktop never answers is unconfirmed, and a late answer still lands", async () => {
    const request = start("r3");
    vi.advanceTimersByTime(1000);
    expect(request.getSnapshot().value).toBe("unconfirmed");
    // An image only wants a value: unconfirmed reads as a timeout.
    expect(await requestOutcome(request)).toMatchObject({ ok: false, code: "timeout" });
    route({ t: "rooms.res", rid: "r3", result: { ok: true } });
    expect(request.getSnapshot().matches("answered")).toBe(true);
  });

  it("Try again re-sends the same rid", () => {
    const request = start("r5");
    vi.advanceTimersByTime(1000);
    request.send({ type: "request.retry" });
    expect(sent).toEqual(["r5", "r5"]);
    route({ t: "rooms.res", rid: "r5", result: { ok: true } });
    expect(request.getSnapshot().matches("answered")).toBe(true);
  });

  it("does not time out a command that was answered", () => {
    start("r4");
    route({ t: "rooms.res", rid: "r4", result: { ok: true } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancelAll fails every command still open, pending or unconfirmed, as a socket close or host switch does", () => {
    const a = start("a");
    const b = start("b");
    vi.advanceTimersByTime(1000);
    const c = start("c");
    expect(b.getSnapshot().value).toBe("unconfirmed");
    pending.cancelAll();
    for (const request of [a, b, c]) {
      expect(request.getSnapshot().value).toBe("failed");
      expect(request.getSnapshot().context.result).toMatchObject({ ok: false, code: "disconnected" });
    }
    // Nothing is left to settle.
    route({ t: "rooms.res", rid: "a", result: { ok: true } });
    expect(a.getSnapshot().value).toBe("failed");
  });

  it("a refused request starts failed", async () => {
    expect(await requestOutcome(refusedRequest({ ok: false, code: "offline", message: "Not connected to your Mac." }))).toMatchObject({ code: "offline" });
  });
});
