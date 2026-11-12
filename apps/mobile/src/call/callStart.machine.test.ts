import { describe, expect, it } from "vitest";
import { createActor } from "xstate";
import { callStartMachine } from "./callStart.machine";

describe("callStartMachine", () => {
  it("starts one call; taps while starting are refused", () => {
    const actor = createActor(callStartMachine).start();
    actor.send({ type: "call.start", agent: "eva" });
    expect(actor.getSnapshot().value).toBe("starting");
    expect(actor.getSnapshot().can({ type: "call.start", agent: "ops" })).toBe(false);
    actor.send({ type: "call.start", agent: "ops" });
    expect(actor.getSnapshot().context.agent).toBe("eva");
  });

  it("can start again once the start settled", () => {
    const actor = createActor(callStartMachine).start();
    actor.send({ type: "call.start", agent: "eva" });
    actor.send({ type: "call.settled" });
    expect(actor.getSnapshot().value).toBe("idle");
    expect(actor.getSnapshot().context.agent).toBeNull();
    expect(actor.getSnapshot().can({ type: "call.start", agent: "eva" })).toBe(true);
  });

  it("refuses settled while idle", () => {
    const actor = createActor(callStartMachine).start();
    expect(actor.getSnapshot().can({ type: "call.settled" })).toBe(false);
  });
});
