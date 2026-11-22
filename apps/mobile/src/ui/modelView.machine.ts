/**
 * One 3D model view (XState v5): a poster until Isaac taps it, then (within the size limit) its
 * live native SceneKit view, and when it snapshots itself into a poster. Only one model is open in
 * the app (`lib/liveModel.ts`): entering `live` takes it (`claim`), and losing it (another model
 * tapped, scrolled away, screen covered) sends `slot.lost`, which always unmounts the native view
 * and frees its scene, even mid-load or mid-snapshot.
 *
 * A tap first checks the file's size (`probe`: the drop's known size, else a HEAD); a model over
 * `MODEL_MAX_BYTES` never opens. A size known up front that is over the limit says so at once.
 *
 * Once the model has drawn (`model.loaded`) and it has no poster yet, it waits `CAPTURE_MS` for
 * SceneKit to put frames on screen, then runs `capture` (a crop of a snapshot of the app's root
 * view, `lib/modelPosters.ts`). The capture answers `later` when the list is moving or the model is
 * not wholly clear of the screen's chrome; the view then waits for the next `viewport.rested` (the
 * slot's next settle) and tries again. Every settle re-arms a drawn view too, in case its poster
 * went missing. A failed load is final for this `src`.
 *
 * Effects: `probe`, `capture` and `claim` are supplied by `ui/ModelView.tsx`; the defaults answer
 * an unknown size, `later` and nothing.
 */
import { assign, fromPromise, setup } from "xstate";
import { MODEL_MAX_BYTES } from "@evaos/chat-core/model-limit";
import type { CaptureResult } from "@/lib/modelPosters";

/** Wait after the model reports drawn before snapshotting it, ms. */
export const CAPTURE_MS = 700;

export interface ModelViewContext {
  /** No poster exists for this model yet (snapshot or the drop's own), and no blank snapshot this run. */
  needsPoster: boolean;
  /** The file's size in bytes, when known. */
  size: number | null;
}

export type ModelViewEvent =
  | { type: "view.open" }
  | { type: "slot.lost" }
  | { type: "model.loaded" }
  | { type: "model.failed" }
  | { type: "viewport.rested" }
  | { type: "poster.changed"; needed: boolean };

export const modelViewMachine = setup({
  types: {
    context: {} as ModelViewContext,
    events: {} as ModelViewEvent,
    input: {} as { needsPoster: boolean; size: number | null },
  },
  actors: {
    probe: fromPromise<number | null>(() => Promise.resolve(null)),
    capture: fromPromise<CaptureResult>(() => Promise.resolve("later")),
  },
  actions: {
    // Become the one open model; provided by the view.
    claim: () => undefined,
  },
  guards: {
    needsPoster: ({ context }) => context.needsPoster,
    tooLarge: ({ context }) => context.size !== null && context.size > MODEL_MAX_BYTES,
  },
  delays: { CAPTURE: CAPTURE_MS },
}).createMachine({
  id: "modelView",
  context: ({ input }) => ({ needsPoster: input.needsPoster, size: input.size }),
  initial: "still",
  on: {
    "poster.changed": { actions: assign(({ event }) => ({ needsPoster: event.needed })) },
  },
  states: {
    still: {
      always: { guard: "tooLarge", target: "tooLarge" },
      on: { "view.open": { target: "checking" } },
    },
    checking: {
      invoke: {
        src: "probe",
        onDone: { target: "sized", actions: assign(({ context, event }) => ({ size: event.output ?? context.size })) },
        // Unknown size: the native download itself fails if the file is not there.
        onError: { target: "live" },
      },
    },
    sized: {
      always: [{ guard: "tooLarge", target: "tooLarge" }, { target: "live" }],
    },
    live: {
      entry: "claim",
      initial: "loading",
      on: {
        "slot.lost": { target: "still" },
        "model.failed": { target: "failed" },
      },
      states: {
        loading: {
          on: { "model.loaded": { target: "drawn" } },
        },
        drawn: {
          after: { CAPTURE: { guard: "needsPoster", target: "capturing" } },
          on: { "viewport.rested": { target: "drawn", reenter: true } },
        },
        capturing: {
          invoke: {
            src: "capture",
            onDone: [{ guard: ({ event }) => event.output === "later", target: "waiting" }, { target: "drawn" }],
            onError: { target: "waiting" },
          },
        },
        waiting: {
          on: { "viewport.rested": { target: "drawn" } },
        },
      },
    },
    failed: {},
    tooLarge: {},
  },
});
