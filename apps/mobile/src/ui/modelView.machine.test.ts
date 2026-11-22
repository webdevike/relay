import { describe, expect, it, vi } from "vitest";
import { SimulatedClock, createActor, fromPromise, waitFor } from "xstate";
import { MODEL_MAX_BYTES } from "@evaos/chat-core/model-limit";
import type { CaptureResult } from "@/lib/modelPosters";
import { CAPTURE_MS, modelViewMachine } from "./modelView.machine";

const MB = 1024 * 1024;

interface Options {
  capture?: () => Promise<CaptureResult>;
  /** The size known up front (a drop's). */
  size?: number | null;
  /** What the HEAD says. */
  probe?: () => Promise<number | null>;
}

function harness(needsPoster: boolean, { capture = () => Promise.resolve("made"), size = 12 * MB, probe }: Options = {}) {
  const captures = vi.fn(capture);
  const claims = vi.fn();
  const clock = new SimulatedClock();
  const machine = modelViewMachine.provide({
    actions: { claim: claims },
    actors: {
      capture: fromPromise(captures),
      probe: fromPromise(probe ?? (() => Promise.resolve(size))),
    },
  });
  const actor = createActor(machine, { clock, input: { needsPoster, size } }).start();
  /** A tap, through the size check, to a live native view. */
  const open = async () => {
    actor.send({ type: "view.open" });
    await waitFor(actor, (s) => s.matches("live"));
  };
  /** Live and drawn, with the first capture (if any) already run. */
  const drawAndCapture = async () => {
    await open();
    actor.send({ type: "model.loaded" });
    clock.increment(CAPTURE_MS);
    await waitFor(actor, (s) => !s.matches({ live: "capturing" }));
  };
  return { actor, clock, captures, claims, open, drawAndCapture, value: () => actor.getSnapshot().value };
}

describe("modelViewMachine", () => {
  it("stays a poster until tapped, then takes the one open slot", async () => {
    const h = harness(false);
    expect(h.value()).toBe("still");
    h.actor.send({ type: "model.loaded" }); // a stale load event from a closed view changes nothing
    h.actor.send({ type: "viewport.rested" });
    expect(h.value()).toBe("still");
    expect(h.claims).not.toHaveBeenCalled();
    await h.open();
    expect(h.value()).toEqual({ live: "loading" });
    expect(h.claims).toHaveBeenCalledOnce();
  });

  it("closes when it loses the slot, even mid-load, and a tap opens it afresh", async () => {
    const h = harness(false);
    await h.open();
    h.actor.send({ type: "slot.lost" });
    expect(h.value()).toBe("still");
    await h.open();
    expect(h.value()).toEqual({ live: "loading" });
    expect(h.claims).toHaveBeenCalledTimes(2);
  });

  it("says a drop over the limit is too large without a tap, and never opens it", () => {
    const h = harness(false, { size: MODEL_MAX_BYTES + 1 });
    expect(h.value()).toBe("tooLarge");
    expect(h.actor.getSnapshot().can({ type: "view.open" })).toBe(false);
    expect(h.claims).not.toHaveBeenCalled();
  });

  it("asks a URL's size on tap and refuses it when the HEAD says it is over the limit", async () => {
    const h = harness(false, { size: null, probe: () => Promise.resolve(64 * MB) });
    expect(h.value()).toBe("still");
    h.actor.send({ type: "view.open" });
    await waitFor(h.actor, (s) => s.matches("tooLarge"));
    expect(h.actor.getSnapshot().context.size).toBe(64 * MB);
    expect(h.claims).not.toHaveBeenCalled();
  });

  it("opens when the size cannot be learned", async () => {
    const h = harness(false, { size: null, probe: () => Promise.reject(new Error("offline")) });
    await h.open();
    expect(h.claims).toHaveBeenCalledOnce();
  });

  it("snapshots a model with no poster CAPTURE_MS after it drew", async () => {
    const h = harness(true);
    await h.open();
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

  it("never snapshots a model that already has a poster", async () => {
    const h = harness(false);
    await h.open();
    h.actor.send({ type: "model.loaded" });
    h.clock.increment(CAPTURE_MS * 3);
    expect(h.captures).not.toHaveBeenCalled();
    expect(h.value()).toEqual({ live: "drawn" });
  });

  it("skips the snapshot when a poster turned up while it was loading", async () => {
    const h = harness(true);
    await h.open();
    h.actor.send({ type: "poster.changed", needed: false });
    h.actor.send({ type: "model.loaded" });
    h.clock.increment(CAPTURE_MS);
    expect(h.captures).not.toHaveBeenCalled();
  });

  it("waits for the next settle when the frame was not clear, then tries again", async () => {
    const results: CaptureResult[] = ["later", "made"];
    const h = harness(true, { capture: () => Promise.resolve(results.shift() ?? "made") });
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

  it("gives the slot back without waiting for a snapshot in flight", async () => {
    const h = harness(true, { capture: () => new Promise<CaptureResult>(() => undefined) });
    await h.open();
    h.actor.send({ type: "model.loaded" });
    h.clock.increment(CAPTURE_MS);
    expect(h.value()).toEqual({ live: "capturing" });
    h.actor.send({ type: "slot.lost" });
    expect(h.value()).toBe("still");
  });

  it("waits for a settle after a failed snapshot instead of retrying at once", async () => {
    const h = harness(true, { capture: () => Promise.reject(new Error("no view")) });
    await h.drawAndCapture();
    expect(h.value()).toEqual({ live: "waiting" });
    h.clock.increment(CAPTURE_MS * 3);
    expect(h.captures).toHaveBeenCalledOnce();
  });

  it("stays failed for this src whatever happens", async () => {
    const h = harness(false);
    await h.open();
    h.actor.send({ type: "model.failed" });
    expect(h.value()).toBe("failed");
    expect(h.actor.getSnapshot().can({ type: "view.open" })).toBe(false);
    h.actor.send({ type: "slot.lost" });
    expect(h.value()).toBe("failed");
  });
});
