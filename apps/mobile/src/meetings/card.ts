/**
 * The words of a meeting's one-row card in an assistant's chat (the desktop StatusCard's copy):
 * "Meeting in progress · <title>" with the call's clock while it runs, then
 * "Meeting ended · N min · <title>" with where its notes are ("Writing notes", then "Summary").
 */
import { MEETING_STAGE_LABEL, meetingClock, type MeetingRecording } from "@relay/protocol";
import { recordingTitle } from "@/state/meetings";

/** Whole minutes the call lasted, at least 1. */
export function meetingMinutes(r: Pick<MeetingRecording, "startedAt" | "endedAt">): number {
  return Math.max(1, Math.round(((r.endedAt ?? r.startedAt) - r.startedAt) / 60_000));
}

export function meetingCardLine(r: MeetingRecording, live: boolean): string {
  return live
    ? `Meeting in progress · ${recordingTitle(r)}`
    : `Meeting ended · ${meetingMinutes(r)} min · ${recordingTitle(r)}`;
}

/** The right side: the elapsed clock live, else the notes' stage, "Summary" once they are written. */
export function meetingCardMeta(r: MeetingRecording, live: boolean, now: number): string {
  if (live) return meetingClock(now - r.startedAt);
  return r.stage === "done" ? "Summary" : MEETING_STAGE_LABEL[r.stage];
}
