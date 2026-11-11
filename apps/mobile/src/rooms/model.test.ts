import { describe, expect, it } from "vitest";
import { COUNCIL_DEFAULT_EFFORT, COUNCIL_DEFAULT_ROUTING, COUNCIL_PAUSE_AT, type RoomWire, type RoomWireCouncil } from "@relay/protocol";
import { debateRoom, doneRoom, runningRoom } from "./fixtures";
import { authorOf, commandError, createCommand, createdRoomId, deltaLabel, notchName, phaseSteps, roomStatus, runControl, seatsOfRoom, spendView, type NewRoomDraft } from "./model";

function councilOfRoom(room: RoomWire): RoomWireCouncil {
  if (room.council === undefined) throw new Error("fixture has no council");
  return room.council;
}

const draft = (patch: Partial<NewRoomDraft> = {}): NewRoomDraft => ({
  prompt: "Match the target", source: "/Users/ike/Eva/work/x", refs: "", renderCmd: "", effort: COUNCIL_DEFAULT_EFFORT, routing: { ...COUNCIL_DEFAULT_ROUTING }, ...patch,
});

describe("createCommand", () => {
  it("builds a create at the default notch without optional fields", () => {
    expect(createCommand(draft())).toEqual({ ok: true, cmd: { op: "create", prompt: "Match the target", council: { effort: 3, source: "/Users/ike/Eva/work/x" } } });
  });

  it("sends only the roles whose provider moved off the default", () => {
    const made = createCommand(draft({ routing: { ...COUNCIL_DEFAULT_ROUTING, builder: "openai" }, refs: " /a.png \n\n/b.png\n", renderCmd: " make " }));
    expect(made).toMatchObject({ ok: true, cmd: { council: { routing: { builder: "openai" }, refs: ["/a.png", "/b.png"], renderCmd: "make" } } });
  });

  it("says what is missing or too long", () => {
    expect(createCommand(draft({ prompt: "  " }))).toMatchObject({ ok: false });
    expect(createCommand(draft({ source: "" }))).toMatchObject({ ok: false });
    expect(createCommand(draft({ refs: Array.from({ length: 13 }, (_, i) => `/r${String(i)}.png`).join("\n") }))).toMatchObject({ ok: false, error: "At most 12 reference images." });
  });

  it("keeps the notch inside the ladder", () => {
    expect(createCommand(draft({ effort: 99 }))).toMatchObject({ cmd: { council: { effort: 6 } } });
    expect(createCommand(draft({ effort: -2 }))).toMatchObject({ cmd: { council: { effort: 1 } } });
  });
});

describe("spendView", () => {
  it("turns amber at 80 % of the cap, not before", () => {
    const council = councilOfRoom(runningRoom());
    const at = (usd: number) => spendView({ ...council, spend: { ...council.spend, usd, cap: 10 } });
    expect(at(10 * COUNCIL_PAUSE_AT - 0.01).warn).toBe(false);
    expect(at(10 * COUNCIL_PAUSE_AT).warn).toBe(true);
    expect(at(14).fraction).toBe(1);
  });
});

describe("phaseSteps", () => {
  it("marks what is behind, now and ahead, with Contract and Integrate only for a split room", () => {
    const steps = phaseSteps(runningRoom());
    expect(steps.map((s) => s.stage)).toEqual(["brief", "contract", "build", "integrate", "critique", "judge", "deliver"]);
    expect(steps.map((s) => s.state)).toEqual(["done", "done", "current", "todo", "todo", "todo", "todo"]);
  });

  it("is all done once the room resolved", () => {
    expect(phaseSteps(doneRoom()).every((s) => s.state === "done")).toBe(true);
  });

  it("has no strip for a debate room", () => {
    expect(phaseSteps(debateRoom())).toEqual([]);
  });
});

describe("roomStatus", () => {
  it("names the round and stage, a pause, and how a room ended", () => {
    const room = runningRoom();
    const council = councilOfRoom(room);
    expect(roomStatus({ ...room, council: { ...council, paused: false } })).toBe("Round 2 of 3 · Build");
    expect(roomStatus(room)).toBe("Paused for your call");
    expect(roomStatus(doneRoom())).toBe("Done");
    expect(roomStatus({ ...room, phase: "failed" })).toBe("Failed");
    expect(roomStatus({ ...room, phase: "paused" })).toBe("Paused");
  });
});

describe("runControl", () => {
  it("pauses a running council round, then resumes a stopped room up to its resume cap", () => {
    const room = runningRoom();
    const council = councilOfRoom(room);
    const running = { ...room, council: { ...council, paused: false } };
    expect(runControl(running, true)).toEqual({ op: "pause", label: "Pause", busy: false });
    expect(runControl({ ...running, council: { ...council, paused: false, pauseRequested: true } }, true)).toMatchObject({ op: "pause", busy: true });
    // Waiting on the cap pause, or finishing: neither.
    expect(runControl(room, true)).toBeNull();
    expect(runControl({ ...running, phase: "wrapping" }, true)).toBeNull();
    // Spend 5.12 is past the pause line of the 6.30 cap: Resume adds one estimate (4.20) on the higher.
    expect(runControl({ ...running, phase: "paused" }, true)).toEqual({ op: "resume", label: "Resume (up to $11)", busy: false });
    expect(runControl(doneRoom(), true)?.op).toBe("resume");
  });

  it("shows nothing on a host without pause / resume, or for a debate room", () => {
    expect(runControl({ ...runningRoom(), phase: "paused" }, false)).toBeNull();
    expect(runControl(debateRoom(), true)).toBeNull();
  });
});

describe("authors and seats", () => {
  it("knows Isaac, the seats, the judge and the room itself", () => {
    const room = runningRoom();
    expect(authorOf(room, "isaac")).toMatchObject({ name: "You", mine: true });
    expect(authorOf(room, "builder-1").agent?.seat?.role).toBe("builder");
    expect(authorOf(room, "judge").name).toBe("Judge");
    expect(authorOf(room, "system").name).toBe("Room");
  });

  it("lists the seats of a council room and none for a debate", () => {
    expect(seatsOfRoom(runningRoom()).length).toBeGreaterThan(3);
    expect(seatsOfRoom(debateRoom())).toEqual([]);
    expect(notchName(runningRoom())).toBe("Team");
    expect(notchName(debateRoom())).toBeNull();
  });
});

describe("results", () => {
  it("shows the desktop's refusal and nothing for success", () => {
    expect(commandError({ ok: true })).toBeNull();
    expect(commandError({ ok: false, code: "x", message: "No desktop." })).toBe("No desktop.");
    expect(commandError({ ok: false, code: "x", message: "" })).toBe("Your Mac could not do that.");
  });
  it("finds the new room's id in a room or a bare id", () => {
    expect(createdRoomId("r9")).toBe("r9");
    expect(createdRoomId({ id: "r8" })).toBe("r8");
    expect(createdRoomId(undefined)).toBeNull();
  });
  it("signs a score change and hides zero", () => {
    expect(deltaLabel(1.46)).toBe("+1.5");
    expect(deltaLabel(-0.3)).toBe("-0.3");
    expect(deltaLabel(0)).toBeNull();
  });
});
