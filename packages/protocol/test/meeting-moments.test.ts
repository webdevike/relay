import { describe, expect, it } from "vitest";
import {
  askAnswered,
  momentRowId,
  nowMoments,
  parseServerMessage,
  shotNear,
  type KeyMoment,
  type LiveLine,
  type MeetingRow,
} from "../src";

const moment = (n: number, over: Partial<KeyMoment> = {}): KeyMoment => ({
  id: `km${n}`,
  kind: "decision",
  atMs: n * 60_000,
  lineId: `l${n}`,
  speaker: "Todd",
  text: `Moment ${n}`,
  shot: null,
  ...over,
});

const line = (track: "app" | "mic", startMs: number, extra: Partial<LiveLine> = {}): LiveLine => ({
  id: `${track}${startMs}`,
  track,
  speaker: track === "mic" ? "Isaac" : "Todd",
  startMs,
  endMs: startMs + 1000,
  text: "words",
  final: true,
  ...extra,
});

const row = (id: string, startMs: number): MeetingRow => ({
  id,
  speaker: "Todd",
  track: "app",
  startMs,
  text: "words",
  draft: false,
});

describe("key moments", () => {
  it("Now shows the newest eight, newest first", () => {
    const all = Array.from({ length: 11 }, (_, i) => moment(i));
    expect(nowMoments(all).map((m) => m.id)).toEqual(["km10", "km9", "km8", "km7", "km6", "km5", "km4", "km3"]);
  });

  it("jumps to the row a moment was said in", () => {
    const rows = [row("a", 0), row("b", 30_000), row("c", 90_000)];
    expect(momentRowId(rows, 45_000)).toBe("b");
    expect(momentRowId(rows, 90_000)).toBe("c");
    // Before the first row (a moment from a line merged later): the first row.
    expect(momentRowId(rows, -5)).toBe("a");
    expect(momentRowId([], 5)).toBeNull();
  });

  it("an ask is answered only by Isaac's own words after it, never by echo", () => {
    const ask = moment(1, { kind: "ask" });
    expect(askAnswered(ask, [line("mic", 30_000), line("app", 70_000)])).toBe(false);
    expect(askAnswered(ask, [line("mic", 70_000, { echo: true })])).toBe(false);
    expect(askAnswered(ask, [line("mic", 70_000)])).toBe(true);
    expect(askAnswered({ ...ask, kind: "decision" }, [line("mic", 70_000)])).toBe(false);
  });

  it("refers to the newest snapshot shown shortly before the moment", () => {
    const shots = [
      { n: 0, atMs: 10_000 },
      { n: 1, atMs: 200_000 },
      { n: 2, atMs: 260_000 },
      { n: 3, atMs: 400_000 },
    ];
    expect(shotNear(shots, 265_000)).toBe(2);
    // A snapshot a few seconds after the words still counts (the share lags the talk).
    expect(shotNear(shots, 395_000)).toBe(3);
    // Too long ago: none.
    expect(shotNear(shots, 150_000)).toBeNull();
  });

  it("moments and snapshots travel as server frames", () => {
    expect(
      parseServerMessage(
        JSON.stringify({ t: "meeting.moments", id: "abcdef12-0000", moments: [moment(1, { shot: 2 })] }),
      ),
    ).toMatchObject({ ok: true, value: { t: "meeting.moments", moments: [{ id: "km1", shot: 2 }] } });
    expect(
      parseServerMessage(
        JSON.stringify({
          t: "meeting.shot",
          id: "abcdef12-0000",
          shot: { n: 0, atMs: 1, src: "/meetings/shots/abcdef12-0000/tok/0", w: 10, h: 10, line: "", ocr: "" },
        }),
      ),
    ).toMatchObject({ ok: true, value: { t: "meeting.shot", shot: { n: 0 } } });
  });
});
