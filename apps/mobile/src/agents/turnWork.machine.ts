/**
 * The work sheet of an assistant thread ("peek behind the curtain", XState v5): a tap on a reply's brain
 * opens the work behind that turn, fetched from the host only then (`assistant.work.req`). Pure: the
 * runtime (`useTurnWork`) supplies `fetchWork` and `fetchDetail`, which send the frame.
 *
 *   closed     nothing is fetched (the setting off keeps it here: no brain sends `sheet.open`)
 *   loading    the sheet is up and waits for the turn's work
 *   shown      the work is in. `settled` once the turn is over; while it runs, `live` waits
 *              `REFRESH_MS` (or a thread change) and `refreshing` asks again, keeping what shows
 *   failed     the host could not answer (offline, an older transcript gone); Try again asks again
 *
 * A part (a step, or the turn's whole thinking) opens with `part.toggle`; its full text is fetched the
 * first time only, by a spawned `fetchDetail` that reports back with `detail.loaded` / `detail.failed`.
 * Answers for a sheet that was closed or moved to another turn carry an old `generation` and are dropped.
 */
import { assign, fromCallback, fromPromise, setup, spawnChild, type SnapshotFrom } from "xstate";
import type { TurnWork, TurnWorkDetail } from "@relay/protocol";

/** How often the sheet asks again while its turn runs. */
export const REFRESH_MS = 2500;

/** Which turn: `at` of a row in it (or, once known, the turn's own start), `row` that row's id; neither = the newest. */
export interface WorkTarget {
  agent: string;
  at?: number;
  row?: string;
}

/** What `assistant.work.res` says, without its `t` and `rid`. */
export interface WorkAnswer {
  ok: boolean;
  work?: TurnWork;
  detail?: TurnWorkDetail;
  error?: string;
}

export type PartState =
  | { state: "loading" }
  | { state: "loaded"; detail: TurnWorkDetail }
  | { state: "failed"; error: string };

export interface TurnWorkContext {
  target: WorkTarget | null;
  work: TurnWork | null;
  error: string | null;
  /** Full texts fetched, by part (step id or THINKING_DETAIL). */
  parts: Record<string, PartState>;
  /** Parts Isaac opened. */
  open: string[];
  /** Bumped on every open; answers from an older one are dropped. */
  generation: number;
}

export interface DetailInput {
  target: WorkTarget;
  id: string;
  generation: number;
}

export type TurnWorkEvent =
  | { type: "sheet.open"; target: WorkTarget }
  | { type: "sheet.close" }
  | { type: "sheet.retry" }
  /** The thread changed (a new snapshot): a running turn asks again at once. */
  | { type: "thread.changed" }
  | { type: "part.toggle"; id: string }
  | { type: "detail.loaded"; id: string; generation: number; detail: TurnWorkDetail }
  | { type: "detail.failed"; id: string; generation: number; error: string };

/** The work an answer carries and the target pinned to its turn's own start, so a newer turn never takes the sheet over. */
function pinned(
  context: TurnWorkContext,
  output: WorkAnswer,
): Pick<TurnWorkContext, "work" | "target"> {
  const work = output.work ?? null;
  const target = context.target;
  if (work === null || target === null) return { work, target };
  return { work, target: { ...target, at: work.at } };
}

export const turnWorkMachine = setup({
  types: {
    context: {} as TurnWorkContext,
    events: {} as TurnWorkEvent,
  },
  actors: {
    /** Supplied by the runtime: one `assistant.work.req` for the target's turn. */
    fetchWork: fromPromise<WorkAnswer, WorkTarget>(() =>
      Promise.reject(new Error("fetchWork is not provided")),
    ),
    /** Supplied by the runtime: one `assistant.work.req` with `detail`; sends back `detail.loaded` / `detail.failed`. */
    fetchDetail: fromCallback<TurnWorkEvent, DetailInput>(() => undefined),
  },
  guards: {
    running: ({ context }) => context.work?.running === true,
    isOpen: ({ context, event }) => event.type === "part.toggle" && context.open.includes(event.id),
    fetched: ({ context, event }) => {
      if (event.type !== "part.toggle") return false;
      const part = context.parts[event.id];
      return part !== undefined && part.state !== "failed";
    },
    current: ({ context, event }) =>
      (event.type === "detail.loaded" || event.type === "detail.failed") &&
      event.generation === context.generation &&
      context.parts[event.id]?.state === "loading",
  },
  delays: { refresh: REFRESH_MS },
}).createMachine({
  id: "turnWork",
  context: { target: null, work: null, error: null, parts: {}, open: [], generation: 0 },
  initial: "closed",
  on: {
    "sheet.open": {
      target: ".loading",
      actions: assign({
        target: ({ event }) => event.target,
        work: null,
        error: null,
        parts: {},
        open: [],
        generation: ({ context }) => context.generation + 1,
      }),
    },
  },
  states: {
    closed: {
      entry: assign({ target: null, work: null, error: null, parts: {}, open: [] }),
    },
    loading: {
      invoke: {
        src: "fetchWork",
        input: ({ context }) => context.target ?? { agent: "" },
        onDone: [
          {
            guard: ({ event }) => event.output.ok && event.output.work !== undefined,
            target: "shown",
            actions: assign(({ context, event }) => pinned(context, event.output)),
          },
          {
            target: "failed",
            actions: assign({
              error: ({ event }) => event.output.error ?? "Nothing to show for this turn.",
            }),
          },
        ],
        onError: {
          target: "failed",
          actions: assign({
            error: ({ event }) =>
              event.error instanceof Error ? event.error.message : "Your Mac did not answer.",
          }),
        },
      },
      on: { "sheet.close": "closed" },
    },
    shown: {
      initial: "checking",
      on: {
        "sheet.close": "#turnWork.closed",
        "part.toggle": [
          {
            guard: "isOpen",
            actions: assign({
              open: ({ context, event }) => context.open.filter((id) => id !== event.id),
            }),
          },
          {
            guard: "fetched",
            actions: assign({ open: ({ context, event }) => [...context.open, event.id] }),
          },
          {
            actions: [
              assign({
                open: ({ context, event }) => [...context.open, event.id],
                parts: ({ context, event }) => ({
                  ...context.parts,
                  [event.id]: { state: "loading" },
                }),
              }),
              spawnChild("fetchDetail", {
                input: ({ context, event }) => ({
                  target: context.target ?? { agent: "" },
                  id: event.type === "part.toggle" ? event.id : "",
                  generation: context.generation,
                }),
              }),
            ],
          },
        ],
        "detail.loaded": {
          guard: "current",
          actions: assign({
            parts: ({ context, event }) => ({
              ...context.parts,
              [event.id]: { state: "loaded", detail: event.detail },
            }),
          }),
        },
        "detail.failed": {
          guard: "current",
          actions: assign({
            parts: ({ context, event }) => ({
              ...context.parts,
              [event.id]: { state: "failed", error: event.error },
            }),
          }),
        },
      },
      states: {
        checking: {
          always: [{ guard: "running", target: "live" }, { target: "settled" }],
        },
        live: {
          after: { refresh: "refreshing" },
          on: { "thread.changed": "refreshing" },
        },
        refreshing: {
          invoke: {
            src: "fetchWork",
            input: ({ context }) => context.target ?? { agent: "" },
            onDone: [
              {
                guard: ({ event }) => event.output.ok && event.output.work !== undefined,
                target: "checking",
                actions: assign(({ context, event }) => pinned(context, event.output)),
              },
              { target: "live" },
            ],
            // A refresh that fails keeps what shows and tries again on the next beat.
            onError: "live",
          },
        },
        settled: {},
      },
    },
    failed: {
      on: { "sheet.close": "closed", "sheet.retry": "loading" },
    },
  },
});

export type TurnWorkSnapshot = SnapshotFrom<typeof turnWorkMachine>;
