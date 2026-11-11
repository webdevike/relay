import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@relay/protocol";
import { runningRoom } from "@/rooms/fixtures";
import { useRoomsStore } from "@/state/rooms";
import { createRoomsFrameRouter, PendingRooms, type RoomsFrameRouter } from "./rooms";

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
    expect(useRoomsStore.getState()).toMatchObject({ supported: true, resumes: true, chats: true });
    route(welcome(["rooms"]));
    expect(useRoomsStore.getState()).toMatchObject({ chats: false });
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
  it("settles the command waiting on its rid, with the desktop's answer", async () => {
    const answer = pending.add("r1");
    route({ t: "rooms.res", rid: "r1", result: { ok: true, value: "maul-2" } });
    expect(await answer).toEqual({ ok: true, value: "maul-2" });
  });

  it("carries a refusal through", async () => {
    const answer = pending.add("r2");
    route({ t: "rooms.res", rid: "r2", result: { ok: false, code: "no-desktop", message: "No Relay Desktop is connected." } });
    expect(await answer).toEqual({ ok: false, code: "no-desktop", message: "No Relay Desktop is connected." });
  });

  it("ignores an answer nobody waits for", () => {
    expect(() => {
      route({ t: "rooms.res", rid: "late", result: { ok: true } });
    }).not.toThrow();
  });

  it("fails a command the desktop never answers", async () => {
    const answer = pending.add("r3");
    vi.advanceTimersByTime(1000);
    expect(await answer).toMatchObject({ ok: false, code: "timeout" });
    // The timer is gone: a late answer is dropped.
    route({ t: "rooms.res", rid: "r3", result: { ok: true } });
  });

  it("does not time out a command that was answered", async () => {
    const answer = pending.add("r4");
    route({ t: "rooms.res", rid: "r4", result: { ok: true } });
    await answer;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancelAll fails every command still waiting, as a host switch does", async () => {
    const a = pending.add("a");
    const b = pending.add("b");
    pending.cancelAll();
    expect(await a).toMatchObject({ ok: false, code: "disconnected" });
    expect(await b).toMatchObject({ ok: false, code: "disconnected" });
  });
});
