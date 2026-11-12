import { beforeEach, describe, expect, it } from "vitest";
import { meetingCardsFor, type MeetingRecording, type MeetingSnapshot } from "@relay/protocol";
import { useMeetingsStore } from "@/state/meetings";
import { createMeetingsFrameRouter, PendingMeetings } from "./meetings";

const ID = "6f1c2b8e-0d1a-4c55-9a51-3b2f0c7d9e10";
const rec = (over: Partial<MeetingRecording> = {}): MeetingRecording => ({
  id: ID,
  app: "Zoom",
  title: "Sync",
  startedAt: 1,
  endedAt: null,
  device: "Mini",
  stage: "recording",
  health: "ok",
  healthDetail: "Hearing Zoom and your mic",
  error: null,
  shadow: true,
  stem: null,
  seconds: 0,
  assistant: null,
  ...over,
});
const line = (id: string, text: string, final = true) => ({
  id,
  track: "app" as const,
  speaker: "Remote",
  startMs: 0,
  endMs: 1000,
  text,
  final,
});

beforeEach(() => {
  useMeetingsStore.getState().clear();
});

describe("meetings frames", () => {
  it("keeps the list, a page's lines and Astra current", async () => {
    const pending = new PendingMeetings();
    const route = createMeetingsFrameRouter(useMeetingsStore.getState(), pending);
    route({
      t: "meetings.state",
      recordings: [],
      meetings: [],
      digest: { recentCount: 0, waiting: [], out: [], decisions: [] },
      now: 1,
    });
    route({ t: "meeting.recording", recording: rec() });
    expect(useMeetingsStore.getState().state?.recordings.map((r) => r.id)).toEqual([ID]);

    const answer = pending.add("r1", { kind: "open", id: ID });
    const snapshot: MeetingSnapshot = {
      recording: rec(),
      rev: 1,
      lines: [line("a", "Hel", false)],
      astra: null,
      notes: null,
    };
    route({ t: "meetings.res", rid: "r1", ok: true, snapshot });
    expect((await answer).ok).toBe(true);
    route({ t: "meeting.live", id: ID, rev: 2, upsert: [line("a", "Hello")] });
    expect(useMeetingsStore.getState().pages[ID]?.lines).toEqual([line("a", "Hello")]);
    route({ t: "meeting.recording", recording: rec({ stage: "summarizing" }) });
    expect(useMeetingsStore.getState().pages[ID]?.recording.stage).toBe("summarizing");

    const item = {
      url: "u",
      title: "t",
      sessionId: null,
      turns: [{ id: "q", role: "user" as const, text: "When?", streaming: false }],
      working: true,
      waiting: null,
      error: null,
    };
    const asked = pending.add("r2", { kind: "ask", id: ID, question: "When?" });
    route({ t: "meetings.res", rid: "r2", ok: true, astra: item });
    await asked;
    expect(useMeetingsStore.getState().pages[ID]?.astra?.working).toBe(true);
  });

  it("moves a recording to the chat it is routed to, and its card with it", () => {
    const route = createMeetingsFrameRouter(useMeetingsStore.getState(), new PendingMeetings());
    route({
      t: "meetings.state",
      recordings: [rec({ assistant: "astra" })],
      meetings: [],
      digest: { recentCount: 0, waiting: [], out: [], decisions: [] },
      now: 1,
    });
    const cards = (agent: string) =>
      meetingCardsFor(useMeetingsStore.getState().state?.recordings ?? [], agent, 2).map((c) => c.recording.id);
    expect(cards("astra")).toEqual([ID]);
    route({ t: "meeting.recording", recording: rec({ assistant: "nova" }) });
    expect(useMeetingsStore.getState().state?.recordings).toHaveLength(1);
    expect(cards("astra")).toEqual([]);
    expect(cards("nova")).toEqual([ID]);
  });

  it("fails what waits when the connection goes", async () => {
    const pending = new PendingMeetings();
    const answer = pending.add("r1", { kind: "get", stem: "x" });
    pending.cancelAll();
    expect(await answer).toMatchObject({ ok: false, error: "Disconnected." });
  });
});
