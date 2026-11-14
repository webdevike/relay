import { describe, expect, it, vi } from "vitest";
import { SimulatedClock, createActor, fromPromise, waitFor } from "xstate";
import type { CaptureResult } from "@/lib/modelPosters";
import { CAPTURE_MS, modelViewMachine } from "./modelView.machine";

function harness(needsPoster: boolean, capture: () => Promise<CaptureResult> = () => Promise.resolve("made")) {
  const captures = vi.fn(capture);
  const clock = new SimulatedClock();
  const machine = modelViewMachine.provide({ actors: { capture: fromPromise(captures) } });
  const actor = createActor(machine, { clock, input: { needsPoster } }).start();
  /** Live and drawn, with the first capture (if any) already run. */
  const drawAndCapture = async () => {
    actor.send({ type: "slot.gained" });
    actor.send({ type: "model.loaded" });
    clock.increment(CAPTURE_MS);
    await waitFor(actor, (s) => !s.matches({ live: "capturing" }));
  };
  return { actor, clock, captures, drawAndCapture, value: () => actor.getSnapshot().value };
}

describe("modelViewMachine", () => {
  it("draws only while it holds the slot, and losing it mid-load drops the native view", () => {
    const { actor, value } = harness(false);
    expect(value()).toBe("still");
    actor.send({ type: "model.loaded" }); // a stale load event from a released view changes nothing
    expect(value()).toBe("still");
    actor.send({ type: "slot.gained" });
    expect(value()).toEqual({ live: "loading" });
    actor.send({ type: "slot.lost" });
    expect(value()).toBe("still");
    // Gaining it again loads afresh.
    actor.send({ type: "slot.gained" });
    expect(value()).toEqual({ live: "loading" });
  });

  it("snapshots a model with no poster CAPTURE_MS after it drew", async () => {
    const h = harness(true);
    h.actor.send({ type: "slot.gained" });
    h.actor.send({ type: "model.loaded" });
    h.clock.increment(CAPTURE_MS - 1);
    expect(h.captures).not.toHaveBeenCalled();
    h.clock.increment(1);
    expect(h.captures).toHaveBeenCalledOnce();
    await waitFor(h.actor, (s) => s.matches({ live: "drawn" }));
    // The poster now exists: no second snapshot, even after settles.
    h.actor.send({ type: "poster.changed", needed: false });
    h.actor.send({ type: "viewport.rested" });
    h.clock.increment(CAPTURE_MS * 3);
    expect(h.captures).toHaveBeenCalledOnce();
  });

  it("never snapshots a model that already has a poster", () => {
    const { actor, clock, captures, value } = harness(false);
    actor.send({ type: "slot.gained" });
    actor.send({ type: "model.loaded" });
    clock.increment(CAPTURE_MS * 3);
    expect(captures).not.toHaveBeenCalled();
    expect(value()).toEqual({ live: "drawn" });
  });

  it("skips the snapshot when a poster turned up while it was loading", () => {
    const { actor, clock, captures } = harness(true);
    actor.send({ type: "slot.gained" });
    actor.send({ type: "poster.changed", needed: false });
    actor.send({ type: "model.loaded" });
    clock.increment(CAPTURE_MS);
    expect(captures).not.toHaveBeenCalled();
  });

  it("waits for the next settle when the frame was not clear, then tries again", async () => {
    const results: CaptureResult[] = ["later", "made"];
    const h = harness(true, () => Promise.resolve(results.shift() ?? "made"));
    await h.drawAndCapture();
    expect(h.value()).toEqual({ live: "waiting" });
    // No polling while it waits.
    h.clock.increment(CAPTURE_MS * 5);
    expect(h.captures).toHaveBeenCalledOnce();
    h.actor.send({ type: "viewport.rested" });
    h.clock.increment(CAPTURE_MS);
    expect(h.captures).toHaveBeenCalledTimes(2);
  });

  it("tries again after a settle when its poster went missing while it was live", async () => {
    const h = harness(false);
    await h.drawAndCapture();
    expect(h.captures).not.toHaveBeenCalled();
    h.actor.send({ type: "poster.changed", needed: true });
    h.actor.send({ type: "viewport.rested" });
    h.clock.increment(CAPTURE_MS);
    expect(h.captures).toHaveBeenCalledOnce();
  });

  it("gives the slot back without waiting for a snapshot in flight", () => {
    const { actor, clock, value } = harness(true, () => new Promise<CaptureResult>(() => undefined));
    actor.send({ type: "slot.gained" });
    actor.send({ type: "model.loaded" });
    clock.increment(CAPTURE_MS);
    expect(value()).toEqual({ live: "capturing" });
    actor.send({ type: "slot.lost" });
    expect(value()).toBe("still");
  });

  it("waits for a settle after a failed snapshot instead of retrying at once", async () => {
    const h = harness(true, () => Promise.reject(new Error("no view")));
    await h.drawAndCapture();
    expect(h.value()).toEqual({ live: "waiting" });
    h.clock.increment(CAPTURE_MS * 3);
    expect(h.captures).toHaveBeenCalledOnce();
  });

  it("stays failed for this src whatever the slot does", () => {
    const { actor, value } = harness(false);
    actor.send({ type: "slot.gained" });
    actor.send({ type: "model.failed" });
    expect(value()).toBe("failed");
    expect(actor.getSnapshot().can({ type: "slot.gained" })).toBe(false);
    actor.send({ type: "slot.lost" });
    expect(value()).toBe("failed");
  });
});
