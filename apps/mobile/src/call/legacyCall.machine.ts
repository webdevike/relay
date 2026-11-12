/**
 * The legacy voice call (host-side speech, `call.*` frames over the app's socket) as an XState v5
 * statechart. Pure: the native audio engine, `call.*` sends and listeners are actors and actions
 * that `call/controller.ts` provides; the store the UI reads (`state/call.ts`) is a projection of
 * this machine (`callView`).
 *
 *   idle -start-> active.opening_mic -mic open-> active.up.connecting -host state-> active.up.live
 *   anything up -hang up / host ended cleanly-> idle; -failure / socket epoch ended-> ended
 *
 * A call belongs to the socket epoch it started on: when that socket ends, however it ended (also
 * silently swapped for a new one), the call ends with it instead of listening forever.
 */
import { assertEvent, assign, fromCallback, fromPromise, setup, type SnapshotFrom } from "xstate";
import type { CallState } from "@relay/protocol";

export type LegacyCallEvent =
  /** Start a call with `agent` on socket epoch `epoch`; ignored while one is opening its microphone. */
  | { type: "call.start"; callId: string; agent: string; epoch: number }
  | { type: "call.hangUp" }
  /** iOS took the audio session (a phone call, Siri). */
  | { type: "call.interrupted" }
  /** The microphone produced its first audio of this call. */
  | { type: "mic.heard" }
  /** A host `call.state` frame. */
  | { type: "host.state"; callId: string; state: CallState; text: string | null; error: string | null }
  /** Socket epoch `epoch` ended (closed by either side or replaced). */
  | { type: "socket.epochEnded"; epoch: number };

export interface LegacyCallContext {
  callId: string | null;
  agent: string | null;
  /** The socket epoch the call runs on. */
  epoch: number;
  /** What the host last said the call is doing. */
  phase: CallState;
  text: string | null;
  /** Why the call ended, when it did not end by hanging up. */
  error: string | null;
  /** The microphone has sent audio this call. */
  heard: boolean;
  /** The `call.end` reason for the host, with the engine's report. */
  endNote: string;
  /** The engine's report (native state and what reached JS), read before the engine stops. */
  readonly diagnostics: () => string;
}

export interface LegacyCallInput {
  readonly diagnostics: () => string;
}

/** A call whose microphone has produced nothing this long after `call.start` is ended with a reason. */
export const NO_AUDIO_MS = 3_000;
export const LOST_CONNECTION = "Lost the connection to your Mac";

function notProvided(name: string): never {
  throw new Error(`legacy call "${name}" not provided`);
}

export const legacyCallMachine = setup({
  types: {
    context: {} as LegacyCallContext,
    events: {} as LegacyCallEvent,
    input: {} as LegacyCallInput,
  },
  actors: {
    /** Starts the native engine (microphone and player); rejects with a message for the person. */
    openMic: fromPromise<null>(() => notProvided("openMic")),
    /** The engine's audio, level and interruption listeners while the call holds the engine. */
    engineEvents: fromCallback<LegacyCallEvent, { callId: string }>(() => notProvided("engineEvents")),
  },
  actions: {
    /** Sends `call.start` for the context's call. */
    sendStart: () => notProvided("sendStart"),
    /** Sends `call.end` with `endNote`. */
    sendEnd: () => notProvided("sendEnd"),
    /** Stops the engine, which lets go of the microphone. */
    release: () => notProvided("release"),
    begin: assign(({ event }) => {
      assertEvent(event, "call.start");
      return {
        callId: event.callId,
        agent: event.agent,
        epoch: event.epoch,
        phase: "connecting" as const,
        text: null,
        error: null,
        heard: false,
        endNote: "",
      };
    }),
    /** A local end: `reason` null is a hang-up. Reads the engine report before `release` stops it. */
    noteEnd: assign(({ context }, params: { reason: string | null }) => {
      const details = context.diagnostics();
      return {
        endNote: `${params.reason ?? "hung up"} (${details})`.slice(0, 2000),
        error: params.reason === null ? null : `${params.reason} (${details})`,
      };
    }),
    hostPhase: assign(({ event }) => {
      assertEvent(event, "host.state");
      return { phase: event.state, text: event.text, error: event.error };
    }),
  },
  guards: {
    thisCall: ({ context, event }) => event.type === "host.state" && event.callId === context.callId,
    /** The host ended this call cleanly (the assistant hung up). */
    hostHungUp: ({ context, event }) =>
      event.type === "host.state" && event.callId === context.callId && event.state === "ended" && event.error === null,
    /** The host ended this call on an error. */
    hostFailed: ({ context, event }) =>
      event.type === "host.state" && event.callId === context.callId && event.state === "ended" && event.error !== null,
    onCallEpoch: ({ context, event }) => event.type === "socket.epochEnded" && event.epoch === context.epoch,
    micSilent: ({ context }) => !context.heard,
  },
  delays: { NO_AUDIO: NO_AUDIO_MS },
}).createMachine({
  id: "legacyCall",
  initial: "idle",
  context: ({ input }) => ({
    callId: null,
    agent: null,
    epoch: 0,
    phase: "connecting",
    text: null,
    error: null,
    heard: false,
    endNote: "",
    diagnostics: input.diagnostics,
  }),
  states: {
    idle: {
      on: { "call.start": { target: "active", actions: "begin" } },
    },
    /** The call holds the engine: listeners on, microphone opening or open. */
    active: {
      initial: "opening_mic",
      invoke: { src: "engineEvents", input: ({ context }) => ({ callId: context.callId ?? "" }) },
      on: {
        "call.hangUp": {
          target: "idle",
          actions: [{ type: "noteEnd", params: { reason: null } }, "sendEnd", "release"],
        },
        "call.interrupted": {
          target: "ended",
          actions: [{ type: "noteEnd", params: { reason: "The call was interrupted" } }, "sendEnd", "release"],
        },
        // The host hangs up a call with its socket; no `call.end` can reach it.
        "socket.epochEnded": {
          guard: "onCallEpoch",
          target: "ended",
          actions: [assign({ error: LOST_CONNECTION }), "release"],
        },
        "mic.heard": { actions: assign({ heard: true }) },
      },
      states: {
        /** The engine is starting. A second start now is a double tap and is ignored. */
        opening_mic: {
          invoke: {
            src: "openMic",
            onDone: { target: "up", actions: "sendStart" },
            onError: {
              target: "#legacyCall.ended",
              actions: [
                {
                  type: "noteEnd",
                  params: ({ event }) => ({
                    reason:
                      event.error instanceof Error && event.error.message !== ""
                        ? event.error.message
                        : "Couldn't open the microphone.",
                  }),
                },
                "sendEnd",
                "release",
              ],
            },
          },
        },
        /** `call.start` is out; the host answers with `call.state` frames. */
        up: {
          initial: "connecting",
          // A deaf call looks exactly like one where nobody answers; say so instead.
          after: {
            NO_AUDIO: {
              guard: "micSilent",
              target: "#legacyCall.ended",
              actions: [{ type: "noteEnd", params: { reason: "The microphone sent no audio" } }, "sendEnd", "release"],
            },
          },
          on: {
            // Calling again ends this call before the new one opens the engine.
            "call.start": {
              target: "#legacyCall.active",
              reenter: true,
              actions: [{ type: "noteEnd", params: { reason: null } }, "sendEnd", "release", "begin"],
            },
            "host.state": [
              { guard: "hostFailed", target: "#legacyCall.ended", actions: ["hostPhase", "release"] },
              // The assistant hung up: nothing to read, so the call is forgotten at once.
              { guard: "hostHungUp", target: "#legacyCall.idle", actions: "release" },
              { guard: "thisCall", target: ".live", actions: "hostPhase" },
            ],
          },
          states: {
            connecting: {},
            /** Listening, thinking or speaking (`phase`). */
            live: {},
          },
        },
      },
    },
    /** Ended on an error; kept, with the error, until its screen closes (hang-up) or a new call. */
    ended: {
      on: {
        "call.start": { target: "active", actions: "begin" },
        "call.hangUp": { target: "idle" },
      },
    },
  },
});

export type LegacyCallSnapshot = SnapshotFrom<typeof legacyCallMachine>;

export interface CallView {
  readonly id: string;
  readonly agent: string;
  readonly state: CallState;
  readonly text: string | null;
  readonly error: string | null;
}

/** What the call screen shows for `snapshot`: nothing when idle, else the call and its state. */
export function callView(snapshot: LegacyCallSnapshot): CallView | null {
  const { callId, agent, phase, text, error } = snapshot.context;
  if (snapshot.matches("idle") || callId === null || agent === null) return null;
  if (snapshot.matches("ended")) return { id: callId, agent, state: "ended", text, error };
  if (snapshot.matches({ active: { up: "live" } })) return { id: callId, agent, state: phase, text, error: null };
  return { id: callId, agent, state: "connecting", text: null, error: null };
}
