import { describe, expect, it } from "vitest";
import type { Presence } from "../../canvas-live/src/shared";
import { DONE_MS, DoneTracker, SETTLE_MS, beginLoad, describeRoom } from "../src/activity";

const nova = (p: Partial<Presence> = {}): Presence => ({
  user: { name: "Nova", color: "#8b5cf6", kind: "agent", avatar: "/canvas/avatar/nova" },
  status: "idle",
  ...p,
});
const isaac: Presence = { user: { name: "Isaac", color: "#fa5252", kind: "human" } };
const novaOf = (p: Partial<Presence>, added = 0) =>
  describeRoom([isaac, nova(p)], added).find((x) => x.name === "Nova");

describe("describeRoom", () => {
  it("lists who is here, humans first, each once, and an idle agent as idle", () => {
    const room = describeRoom([nova(), isaac, { ...isaac }], 0);
    expect(room.map((x) => x.name)).toEqual(["Isaac", "Nova"]);
    expect(room[1]).toMatchObject({ state: "idle", label: "idle", avatar: "/canvas/avatar/nova" });
    expect(room[0]).toMatchObject({ agent: false, label: "" });
  });

  it("says what the agent is doing", () => {
    expect(novaOf({ status: "thinking" })).toMatchObject({ state: "thinking", label: "thinking…" });
    expect(novaOf({ status: "typing" })).toMatchObject({ state: "editing", label: "editing the board" });
    expect(novaOf({ status: "drawing" })?.label).toBe("connecting cards");
    expect(novaOf({ status: "typing" }, 1)?.label).toBe("adding a card");
    expect(novaOf({ status: "typing" }, 3)?.label).toBe("adding 3 cards");
  });

  it("shows a tool as a short label, also from an agent that only works off the board", () => {
    expect(novaOf({ status: "thinking", doing: "building the mockup…" })).toMatchObject({
      state: "tool",
      label: "building the mockup…",
    });
    expect(novaOf({ doing: "running a command…" })).toMatchObject({ state: "tool" });
  });

  it("names a handoff the agent is waiting on", () => {
    expect(novaOf({ task: "screenshots" })).toMatchObject({
      state: "waiting",
      label: "waiting on a handoff: screenshots",
    });
    expect(novaOf({ task: "x".repeat(200) })?.label.length).toBeLessThan(70);
  });

  it("prefers acting over waiting", () => {
    expect(novaOf({ task: "screenshots", status: "thinking" })?.state).toBe("thinking");
  });
});

describe("DoneTracker", () => {
  const at = (tracker: DoneTracker, p: Partial<Presence>, now: number) =>
    tracker.apply(describeRoom([nova(p)], 0), now)[0];

  it("holds the last line for a beat, reads done, then settles to idle", () => {
    const tracker = new DoneTracker();
    expect(at(tracker, { status: "thinking" }, 0)?.state).toBe("thinking");
    expect(tracker.pending).toBe(true);
    expect(at(tracker, {}, SETTLE_MS - 1)).toMatchObject({ state: "thinking" });
    expect(at(tracker, {}, SETTLE_MS)).toMatchObject({ state: "done", label: "done" });
    expect(at(tracker, {}, DONE_MS - 1)?.state).toBe("done");
    expect(at(tracker, {}, DONE_MS)?.state).toBe("idle");
    expect(tracker.pending).toBe(false);
  });

  it("is idle, never done, for an agent that did nothing", () => {
    expect(at(new DoneTracker(), {}, 10_000)?.state).toBe("idle");
  });

  it("restarts the clock when the agent works again", () => {
    const tracker = new DoneTracker();
    at(tracker, { status: "thinking" }, 0);
    expect(at(tracker, {}, 3000)?.state).toBe("done");
    expect(at(tracker, { doing: "reading files…" }, 4000)?.state).toBe("tool");
    expect(at(tracker, {}, 4000 + SETTLE_MS - 1)?.state).toBe("tool");
  });

  it("leaves humans alone", () => {
    const tracker = new DoneTracker();
    expect(tracker.apply(describeRoom([isaac], 0), 0)[0]?.state).toBe("idle");
    expect(tracker.pending).toBe(false);
  });
});

describe("beginLoad", () => {
  it("ends a load once, however often the end is called", () => {
    const a = beginLoad("card-1");
    const b = beginLoad("card-1");
    a();
    a();
    b();
    // No throw and nothing left open: a fresh pair behaves the same.
    const c = beginLoad("card-1");
    c();
  });
});
