import { beforeEach, describe, expect, it } from "vitest";
import { debateRoom, doneRoom, runningRoom } from "@/rooms/fixtures";
import { asRoom, useRoomsStore } from "./rooms";

beforeEach(() => {
  useRoomsStore.getState().clear();
});

describe("rooms.state", () => {
  it("replaces every room, newest first, and marks the list loaded", () => {
    const { setState } = useRoomsStore.getState();
    setState([doneRoom(), runningRoom(), debateRoom()]);
    const state = useRoomsStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.rooms.map((r) => r.id)).toEqual(["maul-1", "maul-0", "debate-1"]);
    setState([debateRoom()]);
    expect(useRoomsStore.getState().rooms.map((r) => r.id)).toEqual(["debate-1"]);
  });

  it("drops frames that are not rooms", () => {
    useRoomsStore.getState().setState([null, 3, { id: "", startedAt: 1 }, { id: "ok", title: "T", phase: "open", startedAt: 5 }]);
    expect(useRoomsStore.getState().rooms.map((r) => r.id)).toEqual(["ok"]);
  });
});

describe("rooms.room", () => {
  it("replaces the room with the same id and keeps the list newest first", () => {
    const store = useRoomsStore.getState();
    store.setState([runningRoom(), doneRoom()]);
    store.upsert({ ...runningRoom(), title: "Renamed", phase: "resolved" });
    store.upsert({ ...debateRoom(), id: "newest", startedAt: Date.now() });
    const rooms = useRoomsStore.getState().rooms;
    expect(rooms.map((r) => r.id)).toEqual(["newest", "maul-1", "maul-0"]);
    expect(rooms.find((r) => r.id === "maul-1")).toMatchObject({ title: "Renamed", phase: "resolved" });
  });
});

describe("asRoom", () => {
  it("fills the lists a screen maps over when the desktop left them out", () => {
    expect(asRoom({ id: "r", title: "T", phase: "open", startedAt: 1 })).toMatchObject({ agents: [], messages: [], presence: {}, rounds: 0, prompt: "" });
  });
  it("is null without an id or a start time", () => {
    expect(asRoom({ title: "T" })).toBeNull();
    expect(asRoom({ id: "r" })).toBeNull();
  });
});

describe("clear", () => {
  it("forgets the host's rooms and whether it supported them", () => {
    const store = useRoomsStore.getState();
    store.setSupported(true);
    store.setState([runningRoom()]);
    store.clear();
    expect(useRoomsStore.getState()).toMatchObject({ supported: null, loaded: false, rooms: [] });
  });
});
