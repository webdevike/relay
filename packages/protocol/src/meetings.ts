// Meetings: calls recorded by Relay Meetings on any Mac, transcribed live on the host, written up
// after the call; plus the Meetings page's records (work/meetings/<stem>.json from meeting-memory).
//
// Capture: Relay desktop asks `meeting.ingest.open {id, app, title?, startedAt}` over its relay
// socket and gets `meeting.ingest.ticket {id, ticket}` (or `meeting.ingest.refused`). The ticket
// opens one binary WebSocket at `MEETINGS_INGEST_PATH?ticket=` within MEETING_TICKET_TTL_MS
// (see `apps/meetings-capture`): binary frames are `u8 track (0 app, 1 mic), i64 LE first sample,
// s16 LE PCM` at 16 kHz mono; text frames are `meeting.hello`, `meeting.health`, `meeting.end` in
// and `ack {track, upTo}`, `meeting.done`, `meeting.stop` out. That socket is not part of the zod
// unions below.
//
// Clients: `meetings.list` answers `meetings.state` (Relay's recordings, the records and their
// digest), which is pushed again whenever a recording starts, ends or changes stage or a record
// changes. `meeting.recording` carries one recording's change, `meeting.live` the transcript lines
// it added or replaced (drafts are replaced by id, finals never change), `meeting.astra` Astra's
// session about that meeting. Everything else is `meetings.req {rid, op}` answered by
// `meetings.res` with the same rid.
import { z } from "zod";
import { AstraItem } from "./reviews";

export const MEETINGS_INGEST_PATH = "/meetings/ingest" as const;
/** `welcome.features` entry of a host that runs Meetings. */
export const MEETINGS_FEATURE = "meetings";
/** A `meeting.ingest.ticket` opens the ingest socket within this long of being issued, and once. */
export const MEETING_TICKET_TTL_MS = 30_000;
export const MEETING_SAMPLE_RATE = 16_000;
export const MAX_LIVE_LINES = 5_000;
export const MAX_MEETING_QUESTION = 4_000;

const ms = z.number().finite();
const nonEmpty = z.string().min(1);
/** A recording's id: the helper's lowercase UUID. */
export const MeetingId = z.string().regex(/^[a-z0-9][a-z0-9-]{7,63}$/);
/** A record's stem (work/meetings/<stem>.json). */
export const MeetingStem = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .max(300);
export const MeetingsRid = z.string().min(1).max(64);

export const MeetingTrack = z.enum(["app", "mic"]);
export type MeetingTrack = z.infer<typeof MeetingTrack>;

/**
 * `recording`: the call is on. `uploading`: it ended on a Mac the host has not heard all of yet.
 * Then the after-call stages; `done` has notes, `failed` says why in `error`.
 */
export const MeetingStage = z.enum([
  "recording",
  "uploading",
  "transcribing",
  "diarizing",
  "naming",
  "summarizing",
  "done",
  "failed",
]);
export type MeetingStage = z.infer<typeof MeetingStage>;

/** `silent-app`: the call plays but the tap hears silence (System Audio Recording not granted). */
export const MeetingHealth = z.enum(["ok", "silent-app", "no-mic"]);
export type MeetingHealth = z.infer<typeof MeetingHealth>;

/** One transcript line. Mic lines are Isaac; app lines are everyone else (`speaker` a raw label until named). */
export const LiveLine = z.object({
  id: nonEmpty.max(64),
  track: MeetingTrack,
  speaker: z.string().max(200),
  /** From the start of the recording. */
  startMs: ms,
  endMs: ms,
  text: z.string().max(20_000),
  /** A draft is replaced (same id) until it is final. */
  final: z.boolean(),
  /** Mic words the call audio had just played (speaker echo); kept for the record, hidden in the UI. */
  echo: z.boolean().optional(),
});
export type LiveLine = z.infer<typeof LiveLine>;

/** One of Relay's recordings. */
export const MeetingRecording = z.object({
  id: MeetingId,
  app: z.string().max(100),
  title: z.string().max(500).nullable(),
  /** Epoch ms. */
  startedAt: ms,
  endedAt: ms.nullable(),
  /** The Mac it was recorded on. */
  device: z.string().max(200),
  stage: MeetingStage,
  health: MeetingHealth,
  /** One line for the page: "Hearing Microsoft Teams and your mic". */
  healthDetail: z.string().max(500),
  error: z.string().max(2000).nullable(),
  /** Recorded next to MeetingTranscriber; its notes are Relay's own, not in the digest or memory. */
  shadow: z.boolean(),
  /** The notes file's stem once written (`<YYYYMMDD_HHMM>_<slug>_<id8>`). */
  stem: z.string().max(300).nullable(),
  seconds: z.number().nonnegative(),
  /**
   * The assistant whose chat the meeting is in (a registry id: Astra for eCard Systems work, Nova
   * for the rest), or null when the host has none. Its chat shows the meeting card, and what Isaac
   * says there while the call runs reaches it with the transcript. Older hosts leave it out.
   */
  assistant: z.string().max(64).nullable().default(null),
});
export type MeetingRecording = z.infer<typeof MeetingRecording>;

export const MeetingProposal = z.object({
  id: z.string().max(300),
  kind: z.string().max(32),
  text: z.string().max(5000),
  workspace: z.string().max(200).nullable(),
  item: z.string().max(200).nullable(),
  p: z.number().nullable(),
  source: z.string().max(500).nullable(),
  status: z.enum(["proposed", "accepted", "dismissed"]),
});
export type MeetingProposal = z.infer<typeof MeetingProposal>;

/** A record in the Meetings list. */
export const MeetingSummary = z.object({
  stem: MeetingStem,
  title: z.string().max(500),
  start: z.string().nullable(),
  skipped: z.boolean(),
  skippedReason: z.string().max(500).nullable(),
  pending: z.number().int().min(0),
  hasNotes: z.boolean(),
});
export type MeetingSummary = z.infer<typeof MeetingSummary>;

const short = z.string().max(5000);
const ref = { stem: MeetingStem, title: z.string().max(500) };

export const MeetingDigest = z.object({
  recentCount: z.number().int().min(0),
  waiting: z.array(z.object({ ...ref, proposal: MeetingProposal })).max(2000),
  out: z.array(z.object({ text: short, date: z.string().nullable(), ...ref })).max(2000),
  decisions: z.array(z.object({ text: short, ...ref })).max(2000),
});
export type MeetingDigest = z.infer<typeof MeetingDigest>;

/** Parsed notes (MeetingTranscriber's protocol format, which Relay writes too). */
export const MeetingNotes = z.object({
  attendees: z.array(z.string().max(300)).max(500),
  attendeesSource: z.string().max(300).nullable(),
  summary: z.array(short).max(2000),
  decisions: z.array(short).max(2000),
  questions: z.array(short).max(2000),
  transcript: z
    .array(
      z.object({
        time: z.string().max(32),
        speaker: z.string().max(200).nullable(),
        text: z.string().max(20_000),
      }),
    )
    .max(20_000),
});
export type MeetingNotes = z.infer<typeof MeetingNotes>;

/** A record with its proposals and notes (`notes`: whether its notes file could be read). */
export const MeetingDetail = z.object({
  meeting: MeetingSummary.extend({
    proposals: z.array(MeetingProposal).max(500),
    memorized: z
      .array(z.object({ kind: z.string().max(32), text: short, p: z.number().nullable() }))
      .max(500),
  }).nullable(),
  notes: z.enum(["ok", "missing", "none"]),
  protocol: MeetingNotes.nullable(),
});
export type MeetingDetail = z.infer<typeof MeetingDetail>;

/** A recording as its page opens it: everything said so far, Astra's session, the notes once written. */
export const MeetingSnapshot = z.object({
  recording: MeetingRecording,
  rev: z.number().int().nonnegative(),
  lines: z.array(LiveLine).max(MAX_LIVE_LINES),
  astra: AstraItem.nullable(),
  notes: MeetingNotes.nullable(),
});
export type MeetingSnapshot = z.infer<typeof MeetingSnapshot>;

export const MeetingsState = z.object({
  /** Relay's recordings of the last 30 days, newest first (live ones on top). */
  recordings: z.array(MeetingRecording).max(500),
  /** The records (work/meetings), newest first. */
  meetings: z.array(MeetingSummary).max(2000),
  digest: MeetingDigest,
  /** The host's clock, epoch ms. */
  now: ms,
});
export type MeetingsState = z.infer<typeof MeetingsState>;

export const MeetingsOp = z.discriminatedUnion("kind", [
  /** A record's detail; answered with `detail`. */
  z.object({ kind: z.literal("get"), stem: MeetingStem }),
  /** A recording's page; answered with `snapshot`. */
  z.object({ kind: z.literal("open"), id: MeetingId }),
  /** A question to Astra about the meeting (her session, seeded with the transcript so far); answered with `astra`. */
  z.object({
    kind: z.literal("ask"),
    id: MeetingId,
    question: z.string().min(1).max(MAX_MEETING_QUESTION),
  }),
  /** Accept a record's proposal: a todo in memory/todos.md; answered with `todoId` and `tag`. */
  z.object({
    kind: z.literal("accept"),
    stem: MeetingStem,
    proposalId: z.string().min(1).max(300),
  }),
  z.object({
    kind: z.literal("dismiss"),
    stem: MeetingStem,
    proposalId: z.string().min(1).max(300),
  }),
  /** End a recording by hand (the Mac stops capturing). */
  z.object({ kind: z.literal("stop"), id: MeetingId }),
  /** Delete a recording, its audio and its notes. */
  z.object({ kind: z.literal("discard"), id: MeetingId }),
  /** Name a remote speaker label (`R_S2`) in the transcript and notes. */
  z.object({
    kind: z.literal("rename"),
    id: MeetingId,
    label: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
  }),
]);
export type MeetingsOp = z.infer<typeof MeetingsOp>;

export const MeetingsResult = z.object({
  rid: MeetingsRid,
  ok: z.boolean(),
  /** Why it was refused, one line for the UI. */
  error: z.string().max(2000).optional(),
  /** The pages' error code (`not-found`, `not-proposed`, `changed-on-disk`, `partial-accept`). */
  code: z.string().max(64).optional(),
  detail: MeetingDetail.optional(),
  snapshot: MeetingSnapshot.optional(),
  astra: AstraItem.optional(),
  todoId: z.string().max(32).optional(),
  tag: z.string().max(100).optional(),
});
export type MeetingsResult = z.infer<typeof MeetingsResult>;

/** Client frames (index.ts adds them to the client union). */
export const MeetingsClientFrames = [
  /** Ask for the recordings and records; answered by `meetings.state`. */
  z.object({ t: z.literal("meetings.list") }),
  /** One Meetings op; answered by `meetings.res` with the same `rid`. */
  z.object({ t: z.literal("meetings.req"), rid: MeetingsRid, op: MeetingsOp }),
  /** A Mac started (or still holds) a recording; answered by `meeting.ingest.ticket` or `meeting.ingest.refused`. */
  z.object({
    t: z.literal("meeting.ingest.open"),
    id: MeetingId,
    app: z.string().min(1).max(100),
    title: z.string().max(500).optional(),
    startedAt: ms,
  }),
] as const;

/** Server frames (index.ts adds them to the server union). */
export const MeetingsServerFrames = [
  MeetingsState.extend({ t: z.literal("meetings.state") }),
  /** One recording changed (stage, health, title, end). */
  z.object({ t: z.literal("meeting.recording"), recording: MeetingRecording }),
  /** Lines a recording added or replaced since `rev - 1`. */
  z.object({
    t: z.literal("meeting.live"),
    id: MeetingId,
    rev: z.number().int().positive(),
    upsert: z.array(LiveLine).max(200),
  }),
  /** Astra's session about a recording changed. */
  z.object({ t: z.literal("meeting.astra"), id: MeetingId, item: AstraItem }),
  MeetingsResult.extend({ t: z.literal("meetings.res") }),
  /** Open `MEETINGS_INGEST_PATH?ticket=<ticket>` within MEETING_TICKET_TTL_MS. Single use. */
  z.object({ t: z.literal("meeting.ingest.ticket"), id: MeetingId, ticket: nonEmpty }),
  z.object({ t: z.literal("meeting.ingest.refused"), id: MeetingId, reason: z.string().max(500) }),
] as const;

// ---------------------------------------------------------------------------------------------
// Shared helpers (both clients)
// ---------------------------------------------------------------------------------------------

/** `lines` with `upsert` applied: replaced by id, new ones appended, ordered by start. */
export function applyLiveLines(
  lines: readonly LiveLine[],
  upsert: readonly LiveLine[],
): LiveLine[] {
  const byId = new Map(lines.map((l) => [l.id, l]));
  for (const l of upsert) byId.set(l.id, l);
  return [...byId.values()].sort(
    (a, b) => a.startMs - b.startMs || (a.track === b.track ? 0 : a.track === "mic" ? -1 : 1),
  );
}

/** A transcript row: consecutive lines of one speaker within 20 s merged (the drawer's rows). */
export interface MeetingRow {
  readonly id: string;
  readonly speaker: string;
  readonly track: MeetingTrack;
  readonly startMs: number;
  readonly text: string;
  /** Some of its text is still a draft. */
  readonly draft: boolean;
}

export const MERGE_GAP_MS = 20_000;

/** Rows to show: echo lines hidden, same-speaker lines within MERGE_GAP_MS merged. */
export function meetingRows(lines: readonly LiveLine[]): MeetingRow[] {
  const rows: MeetingRow[] = [];
  let lastEnd = -Infinity;
  for (const l of lines) {
    if (l.echo === true || l.text.trim() === "") continue;
    const prev = rows[rows.length - 1];
    if (prev?.speaker === l.speaker && l.startMs - lastEnd <= MERGE_GAP_MS) {
      rows[rows.length - 1] = {
        ...prev,
        text: `${prev.text} ${l.text.trim()}`,
        draft: prev.draft || !l.final,
      };
    } else {
      rows.push({
        id: l.id,
        speaker: l.speaker,
        track: l.track,
        startMs: l.startMs,
        text: l.text.trim(),
        draft: !l.final,
      });
    }
    lastEnd = Math.max(lastEnd, l.endMs);
  }
  return rows;
}

/** "12:05" or "1:02:05" from ms. */
export function meetingClock(msFromStart: number): string {
  const s = Math.max(0, Math.floor(msFromStart / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export const MEETING_STAGE_LABEL: Record<MeetingStage, string> = {
  recording: "Recording",
  uploading: "Waiting for the rest of the audio",
  transcribing: "Transcribing",
  diarizing: "Telling speakers apart",
  naming: "Naming speakers",
  summarizing: "Writing notes",
  done: "Notes ready",
  failed: "Failed",
};

/** A meeting still on the call (recording, or the Mac still sending the last of the audio). */
export function meetingIsLive(r: Pick<MeetingRecording, "stage">): boolean {
  return r.stage === "recording" || r.stage === "uploading";
}

/** How long a chat keeps a meeting's "Meeting ended" card after the call (unless Isaac dismisses it). */
export const MEETING_ENDED_CARD_MS = 12 * 60 * 60 * 1000;

/**
 * The meeting cards assistant `agent`'s chat shows, live ones first, then the newest: every meeting
 * routed to it that is still on the call, or ended less than `MEETING_ENDED_CARD_MS` ago.
 */
export function meetingCardsFor(
  recordings: readonly MeetingRecording[],
  agent: string,
  now: number,
): { recording: MeetingRecording; live: boolean }[] {
  return recordings
    .filter((r) => r.assistant === agent)
    .map((recording) => ({ recording, live: meetingIsLive(recording) }))
    .filter(
      ({ recording, live }) =>
        live ||
        now - (recording.endedAt ?? recording.startedAt) < MEETING_ENDED_CARD_MS,
    )
    .sort((a, b) => Number(b.live) - Number(a.live) || b.recording.startedAt - a.recording.startedAt);
}

/**
 * The Ask menu beside a meeting: `label` is the menu item, `text` what is posted into the chat the
 * meeting is in, as Isaac (the host gives the assistant the transcript).
 */
export const MEETING_ASKS = [
  { label: "Catch me up", text: "Catch me up on the meeting" },
  { label: "Draft a reply", text: "Draft a reply for me" },
  { label: "List actions", text: "List the actions so far" },
] as const;
