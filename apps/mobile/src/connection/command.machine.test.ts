import { describe, expect, it } from "vitest";
import { createActor, SimulatedClock } from "xstate";
import { commandMachine, QUEUED_TIMEOUT_MS, UNCONFIRMED_TTL_MS } from "./command.machine";

function harness(ackMs = 10_000) {
  const clock = new SimulatedClock();
  const actor = createActor(commandMachine, { input: { ackMs }, clock });
  const emitted: string[] = [];
  for (const type of ["outcome.acked", "outcome.nacked", "outcome.unconfirmed", "outcome.unsent", "outcome.cancelled"] as const) {
    actor.on(type, (event) => {
      emitted.push("late" in event && event.late ? `${event.type}:late` : event.type);
    });
  }
  actor.start();
  const snapshot = () => actor.getSnapshot();
  return { actor, clock, emitted, snapshot, value: () => snapshot().value };
}

/** Sent, then past the ack deadline: unconfirmed. */
function unconfirmed() {
  const h = harness();
  h.actor.send({ type: "command.sent" });
  h.clock.increment(10_000);
  return h;
}

describe("commandMachine", () => {
  it("starts queued and goes inflight once sent", () => {
    const h = harness();
    expect(h.value()).toBe("queued");
    h.actor.send({ type: "command.sent" });
    expect(h.value()).toBe("inflight");
  });

  it("acks from inflight", () => {
    const h = harness();
    h.actor.send({ type: "command.sent" });
    h.actor.send({ type: "command.acked" });
    expect(h.value()).toBe("acked");
    expect(h.emitted).toEqual(["outcome.acked"]);
  });

  it("keeps the nack's error", () => {
    const h = harness();
    h.actor.send({ type: "command.sent" });
    h.actor.send({ type: "command.nacked", error: { code: "invalid_command", message: "no" } });
    expect(h.value()).toBe("nacked");
    expect(h.snapshot().context.error).toEqual({ code: "invalid_command", message: "no" });
  });

  it("runs the ack deadline only while inflight: queued for longer than it never times out", () => {
    const h = harness();
    h.clock.increment(60_000);
    expect(h.value()).toBe("queued");
    h.actor.send({ type: "command.sent" });
    h.clock.increment(9_999);
    expect(h.value()).toBe("inflight");
    h.clock.increment(1);
    expect(h.value()).toBe("unconfirmed");
    expect(h.emitted).toEqual(["outcome.unconfirmed"]);
  });

  it("fails as unsent once queued past the never-sent deadline", () => {
    const h = harness();
    h.clock.increment(QUEUED_TIMEOUT_MS);
    expect(h.value()).toBe("unsent");
    expect(h.emitted).toEqual(["outcome.unsent"]);
  });

  it("goes back to queued when its socket closes, with no ack deadline running", () => {
    const h = harness();
    h.actor.send({ type: "command.sent" });
    h.clock.increment(9_000);
    h.actor.send({ type: "socket.closed" });
    h.clock.increment(30_000);
    expect(h.value()).toBe("queued");
    h.actor.send({ type: "command.sent" });
    h.clock.increment(9_000);
    expect(h.value()).toBe("inflight");
  });

  it("restarts the ack deadline when sent again while inflight", () => {
    const h = harness();
    h.actor.send({ type: "command.sent" });
    h.clock.increment(9_000);
    h.actor.send({ type: "command.sent" });
    h.clock.increment(9_000);
    expect(h.value()).toBe("inflight");
  });

  it("settles a late ack in unconfirmed as acked, reported late", () => {
    const h = unconfirmed();
    h.actor.send({ type: "command.acked" });
    expect(h.value()).toBe("acked");
    expect(h.emitted).toEqual(["outcome.unconfirmed", "outcome.acked:late"]);
  });

  it("settles a late nack in unconfirmed as nacked, reported late", () => {
    const h = unconfirmed();
    h.actor.send({ type: "command.nacked", error: { code: "internal", message: "x" } });
    expect(h.value()).toBe("nacked");
    expect(h.emitted).toEqual(["outcome.unconfirmed", "outcome.nacked:late"]);
  });

  it("retries an unconfirmed command: back to queued, then a fresh inflight", () => {
    const h = unconfirmed();
    h.actor.send({ type: "command.retry" });
    expect(h.value()).toBe("queued");
    h.actor.send({ type: "command.sent" });
    h.actor.send({ type: "command.acked" });
    expect(h.emitted).toEqual(["outcome.unconfirmed", "outcome.acked"]);
  });

  it("refuses a retry unless unconfirmed, and a socket drop unless inflight", () => {
    const h = harness();
    expect(h.snapshot().can({ type: "command.retry" })).toBe(false);
    expect(h.snapshot().can({ type: "socket.closed" })).toBe(false);
    h.actor.send({ type: "command.sent" });
    expect(h.snapshot().can({ type: "command.retry" })).toBe(false);
    expect(h.snapshot().can({ type: "socket.closed" })).toBe(true);
    const late = unconfirmed();
    expect(late.snapshot().can({ type: "command.retry" })).toBe(true);
    expect(late.snapshot().can({ type: "socket.closed" })).toBe(false);
    expect(late.snapshot().can({ type: "command.sent" })).toBe(false);
  });

  it("refuses everything once settled", () => {
    const h = harness();
    h.actor.send({ type: "command.sent" });
    h.actor.send({ type: "command.acked" });
    expect(h.snapshot().can({ type: "command.acked" })).toBe(false);
    expect(h.snapshot().can({ type: "command.nacked", error: { code: "internal", message: "x" } })).toBe(false);
    expect(h.snapshot().can({ type: "command.retry" })).toBe(false);
  });

  it("forgets an unconfirmed command after its time to live", () => {
    const h = unconfirmed();
    h.clock.increment(UNCONFIRMED_TTL_MS);
    expect(h.value()).toBe("expired");
    expect(h.snapshot().status).toBe("done");
  });

  it("cancels a pending command with a report, an unconfirmed one silently", () => {
    const pending = harness();
    pending.actor.send({ type: "command.cancel" });
    expect(pending.value()).toBe("cancelled");
    expect(pending.emitted).toEqual(["outcome.cancelled"]);
    const late = unconfirmed();
    late.actor.send({ type: "command.cancel" });
    expect(late.value()).toBe("expired");
    expect(late.emitted).toEqual(["outcome.unconfirmed"]);
  });

  it("acks a command its socket dropped before the ack, once the replay is answered", () => {
    const h = harness();
    h.actor.send({ type: "command.sent" });
    h.actor.send({ type: "socket.closed" });
    h.actor.send({ type: "command.acked" });
    expect(h.value()).toBe("acked");
  });
});
