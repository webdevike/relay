/**
 * OTA reload gate (XState v5): check the update server, download a newer bundle, then wait in
 * `ready` until restarting into it kills nothing. A reload throws away the whole JS world: the
 * command queue (a turn the host may still run would be re-sent), the legacy call, a dictation,
 * a half-typed reply. So `ready` restarts only while the app is in front and quiet; otherwise it
 * waits for the runtime (`otaUpdates.ts`) to report that things went quiet, and expo-updates
 * applies the downloaded bundle on the next cold start anyway.
 *
 * Checks start on launch, on a Settings tap, and on a return from the background. An
 * `inactive` -> `active` bounce (Face ID, Notification Center) is not a return: nothing was away.
 */
import { assign, fromPromise, setup, type SnapshotFrom } from "xstate";

/** What the runtime reads off the app's stores and actors; every one must be at rest to reload. */
export interface QuietSignals {
  /** A legacy (JS) call is up. */
  legacyCall: boolean;
  /** A live (native) call is up. */
  liveCall: boolean;
  /** Commands sent or queued whose outcome the host has not settled. */
  commandsOutstanding: number;
  /** Dictation is at rest (nothing listening, finishing or sending). */
  dictationIdle: boolean;
  /** A composer is open, being typed in, dictating or held. */
  composerBusy: boolean;
}

export type QuietReason = "legacyCall" | "liveCall" | "commands" | "dictation" | "composer";

/** Why a reload must wait, or null when nothing would be lost. */
export function holdReason(signals: QuietSignals): QuietReason | null {
  if (signals.legacyCall) return "legacyCall";
  if (signals.liveCall) return "liveCall";
  if (signals.commandsOutstanding > 0) return "commands";
  if (!signals.dictationIdle) return "dictation";
  if (signals.composerBusy) return "composer";
  return null;
}

export const QUIET: QuietSignals = {
  legacyCall: false,
  liveCall: false,
  commandsOutstanding: 0,
  dictationIdle: true,
  composerBusy: false,
};

export type AppStateName = "active" | "inactive" | "background";

export interface OtaGateContext {
  /** The app is in front (`active`). */
  active: boolean;
  /** Went to the background since the last `active`: the next `active` is a real return. */
  away: boolean;
  signals: QuietSignals;
  /** How the last check that found nothing to apply ended. */
  result: "up-to-date" | "failed" | null;
}

export interface OtaGateInput {
  appState: AppStateName;
  signals: QuietSignals;
}

export type OtaGateEvent =
  /** Launch or a Settings tap: ask the server now. */
  | { type: "ota.check" }
  | { type: "ota.appState"; state: AppStateName }
  /** Something the quiet guard reads changed. */
  | { type: "ota.signals"; signals: QuietSignals };

function notProvided(name: string): never {
  throw new Error(`otaGate actor "${name}" not provided`);
}

export const otaGateMachine = setup({
  types: {
    context: {} as OtaGateContext,
    events: {} as OtaGateEvent,
    input: {} as OtaGateInput,
  },
  actors: {
    /** Resolves true when the server has a newer bundle (or a rollback to the embedded one). */
    checkForUpdate: fromPromise<boolean>(() => notProvided("checkForUpdate")),
    /** Downloads it; resolves true when there is something new to restart into. */
    fetchUpdate: fromPromise<boolean>(() => notProvided("fetchUpdate")),
    reload: fromPromise<unknown>(() => notProvided("reload")),
  },
  actions: {
    trackAppState: assign(({ context, event }) => {
      if (event.type !== "ota.appState") return {};
      return {
        active: event.state === "active",
        away: event.state === "background" ? true : event.state === "active" ? false : context.away,
      };
    }),
    trackSignals: assign({
      signals: ({ context, event }) => (event.type === "ota.signals" ? event.signals : context.signals),
    }),
  },
  guards: {
    found: ({ event }) => "output" in event && event.output === true,
    activeAndQuiet: ({ context }) => context.active && holdReason(context.signals) === null,
    /** `active` after `background`; read before `trackAppState` clears `away`. */
    returned: ({ context, event }) => event.type === "ota.appState" && event.state === "active" && context.away,
  },
}).createMachine({
  id: "otaGate",
  context: ({ input }) => ({
    active: input.appState === "active",
    away: input.appState === "background",
    signals: input.signals,
    result: null,
  }),
  on: {
    "ota.appState": { actions: "trackAppState" },
    "ota.signals": { actions: "trackSignals" },
  },
  initial: "idle",
  states: {
    idle: {
      on: {
        "ota.check": { target: "checking", actions: assign({ result: null }) },
        "ota.appState": [
          { guard: "returned", target: "checking", actions: ["trackAppState", assign({ result: null })] },
          { actions: "trackAppState" },
        ],
      },
    },
    checking: {
      invoke: {
        src: "checkForUpdate",
        onDone: [{ guard: "found", target: "fetching" }, { target: "idle", actions: assign({ result: "up-to-date" }) }],
        onError: { target: "idle", actions: assign({ result: "failed" }) },
      },
    },
    fetching: {
      invoke: {
        src: "fetchUpdate",
        onDone: [{ guard: "found", target: "ready" }, { target: "idle", actions: assign({ result: "up-to-date" }) }],
        onError: { target: "idle", actions: assign({ result: "failed" }) },
      },
    },
    /** Downloaded; restarts the moment the app is in front and quiet. Root `on` keeps the context current. */
    ready: {
      always: { guard: "activeAndQuiet", target: "reloading" },
    },
    reloading: {
      invoke: {
        src: "reload",
        // The bundle stays downloaded and expo-updates launches it next time; no retry loop here.
        onError: { target: "idle", actions: assign({ result: "failed" }) },
      },
    },
  },
});

export type OtaGateSnapshot = SnapshotFrom<typeof otaGateMachine>;
