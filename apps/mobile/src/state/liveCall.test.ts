import { describe, expect, it } from "vitest";
import type { LiveCallSnapshot } from "../../modules/live-call";
import { nextLiveCall } from "./liveCall";

function snapshot(change: Partial<LiveCallSnapshot> = {}): LiveCallSnapshot {
  return { agent: "nova", callId: "c1", state: "listening", line: "", muted: false, fallback: false, startedAt: 1, ...change };
}

describe("nextLiveCall", () => {
  it("follows a running call", () => {
    expect(nextLiveCall(null, snapshot({ state: "connecting" }))).toMatchObject({ state: "connecting" });
    expect(nextLiveCall(snapshot(), snapshot({ state: "thinking", text: "what's on today" }))).toMatchObject({ state: "thinking", text: "what's on today" });
  });

  it("closes at once on a clean hang-up or a hand-over to the legacy call", () => {
    expect(nextLiveCall(snapshot(), snapshot({ state: "ended" }))).toBeNull();
    expect(nextLiveCall(snapshot({ state: "connecting" }), snapshot({ state: "ended", fallback: true, error: "Couldn't reach your Mac" }))).toBeNull();
  });

  it("keeps a call that ended on an error until it is dismissed", () => {
    const ended = snapshot({ state: "ended", error: "Lost the voice connection" });
    expect(nextLiveCall(snapshot(), ended)).toEqual(ended);
    // The engine has no call any more (`current()` is null), the error stays on screen.
    expect(nextLiveCall(ended, null)).toEqual(ended);
  });

  it("drops a running call the engine no longer has (missed while in the background)", () => {
    expect(nextLiveCall(snapshot(), null)).toBeNull();
  });

  it("ignores the late end of a call another one replaced", () => {
    const second = snapshot({ callId: "c2", agent: "astra", state: "connecting" });
    expect(nextLiveCall(second, snapshot({ state: "ended", error: "Hung up" }))).toBe(second);
  });
});
