// After a call: the notes, in MeetingTranscriber's protocol format so meeting-digest,
// meeting-memory and the Meetings page read them unchanged.
//
//   transcribing  the mic through AEC3 against the call track, then both tracks re-transcribed
//                 whole (the live lines are drafts of this)
//   diarizing     the call track's voices told apart (sherpa-onnx; R_S1.. labels, mic = M_S1)
//   naming        the meeting app's own names first (namesFromCall: who its window marked as
//                 talking during each voice's turns, and the names the live transcript gave), then
//                 mt-autoname's rules (`<agent home>/.omp/tools/mt-autoname.ts`): the mic is the
//                 human, a calendar 1:1 or a two-person Slack DM names the remote voice, group
//                 calls keep raw labels.
//   summarizing   headless Claude (Sonnet, no tools) writes Summary .. Open Questions
//
// Output: `work/meetings/protocols/<YYYYMMDD_HHMM>_<slug>_<id8>.md` plus the `.txt` transcript, or
// work/meetings/shadow for a recording made in shadow mode (digest and memory do not read it).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { meetingClock, MEETING_SAMPLE_RATE as SR, type LiveLine } from "@relay/protocol";
import { z } from "zod";
import type { ToolRun } from "../reviews/exec";
import type { Asr, Segment, Turn } from "./asr";
import { ECHO_WINDOW_MS, ownSpeech, triples } from "./echo";
import { calendarTitle } from "./route";
import type { AfterCall } from "./service";
import { SpeakerTimeline, type PlatformSample } from "./speakers";
import type { RecordingMeta, RecordingStore } from "./store";

/** The parts of mt-autoname.ts this uses (it keeps its side effects behind import.meta.main). */
export interface Autoname {
  lookupMeeting(
    start: Date | undefined,
    title: string,
  ): Promise<{ annotation: string; remoteName?: string } | undefined>;
  autoMapping(
    speakers: { label: string; suggested: string }[],
    micName: string,
    micOnly?: boolean,
    remoteName?: string,
  ): Record<string, string>;
  withAttendees(protocol: string, meeting: { annotation: string }): string;
}

/** mt-autoname.ts from the agent home, or null when it is not there. */
export async function loadAutoname(
  agentHome: string | null,
  log: (line: string) => void,
): Promise<Autoname | null> {
  if (agentHome === null) return null;
  try {
    // A runtime path: the tool lives in the agent home's checkout, not in this repo.
    const mod = (await import(
      join(agentHome, ".omp", "tools", "mt-autoname.ts")
    )) as Partial<Autoname>;
    if (
      typeof mod.lookupMeeting !== "function" ||
      typeof mod.autoMapping !== "function" ||
      typeof mod.withAttendees !== "function"
    )
      return null;
    return mod as Autoname;
  } catch (error) {
    log(
      `meetings: mt-autoname unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export interface Utterance {
  readonly start: number;
  readonly end: number;
  readonly label: string;
  readonly text: string;
}

/** The call track's speaker for a segment: the turn overlapping it most; `R_S1` without turns. */
export function labelSegments(segments: readonly Segment[], turns: readonly Turn[]): Utterance[] {
  return segments.map((s) => {
    let best = 0;
    let speaker = 1;
    for (const t of turns) {
      const overlap = Math.min(s.end, t.end) - Math.max(s.start, t.start);
      if (overlap > best) {
        best = overlap;
        speaker = t.speaker;
      }
    }
    return { start: s.start, end: s.end, label: `R_S${String(speaker)}`, text: s.text };
  });
}

/** Below this share of a voice's talk, the window's or the live view's name is not given to it. */
const NAME_SHARE = 0.5;
/** A segment the window marked as one person for at least this share of it is theirs outright. */
const SEGMENT_SHARE = 0.7;

/**
 * The call's own names for the after-call voices: each `R_S` label gets the name the window marked
 * as talking for most of its turns (or, with no window, the name most of its live lines carried),
 * and a segment the window marked as one person is that person whatever its label. Answers the
 * relabelled segments (outright ones carry the name as their label), the label names, and everyone
 * the window showed.
 */
export function namesFromCall(
  remote: readonly Utterance[],
  turns: readonly Turn[],
  samples: readonly PlatformSample[],
  live: readonly LiveLine[],
): { remote: Utterance[]; names: Record<string, string>; roster: string[] } {
  const timeline = new SpeakerTimeline();
  for (const s of samples) timeline.addSample(s);
  const votes = new Map<string, Map<string, number>>();
  const vote = (label: string, name: string, seconds: number): void => {
    const by = votes.get(label) ?? new Map<string, number>();
    by.set(name, (by.get(name) ?? 0) + seconds);
    votes.set(label, by);
  };
  for (const t of turns) {
    const label = `R_S${String(t.speaker)}`;
    const marked = timeline.marked(t.start * SR, t.end * SR);
    for (const [name, n] of marked) vote(label, name, n / SR);
    if (marked.size > 0) continue;
    for (const l of live) {
      if (l.track !== "app" || !l.final || /^(Speaker \d+|Remote)$/.test(l.speaker)) continue;
      const overlap = Math.min(t.end, l.endMs / 1000) - Math.max(t.start, l.startMs / 1000);
      if (overlap > 0) vote(label, l.speaker, overlap);
    }
  }
  const names: Record<string, string> = {};
  for (const [label, by] of votes) {
    let total = 0;
    let best = "";
    let most = 0;
    for (const [name, s] of by) {
      total += s;
      if (s > most) {
        best = name;
        most = s;
      }
    }
    if (most >= 2 && most / total >= NAME_SHARE) names[label] = best;
  }
  const relabelled = remote.map((u) => {
    const marked = timeline.marked(u.start * SR, u.end * SR);
    const length = (u.end - u.start) * SR;
    if (marked.size !== 1 || length <= 0) return u;
    const [name, n] = [...marked][0] ?? ["", 0];
    return n / length >= SEGMENT_SHARE ? { ...u, label: name } : u;
  });
  return { remote: relabelled, names, roster: [...timeline.roster].sort() };
}

/** Mic segments with the call's echo taken out (the same word-run rule as the live view). */
export function micUtterances(mic: readonly Segment[], app: readonly Segment[]): Utterance[] {
  const out: Utterance[] = [];
  const windowS = ECHO_WINDOW_MS / 1000;
  for (const s of mic) {
    const call = new Set<string>();
    for (const a of app)
      if (a.end >= s.start - windowS && a.start <= s.end + windowS)
        for (const t of triples(a.text)) call.add(t);
    const own = ownSpeech(s.text, call).trim();
    if (own !== "") out.push({ start: s.start, end: s.end, label: "M_S1", text: own });
  }
  return out;
}

/** `20261102_1004_weekly_engineering_sync_6f1c2b8e`. */
export function protocolStem(
  meta: Pick<RecordingMeta, "id" | "app" | "title" | "startedAt">,
): string {
  const d = new Date(meta.startedAt);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const when = `${String(d.getFullYear())}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const slug =
    (meta.title ?? meta.app)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40)
      .replace(/_+$/, "") || "meeting";
  return `${when}_${slug}_${meta.id.replace(/-/g, "").slice(0, 8)}`;
}

/** `[mm:ss] Name: text` lines, in time order. */
export function transcriptLines(
  utterances: readonly Utterance[],
  names: Record<string, string>,
): string {
  return [...utterances]
    .sort((a, b) => a.start - b.start)
    .map((u) => `[${meetingClock(u.start * 1000)}] ${names[u.label] ?? u.label}: ${u.text}`)
    .join("\n");
}

export const SUMMARY_PROMPT = `You write meeting notes from a machine transcript. Lines are "[mm:ss] Speaker: text". The speaker named as the host's user is the person these notes are for; labels like R_S2 are voices nobody named.
Start with one line "Title: <what this meeting was, 2 to 6 words, e.g. UI/UX Standup>", then write these sections in Markdown, in this order, with exactly these headings:
## Summary
(one paragraph)
## Participants
(a bullet per speaker; keep raw labels, add what they worked on when clear, e.g. "- Bill (R_S3)")
## Topics Discussed
(### subheadings with bullets)
## Decisions
(bullets)
## Tasks
| Task | Responsible | Deadline | Priority |
|------|-------------|----------|----------|
(Deadline: a date, a day, or Open. Priority: 🔴 high, 🟡 medium or 🟢 low)
## Open Questions
(bullets)
Be factual; nothing that is not in the transcript. Plain sentences, no em dashes.`;

export interface PipelineDeps {
  readonly store: RecordingStore;
  readonly asr: Asr | null;
  readonly agentHome: string | null;
  /** `<agent home>/work/meetings`: a recording's notes go to its `shadow/` (recorded in shadow mode)
   * or `protocols/` (after the cutover), so notes from before the cutover stay where they were. */
  readonly meetingsDir: string;
  readonly human: string;
  readonly claude: string;
  readonly run: ToolRun;
  readonly autoname: () => Promise<Autoname | null>;
  readonly log: (line: string) => void;
}

const ClaudeReply = z.object({ result: z.string().optional(), is_error: z.boolean().optional() });

export class MeetingPipeline implements AfterCall {
  constructor(private readonly deps: PipelineDeps) {}

  private dirOf(meta: Pick<RecordingMeta, "shadow">): string {
    return join(this.deps.meetingsDir, meta.shadow ? "shadow" : "protocols");
  }

  private file(meta: RecordingMeta, ext: "md" | "txt"): string {
    return join(this.dirOf(meta), `${meta.stem ?? protocolStem(meta)}.${ext}`);
  }

  notes(meta: RecordingMeta): string | null {
    try {
      return readFileSync(this.file(meta, "md"), "utf8");
    } catch {
      return null;
    }
  }

  remove(meta: RecordingMeta): void {
    if (meta.stem === null) return;
    for (const ext of ["md", "txt"] as const) rmSync(this.file(meta, ext), { force: true });
  }

  async rename(meta: RecordingMeta, label: string, name: string): Promise<void> {
    const speaker = new RegExp(`(\\] )${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "g");
    for (const ext of ["md", "txt"] as const) {
      const path = this.file(meta, ext);
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      text = text
        .replace(speaker, `$1${name}:`)
        .replace(new RegExp(`^- ${label}$`, "m"), `- ${name} (${label})`);
      writeFileSync(path, text);
    }
    await Promise.resolve();
  }

  async lookup(meta: RecordingMeta): Promise<RecordingMeta["context"]> {
    const autoname = await this.deps.autoname();
    if (autoname === null) return null;
    const found = await autoname.lookupMeeting(new Date(meta.startedAt), meta.title ?? "");
    if (found === undefined) return null;
    return found.remoteName === undefined
      ? { annotation: found.annotation }
      : { annotation: found.annotation, remoteName: found.remoteName };
  }

  /** The notes sections, and the meeting's name as the summary saw it (null when it gave none). */
  private async summarize(
    transcript: string,
    title: string,
  ): Promise<{ title: string | null; sections: string }> {
    const cwd = mkdtempSync(join(tmpdir(), "relay-meeting-"));
    try {
      const prompt = `${SUMMARY_PROMPT}\nThe host's user is ${this.deps.human}. The meeting: ${title}.\n\n<transcript>\n${transcript}\n</transcript>`;
      const r = await this.deps.run(
        [
          this.deps.claude,
          "-p",
          prompt,
          "--model",
          "sonnet",
          "--tools",
          "",
          "--setting-sources",
          "",
          "--no-session-persistence",
          "--output-format",
          "json",
        ],
        // EVA_GATE_OFF: the Habit Gate's Claude Code hook must not block an unattended summary (mt-claude.sh).
        { cwd, timeoutMs: 600_000, env: { EVA_GATE_OFF: "1" } },
      );
      let reply: z.infer<typeof ClaudeReply> = {};
      try {
        reply = ClaudeReply.parse(JSON.parse(r.stdout));
      } catch {
        // not JSON: the error below says what claude printed
      }
      if (r.code !== 0 || reply.is_error === true || reply.result === undefined) {
        throw new Error(
          `the summary failed: ${(reply.result ?? (r.stderr || r.stdout)).trim().slice(0, 300) || (r.timedOut ? "timed out" : `exit ${String(r.code)}`)}`,
        );
      }
      const at = reply.result.indexOf("## Summary");
      const head = at >= 0 ? reply.result.slice(0, at) : "";
      const named = /^\W*Title:\**\s*(.+)$/im.exec(head)?.[1]?.replace(/[*"]/g, "").trim() ?? "";
      return {
        title: named === "" ? null : named.slice(0, 120),
        sections: (at >= 0 ? reply.result.slice(at) : reply.result).trim(),
      };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  async run(
    meta: RecordingMeta,
    live: readonly LiveLine[],
    qa: readonly { question: string; answer: string }[],
    report: { stage(stage: RecordingMeta["stage"], error?: string): void },
  ): Promise<{ stem: string; title: string | null; context: RecordingMeta["context"] } | null> {
    const asr = this.deps.asr;
    if (asr === null)
      throw new Error("This host has no transcription worker; run apps/linux/asr/setup.sh on it.");
    const total = meta.total ?? { app: 0, mic: 0 };
    const dir = this.deps.store.dir(meta.id);
    report.stage("transcribing");
    const appWav = this.deps.store.wav(meta.id, "app", total.app);
    const micWav = this.deps.store.wav(meta.id, "mic", total.mic);
    const micClean = join(dir, "mic-aec.wav");
    await asr.aec(appWav, micWav, micClean);
    const [app, mic] = await Promise.all([asr.transcribe(appWav), asr.transcribe(micClean)]);
    if (app.length === 0 && mic.length === 0) {
      throw new Error(
        meta.health === "silent-app"
          ? "Empty transcript: the call audio was silent (System Audio Recording not granted to Relay?) and the mic heard nothing."
          : "Empty transcript: nothing was said on either track.",
      );
    }
    report.stage("diarizing");
    const turns = app.length === 0 ? [] : await asr.diarize(appWav);
    const call = namesFromCall(
      labelSegments(app, turns),
      turns,
      this.deps.store.speakers(meta.id).samples,
      live,
    );
    const remote = call.remote;
    const own = micUtterances(mic, app);
    report.stage("naming");
    const context =
      meta.context ??
      (await this.lookup(meta).catch((error: unknown) => {
        this.deps.log(
          `meetings: lookup for ${meta.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }));
    const autoname = await this.deps.autoname();
    const speakers = [...new Set([...own, ...remote].map((u) => u.label))].map((label) => ({
      label,
      suggested: label,
    }));
    const mapped =
      autoname === null
        ? Object.fromEntries(
            speakers.map((s) => [s.label, s.label.startsWith("M_") ? this.deps.human : s.label]),
          )
        : autoname.autoMapping(speakers, this.deps.human, false, context?.remoteName);
    // The app's names over the calendar's; Isaac's own fixes over everything.
    const names = { ...mapped, ...call.names, ...meta.names };
    report.stage("summarizing");
    const transcript = transcriptLines([...own, ...remote], names);
    // The window's title, else the calendar event's, else what the summary calls it.
    const known = meta.title ?? (context === null ? null : calendarTitle(context.annotation));
    const summary = await this.summarize(transcript, known ?? `${meta.app} call`);
    const named = known ?? summary.title;
    const title = named ?? `${meta.app} call`;
    const sections = summary.sections;
    const d = new Date(meta.startedAt);
    const pad = (n: number): string => String(n).padStart(2, "0");
    let md = `# Meeting Protocol - ${title}\n**Date:** ${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}\n**Time:** ${pad(d.getHours())}:${pad(d.getMinutes())}\n`;
    if (context !== null && autoname !== null) md = autoname.withAttendees(md, context);
    else if (context !== null) md += `${context.annotation}\n`;
    else if (call.roster.length > 0)
      md += `**Attendees:** ${[this.deps.human, ...call.roster].join(", ")} (from the call)\n`;
    md += `\n---\n\n${sections}\n`;
    if (qa.length > 0)
      md += `\n## Questions asked during the call\n\n${qa.map((q) => `**Q:** ${q.question}\n\n${q.answer.trim()}`).join("\n\n")}\n`;
    md += `\n---\n\n## Full Transcript\n\n${transcript}\n`;
    const stem = protocolStem({ ...meta, title: named });
    const out = this.dirOf(meta);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${stem}.md`), md);
    writeFileSync(join(out, `${stem}.txt`), `${transcript}\n`);
    for (const f of ["app.wav", "mic.wav", "mic-aec.wav"]) rmSync(join(dir, f), { force: true });
    this.deps.log(`meetings: notes for ${meta.id} in ${join(out, `${stem}.md`)}`);
    return { stem, title: named, context };
  }
}
