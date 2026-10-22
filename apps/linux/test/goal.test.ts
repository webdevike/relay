import { describe, expect, it } from "vitest";
import { goalFromEntries, goalOf, phoneGoalCommand, sameGoal } from "../src/agents/goal";

const record = (status: string, tokensUsed = 0) => ({ id: "g1", objective: "ship the strip", status, tokensUsed, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 });
const change = (mode: string, goal?: object) => ({ type: "mode_change", id: "m", parentId: null, mode, ...(goal === undefined ? {} : { data: { goal } }) });

describe("goalOf", () => {
  it("reports an active or paused goal with its tokens", () => {
    expect(goalOf(record("active", 41_500))).toEqual({ objective: "ship the strip", paused: false, tokensUsed: 41_500 });
    expect(goalOf(record("paused"))).toEqual({ objective: "ship the strip", paused: true, tokensUsed: 0 });
  });

  it("clears a goal that was met, dropped or ran out of budget, and anything malformed", () => {
    expect(goalOf(record("complete"))).toBeUndefined();
    expect(goalOf(record("dropped"))).toBeUndefined();
    expect(goalOf(record("budget-limited"))).toBeUndefined();
    expect(goalOf(null)).toBeUndefined();
    expect(goalOf({ status: "active", objective: "  " })).toBeUndefined();
    expect(goalOf({ status: "active", objective: "x", tokensUsed: Number.NaN })).toEqual({ objective: "x", paused: false, tokensUsed: 0 });
  });
});

describe("goalFromEntries", () => {
  it("follows the branch's mode changes: set, paused, met", () => {
    const active = [change("goal", record("active"))];
    expect(goalFromEntries(active)?.paused).toBe(false);
    const paused = [...active, change("goal_paused", record("paused"))];
    expect(goalFromEntries(paused)?.paused).toBe(true);
    const met = [...paused, change("goal", record("complete"))];
    expect(goalFromEntries(met)).toBeUndefined();
  });

  it("clears on mode none, and other modes and entries leave it alone", () => {
    const active = [{ type: "session" }, change("goal", record("active", 9)), { type: "compaction", summary: "Goal" }, change("plan")];
    expect(goalFromEntries(active)).toEqual({ objective: "ship the strip", paused: false, tokensUsed: 9 });
    expect(goalFromEntries([...active, change("none")])).toBeUndefined();
    expect(goalFromEntries([])).toBeUndefined();
  });
});

describe("sameGoal", () => {
  it("compares every field and treats two absent goals as the same", () => {
    const goal = { objective: "x", paused: false, tokensUsed: 1 };
    expect(sameGoal(goal, { ...goal })).toBe(true);
    expect(sameGoal(goal, { ...goal, tokensUsed: 2 })).toBe(false);
    expect(sameGoal(goal, undefined)).toBe(false);
    expect(sameGoal(undefined, undefined)).toBe(true);
  });
});

describe("phoneGoalCommand", () => {
  it("keeps the forms the terminal runs without asking back", () => {
    expect(phoneGoalCommand("/goal set ship it")).toBe("/goal set ship it");
    expect(phoneGoalCommand("/goal pause")).toBe("/goal pause");
    expect(phoneGoalCommand("/goal resume")).toBe("/goal resume");
    expect(phoneGoalCommand("/goal drop")).toBe("/goal drop");
    expect(phoneGoalCommand("/goal budget 200k")).toBe("/goal budget 200k");
  });

  it("maps the rest the way EvaOS does", () => {
    expect(phoneGoalCommand("/goal ship it")).toBe("/goal set ship it");
    expect(phoneGoalCommand("/goal create ship it")).toBe("/goal set ship it");
    expect(phoneGoalCommand("/goal clear")).toBe("/goal drop");
    // The menu and the objective editor only exist in the terminal: read the goal instead.
    expect(phoneGoalCommand("/goal")).toBe("/goal show");
    expect(phoneGoalCommand(" /goal status ")).toBe("/goal show");
    expect(phoneGoalCommand("/goal set")).toBe("/goal show");
  });

  it("leaves anything that is not /goal alone", () => {
    expect(phoneGoalCommand("/goals")).toBeNull();
    expect(phoneGoalCommand("/handoff")).toBeNull();
    expect(phoneGoalCommand("hi /goal")).toBeNull();
  });
});
