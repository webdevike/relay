import { describe, expect, it } from "vitest";
import { createActor, fromPromise, SimulatedClock, waitFor } from "xstate";
import { CommandError } from "@/connection/commands";
import { ACKED_ECHO_MS, turnMachine } from "./turn.machine";

/** A turn whose attempts resolve or reject as the test says; `refusals` collects `reportRefusal`. */
function harness(options: { canRetry?: boolean; idle?: boolean } = {}) {
  const clock = new SimulatedClock();
  const attempts: { attempt: number; resolve: () => void; reject: (error: unknown) => void }[] = [];
  const refusals: unknown[] = [];
  const machine = turnMachine.provide({
    actors: {
      deliver: fromPromise<null, { attempt: number }>(
        ({ input }) =>
          // Executor form: Hermes on the phone predates Promise.withResolvers.
          new Promise<null>((resolve, reject) => {
            attempts.push({ attempt: input.attempt, resolve: () => { resolve(null); }, reject });
          }),
      ),
    },
    actions: {
      reportRefusal: (_, params) => {
        refusals.push(params.error);
      },
    },
    guards: { threadIdle: () => options.idle ?? true },
  });
  const actor = createActor(machine, { input: { agent: "nova", clientId: "k1", canRetry: options.canRetry ?? true }, clock }).start();
  const reach = (state: "sent" | "unconfirmed" | "refused") => waitFor(actor, (snapshot) => snapshot.matches(state));
  return { actor, clock, attempts, refusals, reach, snapshot: () => actor.getSnapshot(), value: () => actor.getSnapshot().value };
}

const timeout = new CommandError("timeout", "command timed out waiting for an ack");

/** A turn whose first attempt timed out. */
async function unconfirmed(options: { canRetry?: boolean } = {}) {
  const h = harness(options);
  h.attempts[0]?.reject(timeout);
  await h.reach("unconfirmed");
  return h;
}

describe("turnMachine", () => {
  it("is sending at once, and sent once acked", async () => {
    const h = harness();
    expect(h.value()).toBe("sending");
    h.attempts[0]?.resolve();
    await h.reach("sent");
  });

  it("keeps a timed-out turn as unconfirmed without reporting a refusal", async () => {
    const h = await unconfirmed();
    expect(h.refusals).toEqual([]);
  });

  it("is refused on a nack and reports it (the runtime gives the words back)", async () => {
    const h = harness();
    const nack = new CommandError("invalid_command", "no");
    h.attempts[0]?.reject(nack);
    await h.reach("refused");
    expect(h.refusals).toEqual([nack]);
  });

  it("tries again from unconfirmed as a new attempt of the same turn", async () => {
    const h = await unconfirmed();
    h.actor.send({ type: "turn.retry" });
    expect(h.value()).toBe("sending");
    expect(h.attempts.map((a) => a.attempt)).toEqual([0, 1]);
    h.attempts[1]?.resolve();
    await h.reach("sent");
  });

  it("refuses Try again while sending or sent, and for a turn that cannot be sent as itself", async () => {
    const h = harness();
    expect(h.snapshot().can({ type: "turn.retry" })).toBe(false);
    expect(h.snapshot().can({ type: "turn.dismiss" })).toBe(false);
    h.attempts[0]?.resolve();
    await h.reach("sent");
    expect(h.snapshot().can({ type: "turn.retry" })).toBe(false);
    const fixed = await unconfirmed({ canRetry: false });
    expect(fixed.snapshot().can({ type: "turn.retry" })).toBe(false);
    expect(fixed.snapshot().can({ type: "turn.dismiss" })).toBe(true);
  });

  it("takes a late ack as sent and a late nack as refused", async () => {
    const acked = await unconfirmed();
    acked.actor.send({ type: "command.lateAck" });
    expect(acked.value()).toBe("sent");

    const nacked = await unconfirmed();
    nacked.actor.send({ type: "command.lateNack", error: "no" });
    expect(nacked.value()).toBe("refused");
    expect(nacked.refusals).toEqual(["no"]);
  });

  it("lets Isaac dismiss a stuck unconfirmed echo", async () => {
    const h = await unconfirmed();
    h.actor.send({ type: "turn.dismiss" });
    expect(h.value()).toBe("dismissed");
  });

  it("settles from any state once its row lands", () => {
    const h = harness();
    h.actor.send({ type: "turn.landed" });
    expect(h.value()).toBe("settled");
    expect(h.snapshot().status).toBe("done");
  });

  it("settles a sent turn that left no row once the thread has been idle for ACKED_ECHO_MS, and keeps it while busy", async () => {
    const idle = harness({ idle: true });
    idle.attempts[0]?.resolve();
    await idle.reach("sent");
    idle.clock.increment(ACKED_ECHO_MS);
    expect(idle.value()).toBe("settled");

    const busy = harness({ idle: false });
    busy.attempts[0]?.resolve();
    await busy.reach("sent");
    busy.clock.increment(ACKED_ECHO_MS);
    expect(busy.value()).toBe("sent");
  });
});
