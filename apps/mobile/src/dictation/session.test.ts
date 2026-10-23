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
import "./session";

beforeEach(() => {
  speech.calls.length = 0;
  useCallStore.getState().clear();
});

describe("Apple's recognizer ending", () => {
  it("hands the audio session back as playback only, deactivated", () => {
    expect(speech.ends).toHaveLength(1);
    speech.ends[0]?.();
    expect(speech.calls).toEqual(["category playback/default []", "active false"]);
  });

  it("leaves the session alone while a call has it", () => {
    useCallStore.getState().begin("c1", "astra");
    speech.ends[0]?.();
    expect(speech.calls).toEqual([]);
  });

  it("hands it back once the call has ended", () => {
    useCallStore.getState().begin("c1", "astra");
    useCallStore.getState().update("c1", { state: "ended", error: "Lost the connection to your Mac" });
    speech.ends[0]?.();
    expect(speech.calls).toEqual(["category playback/default []", "active false"]);
  });
});
