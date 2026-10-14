import { describe, expect, it } from "vitest";
import type { GateStatus } from "@relay/protocol";
import { activeChoice, gateChoices, gatePhase, secondsLeft, timerProgress } from "./gate";

const START = Date.parse("2026-10-13T15:00:00.000Z");
const MINUTE = 60_000;

function gate(overrides: Partial<GateStatus> = {}): GateStatus {
  return {
    locked: true,
    blocked: true,
    reason: "planned break",
    active: null,
    habits: [
      { id: "walk", name: "Walk", minutes: 15, photo: false },
      { id: "draw", name: "Draw", minutes: 10, photo: true },
    ],
    tasks: [
      { id: "taxes", name: "File taxes", minutes: null, done: false },
      { id: "shelf", name: "Fix shelf", minutes: 30, done: true },
    ],
    canFinish: false,
    remainingSeconds: null,
    ...overrides,
  };
}

const drawing = { kind: "habit" as const, id: "draw", startedAt: new Date(START).toISOString(), endsAt: new Date(START + 10 * MINUTE).toISOString() };

describe("gateChoices", () => {
  it("lists habits, then only the open tasks", () => {
    expect(gateChoices(gate()).map((choice) => `${choice.kind}:${choice.id}`)).toEqual(["habit:walk", "habit:draw", "task:taxes"]);
  });

  it("carries the photo rule for habits; tasks never need one", () => {
    const [walk, draw, taxes] = gateChoices(gate());
    expect([walk?.photo, draw?.photo, taxes?.photo]).toEqual([false, true, false]);
    expect(taxes?.minutes).toBeNull();
  });
});

describe("activeChoice", () => {
  it("resolves the running habit or task, or null", () => {
    expect(activeChoice(gate())).toBeNull();
    expect(activeChoice(gate({ active: drawing }))).toMatchObject({ id: "draw", photo: true });
    expect(activeChoice(gate({ active: { ...drawing, kind: "task", id: "taxes" } }))).toMatchObject({ kind: "task", id: "taxes" });
    expect(activeChoice(gate({ active: { ...drawing, id: "gone" } }))).toBeNull();
  });
});

describe("timer", () => {
  it("counts whole seconds down to zero and never below", () => {
    expect(secondsLeft(drawing, START)).toBe(600);
    expect(secondsLeft(drawing, START + 9 * MINUTE + 59_500)).toBe(1);
    expect(secondsLeft(drawing, START + 11 * MINUTE)).toBe(0);
    expect(secondsLeft({ ...drawing, endsAt: "soon" }, START)).toBe(0);
  });

  it("reports progress clamped to 0..1", () => {
    expect(timerProgress(drawing, START - MINUTE)).toBe(0);
    expect(timerProgress(drawing, START + 5 * MINUTE)).toBe(0.5);
    expect(timerProgress(drawing, START + 20 * MINUTE)).toBe(1);
    expect(timerProgress({ ...drawing, endsAt: drawing.startedAt }, START)).toBe(1);
  });
});

describe("gatePhase", () => {
  it("picks with no timer, runs until the phone's clock passes endsAt, then finishes", () => {
    expect(gatePhase(gate(), START)).toBe("pick");
    expect(gatePhase(gate({ active: drawing }), START + MINUTE)).toBe("running");
    expect(gatePhase(gate({ active: drawing }), START + 10 * MINUTE)).toBe("finish");
  });

  it("finishes early when the host already says the timer is done", () => {
    expect(gatePhase(gate({ active: drawing, canFinish: true }), START + MINUTE)).toBe("finish");
  });
});
