/**
 * One 3D model view (XState v5): whether it draws its live native SceneKit view or its still, and
 * when it snapshots itself into a poster. The app-wide slot (`lib/liveModel.ts`) decides who is
 * live; this machine follows it (`slot.gained` / `slot.lost`), so losing the slot always unmounts
 * the native view and frees its scene, even mid-load or mid-snapshot.
 *
 * Once the model has drawn (`model.loaded`) and it has no poster yet, it waits `CAPTURE_MS` for
 * SceneKit to put frames on screen, then runs `capture` (a crop of a snapshot of the app's root
 * view, `lib/modelPosters.ts`). The capture answers `later` when the list is moving or the model is
 * not wholly clear of the screen's chrome; the view then waits for the next `viewport.rested` (the
 * slot's next settle) and tries again. Every settle re-arms a drawn view too, in case its poster
 * went missing. A failed load is final for this `src`.
 *
 * Effects: the `capture` actor is supplied by `ui/ModelView.tsx`; the default answers `later`.
 */
import { assign, fromPromise, setup } from "xstate";
import type { CaptureResult } from "@/lib/modelPosters";

/** Wait after the model reports drawn before snapshotting it, ms. */
export const CAPTURE_MS = 700;

export interface ModelViewContext {
  /** No poster exists for this model yet (snapshot or the drop's own), and no blank snapshot this run. */
  needsPoster: boolean;
}

export type ModelViewEvent =
  | { type: "slot.gained" }
  | { type: "slot.lost" }
  | { type: "model.loaded" }
  | { type: "model.failed" }
  | { type: "viewport.rested" }
  | { type: "poster.changed"; needed: boolean };

export const modelViewMachine = setup({
  types: { context: {} as ModelViewContext, events: {} as ModelViewEvent, input: {} as { needsPoster: boolean } },
  actors: {
    capture: fromPromise<CaptureResult>(() => Promise.resolve("later")),
  },
  guards: {
    needsPoster: ({ context }) => context.needsPoster,
  },
  delays: { CAPTURE: CAPTURE_MS },
}).createMachine({
  id: "modelView",
  context: ({ input }) => ({ needsPoster: input.needsPoster }),
  initial: "still",
  on: {
    "poster.changed": { actions: assign(({ event }) => ({ needsPoster: event.needed })) },
  },
  states: {
    still: {
      on: { "slot.gained": { target: "live" } },
    },
    live: {
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
  },
});
