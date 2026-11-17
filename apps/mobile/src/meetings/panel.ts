/**
 * The meeting view's logic (the desktop Meeting tab's design): its tabs and when the transcript
 * follows the newest line, the meta line under the title, how a key moment is labelled, the
 * screen snapshots and the ended call's Summary. Pure, so it is tested without a device.
 */
import {
  askAnswered,
  KEY_MOMENT_LABEL,
  MEETING_STAGE_LABEL,
  momentRowId,
  momentStamp,
  type KeyMoment,
  type LiveLine,
  type MeetingNotes,
  type MeetingRecording,
  type MeetingRow,
  type MeetingShot,
} from "@relay/protocol";
import { clockTime } from "@/lib/format";
import { meetingMinutes } from "./card";

export type MeetingTabKey = "now" | "summary" | "transcript" | "moments";

/** Live: Now / Transcript / Moments. Ended: Summary / Transcript / Moments. */
export function meetingTabs(live: boolean): { key: MeetingTabKey; label: string }[] {
  return [
    live ? { key: "now", label: "Now" } : { key: "summary", label: "Summary" },
    { key: "transcript", label: "Transcript" },
    { key: "moments", label: "Moments" },
  ];
}

export interface PanelState {
  tab: MeetingTabKey;
  /** The transcript stays scrolled to its newest line. */
  follow: boolean;
  /** The transcript row a moment jumped to, lit for a moment. */
  highlight: string | null;
}

export type PanelEvent =
  | { type: "tab"; tab: MeetingTabKey }
  /** The transcript was scrolled; `atBottom` per `nearBottom`. */
  | { type: "scrolled"; atBottom: boolean }
  | { type: "jumpLive" }
  /** A moment was tapped: its row in the transcript, following paused there. */
  | { type: "moment"; rowId: string }
  | { type: "unhighlight"; rowId: string }
  /** The call started or ended under the view: back to its first tab. */
  | { type: "lead"; live: boolean };

export function initialPanel(live: boolean): PanelState {
  return { tab: live ? "now" : "summary", follow: true, highlight: null };
}

export function panelReducer(state: PanelState, event: PanelEvent): PanelState {
  switch (event.type) {
    case "tab":
      return { tab: event.tab, follow: true, highlight: null };
    case "scrolled":
      if (state.tab !== "transcript" || state.follow === event.atBottom) return state;
      return { ...state, follow: event.atBottom };
    case "jumpLive":
      return state.follow ? state : { ...state, follow: true };
    case "moment":
      return { tab: "transcript", follow: false, highlight: event.rowId };
    case "unhighlight":
      return state.highlight === event.rowId ? { ...state, highlight: null } : state;
    case "lead":
      return initialPanel(event.live);
  }
}

/** The Jump to live pill: on a live call's transcript while it is not following. */
export function jumpVisible(state: PanelState, live: boolean): boolean {
  return live && state.tab === "transcript" && !state.follow;
}

/** Within 24 px of the end: scrolling back here resumes following. */
export function nearBottom(
  contentHeight: number,
  offsetY: number,
  viewportHeight: number,
): boolean {
  return contentHeight - offsetY - viewportHeight < 24;
}

/** Where the transcript scrolls to show a moment's row: about a third down the viewport. */
export function momentScrollY(rowY: number, viewportHeight: number): number {
  return Math.max(0, rowY - viewportHeight / 3);
}

/** "2:51 – 3:33 PM", or "11:40 AM – 12:20 PM" across noon. */
export function meetingTimeSpan(start: number, end: number): string {
  const from = clockTime(start);
  const to = clockTime(end);
  return from.slice(-2) === to.slice(-2) ? `${from.slice(0, -3)} – ${to}` : `${from} – ${to}`;
}

/** The line under the title: app, then the clock span once ended, then the length. */
export interface MeetingMeta {
  app: string;
  live: boolean;
  /** Ended only. */
  span: string | null;
  /** "55 min". */
  length: string;
}

export function meetingMeta(r: MeetingRecording, live: boolean, now: number): MeetingMeta {
  const end = live ? now : (r.endedAt ?? r.startedAt);
  return {
    app: r.app,
    live,
    span: live ? null : meetingTimeSpan(r.startedAt, end),
    length: `${String(meetingMinutes({ startedAt: r.startedAt, endedAt: end }))} min`,
  };
}

/** A row's speaker as shown: Isaac's mic is "You". */
export function rowSpeaker(row: Pick<MeetingRow, "track" | "speaker">): string {
  return row.track === "mic" ? "You" : row.speaker;
}

/** Someone asked Isaac for something and he has not spoken since: the one blue thing. */
export function momentNeedsYou(m: KeyMoment, lines: readonly LiveLine[]): boolean {
  return m.kind === "ask" && !askAnswered(m, lines);
}

/** Who said a moment as shown: Isaac's own mic line is "You", like the transcript. */
export function momentSpeaker(
  m: Pick<KeyMoment, "lineId" | "speaker">,
  lines: readonly LiveLine[],
): string {
  return lines.find((l) => l.id === m.lineId)?.track === "mic" ? "You" : m.speaker;
}

/**
 * The small line under a moment: "Action · Priya", "Claim · Todd"; an ask of Isaac "Todd · 20 min
 * ago, no reply yet" while the call runs, "Todd · no reply yet" after it, and "Todd asked you"
 * once he has answered.
 */
export function momentWho(
  m: KeyMoment,
  lines: readonly LiveLine[],
  live: boolean,
  now: number,
  startedAt: number,
): string {
  const who = momentSpeaker(m, lines);
  if (m.kind !== "ask") return `${KEY_MOMENT_LABEL[m.kind]} · ${who}`;
  if (askAnswered(m, lines)) return `${who} asked you`;
  if (!live) return `${who} · no reply yet`;
  const minutes = Math.floor((now - startedAt - m.atMs) / 60_000);
  return `${who} · ${minutes < 1 ? "just now" : `${String(minutes)} min ago`}, no reply yet`;
}

/** Rows whose speaker reads in blue: Isaac's own, and those where someone asked him for something. */
export function blueRows(rows: readonly MeetingRow[], moments: readonly KeyMoment[]): Set<string> {
  const ids = new Set<string>();
  for (const m of moments) {
    if (m.kind !== "ask") continue;
    const id = momentRowId(rows, m.atMs);
    if (id !== null) ids.add(id);
  }
  for (const row of rows) if (row.track === "mic") ids.add(row.id);
  return ids;
}

/** Where a snapshot's JPEG loads from: the connected host's http origin, nothing while offline. */
export function shotUri(shot: Pick<MeetingShot, "src">, hostBase: string | null): string | null {
  return hostBase === null ? null : `${hostBase}${shot.src}`;
}

/** A strip thumbnail's width at `height`: the shot's own shape, kept between square and 2:1. */
export function shotThumbWidth(shot: Pick<MeetingShot, "w" | "h">, height: number): number {
  return Math.round(Math.min(2, Math.max(1, shot.w / shot.h)) * height);
}

/** The one line the view shows while someone shares but the Mac may not capture it. */
export function shareNotice(r: Pick<MeetingRecording, "share">, live: boolean): string | null {
  return live && r.share === "no-permission"
    ? "Screen snapshots are off: allow Screen Recording for Relay on the Mac."
    : null;
}

export interface SummarySections {
  /** The notes' summary, once written. */
  paragraphs: readonly string[];
  /** Where the notes are while they are not written ("Writing notes", "Failed: ..."). */
  status: { text: string; failed: boolean } | null;
  /** What waits on Isaac: asks he has not answered. */
  forYou: { moment: KeyMoment; detail: string }[];
  actions: KeyMoment[];
  decided: readonly string[];
}

/** The ended call's Summary: what needs Isaac first, then actions, then what was decided. */
export function summarySections(
  r: Pick<MeetingRecording, "stage" | "error">,
  moments: readonly KeyMoment[],
  lines: readonly LiveLine[],
  notes: MeetingNotes | null,
): SummarySections {
  const status =
    notes !== null
      ? null
      : r.stage === "failed"
        ? { text: `Failed: ${r.error ?? "no reason given"}`, failed: true }
        : { text: r.stage === "done" ? "No notes" : MEETING_STAGE_LABEL[r.stage], failed: false };
  return {
    paragraphs: notes?.summary ?? [],
    status,
    forYou: moments
      .filter((m) => momentNeedsYou(m, lines))
      .map((moment) => ({
        moment,
        detail: `${momentSpeaker(moment, lines)} asked at ${momentStamp(moment.atMs)}, no reply yet`,
      })),
    actions: moments.filter((m) => m.kind === "action"),
    decided:
      notes !== null && notes.decisions.length > 0
        ? notes.decisions
        : moments.filter((m) => m.kind === "decision").map((m) => m.text),
  };
}
