import { describe, expect, test } from "bun:test";
import { createActor, fromPromise, waitFor } from "xstate";
import { type SwitchInput, trialMachine } from "./trial.machine.ts";

const ARMS = ["m/a", "m/b", "m/c"];

const start = (switchModel: (input: SwitchInput) => Promise<void>) => {
  const calls: SwitchInput[] = [];
  const actor = createActor(
    trialMachine.provide({
      actors: {
        switchModel: fromPromise<void, SwitchInput>(({ input }) => {
          calls.push(input);
          return switchModel(input);
        }),
      },
    }),
    { input: { agent: "diagram" } },
  ).start();
  let at = 0;
  const pick = (winner: string | null) =>
    actor.send({ type: "pick.recorded", pick: { at: ++at, winner }, trialId: `t${at}` });
  return { actor, calls, pick };
};

describe("trial machine", () => {
  test("8 wins in the last 10 picks switches, with the deciding trial and the tally", async () => {
    const { actor, calls, pick } = start(async () => {});
    actor.send({ type: "trial.on", arms: ARMS, picks: [] });
    for (const winner of ["m/b", "m/a", "m/b", "m/b", null, "m/b", "m/b", "m/b", "m/b"])
      pick(winner);
    expect(actor.getSnapshot().value).toBe("trialing");
    pick("m/b");
    await waitFor(actor, (s) => s.matches("off"));
    expect(calls).toEqual([
      {
        agent: "diagram",
        arms: ARMS,
        decision: { winner: "m/b", wins: 8, of: 10, rule: "window" },
        trialId: "t10",
      },
    ]);
    expect(actor.getSnapshot().context.picks).toEqual([]);
  });

  test("a clear lead after 15 picks switches without 8 of the last 10", async () => {
    const { actor, calls, pick } = start(async () => {});
    actor.send({ type: "trial.on", arms: ARMS, picks: [] });
    // 9 to 4 to 2: never 8 of any 10 in a row, but twice the runner-up and 5 ahead at 15.
    const order = [
      "m/a",
      "m/b",
      "m/a",
      "m/c",
      "m/a",
      "m/b",
      "m/a",
      "m/b",
      "m/a",
      "m/c",
      "m/a",
      "m/b",
      "m/a",
      "m/a",
    ];
    for (const winner of order) pick(winner);
    expect(actor.getSnapshot().value).toBe("trialing");
    pick("m/a");
    await waitFor(actor, (s) => s.matches("off"));
    expect(calls[0]?.decision).toEqual({ winner: "m/a", wins: 9, of: 15, rule: "lead" });
  });

  test("picks while off count for nothing; Undo forgets the earlier count", () => {
    const { actor, pick } = start(async () => {});
    pick("m/b");
    expect(actor.getSnapshot().context.picks).toEqual([]);
    actor.send({ type: "trial.on", arms: ARMS, picks: [] });
    for (let i = 0; i < 7; i++) pick("m/b");
    actor.send({ type: "switch.undone" });
    expect(actor.getSnapshot().value).toBe("trialing");
    expect(actor.getSnapshot().context.picks).toEqual([]);
    for (let i = 0; i < 3; i++) pick("m/b");
    expect(actor.getSnapshot().value).toBe("trialing");
  });

  test("a switch that cannot be written keeps trialing, and the next pick tries again", async () => {
    let fail = true;
    const { actor, calls, pick } = start(async () => {
      if (fail) throw new Error("config.json is invalid");
    });
    actor.send({ type: "trial.on", arms: ARMS, picks: [] });
    for (let i = 0; i < 10; i++) pick("m/c");
    await waitFor(actor, (s) => s.matches("trialing") && s.context.error !== null);
    fail = false;
    pick("m/c");
    await waitFor(actor, (s) => s.matches("off"));
    expect(calls).toHaveLength(2);
  });

  test("new trial models start the count over; restored picks carry on after a restart", () => {
    const { actor, pick } = start(async () => {});
    actor.send({ type: "trial.on", arms: ARMS, picks: [{ at: 0, winner: "m/a" }] });
    pick("m/a");
    expect(actor.getSnapshot().context.picks).toHaveLength(2);
    actor.send({ type: "trial.on", arms: ["m/a", "m/new"], picks: [] });
    expect(actor.getSnapshot().context).toMatchObject({ arms: ["m/a", "m/new"], picks: [] });
    expect(actor.getSnapshot().can({ type: "trial.off" })).toBe(true);
  });
});
