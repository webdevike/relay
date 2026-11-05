// Who said what on the call track, live. Two signals:
//
// - The meeting app's window (the capture helper reads it through Accessibility five times a
//   second): who it marks as talking, who is muted, and caption lines with names. Samples are
//   stamped with their position on the app track (`at`, in samples).
// - The worker's voice labels: every final call-track line comes back as turns of call-wide voices
//   ("2", "3", ...), some named by a known voice print.
//
// A word's speaker, in order: the caption that has the word around then; the one person the app
// marks as talking around it (with two, the one whose voice it is); the name the app gave that
// voice most of the time so far; the name a known voice print gives it; "Speaker N". A final line
// is split where the speaker changes. The names the app gave each voice (votes, by seconds) carry
// the live view through silence, a missing tile and overlap, and are what the after-call pass and
// Relay's voice prints learn from.

import { MEETING_SAMPLE_RATE } from "@relay/protocol";
import { z } from "zod";

const Name = z.string().min(1).max(200);

/** One sample of the meeting app's window (a `meeting.speakers` line, `speakers.jsonl`). */
export const PlatformSampleSchema = z.object({
  /** Its moment on the app track, in samples. */
  at: z.number().int().nonnegative(),
  /** Who the app marks as talking. */
  speaking: z.array(Name).max(100),
  /** Who is not muted, when the app shows mute state. */
  unmuted: z.array(Name).max(500).optional(),
  roster: z.array(Name).max(500),
  /** Caption lines on screen, oldest first. */
  captions: z
    .array(z.object({ name: Name, text: z.string().max(4000) }))
    .max(20)
    .optional(),
});
export type PlatformSample = z.infer<typeof PlatformSampleSchema>;

export interface VoiceTurn {
  readonly start: number;
  readonly end: number;
  readonly speaker: number;
}

/** A word on the app track: [start, end] in samples. */
export type Word = readonly [start: number, end: number, text: string];

export type Source = "caption" | "platform" | "voice" | "known" | "label";

export interface Segment {
  readonly speaker: string;
  readonly source: Source;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const SR = MEETING_SAMPLE_RATE;
/** A window sample's state holds until the next one, at most this long (the helper repeats every 5 s). */
const HOLD = 6 * SR;
/** The app's talking mark is checked this far around a word (its indicator lags or leads audio). */
const AROUND = Math.round(0.35 * SR);
/** Captions show a word up to this long after it was said (and a little before, for clock skew). */
const CAPTION_AFTER = 10 * SR;
const CAPTION_BEFORE = 1 * SR;
/** A voice gets the app's name once this much of its speech carried that name, at this share. */
const VOTE_MIN = 3 * SR;
const VOTE_SHARE = 0.6;
/** Segments shorter than this many words join a neighbour (no one-word speaker flicker). */
const MIN_WORDS = 2;
/** Caption words count only in runs this long that the line shares with a caption. */
const CAPTION_RUN = 3;

export function normWord(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}

export class SpeakerTimeline {
  private readonly samples: PlatformSample[] = [];
  private readonly turns: VoiceTurn[] = [];
  /** Voice label -> name -> samples of speech the app marked with that name alone. */
  private readonly votes = new Map<number, Map<string, number>>();
  /** Voice label -> name from a known voice print (the worker's). */
  private readonly known = new Map<number, string>();
  /** Every remote participant the app showed. */
  readonly roster = new Set<string>();
  /** Whether the app ever marked anyone as talking (else muted state stands in). */
  private sawSpeaking = false;

  constructor(
    /** The calendar's other side of a 1:1, when known. */
    private readonly remoteName: () => string | undefined = () => undefined,
  ) {}

  addSample(s: PlatformSample): void {
    // Samples arrive in order; a resend after a reconnect may repeat one.
    const last = this.samples[this.samples.length - 1];
    if (last !== undefined && s.at < last.at) {
      const i = this.samples.findIndex((x) => x.at > s.at);
      this.samples.splice(i, 0, s);
    } else this.samples.push(s);
    for (const n of s.roster) this.roster.add(n);
    if (s.speaking.length > 0) this.sawSpeaking = true;
  }

  get hasPlatform(): boolean {
    return this.samples.length > 0;
  }

  addTurns(turns: readonly VoiceTurn[], names: Readonly<Record<string, string>>): void {
    for (const t of turns) this.turns.push(t);
    this.turns.sort((a, b) => a.start - b.start);
    for (const [k, v] of Object.entries(names)) this.known.set(Number(k), v);
  }

  /** The voice label at a sample (the turn holding it, else the nearest within half a second). */
  voiceAt(at: number): number | null {
    let best: number | null = null;
    let gap = SR / 2;
    // Turns sit inside utterances of at most 15 s, so none starting earlier than that can hold `at`.
    for (let i = lowerBound(this.turns, at - 16 * SR, (t) => t.start); i < this.turns.length; i++) {
      const t = this.turns[i];
      if (t === undefined) break;
      if (t.start > at + gap) break;
      if (t.start <= at && at <= t.end) return t.speaker;
      const d = Math.min(Math.abs(at - t.start), Math.abs(at - t.end));
      if (d < gap) {
        gap = d;
        best = t.speaker;
      }
    }
    return best;
  }

  /** Samples of [from, to) each name was marked talking (or, for an app that never marks anyone, the only one unmuted). */
  marked(from: number, to: number): Map<string, number> {
    const out = new Map<string, number>();
    const s = this.samples;
    // The last sample at or before `from`, then every one up to `to`.
    let i = lowerBound(s, from, (x) => x.at) - 1;
    if (i < 0) i = 0;
    for (; i < s.length; i++) {
      const cur = s[i];
      if (cur === undefined || cur.at >= to) break;
      const next = s[i + 1];
      const holdEnd = Math.min(next?.at ?? cur.at + HOLD, cur.at + HOLD);
      const a = Math.max(from, cur.at);
      const b = Math.min(to, holdEnd);
      if (b <= a) continue;
      const who = this.sawSpeaking ? cur.speaking : cur.unmuted?.length === 1 ? cur.unmuted : [];
      for (const n of who) out.set(n, (out.get(n) ?? 0) + (b - a));
    }
    return out;
  }

  /**
   * Caption names for a line's words: every caption shown from just before the line to
   * CAPTION_AFTER past it is aligned with the words (longest common subsequence), and a run of
   * CAPTION_RUN or more words in a row in both names its words (common words like "of the" are in
   * everyone's captions; a run of three is someone's sentence). A line shorter than a run matches
   * whole. The longest run wins a word.
   */
  private captionNames(words: readonly Word[]): (string | null)[] {
    const out: (string | null)[] = words.map(() => null);
    const first = words[0];
    const last = words[words.length - 1];
    if (first === undefined || last === undefined) return out;
    const asr = words.map((w) => normWord(w[2]));
    const seen = new Set<string>();
    const best: number[] = words.map(() => 0);
    const s = this.samples;
    for (let k = lowerBound(s, first[0] - CAPTION_BEFORE, (x) => x.at); k < s.length; k++) {
      const cur = s[k];
      if (cur === undefined || cur.at > last[1] + CAPTION_AFTER) break;
      for (const c of cur.captions ?? []) {
        const key = `${c.name}\n${c.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const cap = c.text
          .split(/\s+/)
          .map(normWord)
          .filter((x) => x !== "");
        const need = Math.min(CAPTION_RUN, asr.length);
        for (const run of commonRuns(asr, cap, need))
          for (let i = run.from; i < run.from + run.length; i++)
            if (run.length > (best[i] ?? 0)) {
              best[i] = run.length;
              out[i] = c.name;
            }
      }
    }
    return out;
  }

  /** The name the app gave a voice most, once there is enough of it. */
  nameOfVoice(v: number): string | null {
    const by = this.votes.get(v);
    if (by === undefined) return null;
    let total = 0;
    for (const n of by.values()) total += n;
    const best = top(by);
    if (best === null || total < VOTE_MIN || (by.get(best) ?? 0) / total < VOTE_SHARE) return null;
    return best;
  }

  /** Voices whose name the app settled, with the seconds behind it (for learning prints). */
  settled(
    minSeconds: number,
    minShare: number,
  ): { voice: number; name: string; seconds: number }[] {
    const out: { voice: number; name: string; seconds: number }[] = [];
    for (const [v, by] of this.votes) {
      let total = 0;
      for (const n of by.values()) total += n;
      const best = top(by);
      const n = best === null ? 0 : (by.get(best) ?? 0);
      if (best !== null && n >= minSeconds * SR && n / total >= minShare)
        out.push({ voice: v, name: best, seconds: n / SR });
    }
    return out;
  }

  private vote(v: number, name: string, samples: number): void {
    let by = this.votes.get(v);
    if (by === undefined) {
      by = new Map();
      this.votes.set(v, by);
    }
    by.set(name, (by.get(name) ?? 0) + samples);
  }

  /** The label for a voice nobody named: the calendar's other side when it is the only voice. */
  private fallbackName(v: number | null): { speaker: string; source: Source } {
    if (v !== null) {
      const voted = this.nameOfVoice(v);
      if (voted !== null) return { speaker: voted, source: "voice" };
      const k = this.known.get(v);
      if (k !== undefined) return { speaker: k, source: "known" };
    }
    const voices = new Set(this.turns.map((t) => t.speaker));
    if (this.roster.size === 1 && voices.size <= 1)
      return { speaker: [...this.roster][0] ?? "Remote", source: "platform" };
    const remote = this.remoteName();
    if (remote !== undefined && voices.size <= 1 && this.roster.size === 0)
      return { speaker: remote, source: "label" };
    return { speaker: v === null ? "Remote" : `Speaker ${String(v)}`, source: "label" };
  }

  /**
   * Speaker segments of a final line's words. `learn` adds the app's names to the voice votes
   * (once per line: the caller passes true the first time a line has both its words and turns).
   */
  segments(words: readonly Word[], learn: boolean): Segment[] {
    const named: { speaker: string; source: Source; w: Word }[] = [];
    const captions = this.captionNames(words);
    for (const [i, w] of words.entries()) {
      const v = this.voiceAt((w[0] + w[1]) / 2);
      const caption = captions[i] ?? null;
      if (caption !== null) {
        if (learn && v !== null) this.vote(v, caption, w[1] - w[0]);
        named.push({ speaker: caption, source: "caption", w });
        continue;
      }
      const on = this.marked(w[0] - AROUND, w[1] + AROUND);
      if (on.size === 1) {
        const name = [...on.keys()][0] ?? "";
        if (learn && v !== null) this.vote(v, name, w[1] - w[0]);
        named.push({ speaker: name, source: "platform", w });
        continue;
      }
      if (on.size > 1) {
        // Two talking at once: the one this voice belongs to, else the one marked longest.
        const mine = v === null ? null : this.nameOfVoice(v);
        named.push({
          speaker: mine !== null && on.has(mine) ? mine : (top(on) ?? ""),
          source: "platform",
          w,
        });
        continue;
      }
      named.push({ ...this.fallbackName(v), w });
    }
    return smooth(named);
  }
  /** A draft's speaker: the app's mark over its span, else its voice's name, else the last known. */
  draftSpeaker(start: number, end: number, previous: string | undefined): string {
    const on = this.marked(start, end);
    const t = top(on);
    if (t !== null) return t;
    const v = this.voiceAt(end);
    if (v !== null) return this.fallbackName(v).speaker;
    return previous ?? this.fallbackName(null).speaker;
  }
}

/** Index of the first item whose key is >= x (items sorted by key). */
function lowerBound<T>(s: readonly T[], x: number, key: (item: T) => number): number {
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const item = s[mid];
    if (item !== undefined && key(item) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function top(m: ReadonlyMap<string, number>): string | null {
  let best: string | null = null;
  let n = -1;
  for (const [k, v] of m)
    if (v > n) {
      best = k;
      n = v;
    }
  return best;
}

const RANK: Record<Source, number> = { caption: 4, platform: 3, voice: 2, known: 1, label: 0 };

/** Consecutive same-speaker words as segments; runs under MIN_WORDS join the stronger neighbour. */
function smooth(named: readonly { speaker: string; source: Source; w: Word }[]): Segment[] {
  const runs: { speaker: string; source: Source; words: Word[] }[] = [];
  for (const n of named) {
    const last = runs[runs.length - 1];
    if (last?.speaker === n.speaker) {
      last.words.push(n.w);
      if (RANK[n.source] > RANK[last.source]) last.source = n.source;
    } else runs.push({ speaker: n.speaker, source: n.source, words: [n.w] });
  }
  let changed = true;
  while (changed && runs.length > 1) {
    changed = false;
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      if (r === undefined || r.words.length >= MIN_WORDS) continue;
      const prev = runs[i - 1];
      const next = runs[i + 1];
      const into =
        prev === undefined
          ? next
          : next === undefined
            ? prev
            : prev.words.length >= next.words.length
              ? prev
              : next;
      if (into === undefined) continue;
      if (into === prev) into.words.push(...r.words);
      else into.words.unshift(...r.words);
      runs.splice(i, 1);
      // Neighbours of one speaker meet again: one run.
      for (let j = 1; j < runs.length; j++) {
        const a = runs[j - 1];
        const b = runs[j];
        if (a !== undefined && a.speaker === b?.speaker) {
          a.words.push(...b.words);
          if (RANK[b.source] > RANK[a.source]) a.source = b.source;
          runs.splice(j, 1);
          j--;
        }
      }
      changed = true;
      break;
    }
  }
  return runs.map((r) => ({
    speaker: r.speaker,
    source: r.source,
    start: r.words[0]?.[0] ?? 0,
    end: r.words[r.words.length - 1]?.[1] ?? 0,
    text: r.words.map((w) => w[2]).join(" "),
  }));
}

/**
 * Maximal stretches of `need` or more words in a row that `a` and `b` share (positions in `a`):
 * `n[i][j]` counts the equal words ending at a[i-1] and b[j-1]; a stretch is maximal when the next
 * pair differs or either list ends.
 */
function commonRuns(
  a: readonly string[],
  b: readonly string[],
  need: number,
): { from: number; length: number }[] {
  const runs: { from: number; length: number }[] = [];
  const w = b.length + 1;
  const n = new Int32Array((a.length + 1) * w);
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] !== b[j - 1]) continue;
      const len = (n[(i - 1) * w + j - 1] ?? 0) + 1;
      n[i * w + j] = len;
      const goesOn = i < a.length && j < b.length && a[i] === b[j];
      if (!goesOn && len >= need) runs.push({ from: i - len, length: len });
    }
  return runs;
}
