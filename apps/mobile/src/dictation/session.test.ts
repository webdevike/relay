import { beforeEach, describe, expect, it, vi } from "vitest";

/** Apple's recognizer: its `end` listeners, and the session calls made on it, in order. */
const speech = vi.hoisted(() => {
  const ends: (() => void)[] = [];
  const calls: string[] = [];
  return {
    ends,
    calls,
    module: {
      addListener: (name: string, listener: () => void) => {
        if (name === "end") ends.push(listener);
        return { remove: vi.fn() };
      },
      setCategoryIOS: (options: { category: string; categoryOptions: string[]; mode: string }) => {
        calls.push(`category ${options.category}/${options.mode} [${options.categoryOptions.join(",")}]`);
      },
      setAudioSessionActiveIOS: (active: boolean) => {
        calls.push(`active ${String(active)}`);
      },
    },
  };
});

vi.mock("expo-speech-recognition", () => ({ ExpoSpeechRecognitionModule: speech.module }));
vi.mock("@/connection/log", () => ({ warn: vi.fn() }));

import { useCallStore } from "@/state/call";
import { useLiveCallStore } from "@/state/liveCall";
import { audioOwner } from "./session";

const HANDED_BACK = ["category playback/default []", "active false"];

beforeEach(() => {
  useCallStore.getState().clear();
  useLiveCallStore.getState().dismiss();
  speech.ends[0]?.();
  speech.calls.length = 0;
});

/** Apple's recognizer starting: dictation claims the session (as `runApple` does). */
function startDictation(): void {
  audioOwner.send({ type: "dictation.started" });
}

describe("Apple's recognizer ending", () => {
  it("hands the audio session back as playback only, deactivated", () => {
    expect(speech.ends).toHaveLength(1);
    startDictation();
    speech.ends[0]?.();
    expect(speech.calls).toEqual(HANDED_BACK);
  });

  it("hands it back once, however many ends follow", () => {
    startDictation();
    speech.ends[0]?.();
    speech.ends[0]?.();
    expect(speech.calls).toEqual(HANDED_BACK);
  });

  it("leaves the session alone while a call has it", () => {
    useCallStore.getState().begin("c1", "astra");
    startDictation();
    speech.ends[0]?.();
    expect(speech.calls).toEqual([]);
  });

  it("hands it back once the call has ended under a dictation still running", () => {
    startDictation();
    useCallStore.getState().begin("c1", "astra");
    useCallStore.getState().update("c1", { state: "ended", error: "Lost the connection to your Mac" });
    speech.ends[0]?.();
    expect(speech.calls).toEqual(HANDED_BACK);
  });

  it("leaves a live call's session alone when the dictation under it ends, and after the call", () => {
    startDictation();
    useLiveCallStore.getState().apply({
      agent: "astra",
      callId: "l1",
      state: "listening",
      line: "",
      muted: false,
      fallback: false,
      startedAt: 0,
    });
    expect(audioOwner.getSnapshot().value).toBe("liveCall");
    speech.ends[0]?.();
    expect(speech.calls).toEqual([]);
    useLiveCallStore.getState().apply(null);
    expect(audioOwner.getSnapshot().value).toBe("none");
    expect(speech.calls).toEqual([]);
  });
});
