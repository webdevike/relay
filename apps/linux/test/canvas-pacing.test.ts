import { describe, expect, it } from "bun:test";
import type { Action } from "../src/canvas/dsl";
import { ADD_PACE_MS, type Step, runSteps } from "../src/canvas/participant";
import type { CanvasActor } from "../src/canvas/actor";

function recorder(): { actor: CanvasActor; times: Map<string, number> } {
  const times = new Map<string, number>();
  const actor = {
    run(action: Action) {
      times.set("id" in action ? action.id : action.kind, performance.now());
      return Promise.resolve(null);
    },
  } as unknown as CanvasActor;
  return { actor, times };
}

const add = (id: string): Step => ({ kind: "action", action: { kind: "add_node", id, type: "note", x: 0, y: 0, title: id, body: "" } as unknown as Action });
const del = (id: string): Step => ({ kind: "action", action: { kind: "delete", id } });

describe("canvas batch pacing", () => {
  it("spaces card additions at least ADD_PACE_MS apart, while other actions keep the base pace", async () => {
    const { actor, times } = recorder();
    await runSteps(actor, [add("a"), add("b"), add("c"), del("x"), del("y")], { say: () => undefined, stopped: () => false, paceMs: 10 });
    const a = times.get("a") ?? 0;
    const b = times.get("b") ?? 0;
    const c = times.get("c") ?? 0;
    expect(b - a).toBeGreaterThanOrEqual(ADD_PACE_MS - 15);
    expect(c - b).toBeGreaterThanOrEqual(ADD_PACE_MS - 15);
    // The deletes keep the base pace, not the card pause.
    expect((times.get("y") ?? 0) - (times.get("x") ?? 0)).toBeLessThan(ADD_PACE_MS / 2);
  });

  it("does not wait at all when pacing is off (tests, instant replays)", async () => {
    const { actor } = recorder();
    const t0 = performance.now();
    await runSteps(actor, [add("a"), add("b"), add("c"), add("d")], { say: () => undefined, stopped: () => false, paceMs: 0 });
    expect(performance.now() - t0).toBeLessThan(ADD_PACE_MS);
  });
});
