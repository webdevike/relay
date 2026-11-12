/**
 * The Call button's busy guard (XState v5): one call start at a time, so rapid taps start one
 * call. Pure: `call/live.ts` sends `call.start` before it starts a call and `call.settled` once
 * that start has come out (live, fallback, failed or thrown); a `call.start` while `starting` is
 * ignored.
 *
 *   idle --call.start--> starting --call.settled--> idle
 */
import { assign, setup } from "xstate";

export type CallStartEvent = { type: "call.start"; agent: string } | { type: "call.settled" };

export const callStartMachine = setup({
  types: {
    context: {} as { agent: string | null },
    events: {} as CallStartEvent,
  },
}).createMachine({
  id: "callStart",
  initial: "idle",
  context: { agent: null },
  states: {
    idle: {
      on: {
        "call.start": { target: "starting", actions: assign({ agent: ({ event }) => event.agent }) },
      },
    },
    starting: {
      on: {
        "call.settled": { target: "idle", actions: assign({ agent: null }) },
      },
    },
  },
});
