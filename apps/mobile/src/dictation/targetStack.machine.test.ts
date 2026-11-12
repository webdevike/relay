import { describe, expect, it } from "vitest";
import { createActor } from "xstate";
import { INSERT, targetOf, targetStackMachine, type DictationTarget } from "./targetStack.machine";

const threadA: DictationTarget = { kind: "assistant", agent: "astra" };
const threadB: DictationTarget = { kind: "assistant", agent: "nova" };
const inbox: DictationTarget = { kind: "agent", sessionId: "s1" };

function harness() {
  const actor = createActor(targetStackMachine).start();
  let owners = 0;
  return {
    actor,
    target: () => targetOf(actor.getSnapshot()),
    push: (target: DictationTarget): (() => void) => {
      owners += 1;
      const owner = owners;
      actor.send({ type: "target.pushed", owner, target });
      return () => {
        actor.send({ type: "target.released", owner });
      };
    },
  };
}

describe("targetStackMachine", () => {
  it("inserts into the Mac with nobody owning dictation", () => {
    const h = harness();
    expect(h.actor.getSnapshot().value).toBe("insert");
    expect(h.target()).toBe(INSERT);
    // Nothing to release while nobody owns it.
    expect(h.actor.getSnapshot().can({ type: "target.released", owner: 1 })).toBe(false);
  });

  it("push A, push B, release A leaves B", () => {
    const h = harness();
    const releaseA = h.push(threadA);
    h.push(threadB);
    releaseA();
    expect(h.target()).toBe(threadB);
    expect(h.actor.getSnapshot().value).toBe("owned");
  });

  it("a second release of the same entry changes nothing", () => {
    const h = harness();
    h.push(threadA);
    const releaseB = h.push(threadB);
    releaseB();
    releaseB();
    expect(h.target()).toBe(threadA);
  });

  it("releasing the last owner goes back to inserting (lastOwner), twice is harmless", () => {
    const h = harness();
    const release = h.push(threadA);
    release();
    expect(h.actor.getSnapshot().value).toBe("insert");
    release();
    expect(h.target()).toBe(INSERT);
  });

  it("a borrower on top returns the target to the screen under it", () => {
    const h = harness();
    h.push(threadA);
    const releaseMeeting = h.push({ kind: "local", onText: () => Promise.resolve() });
    expect(h.target().kind).toBe("local");
    releaseMeeting();
    expect(h.target()).toBe(threadA);
  });

  it("the next screen's focus landing before the previous screen's blur keeps the new screen's target", () => {
    const h = harness();
    const releaseThread = h.push(threadA);
    // Pushing the inbox: its focus runs first, then the thread's blur cleanup.
    h.push(inbox);
    releaseThread();
    expect(h.target()).toBe(inbox);
  });

  it("blur before focus ends in the same place", () => {
    const h = harness();
    const releaseThread = h.push(threadA);
    releaseThread();
    h.push(inbox);
    expect(h.target()).toBe(inbox);
  });
});
