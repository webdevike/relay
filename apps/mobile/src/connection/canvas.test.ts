import { beforeEach, describe, expect, it } from "vitest";
import type { CanvasRoomInfo, ClientMessage } from "@relay/protocol";
import { canvasJoinState, liveRoomOn, useCanvasStore } from "@/state/canvas";
import { beginCanvasAccess, canvasWelcomeFrames, createCanvasFrameRouter } from "./canvas";

let authority: string | null = "100.85.157.127:7817";
const route = createCanvasFrameRouter(useCanvasStore.getState(), () => authority);

function room(overrides: Partial<CanvasRoomInfo> = {}): CanvasRoomInfo {
  return {
    id: "room-1",
    slug: "artifacts",
    board: "Artifacts",
    live: true,
    agent: { name: "Nova", color: "#8B5CF6", avatar: "/canvas/avatar/nova" },
    chat: { assistant: "nova" },
    humans: [],
    startedAt: 1_000,
    ...overrides,
  };
}

const HOUR = 60 * 60 * 1000;

function accessOf(slug: string) {
  return useCanvasStore.getState().access[slug];
}

beforeEach(() => {
  authority = "100.85.157.127:7817";
  useCanvasStore.getState().clear();
});

describe("canvas frames", () => {
  it("lists rooms by id and ignores a list older than the one applied", () => {
    route({ t: "canvas.rooms", rev: 2, rooms: [room()] });
    route({ t: "canvas.rooms", rev: 1, rooms: [] });
    const state = useCanvasStore.getState();
    expect(state.rev).toBe(2);
    expect(Object.keys(state.rooms)).toEqual(["room-1"]);
  });

  it("takes a restarted host's lists, whose revs start over, after the next welcome", () => {
    route({ t: "canvas.rooms", rev: 5, rooms: [room({ live: false })] });
    route({ t: "canvas.access", slug: "artifacts", path: "/canvas/artifacts/?token=old", token: "old", expiresAt: Date.now() + HOUR });
    useCanvasStore.getState().reconnected();
    expect(accessOf("artifacts")).toBeUndefined();
    route({ t: "canvas.rooms", rev: 1, rooms: [room({ id: "room-2" })] });
    const state = useCanvasStore.getState();
    expect(state.rev).toBe(1);
    expect(canvasJoinState(state, "room-2")).toBe("live");
  });

  it("turns access into the web client URL on the connected host", () => {
    route({ t: "canvas.access", slug: "artifacts", path: "/canvas/artifacts/?token=t1", token: "t1", expiresAt: 5_000 });
    expect(accessOf("artifacts")).toEqual({
      kind: "ready",
      url: "http://100.85.157.127:7817/canvas/artifacts/?token=t1",
      expiresAt: 5_000,
    });
  });

  it("drops access that arrives after the socket went away", () => {
    useCanvasStore.getState().setAccess("artifacts", { kind: "asking" });
    authority = null;
    route({ t: "canvas.access", slug: "artifacts", path: "/canvas/artifacts/?token=t1", token: "t1", expiresAt: 5_000 });
    expect(accessOf("artifacts")).toEqual({ kind: "asking" });
  });

  it("records an ended session with its reason", () => {
    route({ t: "canvas.unavailable", slug: "artifacts", reason: "The session ended." });
    expect(accessOf("artifacts")).toEqual({ kind: "unavailable", reason: "The session ended." });
  });

  it("ignores other frames", () => {
    route({ t: "pong", ts: 1, serverTs: 2 });
    expect(useCanvasStore.getState()).toMatchObject({ rev: -1, rooms: {}, access: {} });
  });
});

describe("join state", () => {
  it("is unknown before the host listed rooms, then follows the card's own room", () => {
    expect(canvasJoinState(useCanvasStore.getState(), "room-1")).toBe("unknown");
    route({ t: "canvas.rooms", rev: 1, rooms: [room()] });
    expect(canvasJoinState(useCanvasStore.getState(), "room-1")).toBe("live");
    route({ t: "canvas.rooms", rev: 2, rooms: [room({ live: false, endedAt: 9_000 })] });
    expect(canvasJoinState(useCanvasStore.getState(), "room-1")).toBe("ended");
  });

  it("ends an old card when a new session opens on the same board, or the host forgot the room", () => {
    route({ t: "canvas.rooms", rev: 1, rooms: [room({ id: "room-2" })] });
    expect(canvasJoinState(useCanvasStore.getState(), "room-1")).toBe("ended");
    expect(liveRoomOn(useCanvasStore.getState().rooms, "artifacts")?.id).toBe("room-2");
    route({ t: "canvas.rooms", rev: 2, rooms: [] });
    expect(liveRoomOn(useCanvasStore.getState().rooms, "artifacts")).toBeUndefined();
  });
});

describe("access flow", () => {
  let sent: ClientMessage[];
  const send = (message: ClientMessage): void => {
    sent.push(message);
  };
  beforeEach(() => {
    sent = [];
  });

  it("asks once connected, reuses a live token, and asks again once the room ended", () => {
    route({ t: "canvas.rooms", rev: 1, rooms: [room()] });
    beginCanvasAccess(useCanvasStore.getState(), "artifacts", { now: 0, connected: true, send });
    expect(sent).toEqual([{ t: "canvas.open", slug: "artifacts" }]);
    expect(accessOf("artifacts")).toEqual({ kind: "asking" });

    route({ t: "canvas.access", slug: "artifacts", path: "/canvas/artifacts/?token=t1", token: "t1", expiresAt: 12 * HOUR });
    // Back to chat and Join again: the same URL, no reload, nothing sent.
    beginCanvasAccess(useCanvasStore.getState(), "artifacts", { now: HOUR, connected: true, send });
    expect(sent).toHaveLength(1);
    expect(accessOf("artifacts")?.kind).toBe("ready");

    // The room ends: its token is let go, and the next Join asks (to be told it ended, or a new token).
    route({ t: "canvas.rooms", rev: 2, rooms: [room({ live: false })] });
    expect(accessOf("artifacts")).toBeUndefined();
    beginCanvasAccess(useCanvasStore.getState(), "artifacts", { now: HOUR, connected: true, send });
    expect(sent).toHaveLength(2);
  });

  it("asks again for a token about to lapse", () => {
    route({ t: "canvas.rooms", rev: 1, rooms: [room()] });
    route({ t: "canvas.access", slug: "artifacts", path: "/canvas/artifacts/?token=t1", token: "t1", expiresAt: 100_000 });
    beginCanvasAccess(useCanvasStore.getState(), "artifacts", { now: 99_000, connected: true, send });
    expect(sent).toEqual([{ t: "canvas.open", slug: "artifacts" }]);
  });

  it("holds an offline Join as asking and sends it with the next welcome", () => {
    beginCanvasAccess(useCanvasStore.getState(), "artifacts", { now: 0, connected: false, send });
    expect(sent).toEqual([]);
    useCanvasStore.getState().setAccess("roadmap", { kind: "unavailable", reason: "Ended." });
    expect(canvasWelcomeFrames(useCanvasStore.getState().access)).toEqual([
      { t: "canvas.get" },
      { t: "canvas.open", slug: "artifacts" },
    ]);
  });

  it("forgets everything when the connection moves to another host", () => {
    route({ t: "canvas.rooms", rev: 3, rooms: [room()] });
    route({ t: "canvas.access", slug: "artifacts", path: "/canvas/artifacts/?token=t1", token: "t1", expiresAt: 12 * HOUR });
    useCanvasStore.getState().clear();
    expect(useCanvasStore.getState()).toMatchObject({ rev: -1, rooms: {}, access: {} });
  });
});
