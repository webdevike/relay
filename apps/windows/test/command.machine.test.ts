import { describe, expect, it, vi } from "vitest";
import { createActor, fromCallback, SimulatedClock } from "xstate";
import { commandMachine, type CommandEvent, type CommandExit, type ProcessCommand } from "../src/agent/command.machine";

const input = { timeoutMs: 10_000, killGraceMs: 3_000 };
const exit: CommandExit = { exitCode: 0, stdout: "ok\n", stderr: "" };

/** The machine with a stub process: `exit` reports it finished; `kills` counts `process.kill`. */
function setup() {
  let report: ((event: CommandEvent) => void) | null = null;
  const kills = vi.fn();
  const stopped = vi.fn();
  const machine = commandMachine.provide({
    actors: {
      process: fromCallback<ProcessCommand>(({ sendBack, receive }) => {
        report = sendBack;
        receive(kills);
        return stopped;
      }),
    },
  });
  const clock = new SimulatedClock();
  const actor = createActor(machine, { input, clock }).start();
  const finish = (result: CommandExit): void => {
    report?.({ type: "process.exited", exit: result });
  };
  return { actor, clock, kills, stopped, finish };
}

describe("commandMachine", () => {
  it("returns the exit when the process finishes on its own", () => {
    const { actor, kills, stopped, finish } = setup();
    finish(exit);
    expect(actor.getSnapshot().value).toBe("exited");
    expect(actor.getSnapshot().output).toEqual({ exit });
    expect(kills).not.toHaveBeenCalled();
    expect(stopped).toHaveBeenCalledOnce();
  });

  it("kills the tree at the timeout and keeps what it printed before dying", () => {
    const { actor, clock, kills, finish } = setup();
    clock.increment(10_000);
    expect(actor.getSnapshot().matches({ live: "timingOut" })).toBe(true);
    expect(kills).toHaveBeenCalledOnce();
    finish({ exitCode: 1, stdout: "partial", stderr: "" });
    expect(actor.getSnapshot().value).toBe("timedOut");
    expect(actor.getSnapshot().output?.exit?.stdout).toBe("partial");
  });

  it("gives up on a process that ignores the kill after the grace period", () => {
    const { actor, clock, stopped } = setup();
    clock.increment(10_000);
    clock.increment(3_000);
    expect(actor.getSnapshot().value).toBe("timedOut");
    expect(actor.getSnapshot().output).toEqual({ exit: null });
    expect(stopped).toHaveBeenCalledOnce();
  });

  it("is cancelled when the agent hangs up, and the timeout passing meanwhile changes nothing", () => {
    const { actor, clock, kills, finish } = setup();
    clock.increment(9_000);
    actor.send({ type: "command.cancel" });
    expect(kills).toHaveBeenCalledOnce();
    clock.increment(2_000); // past the 10 s timeout, inside the 3 s grace
    expect(actor.getSnapshot().matches({ live: "cancelling" })).toBe(true);
    expect(kills).toHaveBeenCalledOnce();
    finish({ exitCode: null, stdout: "", stderr: "" });
    expect(actor.getSnapshot().value).toBe("cancelled");
  });

  it("cannot be cancelled once the process exited", () => {
    const { actor, finish } = setup();
    finish(exit);
    expect(actor.getSnapshot().can({ type: "command.cancel" })).toBe(false);
  });
});
