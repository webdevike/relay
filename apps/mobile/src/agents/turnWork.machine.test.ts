import { describe, expect, it } from "vitest";
import { createActor, fromCallback, fromPromise, SimulatedClock, waitFor } from "xstate";
import type { TurnWork, TurnWorkDetail } from "@relay/protocol";
import {
  REFRESH_MS,
  turnWorkMachine,
  type DetailInput,
  type TurnWorkEvent,
  type WorkAnswer,
  type WorkTarget,
} from "./turnWork.machine";

const work = (over: Partial<TurnWork> = {}): TurnWork => ({
  at: 1_000,
  running: false,
  modelMs: 4_000,
  steps: [],
  ...over,
});

/** The machine with the host stubbed: each fetch waits for the test to answer it. */
function harness() {
  const clock = new SimulatedClock();
  const asked: WorkTarget[] = [];
  const answers: ((answer: WorkAnswer) => void)[] = [];
  const details: {
    input: DetailInput;
    reply: (event: { ok: true; detail: TurnWorkDetail } | { ok: false; error: string }) => void;
  }[] = [];
  const machine = turnWorkMachine.provide({
    actors: {
      fetchWork: fromPromise<WorkAnswer, WorkTarget>(({ input }) => {
        asked.push(input);
        // Executor form: the phone's TypeScript lib predates Promise.withResolvers.
        return new Promise<WorkAnswer>((resolve) => answers.push(resolve));
      }),
      fetchDetail: fromCallback<TurnWorkEvent, DetailInput>(({ input, sendBack }) => {
        details.push({
          input,
          reply: (answer) => {
            sendBack(
              answer.ok
                ? {
                    type: "detail.loaded",
                    id: input.id,
                    generation: input.generation,
                    detail: answer.detail,
                  }
                : {
                    type: "detail.failed",
                    id: input.id,
                    generation: input.generation,
                    error: answer.error,
                  },
            );
          },
        });
      }),
    },
  });
  const actor = createActor(machine, { clock }).start();
  const answer = async (reply: WorkAnswer) => {
    const resolve = answers.shift();
    if (resolve === undefined) throw new Error("nothing asked");
    resolve(reply);
    await waitFor(actor, (s) => !s.matches("loading") && !s.matches({ shown: "refreshing" }));
  };
  return {
    actor,
    clock,
    asked,
    details,
    answer,
    value: () => actor.getSnapshot().value,
    context: () => actor.getSnapshot().context,
  };
}

describe("turnWorkMachine", () => {
  it("fetches nothing until a brain is tapped, then shows a settled turn without asking again", async () => {
    const h = harness();
    expect(h.value()).toBe("closed");
    expect(h.asked).toEqual([]);
    h.actor.send({ type: "sheet.open", target: { agent: "nova", at: 3_000, row: "r9" } });
    expect(h.value()).toBe("loading");
    await h.answer({ ok: true, work: work() });
    expect(h.value()).toEqual({ shown: "settled" });
    h.clock.increment(REFRESH_MS * 3);
    h.actor.send({ type: "thread.changed" });
    expect(h.asked).toHaveLength(1);
  });

  it("asks again while the turn runs, pinned to the turn's own start, until it is done", async () => {
    const h = harness();
    h.actor.send({ type: "sheet.open", target: { agent: "nova" } });
    await h.answer({ ok: true, work: work({ running: true, at: 5_000 }) });
    expect(h.value()).toEqual({ shown: "live" });
    h.clock.increment(REFRESH_MS);
    expect(h.value()).toEqual({ shown: "refreshing" });
    // The newest turn asked once; every refresh asks for that same turn, so a new one never takes the sheet over.
    expect(h.asked[1]).toEqual({ agent: "nova", at: 5_000 });
    await h.answer({ ok: true, work: work({ running: true, at: 5_000, steps: [] }) });
    h.actor.send({ type: "thread.changed" });
    expect(h.value()).toEqual({ shown: "refreshing" });
    await h.answer({ ok: true, work: work({ running: false, at: 5_000 }) });
    expect(h.value()).toEqual({ shown: "settled" });
  });

  it("keeps what shows when a refresh fails, and fails the sheet only when the first fetch does", async () => {
    const h = harness();
    h.actor.send({ type: "sheet.open", target: { agent: "nova" } });
    await h.answer({ ok: true, work: work({ running: true }) });
    h.clock.increment(REFRESH_MS);
    await h.answer({ ok: false, error: "Your Mac did not answer." });
    expect(h.value()).toEqual({ shown: "live" });
    expect(h.context().work?.running).toBe(true);
    h.actor.send({ type: "sheet.open", target: { agent: "nova", at: 1 } });
    await h.answer({ ok: false, error: "Nova's transcript could not be read." });
    expect(h.value()).toBe("failed");
    expect(h.context().error).toBe("Nova's transcript could not be read.");
    h.actor.send({ type: "sheet.retry" });
    expect(h.value()).toBe("loading");
  });

  it("fetches a part's full text the first time it opens only", async () => {
    const h = harness();
    h.actor.send({ type: "sheet.open", target: { agent: "nova", at: 1_000 } });
    await h.answer({ ok: true, work: work() });
    h.actor.send({ type: "part.toggle", id: "step-1" });
    expect(h.context().open).toEqual(["step-1"]);
    expect(h.context().parts["step-1"]).toEqual({ state: "loading" });
    expect(h.details.map((d) => d.input)).toEqual([
      { target: { agent: "nova", at: 1_000 }, id: "step-1", generation: 1 },
    ]);
    h.details[0]?.reply({ ok: true, detail: { input: "ls", output: "a\nb" } });
    expect(h.context().parts["step-1"]).toEqual({
      state: "loaded",
      detail: { input: "ls", output: "a\nb" },
    });
    h.actor.send({ type: "part.toggle", id: "step-1" });
    h.actor.send({ type: "part.toggle", id: "step-1" });
    expect(h.context().open).toEqual(["step-1"]);
    expect(h.details).toHaveLength(1);
  });

  it("asks again for a part that failed, and drops an answer for a sheet already closed", async () => {
    const h = harness();
    h.actor.send({ type: "sheet.open", target: { agent: "nova", at: 1_000 } });
    await h.answer({ ok: true, work: work() });
    h.actor.send({ type: "part.toggle", id: "thinking" });
    h.details[0]?.reply({ ok: false, error: "Disconnected." });
    expect(h.context().parts["thinking"]).toEqual({ state: "failed", error: "Disconnected." });
    h.actor.send({ type: "part.toggle", id: "thinking" });
    h.actor.send({ type: "part.toggle", id: "thinking" });
    expect(h.details).toHaveLength(2);
    h.actor.send({ type: "sheet.close" });
    expect(h.value()).toBe("closed");
    h.details[1]?.reply({ ok: true, detail: { text: "late" } });
    expect(h.context().parts).toEqual({});
    // Closed, a part cannot be opened: no fetch goes out.
    expect(h.actor.getSnapshot().can({ type: "part.toggle", id: "x" })).toBe(false);
  });
});
