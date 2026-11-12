import { describe, expect, it } from "vitest";
import { createActor, fromPromise, waitFor } from "xstate";
import { CommandError } from "@/connection/commands";
import { askMachine, type AskReply } from "./ask.machine";

const answer: AskReply = { turn: { agent: "nova", clientId: "k1", text: "Yes" }, commands: [{ kind: "assistant.ask.resolve", agent: "nova", id: "0000000a", how: "answered", answer: "Yes" }] };
const dismiss: AskReply = { turn: null, commands: [{ kind: "assistant.ask.resolve", agent: "nova", id: "0000000a", how: "dismissed" }] };

/** An ask whose sends resolve or reject as the test says. */
function harness() {
  const sends: { reply: AskReply; attempt: number; resolve: () => void; reject: (error: unknown) => void }[] = [];
  const machine = askMachine.provide({
    actors: {
      deliver: fromPromise<null, { reply: AskReply; attempt: number }>(
        ({ input }) =>
          // Executor form: Hermes on the phone predates Promise.withResolvers.
          new Promise<null>((resolve, reject) => {
            sends.push({ ...input, resolve: () => { resolve(null); }, reject });
          }),
      ),
    },
  });
  const actor = createActor(machine).start();
  const reach = (state: "answered" | "dismissed" | "failed") => waitFor(actor, (snapshot) => snapshot.matches(state));
  return { actor, sends, reach, snapshot: () => actor.getSnapshot() };
}

describe("askMachine", () => {
  it("answers once: open, answering, answered", async () => {
    const h = harness();
    expect(h.snapshot().value).toBe("open");
    h.actor.send({ type: "ask.answer", reply: answer });
    expect(h.snapshot().value).toBe("answering");
    h.sends[0]?.resolve();
    await h.reach("answered");
  });

  it("refuses a second answer while the first is on its way or after it landed (card plus sheet sends once)", async () => {
    const h = harness();
    h.actor.send({ type: "ask.answer", reply: answer });
    expect(h.snapshot().can({ type: "ask.answer", reply: answer })).toBe(false);
    expect(h.snapshot().can({ type: "ask.dismiss", reply: dismiss })).toBe(false);
    h.actor.send({ type: "ask.answer", reply: answer });
    expect(h.sends).toHaveLength(1);
    h.sends[0]?.resolve();
    await h.reach("answered");
    expect(h.snapshot().can({ type: "ask.answer", reply: answer })).toBe(false);
    expect(h.snapshot().can({ type: "ask.retry" })).toBe(false);
  });

  it("keeps a timed-out answer as failed with its reason, and a retry sends the same unit again", async () => {
    const h = harness();
    h.actor.send({ type: "ask.answer", reply: answer });
    h.sends[0]?.reject(new CommandError("timeout", "command timed out waiting for an ack"));
    await h.reach("failed");
    expect(h.snapshot().context.failure).toBe("command timed out waiting for an ack");
    expect(h.snapshot().can({ type: "ask.retry" })).toBe(true);
    h.actor.send({ type: "ask.retry" });
    expect(h.snapshot().value).toBe("answering");
    expect(h.sends[1]).toMatchObject({ reply: answer, attempt: 1 });
    expect(h.snapshot().context.failure).toBeNull();
    h.sends[1]?.resolve();
    await h.reach("answered");
  });

  it("answers again from failed, and retries a failed dismissal as a dismissal", async () => {
    const h = harness();
    h.actor.send({ type: "ask.answer", reply: answer });
    h.sends[0]?.reject(new CommandError("internal", "no"));
    await h.reach("failed");
    h.actor.send({ type: "ask.answer", reply: answer });
    expect(h.snapshot().value).toBe("answering");

    const d = harness();
    d.actor.send({ type: "ask.dismiss", reply: dismiss });
    expect(d.snapshot().value).toBe("dismissing");
    d.sends[0]?.reject(new CommandError("timeout", "late"));
    await d.reach("failed");
    d.actor.send({ type: "ask.retry" });
    expect(d.snapshot().value).toBe("dismissing");
    d.sends[1]?.resolve();
    await d.reach("dismissed");
  });

  it("refuses a retry while open", () => {
    expect(harness().snapshot().can({ type: "ask.retry" })).toBe(false);
  });

  it("is gone when the host drops the ask, even while answering", () => {
    const h = harness();
    h.actor.send({ type: "ask.answer", reply: answer });
    h.actor.send({ type: "host.dropped" });
    expect(h.snapshot().value).toBe("gone");
    expect(h.snapshot().status).toBe("done");
  });
});
