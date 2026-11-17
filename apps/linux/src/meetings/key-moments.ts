// The key moments machine's runtime (key-moments.machine.ts): its `extract` actor asks a small,
// cheap model (`claude -p --model haiku`, Isaac's subscription, no tools) which of a window's
// transcript lines hold a decision, an ask of Isaac, an action or a notable claim, and turns its
// answer into moments on those lines (time, line, speaker, the screen snapshot on show then).
// `replayKeyMoments` runs a recorded transcript through all of it with a fast clock, for checking
// what a whole call yields.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KeyMomentKind,
  meetingClock,
  shotNear,
  type KeyMoment,
  type LiveLine,
  type MeetingShot,
} from "@relay/protocol";
import {
  createActor,
  fromPromise,
  toPromise,
  type Actor,
  type ActorOptions,
  type AnyActorLogic,
} from "xstate";
import { z } from "zod";
import type { ToolRun } from "../reviews/exec";
import {
  KEY_MOMENTS_WINDOW_MS,
  keyMomentsMachine,
  type ExtractInput,
  type KeyMomentsInput,
  type MomentDraft,
  type MomentLine,
} from "./key-moments.machine";

/** A moment the model pointed at: the line it was said in, its kind and one short line. */
export interface FoundMoment {
  readonly lineId: string;
  readonly kind: KeyMomentKind;
  readonly text: string;
}

/** What finds moments in a window of lines (the model in production, a stub in tests). */
export type MomentFinder = (input: ExtractInput) => Promise<readonly FoundMoment[]>;

export type KeyMomentsActor = Actor<typeof keyMomentsMachine>;

/** At most this many moments are taken from one window. */
const MAX_PER_WINDOW = 6;
/** The existing moments the model is shown (the newest), so it does not repeat them. */
const SHOWN_MOMENTS = 40;

/** The lines moments can come from: final, not the call's echo in the mic, not empty. */
export function momentLines(lines: readonly LiveLine[]): MomentLine[] {
  return lines
    .filter((l) => l.final && l.echo !== true && l.text.trim() !== "")
    .map((l) => ({ id: l.id, startMs: l.startMs, speaker: l.speaker, text: l.text.trim() }));
}

/** The prompt for one window: numbered lines (context first), the moments so far, the answer's shape. */
export function momentsPrompt(input: ExtractInput, human: string): string {
  const all = [...input.context, ...input.lines];
  const firstNew = input.context.length + 1;
  const numbered = all
    .map((l, i) => `${String(i + 1)}. [${meetingClock(l.startMs)}] ${l.speaker}: ${l.text}`)
    .join("\n");
  const known = input.moments
    .slice(-SHOWN_MOMENTS)
    .map((m) => `- ${m.kind}: ${m.text}`)
    .join("\n");
  return `You pick the key moments out of a slice of a live meeting transcript, for ${human}, who is in the call. Lines are "<number>. [mm:ss] Speaker: text"; lines from ${human}'s mic carry his name, labels like R_S2 or Remote are other people. It is a machine transcription, so read past small errors.
Kinds:
- decision: something was settled or agreed.
- ask: someone asks ${human} to do, send, check, decide or answer something.
- action: someone takes a task on ("I'll send it", "Bill will fix the build").
- claim: a notable fact, number, date or deadline someone states that is worth checking later.
Only lines ${String(firstNew)} to ${String(all.length)} are new; pick moments only from them. Earlier lines are context. Skip greetings, small talk, filler and anything the moments found so far already cover. Most slices have none, one or two; never more than ${String(MAX_PER_WINDOW)}.
For each moment give the number of the line it was said in, its kind, and one short line (at most 120 characters, plain words, no em dashes) saying what it is, like "Ship the release Tuesday after standup" or "Wants the Q3 numbers by Friday".
Answer with only JSON, no prose: {"moments":[{"line":12,"kind":"decision","text":"..."}]} or {"moments":[]}.

Moments found so far:
${known === "" ? "(none)" : known}

<transcript>
${numbered}
</transcript>`;
}

const ClaudeReply = z.object({ result: z.string().optional(), is_error: z.boolean().optional() });
const ModelReply = z.object({
  moments: z.array(
    z.object({ line: z.number().int(), kind: KeyMomentKind, text: z.string().min(1).max(1_000) }),
  ),
});

/** The model's answer as moments on the new lines; anything pointing elsewhere is dropped. */
export function parseMoments(result: string, input: ExtractInput): FoundMoment[] {
  const start = result.indexOf("{");
  const end = result.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`no JSON in the reply: ${result.slice(0, 200)}`);
  const reply = ModelReply.parse(JSON.parse(result.slice(start, end + 1)));
  const out: FoundMoment[] = [];
  for (const m of reply.moments) {
    const line = input.lines[m.line - input.context.length - 1];
    if (line === undefined) continue;
    out.push({ lineId: line.id, kind: m.kind, text: m.text });
    if (out.length >= MAX_PER_WINDOW) break;
  }
  return out;
}

export interface ClaudeFinderDeps {
  readonly claude: string;
  readonly run: ToolRun;
  /** The host's user, who the asks are of. */
  readonly human: string;
  readonly timeoutMs?: number;
}

/** Finds moments with headless Claude Haiku, the way the after-call summary runs Sonnet (pipeline.ts). */
export function claudeFinder(deps: ClaudeFinderDeps): MomentFinder {
  return async (input) => {
    if (input.lines.length === 0) return [];
    const cwd = mkdtempSync(join(tmpdir(), "relay-moments-"));
    try {
      const r = await deps.run(
        [
          deps.claude,
          "-p",
          momentsPrompt(input, deps.human),
          "--model",
          "haiku",
          "--tools",
          "",
          "--setting-sources",
          "",
          "--no-session-persistence",
          "--output-format",
          "json",
        ],
        // EVA_GATE_OFF: the Habit Gate's Claude Code hook must not block an unattended run (mt-claude.sh).
        { cwd, timeoutMs: deps.timeoutMs ?? 120_000, env: { EVA_GATE_OFF: "1" } },
      );
      let reply: z.infer<typeof ClaudeReply> = {};
      try {
        reply = ClaudeReply.parse(JSON.parse(r.stdout));
      } catch {
        // not JSON: the error below says what claude printed
      }
      if (r.code !== 0 || reply.is_error === true || reply.result === undefined) {
        throw new Error(
          `key moments failed: ${(reply.result ?? (r.stderr || r.stdout)).trim().slice(0, 300) || (r.timedOut ? "timed out" : `exit ${String(r.code)}`)}`,
        );
      }
      return parseMoments(reply.result, input);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

/** The finder's moments as drafts: time, speaker and the snapshot on show come from their line. */
export function draftsOf(
  found: readonly FoundMoment[],
  lines: readonly MomentLine[],
  shots: readonly Pick<MeetingShot, "n" | "atMs">[],
): MomentDraft[] {
  const out: MomentDraft[] = [];
  for (const f of found) {
    const line = lines.find((l) => l.id === f.lineId);
    if (line === undefined) continue;
    out.push({
      kind: f.kind,
      atMs: line.startMs,
      lineId: line.id,
      speaker: line.speaker,
      text: f.text,
      shot: shotNear(shots, line.startMs),
    });
  }
  return out;
}

export interface KeyMomentsOptions {
  readonly find: MomentFinder;
  /** The recording's snapshots so far (read at each extraction). */
  readonly shots: () => readonly Pick<MeetingShot, "n" | "atMs">[];
  readonly input?: KeyMomentsInput;
  /** The timers' clock (the host's session clock in the service, SimulatedClock in tests). */
  readonly clock?: ActorOptions<AnyActorLogic>["clock"];
  readonly log?: (line: string) => void;
}

/** A running key moments actor for one recording. */
export function startKeyMoments(o: KeyMomentsOptions): KeyMomentsActor {
  const machine = keyMomentsMachine.provide({
    actors: {
      extract: fromPromise<readonly MomentDraft[], ExtractInput>(async ({ input }) => {
        try {
          return draftsOf(await o.find(input), input.lines, o.shots());
        } catch (error) {
          o.log?.(`meetings: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
      }),
    },
  });
  const actor = createActor(machine, {
    input: o.input ?? {},
    ...(o.clock === undefined ? {} : { clock: o.clock }),
  });
  actor.start();
  return actor;
}

/**
 * Runs a recorded transcript through the real machine and finder as the live call would, with the
 * clock sped up so a KEY_MOMENTS_WINDOW_MS window lasts `windowMs`: lines arrive at their own
 * (scaled) times, the call ends after the last one, and the answer is the final moments.
 * `onExtract` sees each window's input (to count the model calls).
 */
export async function replayKeyMoments(
  lines: readonly LiveLine[],
  o: {
    readonly find: MomentFinder;
    readonly windowMs: number;
    readonly shots?: readonly Pick<MeetingShot, "n" | "atMs">[];
    readonly onExtract?: (input: ExtractInput) => void;
    readonly log?: (line: string) => void;
  },
): Promise<readonly KeyMoment[]> {
  const scale = o.windowMs / KEY_MOMENTS_WINDOW_MS;
  const actor = startKeyMoments({
    find: (input) => {
      o.onExtract?.(input);
      return o.find(input);
    },
    shots: () => o.shots ?? [],
    input: { windowMs: o.windowMs, retryMs: Math.max(1, Math.round(10_000 * scale)) },
    ...(o.log === undefined ? {} : { log: o.log }),
  });
  const ordered = momentLines(lines).sort((a, b) => a.startMs - b.startMs);
  let at = ordered[0]?.startMs ?? 0;
  for (const line of ordered) {
    const wait = (line.startMs - at) * scale;
    if (wait > 0) {
      const { promise, resolve } = Promise.withResolvers<undefined>();
      setTimeout(() => {
        resolve(undefined);
      }, wait);
      await promise;
    }
    at = line.startMs;
    actor.send({ type: "transcript.lines", lines: [line] });
  }
  actor.send({ type: "call.ended" });
  const out = await toPromise(actor);
  return out.moments;
}
