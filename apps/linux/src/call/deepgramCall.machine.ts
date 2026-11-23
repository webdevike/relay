// Lifecycle of one Deepgram Voice Agent call on the host (pure: xstate and types only; the session
// and the thread bridge are actors and actions the runtime in deepgramCall.ts provides). A call
// that never connects ends in `unavailable` (the phone was told nothing, the service falls back to
// the local call); every other call ends in `ended` exactly once, whatever stopped it, and leaving
// the machine stops the `session` actor, which closes the socket.

import { MAX_LIVE_CALL_MS } from "@relay/protocol";
import { assign, fromCallback, setup } from "xstate";

export type DeepgramCallEvent =
  | { readonly type: "session.ready" }
  | { readonly type: "session.failed"; readonly reason: string }
  | { readonly type: "session.closed"; readonly reason: string }
  | { readonly type: "call.hangup"; readonly reason?: string }
  | { readonly type: "user.speaking" }
  | { readonly type: "question.asked" }
  | { readonly type: "agent.speaking" }
  | { readonly type: "agent.done" };

export interface DeepgramCallContext {
  /** Whether the session ever opened. */
  readonly connected: boolean;
  /** Why the call ended; null for a hang-up without a reason. */
  readonly error: string | null;
}

export const deepgramCallMachine = setup({
  types: {
    context: {} as DeepgramCallContext,
    events: {} as DeepgramCallEvent,
    output: {} as DeepgramCallContext,
  },
  actors: {
    session: fromCallback<DeepgramCallEvent>(({ sendBack }) => {
      sendBack({ type: "session.failed", reason: "no session provided" });
      return () => undefined;
    }),
  },
  actions: {
    connected: assign({ connected: true }),
    fail: assign({
      error: ({ event }) => ("reason" in event ? (event.reason ?? null) : null),
    }),
    capped: assign({ error: "The call reached its time limit" }),
  },
  delays: { cap: MAX_LIVE_CALL_MS },
}).createMachine({
  id: "deepgramCall",
  context: { connected: false, error: null },
  initial: "connecting",
  invoke: { src: "session", id: "session" },
  output: ({ context }) => context,
  on: {
    "call.hangup": { target: ".ended", actions: "fail" },
    "session.closed": { target: ".ended", actions: "fail" },
  },
  states: {
    connecting: {
      on: {
        "session.ready": { target: "live", actions: "connected" },
        "session.failed": { target: "unavailable", actions: "fail" },
      },
    },
    live: {
      initial: "listening",
      after: { cap: { target: "ended", actions: "capped" } },
      on: {
        "session.failed": { target: "ended", actions: "fail" },
        "user.speaking": ".hearing",
        "question.asked": ".thinking",
        "agent.speaking": ".speaking",
        "agent.done": ".listening",
      },
      states: {
        listening: {},
        hearing: {},
        thinking: {},
        speaking: {},
      },
    },
    unavailable: { type: "final" },
    ended: { type: "final" },
  },
});
