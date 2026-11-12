import { describe, expect, it } from "vitest";
import { ActivityItem, etaView, ETA_MAX_FRACTION, type ActivityEta } from "../src";

const FROM = new Date(2026, 10, 11, 9, 0).getTime();
const MIN = 60_000;

const eta = (over: Partial<ActivityEta> = {}): ActivityEta => ({
  from: FROM,
  totalMs: 20 * MIN,
  lowMs: 15 * MIN,
  highMs: 30 * MIN,
  typicalMs: 18 * MIN,
  runs: 34,
  confidence: "rough",
  overrunning: false,
  ...over,
});

describe("etaView", () => {
  it("fills by elapsed over the expected total and counts down what is left", () => {
    const view = etaView(eta(), FROM + 8 * MIN);
    expect(view.fraction).toBeCloseTo(0.4);
    expect(view).toMatchObject({ state: "onTrack", remainingMs: 12 * MIN, label: "About 12 min left", short: "12m", confident: false, detail: "Rough guess · 34 similar runs" });
  });

  it("names plan steps over the history count, and says when it is sure", () => {
    const view = etaView(eta({ confidence: "confident", steps: { done: 3, total: 7 } }), FROM + 5 * MIN);
    expect(view).toMatchObject({ confident: true, detail: "Fairly sure · 3 of 7 steps done" });
  });

  it("never reads full while running, even when the estimate has run out", () => {
    const view = etaView(eta(), FROM + 29 * MIN);
    expect(view.fraction).toBe(ETA_MAX_FRACTION);
    expect(view).toMatchObject({ state: "onTrack", remainingMs: 0, label: "Less than a minute left" });
  });

  it("past the upper bound it says taking longer instead of parking at 99%", () => {
    const view = etaView(eta(), FROM + 31 * MIN);
    expect(view).toMatchObject({ state: "overrunning", label: "Taking longer than usual", short: null, confident: false, detail: "Usually about 18 min, this one is at 31 min" });
  });

  it("the host's overrunning flag wins even inside the range", () => {
    expect(etaView(eta({ overrunning: true, confidence: "confident" }), FROM + 10 * MIN)).toMatchObject({ state: "overrunning", confident: false });
  });

  it("a clock behind the start reads as just begun", () => {
    const view = etaView(eta(), FROM - 5000);
    expect(view.elapsedMs).toBe(0);
    expect(view.fraction).toBeGreaterThan(0);
  });

  it("rides on an activity item and survives the wire", () => {
    const item = { id: "session:a", kind: "session", owner: "assistant:nova", title: "Build", status: "working", intent: "", startedAt: FROM, updatedAt: FROM, eta: eta({ steps: { done: 1, total: 4 } }), open: { to: "chat", thread: "assistant:nova", session: "a" } };
    expect(ActivityItem.parse(item).eta).toEqual(item.eta);
  });
});
