import { describe, expect, it } from "vitest";
import { useCallStore } from "@/state/call";
import { createCallFrameRouter, type CallPlayer } from "./frames";

function setup() {
  useCallStore.getState().clear();
  const played: string[] = [];
  let flushes = 0;
  const player: CallPlayer = {
    play: (pcm) => played.push(pcm),
    flush: () => {
      flushes += 1;
    },
  };
  const route = createCallFrameRouter({ update: useCallStore.getState().update, current: () => useCallStore.getState().call }, player);
  return { route, played, flushes: () => flushes };
}

describe("call frames", () => {
  it("applies the host's states to the current call and plays its audio in order", () => {
    const h = setup();
    useCallStore.getState().begin("c1", "astra");
    h.route({ t: "call.state", callId: "c1", agent: "astra", state: "listening" });
    h.route({ t: "call.state", callId: "c1", agent: "astra", state: "thinking", text: "what time is it" });
    h.route({ t: "call.audio", callId: "c1", gen: 0, pcm: "A" });
    h.route({ t: "call.audio", callId: "c1", gen: 0, pcm: "B" });
    expect(useCallStore.getState().call).toMatchObject({ state: "thinking", text: "what time is it", error: null });
    expect(h.played).toEqual(["A", "B"]);
  });

  it("barge-in: flushes the player and drops late audio of older generations", () => {
    const h = setup();
    useCallStore.getState().begin("c1", "astra");
    h.route({ t: "call.audio", callId: "c1", gen: 0, pcm: "old-1" });
    h.route({ t: "call.flush", callId: "c1", gen: 1 });
    h.route({ t: "call.audio", callId: "c1", gen: 0, pcm: "old-2" });
    h.route({ t: "call.audio", callId: "c1", gen: 1, pcm: "new" });
    expect(h.flushes()).toBe(1);
    expect(h.played).toEqual(["old-1", "new"]);
  });

  it("ignores frames of another call, and anything after the call ended", () => {
    const h = setup();
    useCallStore.getState().begin("c2", "nova");
    h.route({ t: "call.state", callId: "c1", agent: "astra", state: "speaking" });
    h.route({ t: "call.audio", callId: "c1", gen: 0, pcm: "stale" });
    expect(useCallStore.getState().call?.state).toBe("connecting");
    h.route({ t: "call.state", callId: "c2", agent: "nova", state: "ended", error: "speech models unavailable" });
    h.route({ t: "call.audio", callId: "c2", gen: 0, pcm: "late" });
    expect(useCallStore.getState().call).toMatchObject({ state: "ended", error: "speech models unavailable" });
    expect(h.played).toEqual([]);
  });

  it("starts each new call at generation zero", () => {
    const h = setup();
    useCallStore.getState().begin("c1", "astra");
    h.route({ t: "call.flush", callId: "c1", gen: 3 });
    useCallStore.getState().begin("c2", "astra");
    h.route({ t: "call.audio", callId: "c2", gen: 0, pcm: "first" });
    expect(h.played).toEqual(["first"]);
  });
});
