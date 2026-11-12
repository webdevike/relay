import { describe, expect, it } from "vitest";
import { createActor, fromCallback, fromPromise, SimulatedClock, waitFor } from "xstate";
import { RelaySocket } from "@/connection/socket";
import { callView, legacyCallMachine, LOST_CONNECTION, NO_AUDIO_MS } from "./legacyCall.machine";

/** A microphone that never finishes opening. Executor form: the test runtime predates Promise.withResolvers. */
const stuckMic = (): Promise<void> => new Promise<void>(() => undefined);

/** A started legacy call actor with stub effects; `log` records them in order. */
function start(options: { mic?: () => Promise<void> } = {}) {
  const log: string[] = [];
  const clock = new SimulatedClock();
  const machine = legacyCallMachine.provide({
    actors: {
      openMic: fromPromise(async () => {
        log.push("openMic");
        await options.mic?.();
        return null;
      }),
      engineEvents: fromCallback(() => {
        log.push("listen");
        return () => log.push("unlisten");
      }),
    },
    actions: {
      sendStart: ({ context }) => log.push(`start ${String(context.callId)}`),
      sendEnd: ({ context }) => log.push(`end ${String(context.callId)}: ${context.endNote}`),
      release: () => log.push("release"),
    },
  });
  const actor = createActor(machine, { clock, input: { diagnostics: () => "diag" } }).start();
  return { actor, log, clock };
}

async function up(epoch = 1) {
  const s = start();
  s.actor.send({ type: "call.start", callId: "c1", agent: "astra", epoch });
  await waitFor(s.actor, (snapshot) => snapshot.matches({ active: "up" }));
  return s;
}

describe("legacy call machine", () => {
  it("opens the microphone, then sends call.start, then follows the host", async () => {
    const { actor, log } = await up();
    expect(actor.getSnapshot().value).toEqual({ active: { up: "connecting" } });
    expect(log).toEqual(["listen", "openMic", "start c1"]);
    actor.send({ type: "host.state", callId: "c1", state: "listening", text: null, error: null });
    expect(actor.getSnapshot().value).toEqual({ active: { up: "live" } });
    expect(callView(actor.getSnapshot())).toMatchObject({ id: "c1", state: "listening" });
    actor.send({ type: "host.state", callId: "c1", state: "thinking", text: "what time is it", error: null });
    expect(callView(actor.getSnapshot())).toMatchObject({ state: "thinking", text: "what time is it" });
  });

  it("socket.epochEnded for the call's epoch ends it; another epoch's end does not", async () => {
    const { actor, log } = await up(4);
    expect(actor.getSnapshot().can({ type: "socket.epochEnded", epoch: 3 })).toBe(false);
    actor.send({ type: "socket.epochEnded", epoch: 3 });
    expect(actor.getSnapshot().matches("active")).toBe(true);
    actor.send({ type: "socket.epochEnded", epoch: 4 });
    expect(actor.getSnapshot().value).toBe("ended");
    expect(callView(actor.getSnapshot())).toMatchObject({ state: "ended", error: LOST_CONNECTION });
    // The host dropped the call with its socket: nothing is sent, the engine stops.
    expect(log.slice(-2)).toEqual(["release", "unlisten"]);
  });

  it("ends while the microphone is still opening when its socket ends", () => {
    const { actor } = start({ mic: stuckMic });
    actor.send({ type: "call.start", callId: "c1", agent: "astra", epoch: 2 });
    actor.send({ type: "socket.epochEnded", epoch: 2 });
    expect(actor.getSnapshot().value).toBe("ended");
  });

  it("hangUp cancels the no-audio timer", async () => {
    const { actor, clock, log } = await up();
    actor.send({ type: "call.hangUp" });
    expect(actor.getSnapshot().value).toBe("idle");
    expect(log).toContain("end c1: hung up (diag)");
    clock.increment(NO_AUDIO_MS * 2);
    expect(actor.getSnapshot().value).toBe("idle");
    expect(log.filter((line) => line.includes("sent no audio"))).toEqual([]);
  });

  it("a deaf microphone ends the call after NO_AUDIO; a heard one does not", async () => {
    const deaf = await up();
    deaf.clock.increment(NO_AUDIO_MS);
    expect(deaf.actor.getSnapshot().value).toBe("ended");
    expect(callView(deaf.actor.getSnapshot())?.error).toBe("The microphone sent no audio (diag)");

    const heard = await up();
    heard.actor.send({ type: "mic.heard" });
    heard.actor.send({ type: "host.state", callId: "c1", state: "listening", text: null, error: null });
    heard.clock.increment(NO_AUDIO_MS);
    expect(heard.actor.getSnapshot().value).toEqual({ active: { up: "live" } });
  });

  it("a second start while the microphone opens is refused (double tap)", () => {
    const { actor, log } = start({ mic: stuckMic });
    actor.send({ type: "call.start", callId: "c1", agent: "astra", epoch: 1 });
    expect(actor.getSnapshot().can({ type: "call.start", callId: "c2", agent: "astra", epoch: 1 })).toBe(false);
    actor.send({ type: "call.start", callId: "c2", agent: "astra", epoch: 1 });
    expect(actor.getSnapshot().context.callId).toBe("c1");
    expect(log.filter((line) => line === "openMic")).toHaveLength(1);
  });

  it("a start while up ends the call first, then opens a new one", async () => {
    const { actor, log } = await up();
    log.length = 0;
    actor.send({ type: "call.start", callId: "c2", agent: "nova", epoch: 1 });
    expect(log).toEqual(["end c1: hung up (diag)", "release", "unlisten", "listen", "openMic"]);
    expect(actor.getSnapshot().context.callId).toBe("c2");
  });

  it("the host's ended without an error forgets the call; with one it keeps the error", async () => {
    const clean = await up();
    clean.actor.send({ type: "host.state", callId: "c1", state: "ended", text: null, error: null });
    expect(clean.actor.getSnapshot().value).toBe("idle");
    expect(callView(clean.actor.getSnapshot())).toBeNull();
    expect(clean.log.some((line) => line.startsWith("end "))).toBe(false);

    const failed = await up();
    failed.actor.send({ type: "host.state", callId: "c1", state: "ended", text: null, error: "speech models unavailable" });
    expect(failed.actor.getSnapshot().value).toBe("ended");
    expect(callView(failed.actor.getSnapshot())).toMatchObject({ state: "ended", error: "speech models unavailable" });
  });

  it("ignores host frames for another call", async () => {
    const { actor } = await up();
    expect(actor.getSnapshot().can({ type: "host.state", callId: "c0", state: "ended", text: null, error: null })).toBe(false);
  });

  it("a microphone that fails to open ends the call with its reason and never sends call.start", async () => {
    const { actor, log } = start({ mic: () => Promise.reject(new Error("Couldn't open the microphone.")) });
    actor.send({ type: "call.start", callId: "c1", agent: "astra", epoch: 1 });
    await waitFor(actor, (snapshot) => snapshot.matches("ended"));
    expect(callView(actor.getSnapshot())?.error).toBe("Couldn't open the microphone. (diag)");
    expect(log.some((line) => line.startsWith("start "))).toBe(false);
  });

  it("an interruption ends the call with a reason and tells the host", async () => {
    const { actor, log } = await up();
    actor.send({ type: "call.interrupted" });
    expect(actor.getSnapshot().value).toBe("ended");
    expect(log).toContain("end c1: The call was interrupted (diag)");
    actor.send({ type: "call.hangUp" });
    expect(callView(actor.getSnapshot())).toBeNull();
  });
});

describe("silent socket swap", () => {
  class FakeWebSocket {
    static readonly OPEN = 1;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    close(): void {
      this.readyState = 3;
    }
  }

  it("open() while open reports the old epoch closed and ends a legacy call on it", async () => {
    const saved = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    try {
      const socket = new RelaySocket();
      const closes: [number, boolean][] = [];
      socket.open("ws://mac/relay");
      const { actor } = await up(socket.epoch);
      socket.onClose = (epoch, local) => {
        closes.push([epoch, local]);
        actor.send({ type: "socket.epochEnded", epoch });
      };
      socket.open("ws://mac/relay");
      expect(closes).toEqual([[1, true]]);
      expect(socket.epoch).toBe(2);
      expect(callView(actor.getSnapshot())).toMatchObject({ state: "ended", error: LOST_CONNECTION });
    } finally {
      globalThis.WebSocket = saved;
    }
  });
});
