import { describe, expect, it } from "vitest";
import type { MeetingRecording } from "@relay/protocol";
import { meetingCardLine, meetingCardMeta, meetingMinutes } from "./card";

const MIN = 60_000;
const rec = (over: Partial<MeetingRecording> = {}): MeetingRecording => ({
  id: "6f1c2b8e-0d1a-4c55-9a51-3b2f0c7d9e10",
  app: "Zoom",
  title: "Weekly Sync",
  startedAt: 1_000_000,
  endedAt: null,
  device: "Mini",
  stage: "recording",
  health: "ok",
  healthDetail: "",
  error: null,
  shadow: false,
  stem: null,
  seconds: 0,
  assistant: "astra",
  routedByIsaac: false,
  ...over,
});

describe("meeting card", () => {
  it("reads as in progress with the call's clock while live", () => {
    const r = rec();
    expect(meetingCardLine(r, true)).toBe("Meeting in progress · Weekly Sync");
    expect(meetingCardMeta(r, true, r.startedAt + 65_000)).toBe("1:05");
    expect(meetingCardMeta(r, true, r.startedAt + 3_725_000)).toBe("1:02:05");
  });

  it("names an untitled call by its app", () => {
    expect(meetingCardLine(rec({ title: null }), true)).toBe("Meeting in progress · Zoom call");
  });

  it("says how long an ended call lasted, never 0 min", () => {
    const start = 1_000_000;
    expect(meetingMinutes({ startedAt: start, endedAt: start + 20 * 1000 })).toBe(1);
    expect(meetingMinutes({ startedAt: start, endedAt: start + 32 * MIN + 29_000 })).toBe(32);
    expect(meetingMinutes({ startedAt: start, endedAt: start + 32 * MIN + 31_000 })).toBe(33);
    expect(meetingMinutes({ startedAt: start, endedAt: null })).toBe(1);
    expect(meetingCardLine(rec({ stage: "summarizing", endedAt: start + 45 * MIN }), false)).toBe(
      "Meeting ended · 45 min · Weekly Sync",
    );
  });

  it("shows the notes' stage after the call, then Summary", () => {
    const ended = { endedAt: 1_000_000 + 10 * MIN };
    expect(meetingCardMeta(rec({ ...ended, stage: "summarizing" }), false, 0)).toBe("Writing notes");
    expect(meetingCardMeta(rec({ ...ended, stage: "failed" }), false, 0)).toBe("Failed");
    expect(meetingCardMeta(rec({ ...ended, stage: "done" }), false, 0)).toBe("Summary");
  });
});
