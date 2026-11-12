import { describe, expect, it } from "vitest";
import { createActor, SimulatedClock } from "xstate";
import type { RoomsResult } from "@relay/protocol";
import { requestPhase, ROOMS_LAND_MS, ROOMS_TIMEOUT_MS, roomsRequestMachine, type RoomsRequestInput } from "./roomsRequest.machine";

function harness(input: RoomsRequestInput = { rid: "r1" }) {
  const sent: string[] = [];
  const clock = new SimulatedClock();
  const machine = roomsRequestMachine.provide({
    actions: {
      transmit: ({ context }) => {
        sent.push(context.rid);
      },
    },
  });
  const actor = createActor(machine, { clock, input }).start();
  return {
    actor,
    clock,
    sent,
    snapshot: () => actor.getSnapshot(),
    value: () => actor.getSnapshot().value,
    phase: () => requestPhase(actor.getSnapshot()),
    result: () => actor.getSnapshot().context.result,
    answer: (result: RoomsResult) => {
      actor.send({ type: "request.answered", result });
    },
  };
}

const disconnected: RoomsResult = { ok: false, code: "disconnected", message: "Disconnected." };

describe("roomsRequestMachine", () => {
  it("sends once and lands when the desktop answers", () => {
    const h = harness();
    expect(h.value()).toBe("pending");
    expect(h.phase()).toBe("busy");
    expect(h.sent).toEqual(["r1"]);
    h.answer({ ok: true, value: "x" });
    expect(h.value()).toEqual({ answered: "landed" });
    expect(h.phase()).toBe("done");
    expect(h.result()).toEqual({ ok: true, value: "x" });
  });

  it("a timeout is unconfirmed, not failed, and a late answer still settles it", () => {
    const h = harness();
    h.clock.increment(ROOMS_TIMEOUT_MS - 1);
    expect(h.value()).toBe("pending");
    h.clock.increment(1);
    expect(h.value()).toBe("unconfirmed");
    expect(h.phase()).toBe("unconfirmed");
    h.answer({ ok: true });
    expect(h.value()).toEqual({ answered: "landed" });
    expect(h.sent).toEqual(["r1"]);
  });

  it("Try again re-sends the same rid and restarts the wait", () => {
    const h = harness();
    h.clock.increment(ROOMS_TIMEOUT_MS);
    h.actor.send({ type: "request.retry" });
    expect(h.value()).toBe("pending");
    expect(h.sent).toEqual(["r1", "r1"]);
    h.clock.increment(ROOMS_TIMEOUT_MS - 1);
    expect(h.value()).toBe("pending");
    h.clock.increment(1);
    expect(h.value()).toBe("unconfirmed");
  });

  it("refuses Try again unless unconfirmed, and everything once settled", () => {
    const h = harness();
    expect(h.snapshot().can({ type: "request.retry" })).toBe(false);
    h.answer({ ok: true });
    expect(h.snapshot().can({ type: "request.retry" })).toBe(false);
    expect(h.snapshot().can({ type: "request.answered", result: { ok: true } })).toBe(false);
    expect(h.snapshot().can({ type: "request.cancelled", result: disconnected })).toBe(false);
    const failed = harness();
    failed.actor.send({ type: "request.cancelled", result: disconnected });
    expect(failed.snapshot().can({ type: "request.answered", result: { ok: true } })).toBe(false);
    expect(failed.snapshot().can({ type: "request.retry" })).toBe(false);
    expect(failed.sent).toEqual(["r1"]);
  });

  it("a desktop refusal fails it (guard refused)", () => {
    const h = harness();
    h.answer({ ok: false, code: "no-room", message: "Gone." });
    expect(h.value()).toBe("failed");
    expect(h.phase()).toBe("failed");
    expect(h.result()).toEqual({ ok: false, code: "no-room", message: "Gone." });
  });

  it("the host's timeout and device-gone leave it unconfirmed (guard outcomeUnknown)", () => {
    const h = harness();
    h.answer({ ok: false, code: "device-gone", message: "Your Mac disconnected" });
    expect(h.value()).toBe("unconfirmed");
    h.answer({ ok: false, code: "timeout", message: "Your Mac did not answer in time" });
    expect(h.value()).toBe("unconfirmed");
    h.answer({ ok: false, code: "no-desktop", message: "Open Relay" });
    expect(h.value()).toBe("failed");
  });

  it("request.cancelled fails a pending or an unconfirmed request", () => {
    const a = harness();
    a.actor.send({ type: "request.cancelled", result: disconnected });
    expect(a.value()).toBe("failed");
    expect(a.result()).toEqual(disconnected);
    const b = harness();
    b.clock.increment(ROOMS_TIMEOUT_MS);
    b.actor.send({ type: "request.cancelled", result: disconnected });
    expect(b.value()).toBe("failed");
  });

  it("a request refused before sending starts failed and sends nothing (guard refusedHere)", () => {
    const h = harness({ rid: "", refused: { ok: false, code: "offline", message: "Not connected to your Mac." } });
    expect(h.value()).toBe("failed");
    expect(h.sent).toEqual([]);
  });

  describe("landing (guard shown)", () => {
    it("stays busy after the answer until the room frame shows it", () => {
      const h = harness({ rid: "r1", view: "before" });
      h.answer({ ok: true });
      expect(h.value()).toEqual({ answered: "landing" });
      expect(h.phase()).toBe("busy");
      h.actor.send({ type: "room.changed", view: "before" });
      expect(h.value()).toEqual({ answered: "landing" });
      h.actor.send({ type: "room.changed", view: "after" });
      expect(h.value()).toEqual({ answered: "landed" });
    });

    it("lands at once when the frame moved before the answer", () => {
      const h = harness({ rid: "r1", view: "before" });
      h.actor.send({ type: "room.changed", view: "after" });
      expect(h.value()).toBe("pending");
      h.answer({ ok: true });
      expect(h.value()).toEqual({ answered: "landed" });
    });

    it("frees the card after a while when the frame never moves", () => {
      const h = harness({ rid: "r1", view: "before" });
      h.answer({ ok: true });
      h.clock.increment(ROOMS_LAND_MS - 1);
      expect(h.value()).toEqual({ answered: "landing" });
      h.clock.increment(1);
      expect(h.value()).toEqual({ answered: "landed" });
    });
  });
});
