// One recording's live transcript: the worker's drafts and finals as LiveLines (drafts replaced by
// id, an empty final removes the line's text), with the echo filter on the mic and the call
// track's speakers. A mic line is checked against the call audio of ECHO_WINDOW_MS around it when
// it arrives and again when later call lines come in (the app's final can land after the mic's);
// it only ever shrinks. A call-track final is split where its speaker changes (speakers.ts): the
// first part keeps the line's id, the others get `<id>.2`, `<id>.3`; it is named again when its
// voice labels arrive, when the window's captions catch up, and when its voice gets a name.

import { MEETING_SAMPLE_RATE, type LiveLine } from "@relay/protocol";
import type { WorkerLine, WorkerTurns } from "./asr";
import { ECHO_WINDOW_MS, ownSpeech, triples } from "./echo";
import { SpeakerTimeline, type PlatformSample, type Segment, type Word } from "./speakers";

const MS_PER_SAMPLE = 1000 / MEETING_SAMPLE_RATE;
/** Captions trail speech: lines ending this recently are named again when window samples come. */
const RECENT = 15 * MEETING_SAMPLE_RATE;

interface AppFinal {
  readonly words: readonly Word[];
  readonly start: number;
  readonly end: number;
  /** Its voice turns arrived (and its names were counted toward its voices). */
  turns: boolean;
  learned: boolean;
  /** How many lines it was split into last time. */
  parts: number;
  /** Some part was named only by voice or label (renamed when a voice gets a name). */
  weak: boolean;
}

export class LiveTranscript {
  private readonly lines = new Map<string, LiveLine>();
  /** What the worker heard on each mic line before the echo filter. */
  private readonly heard = new Map<string, string>();
  private readonly finals = new Map<string, AppFinal>();
  readonly timeline: SpeakerTimeline;
  private lastAppSpeaker: string | undefined;
  rev = 0;

  constructor(
    initial: readonly LiveLine[],
    private readonly speakers: { mic: string; remoteName: () => string | undefined },
    samples: readonly PlatformSample[] = [],
  ) {
    for (const l of initial) this.lines.set(l.id, l);
    this.timeline = new SpeakerTimeline(speakers.remoteName);
    for (const s of samples) this.timeline.addSample(s);
  }

  all(): LiveLine[] {
    return [...this.lines.values()].sort((a, b) => a.startMs - b.startMs);
  }

  /** Applies one worker line; answers the lines that changed (empty when nothing did). */
  apply(w: WorkerLine): LiveLine[] {
    const prior = this.lines.get(w.id);
    // Finals never change their words; a draft arriving after its final is stale.
    if (prior?.final === true) return [];
    if (w.track === "app" && w.final && w.words !== undefined && w.words.length > 0) {
      this.finals.set(w.id, {
        words: w.words,
        start: w.start,
        end: w.end,
        turns: false,
        learned: false,
        parts: 0,
        weak: false,
      });
      return this.commit(this.name(w.id));
    }
    const line: LiveLine = {
      id: w.id,
      track: w.track,
      speaker:
        w.track === "mic"
          ? this.speakers.mic
          : this.timeline.draftSpeaker(w.start, w.end, this.lastAppSpeaker),
      startMs: Math.round(w.start * MS_PER_SAMPLE),
      endMs: Math.round(w.end * MS_PER_SAMPLE),
      text: w.text,
      final: w.final,
    };
    if (line.track === "mic") {
      this.heard.set(line.id, line.text);
      return this.commit([this.filtered(line)]);
    }
    return this.commit([line]);
  }

  /** The worker's voice turns for a call-track final: it and every weakly named line again. */
  turns(t: WorkerTurns): LiveLine[] {
    this.timeline.addTurns(t.turns, t.names);
    const f = this.finals.get(t.id);
    if (f !== undefined) f.turns = true;
    const changed = this.name(t.id);
    for (const [id, other] of this.finals)
      if (id !== t.id && other.weak) changed.push(...this.name(id));
    return this.commit(changed);
  }

  /** Window samples from the Mac: recent lines again (their captions and marks may be new). */
  platform(samples: readonly PlatformSample[]): LiveLine[] {
    if (samples.length === 0) return [];
    for (const s of samples) this.timeline.addSample(s);
    const newest = samples.reduce((m, s) => Math.max(m, s.at), 0);
    const changed: LiveLine[] = [];
    for (const [id, f] of this.finals) if (f.end >= newest - RECENT) changed.push(...this.name(id));
    return this.commit(changed);
  }

  /** The calendar named a 1:1's other side: lines nobody named otherwise take it. */
  renameApp(name: string): LiveLine[] {
    const changed: LiveLine[] = [];
    for (const [id, f] of this.finals) if (f.weak) changed.push(...this.name(id));
    for (const l of this.lines.values()) {
      // Lines from before word times (or a host restart) were never split: rename the unnamed ones.
      if (
        l.track === "app" &&
        !this.finals.has(l.id.split(".")[0] ?? l.id) &&
        l.speaker === "Remote"
      )
        changed.push({ ...l, speaker: name });
    }
    return this.commit(changed);
  }

  /** Stores changed lines, counts a revision; answers them. */
  private commit(changed: LiveLine[]): LiveLine[] {
    const out: LiveLine[] = [];
    for (const l of changed) {
      const prior = this.lines.get(l.id);
      if (
        prior?.text === l.text &&
        prior.speaker === l.speaker &&
        prior.final === l.final &&
        prior.echo === l.echo &&
        prior.startMs === l.startMs &&
        prior.endMs === l.endMs
      )
        continue;
      this.lines.set(l.id, l);
      out.push(l);
      if (l.track === "app" && l.text.trim() !== "") this.lastAppSpeaker = l.speaker;
    }
    // Mic lines near new call lines may hold their echo.
    for (const app of out) {
      if (app.track !== "app") continue;
      for (const mic of this.lines.values()) {
        if (mic.track !== "mic" || mic.echo === true || !near(mic, app)) continue;
        const again = this.filtered(mic);
        if (again.text !== mic.text || again.echo !== mic.echo) {
          this.lines.set(again.id, again);
          out.push(again);
        }
      }
    }
    if (out.length > 0) this.rev += 1;
    return out;
  }

  /** A call-track final's lines from its words, split by speaker (empty finals retire old parts). */
  private name(id: string): LiveLine[] {
    const f = this.finals.get(id);
    if (f === undefined) return [];
    const learn = f.turns && !f.learned;
    if (learn) f.learned = true;
    const segs: Segment[] = this.timeline.segments(f.words, learn);
    f.weak = segs.some((s) => s.source === "voice" || s.source === "known" || s.source === "label");
    const out: LiveLine[] = segs.map((s, i) => ({
      id: i === 0 ? id : `${id}.${String(i + 1)}`,
      track: "app",
      speaker: s.speaker,
      startMs: Math.round((i === 0 ? f.start : s.start) * MS_PER_SAMPLE),
      endMs: Math.round((i === segs.length - 1 ? f.end : s.end) * MS_PER_SAMPLE),
      text: s.text,
      final: true,
    }));
    for (let i = segs.length; i < f.parts; i++) {
      const old = this.lines.get(`${id}.${String(i + 1)}`);
      if (old !== undefined) out.push({ ...old, text: "" });
    }
    f.parts = Math.max(f.parts, segs.length);
    return out;
  }

  /** A mic line with the call's three-word runs around it taken out (more call text only drops more). */
  private filtered(mic: LiveLine): LiveLine {
    const text = this.heard.get(mic.id) ?? mic.text;
    const call = new Set<string>();
    for (const l of this.lines.values())
      if (l.track === "app" && near(mic, l)) for (const t of triples(l.text)) call.add(t);
    const own = ownSpeech(text, call);
    const rest: LiveLine = {
      id: mic.id,
      track: mic.track,
      speaker: mic.speaker,
      startMs: mic.startMs,
      endMs: mic.endMs,
      text: mic.text,
      final: mic.final,
    };
    return own.trim() === "" && text.trim() !== ""
      ? { ...rest, text, echo: true }
      : { ...rest, text: own };
  }
}

function near(mic: LiveLine, app: LiveLine): boolean {
  return app.endMs >= mic.startMs - ECHO_WINDOW_MS && app.startMs <= mic.endMs + ECHO_WINDOW_MS;
}
