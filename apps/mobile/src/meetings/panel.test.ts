import { describe, expect, it } from "vitest";
import type { MeetingMoment, MeetingNotes, MeetingRecording, MeetingRow } from "@relay/protocol";
import {
  blueRows,
  initialPanel,
  jumpVisible,
  meetingMeta,
  meetingTabs,
  meetingTimeSpan,
  momentScrollY,
  momentWho,
  nearBottom,
  newestFirst,
  nowView,
  panelReducer,
  rowSpeaker,
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
const moment = (kind: MeetingMoment["kind"], over: Partial<MeetingMoment> = {}): MeetingMoment => ({
  id: `${kind}:0`,
  kind,
  rowId: `row-${kind}`,
  startMs: 35 * MIN,
  speaker: "Todd",
  text: "Isaac, can you take the dashboard?",
  answered: false,
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

describe("now", () => {
  it("is the latest row with the one before it", () => {
    const [todd, priya, chris] = [row("a", "Todd"), row("b", "Priya"), row("c", "Chris")];
    expect(nowView([todd, priya, chris])).toEqual({ current: chris, before: priya });
    expect(nowView([todd])).toEqual({ current: todd, before: null });
    expect(nowView([])).toBeNull();
  });

  it("calls Isaac's mic You", () => {
    expect(rowSpeaker(row("a", "Isaac", { track: "mic" }))).toBe("You");
    expect(rowSpeaker(row("a", "Todd"))).toBe("Todd");
  });
});

describe("moments", () => {
  const start = at(14, 51);

  it("lists newest first, the Now view only the latest three", () => {
    const ms = ["a", "b", "c", "d"].map((id) => moment("action", { id }));
    expect(newestFirst(ms).map((m) => m.id)).toEqual(["d", "c", "b", "a"]);
    expect(newestFirst(ms, 3).map((m) => m.id)).toEqual(["d", "c", "b"]);
  });

  it("labels decisions and actions by kind and speaker", () => {
    expect(momentWho(moment("action", { speaker: "Priya" }), true, start, start)).toBe("Action · Priya");
    expect(momentWho(moment("decision"), false, start, start)).toBe("Decision · Todd");
  });

  it("says how long a question to Isaac has waited while live", () => {
    const m = moment("you", { startMs: 35 * MIN });
    expect(momentWho(m, true, start + 55 * MIN, start)).toBe("Todd · 20 min ago, no reply yet");
    expect(momentWho(m, true, start + 35 * MIN + 20_000, start)).toBe("Todd · just now, no reply yet");
    expect(momentWho(m, false, start + 90 * MIN, start)).toBe("Todd · no reply yet");
    expect(momentWho({ ...m, answered: true }, true, start + 55 * MIN, start)).toBe("Todd asked you");
  });

  it("marks Isaac's rows and rows where someone spoke to him", () => {
    const rows = [row("r1", "Todd"), row("r2", "Isaac", { track: "mic" }), row("r3", "Priya")];
    expect([...blueRows(rows, [moment("you", { rowId: "r1" }), moment("action", { rowId: "r3" })])].sort()).toEqual([
      "r1",
      "r2",
    ]);
  });
});

describe("summary", () => {
  const ended = rec({ endedAt: at(15, 33), stage: "done" });
  const moments = [
    moment("action", { id: "a", speaker: "Priya", text: "Staging dry run after lunch." }),
    moment("decision", { id: "d", text: "Ship Thursday if QA is clean." }),
    moment("you", { id: "y1", startMs: 56 * MIN, text: "Isaac, did you see the Flyway log?" }),
    moment("you", { id: "y2", answered: true }),
  ];

  it("leads with what waits on Isaac, then actions, then what was decided", () => {
    const s = summarySections(ended, moments, notes());
    expect(s.paragraphs).toEqual(["Release status and MFA."]);
    expect(s.status).toBeNull();
    expect(s.forYou).toEqual([{ moment: moments[2], detail: "Todd asked at 56m, no reply yet" }]);
    expect(s.actions.map((m) => m.id)).toEqual(["a"]);
    expect(s.decided).toEqual(["Ship Thursday if QA is clean."]);
  });

  it("takes the decisions from the notes when they have any", () => {
    expect(summarySections(ended, moments, notes({ decisions: ["MFA by month end."] })).decided).toEqual([
      "MFA by month end.",
    ]);
  });

  it("says where the notes are until they are written", () => {
    expect(summarySections(rec({ stage: "summarizing" }), [], null).status).toEqual({
      text: "Writing notes",
      failed: false,
    });
    expect(summarySections(rec({ stage: "failed", error: "No audio" }), [], null).status).toEqual({
      text: "Failed: No audio",
      failed: true,
    });
    expect(summarySections(ended, [], null).status?.text).toBe("No notes");
  });
});
