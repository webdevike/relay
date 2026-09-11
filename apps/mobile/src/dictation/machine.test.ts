import { describe, expect, it } from "vitest";
import { createActor, fromCallback, fromPromise, SimulatedClock, waitFor, type Actor } from "xstate";
import {
  dictationMachine,
  orbOf,
  phaseOf,
  type DeliverInput,
  type PendingImage,
  type DictationPhase,
  type OrbState,
  type PermissionOutcome,
  type RecognizerCommand,
} from "./machine";

interface Harness {
  actor: Actor<typeof dictationMachine>;
  clock: SimulatedClock;
  /** Every `deliver` request the machine made, in order. */
  sends: DeliverInput[];
  /** `stop` commands the recognizer received. */
  recognizerStops: number;
  /** Resolve or reject the in-flight delivery; resolves once the machine has seen the result. */
  settleSend: (outcome?: { code: string }) => Promise<void>;
  recognizerAlive: () => boolean;
  /** `pressStart`, then wait for the permission check to land. */
  press: () => Promise<void>;
  phase: () => DictationPhase;
  orb: () => OrbState;
}

function harness(permission: PermissionOutcome = "granted"): Harness {
  const sends: DeliverInput[] = [];
  let inFlight: { promise: Promise<unknown>; settle: (outcome?: { code: string }) => void } | null = null;
  let recognizerAlive = false;
  const state = { recognizerStops: 0 };

  const machine = dictationMachine.provide({
    actors: {
      checkPermission: fromPromise<PermissionOutcome>(() => Promise.resolve(permission)),
      recognizer: fromCallback<RecognizerCommand>(({ receive }) => {
        recognizerAlive = true;
        receive(() => {
          state.recognizerStops += 1;
        });
        return () => {
          recognizerAlive = false;
        };
      }),
      deliver: fromPromise<null, DeliverInput>(({ input }) => {
        sends.push(input);
        // Executor form: the test runtime predates Promise.withResolvers.
        const promise = new Promise<null>((resolve, reject) => {
          inFlight = {
            promise: Promise.resolve(),
            settle: (outcome) => {
              if (outcome === undefined) resolve(null);
              else reject(Object.assign(new Error(outcome.code), outcome));
            },
          };
        });
        if (inFlight !== null) inFlight.promise = promise;
        return promise;
      }),
    },
  });
  const clock = new SimulatedClock();
  const actor = createActor(machine, { clock }).start();

  return {
    actor,
    clock,
    sends,
    get recognizerStops() {
      return state.recognizerStops;
    },
    settleSend: async (outcome) => {
      if (inFlight === null) throw new Error("no send in flight");
      const { promise, settle } = inFlight;
      inFlight = null;
      settle(outcome);
      // The machine's own continuation was attached first, so it has run by the time this resolves.
      await promise.catch(() => undefined);
    },
    recognizerAlive: () => recognizerAlive,
    press: async () => {
      actor.send({ type: "pressStart" });
      await waitFor(actor, (snapshot) => !snapshot.matches({ speech: "requesting_permission" }));
    },
    phase: () => phaseOf(actor.getSnapshot()),
    orb: () => orbOf(actor.getSnapshot()),
  };
}

/** Press and wait for permission: listening, finger still down. */
async function pressAndListen(h: Harness): Promise<void> {
  await h.press();
  expect(h.phase()).toBe("listening");
}

describe("dictationMachine", () => {
  it("pressStop with submit carries through to the delivery, and does not persist into the next dictation", async () => {
    const h = harness();
    await pressAndListen(h);
    h.actor.send({ type: "partial", text: "ship it" });
    h.actor.send({ type: "pressStop", submit: true });
    expect(h.recognizerStops).toBe(1);
    h.actor.send({ type: "final", text: "ship it" });
    expect(h.sends).toEqual([{ text: "ship it", submit: true, skill: null, images: [] }]);
    expect(h.actor.getSnapshot().context.submit).toBe(true);
    await h.settleSend();
    expect(h.phase()).toBe("sent");
    expect(h.actor.getSnapshot().context.submit).toBe(true);
    h.clock.increment(900);
    expect(h.phase()).toBe("idle");

    await pressAndListen(h);
    h.actor.send({ type: "release" });
    h.actor.send({ type: "final", text: "just text" });
    expect(h.sends[1]).toEqual({ text: "just text", submit: false, skill: null, images: [] });
  });

  it("any release ends the dictation, however short the press", async () => {
    const h = harness();
    await h.press();
    h.actor.send({ type: "release" });
    expect(h.phase()).toBe("finishing");
    expect(h.recognizerStops).toBe(1);
    h.actor.send({ type: "final", text: "quick one" });
    expect(h.sends).toEqual([{ text: "quick one", submit: false, skill: null, images: [] }]);
  });

  /** A machine whose permission check only resolves when the test says so. */
  function slowPermission(): { actor: Actor<typeof dictationMachine>; clock: SimulatedClock; grant: () => void } {
    let grant: () => void = () => undefined;
    const permission = new Promise<PermissionOutcome>((resolve) => {
      grant = () => {
        resolve("granted");
      };
    });
    const machine = dictationMachine.provide({
      actors: {
        checkPermission: fromPromise<PermissionOutcome>(() => permission),
        recognizer: fromCallback<RecognizerCommand>(() => undefined),
        deliver: fromPromise<null, DeliverInput>(() => Promise.resolve(null)),
      },
    });
    const clock = new SimulatedClock();
    const actor = createActor(machine, { clock }).start();
    return { actor, clock, grant };
  }

  it("a release that lands during a slow permission check ends the dictation as soon as listening opens", async () => {
    // The regression: the finger lifted before the check resolved and listening stayed open.
    const { actor, grant } = slowPermission();
    actor.send({ type: "pressStart" });
    actor.send({ type: "release" });
    grant();
    await waitFor(actor, (snapshot) => !snapshot.matches({ speech: "requesting_permission" }));
    expect(phaseOf(actor.getSnapshot())).toBe("finishing");
    actor.send({ type: "recognizerError", code: "no-speech" });
    expect(phaseOf(actor.getSnapshot())).toBe("idle");
    expect(actor.getSnapshot().context.nothingHeard).toBe(true);
  });

  it("a lost release is recovered by the next press", async () => {
    const h = harness();
    await h.press();
    h.actor.send({ type: "partial", text: "still here" });
    h.actor.send({ type: "pressStart" });
    expect(h.phase()).toBe("finishing");
    expect(h.recognizerStops).toBe(1);
    h.actor.send({ type: "final", text: "still here" });
    expect(h.sends).toEqual([{ text: "still here", submit: false, skill: null, images: [] }]);
  });

  it("a no-speech recognizer error is nothing heard, not a failure", async () => {
    const h = harness();
    await pressAndListen(h);
    h.actor.send({ type: "release" });
    h.actor.send({ type: "recognizerError", code: "no-speech" });
    expect(h.phase()).toBe("idle");
    expect(h.actor.getSnapshot().context).toMatchObject({ nothingHeard: true, errorCode: null });
    expect(h.orb()).toBe("fading");
  });

  it("orb: a plain dictation shows, collapses into the check at sent, then fades", async () => {
    const h = harness();
    expect(h.orb()).toBe("hidden");
    await pressAndListen(h);
    expect(h.orb()).toBe("shown");
    h.actor.send({ type: "partial", text: "hi" });
    h.actor.send({ type: "release" });
    expect(h.orb()).toBe("shown");
    h.actor.send({ type: "final", text: "hi" });
    expect(h.orb()).toBe("shown");
    await h.settleSend();
    expect(h.orb()).toBe("collapsing");
    h.clock.increment(900);
    expect(h.phase()).toBe("idle");
    expect(h.orb()).toBe("fading");
    h.clock.increment(180);
    expect(h.orb()).toBe("hidden");
  });

  it("orb: a swipe-submit lifts, flies on release, and the next hold starts from a fresh orb", async () => {
    const h = harness();
    await pressAndListen(h);
    h.actor.send({ type: "partial", text: "ship it" });
    h.actor.send({ type: "pressStop", submit: true });
    expect(h.orb()).toBe("lifted");
    h.actor.send({ type: "final", text: "ship it" });
    await h.settleSend();
    // Still held: the finger decides when it flies, however fast the Mac acks.
    expect(h.phase()).toBe("sent");
    expect(h.orb()).toBe("lifted");
    h.actor.send({ type: "release" });
    expect(h.orb()).toBe("flying");
    h.clock.increment(620);
    expect(h.orb()).toBe("gone");
    h.clock.increment(280);
    expect(h.phase()).toBe("idle");
    expect(h.orb()).toBe("hidden");

    await pressAndListen(h);
    expect(h.orb()).toBe("shown");
    h.actor.send({ type: "release" });
    expect(h.orb()).toBe("shown");
  });

  it("orb: flying outlasts a fast pipeline and stays gone until idle", async () => {
    const h = harness();
    await pressAndListen(h);
    h.actor.send({ type: "pressStop", submit: true });
    h.actor.send({ type: "release" });
    expect(h.orb()).toBe("flying");
    h.actor.send({ type: "final", text: "go" });
    await h.settleSend();
    expect(h.phase()).toBe("sent");
    expect(h.orb()).toBe("flying");
    h.clock.increment(620);
    expect(h.orb()).toBe("gone");
    h.clock.increment(300);
    expect(h.orb()).toBe("hidden");
  });

  it("orb: a lifted orb fades instead of flying when nothing was heard", async () => {
    const h = harness();
    await pressAndListen(h);
    h.actor.send({ type: "pressStop", submit: true });
    h.actor.send({ type: "final", text: "" });
    expect(h.phase()).toBe("idle");
    expect(h.orb()).toBe("lifted");
    h.actor.send({ type: "release" });
    expect(h.orb()).toBe("fading");
    expect(h.sends).toEqual([]);
  });

  it("orb: a recognizer error fades the orb; a new hold during the fade brings it back", async () => {
    const h = harness();
    await pressAndListen(h);
    h.actor.send({ type: "recognizerError", code: "network" });
    expect(h.orb()).toBe("fading");
    await pressAndListen(h);
    expect(h.orb()).toBe("shown");
  });

  it("happy path: press, partials, release, final, send, sent, back to idle", async () => {
    const h = harness();

    h.actor.send({ type: "pressStart" });
    expect(h.phase()).toBe("requesting_permission");
    await waitFor(h.actor, (snapshot) => snapshot.matches({ speech: "active" }));
    expect(h.phase()).toBe("listening");
    expect(h.recognizerAlive()).toBe(true);

    h.actor.send({ type: "partial", text: "hello" });
    h.actor.send({ type: "partial", text: "hello world" });
    expect(h.actor.getSnapshot().context.transcript).toBe("hello world");

    h.actor.send({ type: "release" });
    expect(h.phase()).toBe("finishing");
    expect(h.recognizerStops).toBe(1);

    h.actor.send({ type: "final", text: "hello world." });
    expect(h.phase()).toBe("sending");
    expect(h.recognizerAlive()).toBe(false);
    expect(h.actor.getSnapshot().context.transcript).toBe("hello world.");
    expect(h.sends).toEqual([{ text: "hello world.", submit: false, skill: null, images: [] }]);

    await h.settleSend();
    expect(h.phase()).toBe("sent");

    h.clock.increment(900);
    expect(h.phase()).toBe("idle");
  });

  it("release with no final within 1.5s uses the last partial", async () => {
    const h = harness();
    await pressAndListen(h);
    h.actor.send({ type: "partial", text: "take this down" });
    h.actor.send({ type: "release" });
    expect(h.phase()).toBe("finishing");

    h.clock.increment(1500);
    expect(h.phase()).toBe("sending");
    expect(h.sends).toEqual([{ text: "take this down", submit: false, skill: null, images: [] }]);
  });

  it("the recognizer ending during finishing finalizes with the last partial immediately", async () => {
    const h = harness();
    await pressAndListen(h);
    h.actor.send({ type: "partial", text: "done talking" });
    h.actor.send({ type: "release" });
    h.actor.send({ type: "recognizerEnd" });
    expect(h.phase()).toBe("sending");
    expect(h.sends).toEqual([{ text: "done talking", submit: false, skill: null, images: [] }]);
  });

  it("an empty transcript returns to idle with the nothingHeard flag, which clears after a hold", async () => {
    const h = harness();
    await pressAndListen(h);
    h.actor.send({ type: "release" });
    h.actor.send({ type: "final", text: "   " });

    expect(h.phase()).toBe("idle");
    expect(h.actor.getSnapshot().context).toMatchObject({ transcript: "", nothingHeard: true, errorCode: null, submit: false, skill: null, images: [] });
    expect(h.sends).toEqual([]);

    h.clock.increment(1500);
    expect(h.actor.getSnapshot().context.nothingHeard).toBe(false);
  });

  it("clears nothingHeard on the next pressStart", async () => {
    const h = harness();
    await pressAndListen(h);
    h.actor.send({ type: "release" });
    h.actor.send({ type: "final", text: "" });
    expect(h.actor.getSnapshot().context.nothingHeard).toBe(true);

    h.actor.send({ type: "pressStart" });
    expect(h.actor.getSnapshot().context.nothingHeard).toBe(false);
  });

  it("permission denied moves to permission_denied, not listening", async () => {
    const h = harness("denied");
    await h.press();
    expect(h.phase()).toBe("permission_denied");
    expect(h.recognizerAlive()).toBe(false);

    h.actor.send({ type: "pressStart" });
    expect(h.phase()).toBe("requesting_permission");
  });

  it("an unavailable recognizer surfaces service-not-allowed", async () => {
    const h = harness("unavailable");
    await h.press();
    expect(h.phase()).toBe("error");
    expect(h.actor.getSnapshot().context.errorCode).toBe("service-not-allowed");
  });

  it("a recognizer error from listening moves to error, which clears itself after the hold", async () => {
    const h = harness();
    await pressAndListen(h);
    h.actor.send({ type: "recognizerError", code: "audio-capture" });

    expect(h.phase()).toBe("error");
    expect(h.actor.getSnapshot().context).toMatchObject({
      transcript: "",
      nothingHeard: false,
      errorCode: "audio-capture",
      submit: false,
    });
    expect(h.recognizerAlive()).toBe(false);

    h.clock.increment(2500);
    expect(h.phase()).toBe("idle");
    expect(h.actor.getSnapshot().context.errorCode).toBeNull();
  });

  it("a recognizer error from finishing cancels the finish timeout", async () => {
    const h = harness();
    await pressAndListen(h);
    h.actor.send({ type: "release" });
    h.actor.send({ type: "recognizerError", code: "network" });
    expect(h.phase()).toBe("error");

    h.clock.increment(1500);
    expect(h.phase()).toBe("error");
    expect(h.sends).toEqual([]);
  });

  it("a failed delivery surfaces the ack code on the error state", async () => {
    const h = harness();
    await pressAndListen(h);
    h.actor.send({ type: "release" });
    h.actor.send({ type: "final", text: "ship it" });
    expect(h.phase()).toBe("sending");

    await h.settleSend({ code: "accessibility_denied" });
    expect(h.phase()).toBe("error");
    expect(h.actor.getSnapshot().context).toMatchObject({
      transcript: "ship it",
      errorCode: "accessibility_denied",
      submit: false,
    });
  });

  it("reset during sending ignores the late delivery result", async () => {
    const h = harness();
    await pressAndListen(h);
    h.actor.send({ type: "release" });
    h.actor.send({ type: "final", text: "late" });
    h.actor.send({ type: "reset" });
    expect(h.phase()).toBe("idle");
    await h.settleSend();
    expect(h.phase()).toBe("idle");
  });

  it("ignores stray events outside their phase", () => {
    const h = harness();
    h.actor.send({ type: "release" });
    h.actor.send({ type: "pressStop", submit: true });
    h.actor.send({ type: "final", text: "ghost" });
    expect(h.phase()).toBe("idle");
    expect(h.sends).toEqual([]);
    expect(h.orb()).toBe("hidden");
  });

  describe("skill wheel", () => {
    it("opening the wheel stops listening and drops what was heard; lifting on an entry arms it for the next hold", async () => {
      const h = harness();
      await pressAndListen(h);
      h.actor.send({ type: "partial", text: "half a thought" });
      h.actor.send({ type: "wheelOpen" });
      expect(h.phase()).toBe("choosing");
      expect(h.recognizerAlive()).toBe(false);
      expect(h.actor.getSnapshot().context.transcript).toBe("");
      expect(h.orb()).toBe("fading");

      h.actor.send({ type: "wheelSelect", skill: "/skill:deploy" });
      expect(h.phase()).toBe("chosen");
      h.actor.send({ type: "release" });
      expect(h.phase()).toBe("idle");
      expect(h.actor.getSnapshot().context.skill).toBe("/skill:deploy");
      expect(h.sends).toEqual([]);

      // The armed skill outlives the idle hold and the next press.
      h.clock.increment(1500);
      await pressAndListen(h);
      expect(h.actor.getSnapshot().context.skill).toBe("/skill:deploy");
      expect(h.orb()).toBe("shown");

      h.actor.send({ type: "pressStop", submit: true });
      h.actor.send({ type: "final", text: "to staging" });
      expect(h.sends).toEqual([{ text: "to staging", submit: true, skill: "/skill:deploy", images: [] }]);
      await h.settleSend();
      h.clock.increment(900);
      expect(h.phase()).toBe("idle");
      expect(h.actor.getSnapshot().context.skill).toBeNull();
    });

    it("lifting off the open wheel cancels: nothing delivered, no skill kept", async () => {
      const h = harness();
      await pressAndListen(h);
      h.actor.send({ type: "wheelOpen" });
      h.actor.send({ type: "release" });
      expect(h.phase()).toBe("idle");
      expect(h.actor.getSnapshot().context).toMatchObject({ skill: null, nothingHeard: false });
      expect(h.sends).toEqual([]);
    });

    it("sliding onto the close target shuts the wheel and disarms; the later release is a no-op", async () => {
      const h = harness();
      await pressAndListen(h);
      h.actor.send({ type: "wheelOpen" });
      h.actor.send({ type: "wheelSelect", skill: "/skill:deploy" });
      h.actor.send({ type: "release" });
      await pressAndListen(h);
      h.actor.send({ type: "wheelOpen" });
      h.actor.send({ type: "wheelClose" });
      expect(h.phase()).toBe("idle");
      expect(h.actor.getSnapshot().context).toMatchObject({ skill: null, nothingHeard: false });
      h.actor.send({ type: "release" });
      expect(h.phase()).toBe("idle");
      expect(h.sends).toEqual([]);
    });

    it("an armed dictation that hears nothing stays armed", async () => {
      const h = harness();
      await pressAndListen(h);
      h.actor.send({ type: "wheelOpen" });
      h.actor.send({ type: "wheelSelect", skill: "/skill:deploy" });
      h.actor.send({ type: "release" });
      await pressAndListen(h);
      h.actor.send({ type: "release" });
      h.actor.send({ type: "final", text: "" });
      expect(h.phase()).toBe("idle");
      expect(h.actor.getSnapshot().context).toMatchObject({ skill: "/skill:deploy", nothingHeard: true });
      h.clock.increment(1500);
      expect(h.actor.getSnapshot().context).toMatchObject({ skill: "/skill:deploy", nothingHeard: false });
    });

    it("wheel events outside listening/choosing are ignored", async () => {
      const h = harness();
      h.actor.send({ type: "wheelOpen" });
      h.actor.send({ type: "wheelSelect", skill: "/skill:deploy" });
      expect(h.phase()).toBe("idle");
      expect(h.actor.getSnapshot().context.skill).toBeNull();

      await pressAndListen(h);
      h.actor.send({ type: "wheelSelect", skill: "/skill:deploy" });
      expect(h.phase()).toBe("listening");
      expect(h.actor.getSnapshot().context.skill).toBeNull();
    });

    it("descending shows a subcommand ring while choosing; a pick or a fresh open leaves it", async () => {
      const h = harness();
      await pressAndListen(h);
      h.actor.send({ type: "wheelOpen" });
      h.actor.send({ type: "wheelDescend", parent: "/goal" });
      expect(h.phase()).toBe("choosing");
      expect(h.actor.getSnapshot().context.wheelParent).toBe("/goal");
      h.actor.send({ type: "wheelAscend" });
      expect(h.actor.getSnapshot().context.wheelParent).toBeNull();

      h.actor.send({ type: "wheelDescend", parent: "/goal" });
      h.actor.send({ type: "wheelSelect", skill: "/goal set" });
      expect(h.phase()).toBe("chosen");
      expect(h.actor.getSnapshot().context).toMatchObject({ skill: "/goal set", wheelParent: null });
      h.actor.send({ type: "release" });
      await pressAndListen(h);
      h.actor.send({ type: "wheelOpen" });
      expect(h.actor.getSnapshot().context.wheelParent).toBeNull();
    });

    it("a pick that takes no text is sent on its own right away, nothing armed afterwards", async () => {
      const h = harness();
      await pressAndListen(h);
      h.actor.send({ type: "wheelOpen" });
      h.actor.send({ type: "wheelDescend", parent: "/goal" });
      h.actor.send({ type: "wheelSelect", skill: "/goal show", submit: true });
      expect(h.phase()).toBe("sending");
      expect(h.sends).toEqual([{ text: "", submit: true, skill: "/goal show", images: [] }]);
      h.actor.send({ type: "release" });
      await h.settleSend();
      expect(h.phase()).toBe("sent");
      h.clock.increment(900);
      expect(h.phase()).toBe("idle");
      expect(h.actor.getSnapshot().context.skill).toBeNull();
    });

    it("arming while idle points the next dictation at the skill; arming null clears it", async () => {
      const h = harness();
      h.actor.send({ type: "arm", skill: "/goal set" });
      expect(h.actor.getSnapshot().context.skill).toBe("/goal set");
      await pressAndListen(h);
      h.actor.send({ type: "arm", skill: null });
      expect(h.actor.getSnapshot().context.skill).toBe("/goal set");
      h.actor.send({ type: "release" });
      h.actor.send({ type: "final", text: "ship relay" });
      expect(h.sends).toEqual([{ text: "ship relay", submit: false, skill: "/goal set", images: [] }]);
      await h.settleSend();
      h.clock.increment(900);
      h.actor.send({ type: "arm", skill: "/handoff" });
      h.actor.send({ type: "arm", skill: null });
      expect(h.actor.getSnapshot().context.skill).toBeNull();
    });
  });

  describe("attachments", () => {
    const shot = (n: number): PendingImage => ({ mimeType: "image/jpeg", data: `img${String(n)}`, width: 10, height: 20 });

    it("attached images ride along with the next dictation and are cleared once it is delivered", async () => {
      const h = harness();
      h.actor.send({ type: "attach", image: shot(1) });
      h.actor.send({ type: "attach", image: shot(2) });
      await pressAndListen(h);
      expect(h.actor.getSnapshot().context.images).toEqual([shot(1), shot(2)]);
      h.actor.send({ type: "release" });
      h.actor.send({ type: "final", text: "what is this" });
      expect(h.sends).toEqual([{ text: "what is this", submit: false, skill: null, images: [shot(1), shot(2)] }]);
      await h.settleSend();
      h.clock.increment(900);
      expect(h.phase()).toBe("idle");
      expect(h.actor.getSnapshot().context.images).toEqual([]);
    });

    it("sendAttachments sends the images on their own as a submitted, text-free turn", async () => {
      const h = harness();
      h.actor.send({ type: "sendAttachments" });
      expect(h.phase()).toBe("idle");
      h.actor.send({ type: "attach", image: shot(1) });
      h.actor.send({ type: "sendAttachments" });
      expect(h.phase()).toBe("sending");
      expect(h.sends).toEqual([{ text: "", submit: true, skill: null, images: [shot(1)] }]);
      await h.settleSend();
      expect(h.phase()).toBe("sent");
      expect(h.actor.getSnapshot().context.images).toEqual([]);
    });

    it("detach drops one image; a fifth attach is ignored", () => {
      const h = harness();
      for (let n = 1; n <= 5; n += 1) h.actor.send({ type: "attach", image: shot(n) });
      expect(h.actor.getSnapshot().context.images).toEqual([shot(1), shot(2), shot(3), shot(4)]);
      h.actor.send({ type: "detach", index: 1 });
      expect(h.actor.getSnapshot().context.images).toEqual([shot(1), shot(3), shot(4)]);
      h.actor.send({ type: "attach", image: shot(5) });
      expect(h.actor.getSnapshot().context.images).toEqual([shot(1), shot(3), shot(4), shot(5)]);
    });

    it("an armed dictation that hears nothing keeps its images; a failed send drops them", async () => {
      const h = harness();
      h.actor.send({ type: "attach", image: shot(1) });
      await pressAndListen(h);
      h.actor.send({ type: "release" });
      h.actor.send({ type: "recognizerEnd" });
      expect(h.phase()).toBe("idle");
      expect(h.actor.getSnapshot().context.images).toEqual([shot(1)]);
      h.actor.send({ type: "sendAttachments" });
      await h.settleSend({ code: "invalid_command" });
      expect(h.phase()).toBe("error");
      expect(h.actor.getSnapshot().context.images).toEqual([]);
    });
  });
});
