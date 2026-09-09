import { describe, expect, it } from "vitest";
import { DictationMachine, type DictationEffect, type Scheduler } from "./machine";

interface ManualScheduler extends Scheduler {
  flush: (ms: number) => void;
  pendingCount: () => number;
}

/** Deterministic scheduler: timers fire only when the test calls `flush`. */
function manualScheduler(): ManualScheduler {
  let nextId = 0;
  const timers = new Map<number, { dueAt: number; callback: () => void }>();
  let elapsed = 0;
  return {
    after(ms, callback) {
      const id = nextId++;
      timers.set(id, { dueAt: elapsed + ms, callback });
      return () => {
        timers.delete(id);
      };
    },
    flush(ms) {
      elapsed += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.dueAt <= elapsed) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    pendingCount: () => timers.size,
  };
}

function harness(): { machine: DictationMachine; scheduler: ManualScheduler; effects: DictationEffect[] } {
  const scheduler = manualScheduler();
  const effects: DictationEffect[] = [];
  const machine = new DictationMachine({ scheduler, onEffect: (effect) => effects.push(effect) });
  return { machine, scheduler, effects };
}

describe("DictationMachine", () => {
  it("happy path: press, partials, stop, final, send, sent, back to idle", () => {
    const { machine, scheduler, effects } = harness();

    machine.send({ type: "pressStart" });
    expect(machine.getSnapshot().phase).toBe("requesting_permission");

    machine.send({ type: "permission", granted: true });
    expect(machine.getSnapshot().phase).toBe("listening");

    machine.send({ type: "partial", text: "hello" });
    machine.send({ type: "partial", text: "hello world" });
    expect(machine.getSnapshot().transcript).toBe("hello world");

    machine.send({ type: "pressStop" });
    expect(machine.getSnapshot().phase).toBe("finishing");

    machine.send({ type: "final", text: "hello world." });
    expect(machine.getSnapshot().phase).toBe("sending");
    expect(machine.getSnapshot().transcript).toBe("hello world.");
    expect(effects).toEqual([{ type: "send", text: "hello world." }]);

    machine.send({ type: "sendOk" });
    expect(machine.getSnapshot().phase).toBe("sent");

    scheduler.flush(900);
    expect(machine.getSnapshot().phase).toBe("idle");
  });

  it("stop with no final within 1.5s uses the last partial", () => {
    const { machine, scheduler, effects } = harness();

    machine.send({ type: "pressStart" });
    machine.send({ type: "permission", granted: true });
    machine.send({ type: "partial", text: "take this down" });
    machine.send({ type: "pressStop" });
    expect(machine.getSnapshot().phase).toBe("finishing");

    scheduler.flush(1500);
    expect(machine.getSnapshot().phase).toBe("sending");
    expect(machine.getSnapshot().transcript).toBe("take this down");
    expect(effects).toEqual([{ type: "send", text: "take this down" }]);
  });

  it("an empty transcript returns to idle with the nothingHeard flag", () => {
    const { machine, effects } = harness();

    machine.send({ type: "pressStart" });
    machine.send({ type: "permission", granted: true });
    machine.send({ type: "pressStop" });
    machine.send({ type: "final", text: "   " });

    expect(machine.getSnapshot()).toEqual({ phase: "idle", transcript: "", nothingHeard: true, errorCode: null });
    expect(effects).toEqual([]);
  });

  it("clears nothingHeard on the next pressStart", () => {
    const { machine } = harness();

    machine.send({ type: "pressStart" });
    machine.send({ type: "permission", granted: true });
    machine.send({ type: "pressStop" });
    machine.send({ type: "final", text: "" });
    expect(machine.getSnapshot().nothingHeard).toBe(true);

    machine.send({ type: "pressStart" });
    expect(machine.getSnapshot().nothingHeard).toBe(false);
  });

  it("permission denied moves to permission_denied, not listening", () => {
    const { machine } = harness();

    machine.send({ type: "pressStart" });
    machine.send({ type: "permission", granted: false });
    expect(machine.getSnapshot().phase).toBe("permission_denied");

    machine.send({ type: "pressStart" });
    expect(machine.getSnapshot().phase).toBe("requesting_permission");
  });

  it("a recognizer error from listening moves to error, and reset returns to idle", () => {
    const { machine } = harness();

    machine.send({ type: "pressStart" });
    machine.send({ type: "permission", granted: true });
    machine.send({ type: "recognizerError", code: "audio-capture" });

    expect(machine.getSnapshot()).toEqual({
      phase: "error",
      transcript: "",
      nothingHeard: false,
      errorCode: "audio-capture",
    });

    machine.send({ type: "reset" });
    expect(machine.getSnapshot().phase).toBe("idle");
  });

  it("a recognizer error from finishing cancels the finish timeout", () => {
    const { machine, scheduler } = harness();

    machine.send({ type: "pressStart" });
    machine.send({ type: "permission", granted: true });
    machine.send({ type: "pressStop" });
    machine.send({ type: "recognizerError", code: "network" });
    expect(machine.getSnapshot().phase).toBe("error");

    scheduler.flush(1500);
    expect(machine.getSnapshot().phase).toBe("error");
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("sendFailed(code) surfaces the code on the error state", () => {
    const { machine } = harness();

    machine.send({ type: "pressStart" });
    machine.send({ type: "permission", granted: true });
    machine.send({ type: "pressStop" });
    machine.send({ type: "final", text: "ship it" });
    expect(machine.getSnapshot().phase).toBe("sending");

    machine.send({ type: "sendFailed", code: "accessibility_denied" });
    expect(machine.getSnapshot()).toEqual({
      phase: "error",
      transcript: "ship it",
      nothingHeard: false,
      errorCode: "accessibility_denied",
    });
  });

  it("ignores stray events outside their phase", () => {
    const { machine, effects } = harness();

    machine.send({ type: "pressStop" });
    expect(machine.getSnapshot().phase).toBe("idle");

    machine.send({ type: "sendOk" });
    expect(machine.getSnapshot().phase).toBe("idle");
    expect(effects).toEqual([]);
  });
});
