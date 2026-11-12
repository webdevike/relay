// Meetings on the host: every Mac's Relay Meetings helper uploads its recordings here over the
// ticketed ingest socket; the relay-asr worker transcribes them live; every device gets the lines
// (`meeting.live`), the recordings (`meeting.recording`, `meetings.state`) and Astra's session about
// a meeting (`meeting.astra`). After a call the after-call pipeline (pipeline.ts) writes the notes.
// The Meetings page's records (work/meetings/<stem>.json, meeting-memory's) are read and written
// here too, through eva-core, so the phone and a thin client see what the Mini sees.
//
// Shadow mode (`features.meetingsShadow: true`, off since the 2026-11-12 cutover): notes go to
// work/meetings/shadow/, a folder meeting-digest and meeting-memory do not read, so nothing is
// journaled twice while MeetingTranscriber records too.

import { randomBytes } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  MEETING_SAMPLE_RATE,
  MEETING_TICKET_TTL_MS,
  meetingClock,
  meetingIsLive,
  type AstraItem,
  type LiveLine,
  type MeetingNotes,
  type MeetingRecording,
  type MeetingsOp,
  type MeetingsResult,
  type MeetingsState,
  type ServerMessage,
} from "@relay/protocol";
import { createEvaFs, type EvaFs } from "../../../../packages/eva-core/src/fs/eva-fs";
import {
  meetingsAccept,
  meetingsDismiss,
  meetingsGet,
  meetingsList,
} from "../../../../packages/eva-core/src/model/meetings-ops";
import { parseProtocol } from "../../../../packages/eva-core/src/model/protocol";
import type { LaunchOptions } from "../agents/herdr";
import type { AssistantAgentConfig } from "../assistant/registry";
import { ASK_MARK, AstraSessions } from "../reviews/astra";
import type {
  AgentProvider,
  AgentProviderChange,
  IngestConnection,
  IngestGrant,
  IngestPeer,
  MeetingsRelaying,
} from "../seams";
import type { SessionClock } from "../session";
import type { Asr, WorkerLine, WorkerTurns } from "./asr";
import { LiveTranscript } from "./live";
import { calendarTitle, CONTEXT_AFTER_END_MS, meetingContext, routeMeeting, type Given } from "./route";
import { PlatformSampleSchema, type PlatformSample } from "./speakers";
import {
  publicRecording,
  RETENTION_DAYS,
  samplesOf,
  TRACKS,
  type RecordingMeta,
  type RecordingStore,
  type TrackName,
} from "./store";

/** Acks go back to the Mac this often. */
export const ACK_MS = 1_000;
/** Line changes go out at most this often per recording. */
const LIVE_EMIT_MS = 250;
/** A recording this long in is real enough to look up its calendar event (not a device test). */
export const CONTEXT_AFTER_MS = 60_000;
/** A voice the meeting app named for this long, at this share of its talk, is learned as that person. */
const LEARN_MIN_S = 20;
const LEARN_SHARE = 0.8;

/** What happens after a call (pipeline.ts); `stage` moves the page along, `notes` is the file read for the page. */
export interface AfterCall {
  run(
    meta: RecordingMeta,
    lines: readonly LiveLine[],
    qa: readonly { question: string; answer: string }[],
    report: { stage(stage: RecordingMeta["stage"], error?: string): void },
  ): Promise<{ stem: string; title: string | null; context: RecordingMeta["context"] } | null>;
  /** The notes file of a written recording, parsed; null when there is none. */
  notes(meta: RecordingMeta): string | null;
  /** Rewrites the notes and transcript with a remote label named. */
  rename(meta: RecordingMeta, label: string, name: string): Promise<void>;
  /** Deletes a recording's notes. */
  remove(meta: RecordingMeta): void;
  /** The calendar or Slack context of a recording (mt-autoname's lookup). */
  lookup(meta: RecordingMeta): Promise<RecordingMeta["context"]>;
}

export interface MeetingsServiceDeps {
  readonly store: RecordingStore;
  /** null: recordings are kept but nothing is transcribed (no relay-asr venv on this host). */
  readonly asr: Asr | null;
  /** The Eva checkout (records, todos); null when the host has none. */
  readonly agentHome: string | null;
  readonly shadow: boolean;
  readonly human: string;
  readonly afterCall: AfterCall;
  readonly agents: Pick<AgentProvider, "sessions" | "conversation" | "reply" | "configure">;
  readonly launch:
    ((options: LaunchOptions) => Promise<{ readonly joined: Promise<string> }>) | null;
  readonly sessionFile: (sessionId: string) => string | null;
  readonly socketPath: string;
  readonly broadcast: (message: ServerMessage) => void;
  /** A phone push ("Recording ...", "Notes ready"); the tap opens the meeting. */
  readonly push: (title: string, body: string, id: string) => void;
  readonly clock: SessionClock;
  readonly log: (line: string) => void;
  /** A call started or stopped being transcribed live (Studio holds new GPU jobs meanwhile). */
  readonly onLiveChange?: () => void;
  /** The assistants registry as it is now (route.ts picks a meeting's chat from it). */
  readonly assistants: () => readonly Pick<AssistantAgentConfig, "id" | "profile">[];
}

interface Ticket {
  readonly grant: IngestGrant;
  readonly expiresAt: number;
}

interface Live {
  readonly transcript: LiveTranscript;
  pending: Map<string, LiveLine>;
  flush: (() => void) | null;
  /** The worker has a session for it. */
  open: boolean;
  /** startMs of the last line Astra was given. */
  sentToAstra: number;
}

const OK = { ok: true } as const;

function fail(error: unknown): Omit<MeetingsResult, "rid"> {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(typeof code === "string" ? { code } : {}),
  };
}

function localDay(t: number): string {
  const d = new Date(t);
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** `[12:05] Isaac: text` lines, echo left out. */
export function transcriptText(lines: readonly LiveLine[]): string {
  return lines
    .filter((l) => l.echo !== true && l.text.trim() !== "")
    .map(
      (l) =>
        `[${meetingClock(l.startMs)}] ${l.speaker}: ${l.text.trim()}${l.final ? "" : " (still speaking)"}`,
    )
    .join("\n");
}

/** Astra's first message about a meeting: her prime, what this session is, her memory, the transcript. */
export function meetingSeed(o: {
  prime: string;
  memory: string | null;
  title: string;
  label: string;
  url: string;
  context: string;
  question: string;
}): string {
  return `${o.prime}

---
This session is not your main thread. Isaac opened it from Meetings in Relay to ask you about one meeting: ${o.label}. It is titled "${o.title}" and stays about that meeting: every question he asks on its page comes here, and he reads your answers under the live transcript, often while the call is still going, so answer in a few sentences unless he asks for more.
Everything in your prime still holds: your scope, tools, skills, delegation, approvals, and the hard rules (nothing posted, commented or sent without his OK on the exact text). Three differences:
- Your thread memory is below, so skip reading it on start; do the other start reads only if you need them.
- This first message carries his question: answer it instead of replying "(nothing to report)".
- Leave work/eva/agents/astra/thread.md alone from here unless he asks.
The transcript is a machine transcription: lines from his mic carry his name, the rest is the call audio (labels like R_S2 are unnamed voices). Later messages start with the lines said since your last answer.

## Your thread memory (work/eva/agents/astra/thread.md)

${o.memory === null || o.memory.trim() === "" ? "(empty)" : o.memory.trim()}

## The meeting

${o.context.trim()}${ASK_MARK}${o.question.trim()}`;
}

export class MeetingsService implements MeetingsRelaying {
  private readonly tickets = new Map<string, Ticket>();
  private readonly live = new Map<string, Live>();
  /** The open ingest socket per recording. */
  private readonly sockets = new Map<string, Conn>();
  private readonly astra: AstraSessions;
  private readonly astraOf = new Map<string, AstraItem>();
  private readonly running = new Set<string>();
  /** What each assistant's thread was given of each meeting (`<id>:<agent>`), for `contextFor`. */
  private readonly given = new Map<string, Given>();
  private evaFs: EvaFs | null = null;
  private watcher: FSWatcher | null = null;
  private stateTimer: (() => void) | null = null;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: MeetingsServiceDeps) {
    this.astra = new AstraSessions({
      agents: deps.agents,
      launch: deps.launch,
      sessionFile: deps.sessionFile,
      agentHome: deps.agentHome,
      socketPath: deps.socketPath,
      storePath: join(deps.store.root, "astra.json"),
      emit: (item) => {
        const id = idOfUrl(item.url);
        if (id === null) return;
        this.astraOf.set(id, item);
        deps.broadcast({ t: "meeting.astra", id, item });
      },
      clock: deps.clock,
      log: deps.log,
      seed: meetingSeed,
    });
  }

  /** Picks up what a restart interrupted, watches the records and sweeps old audio daily. */
  start(): void {
    const now = this.deps.clock.now();
    for (const id of this.deps.store.sweep(now))
      this.deps.log(`meetings: deleted ${id} (older than ${String(RETENTION_DAYS)} days)`);
    for (const m of this.deps.store.all()) {
      if (
        m.stage === "transcribing" ||
        m.stage === "diarizing" ||
        m.stage === "naming" ||
        m.stage === "summarizing"
      )
        void this.afterCall(m.id);
      // A call recording since before meetings were routed gets its chat now.
      if (m.stage === "recording" && m.assistant === null) {
        m.assistant = routeMeeting(m, this.deps.assistants());
        this.deps.store.save(m);
      }
    }
    if (this.deps.agentHome !== null) {
      try {
        this.watcher = watch(join(this.deps.agentHome, "work", "meetings"), () => {
          this.stateSoon();
        });
      } catch {
        // no work/meetings yet
      }
    }
    this.sweepTimer = setInterval(() => {
      for (const id of this.deps.store.sweep(this.deps.clock.now()))
        this.deps.log(`meetings: deleted ${id} (older than ${String(RETENTION_DAYS)} days)`);
    }, 86_400_000);
  }

  stop(): void {
    this.watcher?.close();
    this.stateTimer?.();
    clearInterval(this.sweepTimer);
    this.astra.stop();
    for (const c of this.sockets.values()) c.peer.close(1001, "host stopping");
  }

  private seconds(m: RecordingMeta): number {
    const samples =
      m.total === null
        ? Math.max(...TRACKS.map((t) => samplesOf(this.deps.store.dir(m.id), t)))
        : Math.max(m.total.app, m.total.mic);
    return Math.round((samples / MEETING_SAMPLE_RATE) * 10) / 10;
  }

  private recording(m: RecordingMeta): MeetingRecording {
    return publicRecording(m, this.seconds(m));
  }

  state(): MeetingsState {
    const now = this.deps.clock.now();
    const recordings = this.deps.store
      .all()
      .slice(0, 500)
      .map((m) => this.recording(m));
    if (this.deps.agentHome === null)
      return {
        recordings,
        meetings: [],
        digest: { recentCount: 0, waiting: [], out: [], decisions: [] },
        now,
      };
    const list = meetingsList(this.deps.agentHome, new Date(now));
    return { recordings, meetings: list.meetings, digest: list.digest, now };
  }

  private stateSoon(): void {
    if (this.stateTimer !== null) return;
    this.stateTimer = this.deps.clock.after(500, () => {
      this.stateTimer = null;
      this.deps.broadcast({ t: "meetings.state", ...this.state() });
    });
  }

  private update(m: RecordingMeta): void {
    this.deps.store.save(m);
    this.deps.broadcast({ t: "meeting.recording", recording: this.recording(m) });
  }

  // -------------------------------------------------------------------------------------------
  // Ingest
  // -------------------------------------------------------------------------------------------

  openIngest(
    deviceId: string,
    deviceName: string,
    open: { id: string; app: string; title?: string | undefined; startedAt: number },
  ): { ticket: string } | { refused: string } {
    const existing = this.deps.store.load(open.id);
    if (existing !== null && existing.deviceId !== deviceId)
      return { refused: "another Mac holds this recording" };
    if (existing === null) {
      this.deps.store.save({
        id: open.id,
        app: open.app,
        title: open.title ?? null,
        startedAt: open.startedAt,
        endedAt: null,
        device: deviceName,
        deviceId,
        stage: "recording",
        health: "ok",
        healthDetail: `Hearing ${open.app} and your mic`,
        error: null,
        shadow: this.deps.shadow,
        stem: null,
        total: null,
        micLeadMs: null,
        globalTap: false,
        context: null,
        names: {},
        assistant: routeMeeting(
          { app: open.app, title: open.title ?? null, context: null },
          this.deps.assistants(),
        ),
      });
      this.deps.log(`meetings: ${open.app} recording ${open.id} from ${deviceName}`);
      this.deps.push(
        `Recording ${open.title ?? `a ${open.app} call`}`,
        `On ${deviceName}. Open it for the live transcript.`,
        open.id,
      );
      this.stateSoon();
      this.scheduleContext(open.id);
    }
    const now = this.deps.clock.now();
    for (const [t, v] of this.tickets) if (v.expiresAt < now) this.tickets.delete(t);
    const ticket = randomBytes(32).toString("hex");
    this.tickets.set(ticket, {
      grant: { id: open.id, deviceId, deviceName },
      expiresAt: now + MEETING_TICKET_TTL_MS,
    });
    return { ticket };
  }

  redeem(ticket: string): IngestGrant | null {
    const t = this.tickets.get(ticket);
    if (t === undefined) return null;
    this.tickets.delete(ticket);
    return t.expiresAt >= this.deps.clock.now() ? t.grant : null;
  }

  connect(grant: IngestGrant, peer: IngestPeer): IngestConnection {
    this.sockets.get(grant.id)?.peer.close(4000, "replaced by a newer connection");
    const conn = new Conn(this, grant, peer);
    this.sockets.set(grant.id, conn);
    return conn;
  }

  /** The hello of a connection: acks where each track stands, and the live session for a recording in progress. */
  hello(conn: Conn, hello: Record<string, unknown>): void {
    const m = this.deps.store.load(conn.grant.id);
    if (m === null || hello["id"] !== conn.grant.id) {
      conn.peer.close(4004, "unknown recording");
      return;
    }
    if (typeof hello["title"] === "string" && m.title === null) m.title = hello["title"];
    const dir = this.deps.store.dir(m.id);
    for (const t of TRACKS) conn.have[t] = samplesOf(dir, t);
    conn.haveSpeakers = this.deps.store.speakers(m.id).rows;
    conn.sendAcks();
    if (m.stage === "recording" && this.deps.asr !== null) {
      this.liveOf(m).open = this.openWorker(m.id, conn.have.app, conn.have.mic);
      this.deps.onLiveChange?.();
    }
    this.update(m);
  }

  private openWorker(id: string, app: number, mic: number): boolean {
    this.deps.asr?.open(id, app, mic, this.deps.human);
    return this.deps.asr !== null;
  }

  private liveOf(m: RecordingMeta): Live {
    let l = this.live.get(m.id);
    if (l === undefined) {
      l = {
        transcript: new LiveTranscript(
          this.deps.store.lines(m.id),
          {
            mic: this.deps.human,
            remoteName: () => this.deps.store.load(m.id)?.context?.remoteName,
          },
          this.deps.store.speakers(m.id).samples,
        ),
        pending: new Map(),
        flush: null,
        open: false,
        sentToAstra: -1,
      };
      this.live.set(m.id, l);
    }
    return l;
  }

  /** New contiguous audio of a recording: to the worker while the call is on. */
  audio(id: string, track: TrackName, at: number, pcm: Uint8Array): void {
    const l = this.live.get(id);
    if (l?.open === true) this.deps.asr?.audio(id, track, at, pcm);
  }

  health(id: string, state: unknown, detail: unknown): void {
    const m = this.deps.store.load(id);
    if (m === null || (state !== "ok" && state !== "silent-app" && state !== "no-mic")) return;
    m.health = state;
    if (typeof detail === "string") m.healthDetail = detail.slice(0, 500);
    this.update(m);
  }

  /** `meeting.end`: the Mac stopped recording; once every sample is here the after-call pipeline starts. */
  ended(conn: Conn, end: Record<string, unknown>): void {
    const m = this.deps.store.load(conn.grant.id);
    if (m === null) return;
    const samples = Array.isArray(end["samples"]) ? end["samples"] : [];
    m.total = {
      app: Number(samples[0] ?? conn.have.app),
      mic: Number(samples[1] ?? conn.have.mic),
    };
    m.endedAt = typeof end["endedAt"] === "number" ? end["endedAt"] : this.deps.clock.now();
    if (typeof end["micLeadMs"] === "number") m.micLeadMs = end["micLeadMs"];
    if (end["globalTap"] === true) m.globalTap = true;
    if (m.stage === "recording") m.stage = "uploading";
    this.update(m);
    this.complete(conn);
  }

  /** After each frame: whether the ended recording is all here. */
  complete(conn: Conn): void {
    const m = this.deps.store.load(conn.grant.id);
    if (m?.total == null || m.stage !== "uploading") return;
    if (conn.have.app < m.total.app || conn.have.mic < m.total.mic) return;
    conn.peer.sendText({ t: "meeting.done" });
    m.stage = "transcribing";
    this.update(m);
    this.stateSoon();
    void this.afterCall(m.id);
  }

  disconnected(conn: Conn): void {
    if (this.sockets.get(conn.grant.id) === conn) this.sockets.delete(conn.grant.id);
  }

  writePcm(id: string, track: TrackName, at: number, pcm: Uint8Array): void {
    this.deps.store.writePcm(id, track, at, pcm);
  }

  /** A worker line: into the live transcript, kept when final, out to every device shortly. */
  line(w: WorkerLine): void {
    const l = this.live.get(w.meeting);
    if (l !== undefined) this.publish(w.meeting, l, l.transcript.apply(w));
  }

  /** The worker's voice turns inside a call-track final: its speakers, maybe others renamed. */
  turns(t: WorkerTurns): void {
    const l = this.live.get(t.meeting);
    if (l !== undefined) this.publish(t.meeting, l, l.transcript.turns(t));
  }

  /**
   * `meeting.speakers {from, lines}`: the Mac's window samples from its line `from` on. Kept in
   * order (a resend of what is here is skipped), acked, and named into the live transcript.
   */
  speakerLines(conn: Conn, msg: Record<string, unknown>): void {
    const from = typeof msg["from"] === "number" ? msg["from"] : -1;
    const lines = Array.isArray(msg["lines"]) ? (msg["lines"] as unknown[]) : [];
    if (from < 0 || from > conn.haveSpeakers) return;
    const fresh = lines.slice(conn.haveSpeakers - from);
    if (fresh.length === 0) return;
    const rows = fresh.map((x) => {
      const r = PlatformSampleSchema.safeParse(x);
      return r.success ? r.data : null;
    });
    this.deps.store.appendSpeakers(conn.grant.id, rows);
    conn.haveSpeakers += rows.length;
    const l = this.live.get(conn.grant.id);
    if (l !== undefined)
      this.publish(
        conn.grant.id,
        l,
        l.transcript.platform(rows.filter((r): r is PlatformSample => r !== null)),
      );
  }

  /** Changed lines: finals kept, all out to every device within LIVE_EMIT_MS. */
  private publish(id: string, l: Live, changed: readonly LiveLine[]): void {
    if (changed.length === 0) return;
    this.deps.store.appendLines(
      id,
      changed.filter((c) => c.final),
    );
    for (const c of changed) l.pending.set(c.id, c);
    l.flush ??= this.deps.clock.after(LIVE_EMIT_MS, () => {
      l.flush = null;
      const upsert = [...l.pending.values()];
      l.pending.clear();
      for (let i = 0; i < upsert.length; i += 200)
        this.deps.broadcast({
          t: "meeting.live",
          id,
          rev: l.transcript.rev,
          upsert: upsert.slice(i, i + 200),
        });
    });
  }

  /** The worker restarted: open the live sessions again where their audio stands. */
  workerRestarted(): void {
    for (const [id, l] of this.live) {
      const m = this.deps.store.load(id);
      if (m?.stage !== "recording" || !l.open) continue;
      const c = this.sockets.get(id);
      this.deps.asr?.open(id, c?.have.app ?? 0, c?.have.mic ?? 0, this.deps.human);
    }
  }

  private scheduleContext(id: string): void {
    this.deps.clock.after(CONTEXT_AFTER_MS, () => {
      const m = this.deps.store.load(id);
      if (m?.context !== null || m.stage === "failed") return;
      this.deps.afterCall.lookup(m).then(
        (context) => {
          const now = this.deps.store.load(id);
          if (now === null || context === null) return;
          now.context = context;
          // The calendar names the call and tells work from personal.
          now.title ??= calendarTitle(context.annotation);
          now.assistant = routeMeeting(now, this.deps.assistants());
          this.update(now);
          const l = this.live.get(id);
          if (context.remoteName !== undefined && l !== undefined) {
            for (const c of l.transcript.renameApp(context.remoteName)) l.pending.set(c.id, c);
            this.deps.broadcast({
              t: "meeting.live",
              id,
              rev: l.transcript.rev,
              upsert: [...l.pending.values()],
            });
            l.pending.clear();
          }
        },
        (error: unknown) => {
          this.deps.log(
            `meetings: context lookup for ${id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
    });
  }

  private async afterCall(id: string): Promise<void> {
    if (this.running.has(id)) return;
    this.running.add(id);
    try {
      const live = this.live.get(id);
      if (live?.open === true) {
        // Voices the meeting app named for most of their talk teach Relay's voice prints.
        for (const s of live.transcript.timeline.settled(LEARN_MIN_S, LEARN_SHARE))
          this.deps.asr?.learn(id, s.voice, s.name);
        await this.deps.asr?.close(id);
        live.open = false;
        this.deps.onLiveChange?.();
      }
      const m = this.deps.store.load(id);
      if (m === null) return;
      const lines = live?.transcript.all() ?? this.deps.store.lines(id);
      const report = {
        stage: (stage: RecordingMeta["stage"], error?: string): void => {
          const now = this.deps.store.load(id);
          if (now === null) return;
          now.stage = stage;
          now.error = error ?? null;
          this.update(now);
        },
      };
      const out = await this.deps.afterCall.run(
        m,
        lines,
        qaOf(this.astraOf.get(id) ?? (await this.astra.snapshot(urlOf(id)))),
        report,
      );
      const done = this.deps.store.load(id);
      if (done === null) return;
      if (out !== null) {
        done.stem = out.stem;
        done.stage = "done";
        done.error = null;
        // What the after-call lookup and the summary learned name the call and can move it.
        done.title ??= out.title;
        done.context ??= out.context;
        done.assistant = routeMeeting(done, this.deps.assistants());
        this.update(done);
        this.deps.push("Notes ready", done.title ?? `${done.app} call`, id);
      }
      this.live.delete(id);
      this.stateSoon();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.deps.log(`meetings: after-call for ${id} failed: ${msg}`);
      const m = this.deps.store.load(id);
      if (m !== null) {
        m.stage = "failed";
        m.error = msg.slice(0, 2000);
        this.update(m);
      }
    } finally {
      this.running.delete(id);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Ops
  // -------------------------------------------------------------------------------------------

  private notesOf(m: RecordingMeta): MeetingNotes | null {
    const text = m.stem === null ? null : this.deps.afterCall.notes(m);
    return text === null ? null : parseProtocol(text);
  }

  private async snapshot(id: string): Promise<Omit<MeetingsResult, "rid">> {
    const m = this.deps.store.load(id);
    if (m === null) return { ok: false, error: "No such recording.", code: "not-found" };
    const l = this.live.get(id);
    const lines = l?.transcript.all() ?? this.deps.store.lines(id);
    const astra = this.astraOf.get(id) ?? (await this.astra.snapshot(urlOf(id)));
    return {
      ok: true,
      snapshot: {
        recording: this.recording(m),
        rev: l?.transcript.rev ?? 0,
        lines: lines.slice(-5000),
        astra,
        notes: this.notesOf(m),
      },
    };
  }

  private async ask(id: string, question: string): Promise<Omit<MeetingsResult, "rid">> {
    const m = this.deps.store.load(id);
    if (m === null) return { ok: false, error: "No such recording.", code: "not-found" };
    const l = this.live.get(id);
    const lines = l?.transcript.all() ?? this.deps.store.lines(id);
    const title = m.title ?? `${m.app} call`;
    const when = new Date(m.startedAt).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const label = `${title} (${m.app}, ${when}${m.stage === "recording" ? ", still going" : ""})`;
    const since = l?.sentToAstra ?? -1;
    const fresh = lines.filter((x) => x.startMs > since);
    const notes = m.stem === null ? null : this.deps.afterCall.notes(m);
    const context = (): Promise<string> =>
      Promise.resolve(
        [
          m.context?.annotation ?? "",
          notes === null ? "" : `### Notes written after the call\n\n${notes}`,
          `### Transcript so far\n\n${transcriptText(lines) || "(nothing said yet)"}`,
        ]
          .filter((s) => s !== "")
          .join("\n\n"),
      );
    const turn =
      fresh.length === 0
        ? question
        : `New in the transcript since your last answer:\n${transcriptText(fresh)}${ASK_MARK}${question}`;
    const last = lines[lines.length - 1];
    if (l !== undefined && last !== undefined) l.sentToAstra = last.startMs;
    const item = await this.astra.ask(
      urlOf(id),
      `Astra · ${title}`,
      label,
      context,
      question,
      turn,
    );
    this.astraOf.set(id, item);
    return { ok: true, astra: item };
  }

  async handle(op: MeetingsOp): Promise<Omit<MeetingsResult, "rid">> {
    try {
      const root = this.deps.agentHome;
      switch (op.kind) {
        case "get":
          if (root === null)
            return { ok: false, error: "This host has no Eva checkout.", code: "not-found" };
          return { ok: true, detail: meetingsGet(root, op.stem, [homedir(), root]) };
        case "open":
          return await this.snapshot(op.id);
        case "ask":
          return await this.ask(op.id, op.question);
        case "accept": {
          if (root === null)
            return { ok: false, error: "This host has no Eva checkout.", code: "not-found" };
          this.evaFs ??= createEvaFs({ root });
          const r = await meetingsAccept(
            root,
            this.evaFs,
            localDay(this.deps.clock.now()),
            op.stem,
            op.proposalId,
          );
          this.stateSoon();
          return { ok: true, todoId: r.todoId, tag: r.tag };
        }
        case "dismiss":
          if (root === null)
            return { ok: false, error: "This host has no Eva checkout.", code: "not-found" };
          this.evaFs ??= createEvaFs({ root });
          await meetingsDismiss(root, this.evaFs, op.stem, op.proposalId);
          this.stateSoon();
          return OK;
        case "stop": {
          const m = this.deps.store.load(op.id);
          if (m?.stage !== "recording")
            return { ok: false, error: "That recording already ended." };
          const c = this.sockets.get(op.id);
          if (c === undefined)
            return { ok: false, error: `${m.device} isn't connected right now; stop it there.` };
          c.peer.sendText({ t: "meeting.stop" });
          return OK;
        }
        case "discard": {
          const m = this.deps.store.load(op.id);
          if (m === null) return { ok: false, error: "No such recording.", code: "not-found" };
          const c = this.sockets.get(op.id);
          // The Mac stops and drops its spool; nothing of it is kept here.
          c?.peer.sendText({ t: "meeting.stop" });
          c?.peer.sendText({ t: "meeting.done" });
          c?.peer.close(1000, "discarded");
          const l = this.live.get(op.id);
          if (l?.open === true) void this.deps.asr?.close(op.id);
          this.live.delete(op.id);
          this.deps.onLiveChange?.();
          this.deps.afterCall.remove(m);
          this.deps.store.remove(op.id);
          this.deps.broadcast({ t: "meetings.state", ...this.state() });
          return OK;
        }
        case "rename": {
          const m = this.deps.store.load(op.id);
          if (m === null) return { ok: false, error: "No such recording.", code: "not-found" };
          m.names[op.label] = op.name;
          this.deps.store.save(m);
          if (m.stem !== null) await this.deps.afterCall.rename(m, op.label, op.name);
          this.update(m);
          return OK;
        }
      }
    } catch (error) {
      return fail(error);
    }
  }

  /** Whether a call is being transcribed live right now. */
  transcribingLive(): boolean {
    return [...this.live.values()].some((l) => l.open);
  }

  /**
   * What assistant `agent`'s next turn is told of the meeting in its chat (route.ts), or null: the
   * newest one still on the call or ended under `CONTEXT_AFTER_END_MS` ago, with what was said since
   * the thread's last turn. Each answer counts as given.
   */
  contextFor(agent: string): { id: string; text: string } | null {
    const now = this.deps.clock.now();
    const m = this.deps.store
      .all()
      .filter(
        (r) =>
          r.assistant === agent &&
          (meetingIsLive(r) || now - (r.endedAt ?? r.startedAt) < CONTEXT_AFTER_END_MS),
      )
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (m === undefined) return null;
    const key = `${m.id}:${agent}`;
    const lines = this.live.get(m.id)?.transcript.all() ?? this.deps.store.lines(m.id);
    const out = meetingContext(m, lines, this.given.get(key) ?? null, now);
    if (out === null) return null;
    this.given.set(key, out.given);
    return { id: m.id, text: out.text };
  }

  observe(change: AgentProviderChange): void {
    this.astra.observe(change);
  }
}

/** Astra's item url for a recording (her sessions are keyed by url). */
export function urlOf(id: string): string {
  return `relay://open/meetings?meeting=${id}`;
}

/** Isaac's questions in Astra's meeting session with the answer that followed each, for the notes. */
export function qaOf(item: AstraItem | null): { question: string; answer: string }[] {
  const out: { question: string; answer: string }[] = [];
  for (const turn of item?.turns ?? []) {
    if (turn.role === "user") out.push({ question: turn.text.trim(), answer: "" });
    else if (turn.role === "assistant" && out.length > 0) {
      const last = out.at(-1);
      if (last !== undefined) last.answer = `${last.answer}\n\n${turn.text}`.trim();
    }
  }
  return out.filter((q) => q.answer !== "");
}

function idOfUrl(url: string): string | null {
  const prefix = "relay://open/meetings?meeting=";
  return url.startsWith(prefix) ? url.slice(prefix.length) : null;
}

/** One ingest socket: frames to the store and the worker, acks back. */
export class Conn implements IngestConnection {
  readonly have: Record<TrackName, number> = { app: 0, mic: 0 };
  /** Window speaker lines held (`speakers.jsonl` rows). */
  haveSpeakers = 0;
  private helloSeen = false;
  private readonly ackTimer: NodeJS.Timeout;

  constructor(
    private readonly service: MeetingsService,
    readonly grant: IngestGrant,
    readonly peer: IngestPeer,
  ) {
    this.ackTimer = setInterval(() => {
      if (this.helloSeen) this.sendAcks();
    }, ACK_MS);
  }

  sendAcks(): void {
    TRACKS.forEach((t, i) => {
      this.peer.sendText({ t: "ack", track: i, upTo: this.have[t] });
    });
    this.peer.sendText({ t: "ack.speakers", upTo: this.haveSpeakers });
  }

  text(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg["t"] === "meeting.hello") {
      this.helloSeen = true;
      this.service.hello(this, msg);
    } else if (msg["t"] === "meeting.health") {
      this.service.health(this.grant.id, msg["state"], msg["detail"]);
    } else if (msg["t"] === "meeting.speakers") {
      if (this.helloSeen) this.service.speakerLines(this, msg);
    } else if (msg["t"] === "meeting.end") {
      this.service.ended(this, msg);
    }
  }

  binary(data: Uint8Array): void {
    if (!this.helloSeen || data.byteLength < 9) return;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const trackIndex = view.getUint8(0);
    const track = TRACKS[trackIndex];
    if (track === undefined) return;
    const at = Number(view.getBigInt64(1, true));
    const pcm = data.subarray(9, 9 + ((data.byteLength - 9) & ~1));
    const n = pcm.byteLength / 2;
    const have = this.have[track];
    if (at + n <= have) return;
    if (at > have) {
      // A gap (never sent by the helper, which sends from the ack on): keep it, do not count it.
      this.service.writePcm(this.grant.id, track, at, pcm);
      return;
    }
    const fresh = pcm.subarray((have - at) * 2);
    this.service.writePcm(this.grant.id, track, have, fresh);
    this.have[track] = have + fresh.byteLength / 2;
    this.service.audio(this.grant.id, track, have, fresh);
    this.service.complete(this);
  }

  closed(): void {
    clearInterval(this.ackTimer);
    this.service.disconnected(this);
  }
}
