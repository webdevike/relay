import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage } from "@relay/protocol";

/**
 * The native module, recording `start` and `stop` in call order (the real module runs them in that
 * order on one queue), so whether the microphone is open is whichever of the two came last.
 */
const native = vi.hoisted(() => {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const fake = {
    ops: [] as ("start" | "stop")[],
    /** A start that throws; the real module closes what it opened before rethrowing. */
    failStart: null as Error | null,
    /** When set, `start` stays pending until `release` is called. */
    hold: false,
    release: null as (() => void) | null,
    listeners,
    requestPermission: () => Promise.resolve(true),
    start: (): Promise<void> => {
      if (fake.failStart !== null) return Promise.reject(fake.failStart);
      fake.ops.push("start");
      if (!fake.hold) return Promise.resolve();
      return new Promise<void>((resolve) => {
        fake.release = resolve;
      });
    },
    stop: () => {
      fake.ops.push("stop");
    },
    setMuted: vi.fn(),
    play: vi.fn(),
    flush: vi.fn(),
    diagnostics: () => "engine",
    addListener: (name: string, listener: (event: unknown) => void) => {
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set);
      set.add(listener);
      return {
        remove: () => {
          set.delete(listener);
        },
      };
    },
    emit: (name: string, event: unknown = {}) => {
      for (const listener of listeners.get(name) ?? []) listener(event);
    },
  };
  return fake;
});
const sent = vi.hoisted(() => [] as ClientMessage[]);
const ids = vi.hoisted(() => ({ next: 0 }));

vi.mock("../../modules/voice-call", () => ({ VoiceCall: native }));
vi.mock("@/connection", () => ({
  sendCall: (message: ClientMessage) => {
    sent.push(message);
  },
}));
vi.mock("expo-crypto", () => ({
  randomUUID: () => {
    ids.next += 1;
    return `call-${String(ids.next)}`;
  },
}));

import { useCallStore } from "@/state/call";
import { useConnectionStore } from "@/state/connection";
import { createCallFrameRouter } from "./frames";
import { hangUp, leaveCall, setCallMuted, startCall } from "./controller";

const route = createCallFrameRouter(
  { update: useCallStore.getState().update, current: () => useCallStore.getState().call },
  { play: vi.fn(), flush: vi.fn() },
);

function micOpen(): boolean {
  return native.ops.lastIndexOf("start") > native.ops.lastIndexOf("stop");
}

function listening(): number {
  let count = 0;
  for (const set of native.listeners.values()) count += set.size;
  return count;
}

function sentOf(type: ClientMessage["t"]): ClientMessage[] {
  return sent.filter((message) => message.t === type);
}

/** A call with `agent` that is up: microphone open, `call.start` sent. */
async function live(agent = "astra"): Promise<string> {
  await startCall(agent);
  const call = useCallStore.getState().call;
  if (call === null) throw new Error("no call");
  expect(micOpen()).toBe(true);
  expect(listening()).toBe(3);
  return call.id;
}

/** The microphone is closed and nothing of the call is listening for the engine any more. */
function expectReleased(): void {
  expect(micOpen()).toBe(false);
  expect(listening()).toBe(0);
}

beforeEach(() => {
  // The deaf-microphone check is a 3 s timer; it never fires here.
  vi.useFakeTimers();
  hangUp();
  native.ops.length = 0;
  native.failStart = null;
  native.hold = false;
  native.release = null;
  native.listeners.clear();
  sent.length = 0;
  useConnectionStore.setState({ status: "connected" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a call that ends cleanly releases the microphone and closes onto the thread", () => {
  it("hanging up stops the engine, tells the host, and forgets the call at once", async () => {
    const id = await live();
    hangUp();
    expectReleased();
    expect(useCallStore.getState().call).toBeNull();
    expect(sentOf("call.end")).toMatchObject([{ t: "call.end", callId: id }]);
  });

  it("hanging up while muted does the same", async () => {
    await live();
    setCallMuted(true);
    hangUp();
    expectReleased();
    expect(useCallStore.getState().call).toBeNull();
  });

  it("the assistant hanging up (the host's call.state ended) does the same, foreground or background", async () => {
    const id = await live();
    route({ t: "call.state", callId: id, agent: "astra", state: "ended" });
    expectReleased();
    expect(useCallStore.getState().call).toBeNull();
    // The host ended it; the phone does not echo a hang-up back.
    expect(sentOf("call.end")).toEqual([]);
  });

  it("its screen going away mid-call (the thread unmounting) hangs up", async () => {
    const id = await live();
    leaveCall(id);
    expectReleased();
    expect(useCallStore.getState().call).toBeNull();
    expect(sentOf("call.end")).toMatchObject([{ callId: id }]);
  });

  it("a screen of an earlier call going away leaves the newer call alone", async () => {
    const first = await live();
    const second = await live("nova");
    expect(second).not.toBe(first);
    leaveCall(first);
    expect(micOpen()).toBe(true);
    expect(useCallStore.getState().call).toMatchObject({ id: second, state: "connecting" });
  });

  it("calling again ends the call before opening a new one", async () => {
    const first = await live();
    const opened = native.ops.length;
    await live();
    // The first call's engine stops before the second one's starts.
    expect(native.ops.slice(opened, -1)).toContain("stop");
    expect(native.ops.at(-1)).toBe("start");
    expect(sentOf("call.end")).toMatchObject([{ callId: first }]);
  });
});

describe("a call that ends on an error releases the microphone and keeps the error until Close", () => {
  const ends: [string, (id: string) => void][] = [
    ["the host failing", (id) => {
      route({ t: "call.state", callId: id, agent: "astra", state: "ended", error: "speech models unavailable" });
    }],
    ["the socket dropping", (id) => {
      useCallStore.getState().update(id, { state: "ended", error: "Lost the connection to your Mac" });
    }],
    ["iOS taking the audio session", () => {
      native.emit("interrupted");
    }],
    ["the microphone sending nothing", () => {
      vi.advanceTimersByTime(3_000);
    }],
  ];

  it.each(ends)("%s", async (_, end) => {
    const id = await live();
    end(id);
    expectReleased();
    expect(useCallStore.getState().call).toMatchObject({ id, state: "ended", error: expect.any(String) as string });
    hangUp();
    expectReleased();
    expect(useCallStore.getState().call).toBeNull();
  });

  it("the microphone failing to open", async () => {
    native.failStart = new Error("Couldn't open the microphone.");
    await startCall("astra");
    expectReleased();
    expect(useCallStore.getState().call).toMatchObject({ state: "ended", error: expect.stringContaining("Couldn't open the microphone.") as string });
    expect(sentOf("call.start")).toEqual([]);
  });
});

describe("a call ended while its microphone is opening", () => {
  it("closes the microphone once it has opened and never starts the call on the host", async () => {
    native.hold = true;
    const opening = startCall("astra");
    await vi.waitFor(() => {
      expect(native.ops).toContain("start");
    });
    hangUp();
    native.release?.();
    await opening;
    expectReleased();
    expect(useCallStore.getState().call).toBeNull();
    expect(sentOf("call.start")).toEqual([]);
  });
});
