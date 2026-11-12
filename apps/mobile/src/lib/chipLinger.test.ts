import { describe, expect, it } from "vitest";
import type { ActivityEta } from "@evaos/chat-core/activity";
import type { EtaView } from "@relay/protocol";
import type { RunningChip } from "./activity";
import { chipFill } from "./chipFill";
import { LINGER_MS, lingerLeft, settleChips, type ShownChip } from "./chipLinger";

const eta: ActivityEta = { from: 0, totalMs: 10, lowMs: 5, highMs: 20, typicalMs: 10, runs: 1, confidence: "rough", overrunning: false };
const chip = (id: string, withEta = true): RunningChip => ({ id, label: id, waiting: false, ...(withEta ? { eta } : {}) });
const running = (...list: RunningChip[]): ShownChip[] => list.map((entry) => ({ chip: entry, done: false, since: null }));
const ids = (shown: ShownChip[]) => shown.map((entry) => [entry.chip.id, entry.done]);

describe("settleChips", () => {
  it("shows live chips as running", () => {
    expect(ids(settleChips([], [chip("a"), chip("b")], 0))).toEqual([["a", false], ["b", false]]);
  });

  it("keeps a chip with an estimate that left, at its old place, until the linger is over", () => {
    const before = running(chip("a"), chip("b"), chip("c"));
    const gone = settleChips(before, [chip("a"), chip("c")], 1000);
    expect(ids(gone)).toEqual([["a", false], ["b", true], ["c", false]]);
    expect(settleChips(gone, [chip("a"), chip("c")], 1000 + LINGER_MS - 1).map((entry) => entry.chip.id)).toEqual(["a", "b", "c"]);
    expect(settleChips(gone, [chip("a"), chip("c")], 1000 + LINGER_MS).map((entry) => entry.chip.id)).toEqual(["a", "c"]);
  });

  it("lets a chip with no estimate vanish at once", () => {
    expect(settleChips(running(chip("a", false)), [], 0)).toEqual([]);
  });

  it("does not restart the linger on later settles, and a chip that runs again is running", () => {
    const first = settleChips(running(chip("a")), [], 100);
    const later = settleChips(first, [], 700);
    expect(later[0]?.since).toBe(100);
    expect(ids(settleChips(later, [chip("a")], 800))).toEqual([["a", false]]);
  });

  it("says how long until the first lingering chip is gone", () => {
    expect(lingerLeft(running(chip("a")), 0)).toBeNull();
    const shown = settleChips(running(chip("a")), [], 100);
    expect(lingerLeft(shown, 400)).toBe(LINGER_MS - 300);
  });
});

describe("chipFill", () => {
  const view = (over: Partial<EtaView>): EtaView => ({ fraction: 0.4, elapsedMs: 0, remainingMs: 0, state: "onTrack", confident: true, label: "", detail: "", short: null, ...over });

  it("picks the agent's color, solid when sure and striped when rough", () => {
    expect(chipFill(view({}), "#111111", "#FBBF24")).toEqual({ fraction: 0.4, color: "#111111", texture: "solid" });
    expect(chipFill(view({ confident: false }), "#111111", "#FBBF24")).toMatchObject({ color: "#111111", texture: "striped" });
  });

  it("goes amber and solid once it overruns, however sure the estimate was", () => {
    expect(chipFill(view({ state: "overrunning", confident: false }), "#111111", "#FBBF24")).toMatchObject({ color: "#FBBF24", texture: "solid" });
  });
});
