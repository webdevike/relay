import { describe, expect, it } from "vitest";
import { detectMoments, type LiveLine } from "../src";

let n = 0;
const line = (track: "app" | "mic", speaker: string, min: number, text: string, final = true): LiveLine => ({
  id: `l${n++}`,
  track,
  speaker,
  startMs: min * 60_000,
  endMs: min * 60_000 + 3000,
  text,
  final,
});

describe("detectMoments", () => {
  it("finds decisions, actions and mentions of Isaac, one kind per sentence", () => {
    const m = detectMoments([
      line("app", "Chris", 1, "I did the work to move locations around."),
      line("app", "Priya", 2, "I will open the MFA ticket today."),
      line("app", "Todd", 3, "Let's settle it: MFA on all console accounts by month end."),
      line("app", "Todd", 9, "Isaac, can you take the dashboard?"),
    ]);
    expect(m.map((x) => [x.kind, x.speaker])).toEqual([
      ["action", "Priya"],
      ["decision", "Todd"],
      ["you", "Todd"],
    ]);
    expect(m[2]).toMatchObject({ text: "Isaac, can you take the dashboard?", answered: false });
  });

  it("marks a mention answered once Isaac speaks, ignores his own mentions and drafts", () => {
    const m = detectMoments([
      line("app", "Todd", 1, "Isaac, did you see the log?"),
      line("mic", "Isaac", 2, "Isaac here, yes I will check it."),
      line("app", "Todd", 3, "We decided to ship Thursday.", false),
    ]);
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ kind: "you", answered: true });
    expect(m[1]).toMatchObject({ kind: "action", speaker: "You" });
  });

  it("splits a merged row into sentences and points each moment at its row", () => {
    const m = detectMoments([
      line("app", "Todd", 4, "Nice work. We agreed on Thursday. I'll send the notes."),
    ]);
    expect(m.map((x) => x.kind)).toEqual(["decision", "action"]);
    expect(new Set(m.map((x) => x.rowId)).size).toBe(1);
  });

  it("does not treat a question as a commitment", () => {
    expect(detectMoments([line("app", "Todd", 1, "Will I send it today?")])).toEqual([]);
  });
});
