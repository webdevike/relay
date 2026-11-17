import { describe, expect, it } from "vitest";
import type {
  KeyMoment,
  LiveLine,
  MeetingNotes,
  MeetingRecording,
  MeetingRow,
} from "@relay/protocol";
import {
  blueRows,
  initialPanel,
  jumpVisible,
  meetingMeta,
  meetingTabs,
  meetingTimeSpan,
  momentNeedsYou,
  momentScrollY,
  momentSpeaker,
  momentWho,
  nearBottom,
  panelReducer,
  rowSpeaker,
  shareNotice,
  shotThumbWidth,
  shotUri,
  summarySections,
  type PanelState,
} from "./panel";

const MIN = 60_000;
const at = (h: number, m: number): number => new Date(2026, 10, 12, h, m).getTime();
const rec = (over: Partial<MeetingRecording> = {}): MeetingRecording => ({
  id: "6f1c2b8e-0d1a-4c55-9a51-3b2f0c7d9e10",
  app: "Teams",
  title: "Developer Sync",
  startedAt: at(14, 51),
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
  share: "none",
  ...over,
});
const row = (id: string, speaker: string, over: Partial<MeetingRow> = {}): MeetingRow => ({
  id,
  speaker,
  track: "app",
  startMs: 0,
  text: `${speaker} said something.`,
  draft: false,
  ...over,
});
const moment = (kind: KeyMoment["kind"], over: Partial<KeyMoment> = {}): KeyMoment => ({
  id: `km-${kind}`,
  kind,
  atMs: 35 * MIN,
  lineId: `line-${kind}`,
  speaker: "Todd",
  text: "Isaac, can you take the dashboard?",
  shot: null,
  ...over,
});
const line = (id: string, over: Partial<LiveLine> = {}): LiveLine => ({
  id,
  track: "app",
  speaker: "Todd",
  startMs: 0,
  endMs: 1_000,
  text: "Something.",
  final: true,
  ...over,
});
const notes = (over: Partial<MeetingNotes> = {}): MeetingNotes => ({
  attendees: [],
  attendeesSource: null,
  summary: ["Release status and MFA."],
  decisions: [],
  questions: [],
  transcript: [],
  ...over,
});

describe("meeting tabs", () => {
  it("leads with Now while live and Summary once ended", () => {
    expect(meetingTabs(true).map((t) => t.label)).toEqual(["Now", "Transcript", "Moments"]);
    expect(meetingTabs(false).map((t) => t.key)).toEqual(["summary", "transcript", "moments"]);
    expect(initialPanel(true).tab).toBe("now");
    expect(initialPanel(false).tab).toBe("summary");
  });

  it("goes back to the first tab when the call ends", () => {
    const onTranscript: PanelState = { tab: "transcript", follow: false, highlight: "r1" };
    expect(panelReducer(onTranscript, { type: "lead", live: false })).toEqual(initialPanel(false));
  });
});

describe("following the transcript", () => {
  const transcript: PanelState = { tab: "transcript", follow: true, highlight: null };

  it("pauses when scrolled up and resumes at the bottom", () => {
    const paused = panelReducer(transcript, { type: "scrolled", atBottom: false });
    expect(paused.follow).toBe(false);
    expect(jumpVisible(paused, true)).toBe(true);
    const resumed = panelReducer(paused, { type: "scrolled", atBottom: true });
    expect(resumed.follow).toBe(true);
    expect(jumpVisible(resumed, true)).toBe(false);
  });

  it("keeps the same state when nothing changes, and ignores scrolls off the transcript", () => {
    expect(panelReducer(transcript, { type: "scrolled", atBottom: true })).toBe(transcript);
    const now = initialPanel(true);
    expect(panelReducer(now, { type: "scrolled", atBottom: false })).toBe(now);
  });

  it("resumes on Jump to live and on picking a tab", () => {
    const paused: PanelState = { tab: "transcript", follow: false, highlight: "r1" };
    expect(panelReducer(paused, { type: "jumpLive" }).follow).toBe(true);
    expect(panelReducer(paused, { type: "tab", tab: "transcript" })).toEqual(transcript);
  });

  it("shows Jump to live only on a live call's transcript", () => {
    const paused: PanelState = { tab: "transcript", follow: false, highlight: null };
    expect(jumpVisible(paused, false)).toBe(false);
    expect(jumpVisible({ ...paused, tab: "moments" }, true)).toBe(false);
  });

  it("counts the last 24 px as the bottom", () => {
    expect(nearBottom(1000, 577, 400)).toBe(true);
    expect(nearBottom(1000, 576, 400)).toBe(false);
  });
});

describe("jumping to a moment", () => {
  it("opens the transcript paused on its row, lit until it fades", () => {
    const jumped = panelReducer(initialPanel(true), { type: "moment", rowId: "r7" });
    expect(jumped).toEqual({ tab: "transcript", follow: false, highlight: "r7" });
    expect(jumpVisible(jumped, true)).toBe(true);
    expect(panelReducer(jumped, { type: "unhighlight", rowId: "r7" }).highlight).toBeNull();
  });

  it("keeps a newer highlight when an older one's timer ends", () => {
    const jumped: PanelState = { tab: "transcript", follow: false, highlight: "r9" };
    expect(panelReducer(jumped, { type: "unhighlight", rowId: "r7" })).toBe(jumped);
  });

  it("puts the row a third down the viewport, never above the top", () => {
    expect(momentScrollY(900, 600)).toBe(700);
    expect(momentScrollY(100, 600)).toBe(0);
  });
});

describe("meta line", () => {
  it("counts the minutes so far while live", () => {
    const r = rec();
    expect(meetingMeta(r, true, r.startedAt + 55 * MIN)).toEqual({
      app: "Teams",
      live: true,
      span: null,
      length: "55 min",
    });
  });

  it("gives the clock span and length once ended", () => {
    const r = rec({ endedAt: at(15, 33), stage: "done" });
    expect(meetingMeta(r, false, at(18, 0))).toEqual({
      app: "Teams",
      live: false,
      span: "2:51 – 3:33 PM",
      length: "42 min",
    });
  });

  it("keeps both halves of the day when the call crosses noon", () => {
    expect(meetingTimeSpan(at(11, 40), at(12, 20))).toBe("11:40 AM – 12:20 PM");
  });
});

describe("rows", () => {
  it("calls Isaac's mic You", () => {
    expect(rowSpeaker(row("a", "Isaac", { track: "mic" }))).toBe("You");
    expect(rowSpeaker(row("a", "Todd"))).toBe("Todd");
  });
});

describe("key moments", () => {
  const start = at(14, 51);
  // Isaac speaks at 40m, after an ask at 35m and before one at 50m.
  const lines = [
    line("l1", { startMs: 35 * MIN }),
    line("me", { track: "mic", speaker: "Isaac", startMs: 40 * MIN }),
  ];

  it("labels every kind but an ask by its kind and speaker", () => {
    expect(momentWho(moment("action", { speaker: "Priya" }), lines, true, start, start)).toBe(
      "Action · Priya",
    );
    expect(momentWho(moment("decision"), lines, false, start, start)).toBe("Decision · Todd");
    expect(momentWho(moment("claim"), [], true, start, start)).toBe("Claim · Todd");
  });

  it("calls a moment from Isaac's own mic line You", () => {
    const mine = moment("action", { lineId: "me", speaker: "Isaac" });
    expect(momentSpeaker(mine, lines)).toBe("You");
    expect(momentWho(mine, lines, true, start, start)).toBe("Action · You");
    expect(momentSpeaker(moment("action"), lines)).toBe("Todd");
  });

  it("says how long an ask of Isaac has waited while live, and that he answered once he spoke", () => {
    const m = moment("ask", { atMs: 50 * MIN });
    expect(momentWho(m, lines, true, start + 70 * MIN, start)).toBe(
      "Todd · 20 min ago, no reply yet",
    );
    expect(momentWho(m, lines, true, start + 50 * MIN + 20_000, start)).toBe(
      "Todd · just now, no reply yet",
    );
    expect(momentWho(m, lines, false, start + 90 * MIN, start)).toBe("Todd · no reply yet");
    expect(momentWho(moment("ask", { atMs: 35 * MIN }), lines, true, start + 55 * MIN, start)).toBe(
      "Todd asked you",
    );
  });

  it("needs Isaac only for an ask he has not answered", () => {
    expect(momentNeedsYou(moment("ask", { atMs: 50 * MIN }), lines)).toBe(true);
    expect(momentNeedsYou(moment("ask", { atMs: 35 * MIN }), lines)).toBe(false);
    expect(momentNeedsYou(moment("action", { atMs: 50 * MIN }), lines)).toBe(false);
  });

  it("marks Isaac's rows and the row an ask sits in", () => {
    const rows = [
      row("r1", "Todd", { startMs: 30 * MIN }),
      row("r2", "Isaac", { track: "mic", startMs: 40 * MIN }),
      row("r3", "Priya", { startMs: 45 * MIN }),
    ];
    const marked = blueRows(rows, [
      moment("ask", { atMs: 35 * MIN }),
      moment("action", { atMs: 46 * MIN }),
    ]);
    expect([...marked].sort()).toEqual(["r1", "r2"]);
    expect([...blueRows([], [moment("ask")])]).toEqual([]);
  });
});

describe("screen snapshots", () => {
  it("load from the connected host, nowhere while offline", () => {
    const shot = { src: "/meetings/shots/abc/f00d/3" };
    expect(shotUri(shot, "http://100.1.2.3:7817")).toBe(
      "http://100.1.2.3:7817/meetings/shots/abc/f00d/3",
    );
    expect(shotUri(shot, null)).toBeNull();
  });

  it("keep their shape in the strip between square and 2:1", () => {
    expect(shotThumbWidth({ w: 1600, h: 1000 }, 60)).toBe(96);
    expect(shotThumbWidth({ w: 1920, h: 600 }, 60)).toBe(120);
    expect(shotThumbWidth({ w: 600, h: 900 }, 60)).toBe(60);
  });

  it("say they are off only while a live call is shared without Screen Recording", () => {
    expect(shareNotice({ share: "no-permission" }, true)).toBe(
      "Screen snapshots are off: allow Screen Recording for Relay on the Mac.",
    );
    expect(shareNotice({ share: "no-permission" }, false)).toBeNull();
    expect(shareNotice({ share: "sharing" }, true)).toBeNull();
    expect(shareNotice({ share: "none" }, true)).toBeNull();
  });
});

describe("summary", () => {
  const ended = rec({ endedAt: at(15, 33), stage: "done" });
  const lines = [line("me", { track: "mic", speaker: "Isaac", startMs: 40 * MIN })];
  const moments = [
    moment("action", { id: "a", speaker: "Priya", text: "Staging dry run after lunch." }),
    moment("decision", { id: "d", text: "Ship Thursday if QA is clean." }),
    moment("ask", { id: "y1", atMs: 56 * MIN, text: "Isaac, did you see the Flyway log?" }),
    moment("ask", { id: "y2", atMs: 30 * MIN }),
    moment("claim", { id: "c", text: "Error rate is down to 0.2%." }),
  ];

  it("leads with what waits on Isaac, then actions, then what was decided", () => {
    const s = summarySections(ended, moments, lines, notes());
    expect(s.paragraphs).toEqual(["Release status and MFA."]);
    expect(s.status).toBeNull();
    expect(s.forYou).toEqual([{ moment: moments[2], detail: "Todd asked at 56m, no reply yet" }]);
    expect(s.actions.map((m) => m.id)).toEqual(["a"]);
    expect(s.decided).toEqual(["Ship Thursday if QA is clean."]);
  });

  it("takes the decisions from the notes when they have any", () => {
    expect(
      summarySections(ended, moments, lines, notes({ decisions: ["MFA by month end."] })).decided,
    ).toEqual(["MFA by month end."]);
  });

  it("says where the notes are until they are written", () => {
    expect(summarySections(rec({ stage: "summarizing" }), [], [], null).status).toEqual({
      text: "Writing notes",
      failed: false,
    });
    expect(
      summarySections(rec({ stage: "failed", error: "No audio" }), [], [], null).status,
    ).toEqual({
      text: "Failed: No audio",
      failed: true,
    });
    expect(summarySections(ended, [], [], null).status?.text).toBe("No notes");
  });
});
