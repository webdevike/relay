// Key moments of one live recording (decisions, asks of Isaac, actions, notable claims), found a
// window at a time: the first new final line opens a window, and when it closes the lines it
// gathered go to the `extract` actor (a small model, key-moments.ts) with the lines before them for
// context and the moments found so far, so it does not repeat one. Lines said meanwhile open the
// next window. A failed extraction is retried with backoff a few times, then its lines are let go.
// When the call ends one last extraction takes whatever is still waiting, and the machine finishes
// with the moments as its output (the after-call notes list them).
//
// Pure: xstate and types only. The runtime (key-moments.ts) provides `extract`; tests stub it.

import { KEY_MOMENT_MAX_CHARS, MAX_KEY_MOMENTS, type KeyMoment } from "@relay/protocol";
import { assign, fromPromise, setup } from "xstate";

/** How long a window gathers lines after its first one. */
export const KEY_MOMENTS_WINDOW_MS = 45_000;
/** The first retry of a failed extraction waits this long; each next one twice as long. */
export const KEY_MOMENTS_RETRY_MS = 10_000;
/** Tries per batch of lines (the first one and its retries). */
export const KEY_MOMENTS_TRIES = 3;
/** Lines already looked at that go along as context. */
export const KEY_MOMENTS_CONTEXT_LINES = 12;

/** A final transcript line, as the extractor reads it. */
export interface MomentLine {
  readonly id: string;
  readonly startMs: number;
  readonly speaker: string;
  readonly text: string;
}

/** A moment the extractor found, before it has an id. */
export type MomentDraft = Omit<KeyMoment, "id">;

export interface ExtractInput {
  /** The new lines; moments come only from these. */
  readonly lines: readonly MomentLine[];
  /** Lines just before them, for context. */
  readonly context: readonly MomentLine[];
  /** The moments found so far, so none is found twice. */
  readonly moments: readonly KeyMoment[];
}

export type KeyMomentsEvent =
  /** New final lines (never seen before). */
  | { readonly type: "transcript.lines"; readonly lines: readonly MomentLine[] }
  /** Lines seen before that changed speaker (the call named a voice). */
  | { readonly type: "transcript.renamed"; readonly lines: readonly MomentLine[] }
  | { readonly type: "call.ended" };

export interface KeyMomentsInput {
  /** Moments kept from before a restart. */
  readonly moments?: readonly KeyMoment[];
  /** startMs of the last line already looked at, -1 for none. */
  readonly through?: number;
  readonly windowMs?: number;
  readonly retryMs?: number;
}

export interface KeyMomentsContext {
  /** Lines waiting for the next extraction. */
  readonly pending: readonly MomentLine[];
  /** Lines the current (or retried) extraction is about. */
  readonly inFlight: readonly MomentLine[];
  /** The last lines looked at, the next extraction's context. */
  readonly recent: readonly MomentLine[];
  readonly moments: readonly KeyMoment[];
  readonly through: number;
  /** Failed tries of the lines in flight. */
  readonly failures: number;
  readonly windowMs: number;
  readonly retryMs: number;
}

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);

/** Whether two moment texts say the same thing (most of their words shared, or one inside the other). */
export function similarText(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (x.length === 0 || y.length === 0) return false;
  const joinedX = x.join(" ");
  const joinedY = y.join(" ");
  if (joinedX.includes(joinedY) || joinedY.includes(joinedX)) return true;
  const setX = new Set(x);
  const setY = new Set(y);
  let shared = 0;
  for (const w of setX) if (setY.has(w)) shared += 1;
  return shared / (setX.size + setY.size - shared) >= 0.6;
}

/** One short line: no dashes Isaac does not use, one space between words, at most KEY_MOMENT_MAX_CHARS. */
export function momentText(text: string): string {
  return text
    .replace(/\s*\u2014\s*/g, ", ")
    .replace(/\u2013/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, KEY_MOMENT_MAX_CHARS)
    .trim();
}

const idNumber = (id: string): number => {
  const n = /^km(\d+)$/.exec(id)?.[1];
  return n === undefined ? -1 : Number(n);
};

/**
 * `existing` with the new drafts added, oldest first: a draft of the same kind as a moment on the
 * same line or saying much the same is dropped, ids go on from the highest `km<n>`, and the list
 * stops at MAX_KEY_MOMENTS. The same array comes back when nothing was added.
 */
export function mergeMoments(
  existing: readonly KeyMoment[],
  drafts: readonly MomentDraft[],
): readonly KeyMoment[] {
  let next = existing.reduce((n, m) => Math.max(n, idNumber(m.id) + 1), 0);
  const out = [...existing];
  for (const d of drafts) {
    if (out.length >= MAX_KEY_MOMENTS) break;
    const text = momentText(d.text);
    if (text === "") continue;
    if (out.some((m) => m.kind === d.kind && (m.lineId === d.lineId || similarText(m.text, text))))
      continue;
    out.push({ ...d, id: `km${String(next)}`, text });
    next += 1;
  }
  if (out.length === existing.length) return existing;
  return out.sort((a, b) => a.atMs - b.atMs);
}

/** `lines` with `fresh` in: a line already there is replaced, a new one appended. */
function upsert(lines: readonly MomentLine[], fresh: readonly MomentLine[]): readonly MomentLine[] {
  const out = [...lines];
  for (const f of fresh) {
    const at = out.findIndex((l) => l.id === f.id);
    if (at >= 0) out[at] = f;
    else out.push(f);
  }
  return out;
}

/** The lines in flight are done with: they become context and `through` moves past them. */
function settled(context: KeyMomentsContext): Partial<KeyMomentsContext> {
  return {
    recent: [...context.recent, ...context.inFlight]
      .sort((a, b) => a.startMs - b.startMs)
      .slice(-KEY_MOMENTS_CONTEXT_LINES),
    through: context.inFlight.reduce((t, l) => Math.max(t, l.startMs), context.through),
    inFlight: [],
    failures: 0,
  };
}

export const keyMomentsMachine = setup({
  types: {
    context: {} as KeyMomentsContext,
    events: {} as KeyMomentsEvent,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- xstate reads the input type from this value
    input: {} as KeyMomentsInput,
    output: {} as { moments: readonly KeyMoment[] },
  },
  actors: {
    extract: fromPromise<readonly MomentDraft[], ExtractInput>(() =>
      Promise.reject(new Error("no extractor provided")),
    ),
  },
  guards: {
    hasLines: ({ event }) => event.type === "transcript.lines" && event.lines.length > 0,
    hasPending: ({ context }) => context.pending.length > 0,
    canRetry: ({ context }) => context.failures + 1 < KEY_MOMENTS_TRIES,
    nothingInFlight: ({ context }) => context.inFlight.length === 0,
  },
  delays: {
    window: ({ context }) => context.windowMs,
    retry: ({ context }) => context.retryMs * 2 ** Math.max(0, context.failures - 1),
  },
  actions: {
    addLines: assign({
      pending: ({ context, event }) =>
        event.type === "transcript.lines" ? upsert(context.pending, event.lines) : context.pending,
    }),
    rename: assign(({ context, event }) => {
      if (event.type !== "transcript.renamed") return {};
      const speaker = new Map(event.lines.map((l) => [l.id, l.speaker]));
      const changed = context.moments.some(
        (m) => speaker.has(m.lineId) && speaker.get(m.lineId) !== m.speaker,
      );
      return {
        pending: context.pending.map((l) => ({ ...l, speaker: speaker.get(l.id) ?? l.speaker })),
        moments: changed
          ? context.moments.map((m) => ({ ...m, speaker: speaker.get(m.lineId) ?? m.speaker }))
          : context.moments,
      };
    }),
    takePending: assign({
      inFlight: ({ context }) => [...context.inFlight, ...context.pending],
      pending: [],
    }),
    merge: assign(({ context }, params: { drafts: readonly MomentDraft[] }) => ({
      moments: mergeMoments(context.moments, params.drafts),
      ...settled(context),
    })),
    countFailure: assign({ failures: ({ context }) => context.failures + 1 }),
    letGo: assign(({ context }) => settled(context)),
  },
}).createMachine({
  id: "keyMoments",
  context: ({ input }) => ({
    pending: [],
    inFlight: [],
    recent: [],
    moments: input.moments ?? [],
    through: input.through ?? -1,
    failures: 0,
    windowMs: input.windowMs ?? KEY_MOMENTS_WINDOW_MS,
    retryMs: input.retryMs ?? KEY_MOMENTS_RETRY_MS,
  }),
  output: ({ context }) => ({ moments: context.moments }),
  on: { "transcript.renamed": { actions: "rename" } },
  initial: "live",
  states: {
    live: {
      initial: "idle",
      on: { "call.ended": "ending" },
      states: {
        idle: {
          on: {
            "transcript.lines": { guard: "hasLines", target: "gathering", actions: "addLines" },
          },
        },
        gathering: {
          on: { "transcript.lines": { actions: "addLines" } },
          after: { window: "extracting" },
        },
        extracting: {
          entry: "takePending",
          on: { "transcript.lines": { actions: "addLines" } },
          invoke: {
            src: "extract",
            input: ({ context }) => ({
              lines: context.inFlight,
              context: context.recent,
              moments: context.moments,
            }),
            onDone: [
              {
                guard: "hasPending",
                target: "gathering",
                actions: { type: "merge", params: ({ event }) => ({ drafts: event.output }) },
              },
              {
                target: "idle",
                actions: { type: "merge", params: ({ event }) => ({ drafts: event.output }) },
              },
            ],
            onError: [
              { guard: "canRetry", target: "backoff", actions: "countFailure" },
              { guard: "hasPending", target: "gathering", actions: "letGo" },
              { target: "idle", actions: "letGo" },
            ],
          },
        },
        backoff: {
          on: { "transcript.lines": { actions: "addLines" } },
          after: { retry: "extracting" },
        },
      },
    },
    ending: {
      entry: "takePending",
      initial: "checking",
      states: {
        checking: {
          always: [
            { guard: "nothingInFlight", target: "#keyMoments.done" },
            { target: "extracting" },
          ],
        },
        extracting: {
          invoke: {
            src: "extract",
            input: ({ context }) => ({
              lines: context.inFlight,
              context: context.recent,
              moments: context.moments,
            }),
            onDone: {
              target: "#keyMoments.done",
              actions: { type: "merge", params: ({ event }) => ({ drafts: event.output }) },
            },
            onError: [
              { guard: "canRetry", target: "backoff", actions: "countFailure" },
              { target: "#keyMoments.done", actions: "letGo" },
            ],
          },
        },
        backoff: { after: { retry: "extracting" } },
      },
    },
    done: { type: "final" },
  },
});
