import { describe, expect, it } from "vitest";
import {
  applyLiveLines,
  meetingClock,
  meetingRows,
  parseClientMessage,
  parseServerMessage,
  type LiveLine,
} from "../src";

const line = (
  id: string,
  track: "app" | "mic",
  startMs: number,
  text: string,
  extra: Partial<LiveLine> = {},
): LiveLine => ({
  id,
  track,
  speaker: track === "mic" ? "Isaac" : "Remote",
  startMs,
  endMs: startMs + 1000,
  text,
  final: true,
  ...extra,
});

describe("meetings protocol", () => {
  it("replaces drafts by id and keeps lines in start order", () => {
    const a = applyLiveLines(
      [],
      [line("m1", "mic", 5000, "Hel", { final: false }), line("a1", "app", 1000, "Hi")],
    );
    expect(a.map((l) => l.id)).toEqual(["a1", "m1"]);
    const b = applyLiveLines(a, [line("m1", "mic", 5000, "Hello there")]);
    expect(b).toHaveLength(2);
    expect(b[1]).toMatchObject({ text: "Hello there", final: true });
  });

  it("merges a speaker's lines within 20 s and hides echo", () => {
    const rows = meetingRows([
      line("a1", "app", 0, "Release is"),
      line("a2", "app", 3000, "Tuesday."),
      line("m1", "mic", 5000, "Tuesday.", { echo: true }),
      line("m2", "mic", 6000, "Sounds good", { final: false }),
      line("a3", "app", 40_000, "Next topic."),
    ]);
    expect(rows.map((r) => [r.speaker, r.text, r.draft])).toEqual([
      ["Remote", "Release is Tuesday.", false],
      ["Isaac", "Sounds good", true],
      ["Remote", "Next topic.", false],
    ]);
  });

  it("formats the clock", () => {
    expect(meetingClock(0)).toBe("0:00");
    expect(meetingClock(65_400)).toBe("1:05");
    expect(meetingClock(3_725_000)).toBe("1:02:05");
  });

  it("rejects bad ids, empty questions and ingest frames without a start", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          t: "meetings.req",
          rid: "r",
          op: { kind: "ask", id: "../x", question: "q" },
        }),
      ).ok,
    ).toBe(false);
    expect(
      parseClientMessage(
        JSON.stringify({
          t: "meetings.req",
          rid: "r",
          op: { kind: "ask", id: "6f1c2b8e-0d1a", question: "" },
        }),
      ).ok,
    ).toBe(false);
    expect(
      parseClientMessage(
        JSON.stringify({ t: "meeting.ingest.open", id: "6f1c2b8e-0d1a", app: "Zoom" }),
      ).ok,
    ).toBe(false);
    expect(
      parseServerMessage(
        JSON.stringify({ t: "meeting.live", id: "6f1c2b8e-0d1a", rev: 0, upsert: [] }),
      ).ok,
    ).toBe(false);
  });
});
