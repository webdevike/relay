import { useEffect } from "react";
import { AppState, type AppStateStatus } from "react-native";
import * as Updates from "expo-updates";
import { createActor, fromPromise, waitFor } from "xstate";
import { commandsOutstanding } from "@/connection";
import { callIsLive, useCallStore } from "@/state/call";
import { liveCallIsUp, useLiveCallStore } from "@/state/liveCall";
import { dictationActor } from "@/dictation/actor";
import { phaseOf } from "@/dictation/machine";
import { composerBusy, subscribeComposerBusy } from "@/agents/composerShape";
import { otaGateMachine, type AppStateName, type QuietSignals } from "./otaGate.machine";
import { stopPosterCaptures } from "./modelPosters";

/**
 * Over-the-air JS updates from the self-hosted server on the Mac mini (`apps/ota-server`, URL in
 * app.json `updates.url`). Off in development and in builds without expo-updates enabled. The
 * decisions live in `otaGate.ts`; this file runs that machine against expo-updates and feeds it
 * the app state and what the quiet guard reads.
 */
export const otaEnabled = !__DEV__ && Updates.isEnabled;

/** `waiting`: downloaded, restarting once nothing is running (a call, a send, a dictation, typing). */
export type UpdateOutcome = "disabled" | "up-to-date" | "waiting" | "reloading";

/** Commands have no change event of their own; while an update waits, look again this often. */
const RECHECK_MS = 1000;

function appStateName(state: AppStateStatus): AppStateName {
  if (state === "active" || state === "background") return state;
  return "inactive";
}

function readSignals(): QuietSignals {
  const phase = phaseOf(dictationActor.getSnapshot());
  return {
    legacyCall: callIsLive(),
    liveCall: liveCallIsUp(),
    commandsOutstanding: commandsOutstanding(),
    // A refused permission is at rest too: nothing is listening, and it stays there until a press.
    dictationIdle: phase === "idle" || phase === "permission_denied",
    composerBusy: composerBusy(),
  };
}

function startGate() {
  const gate = createActor(
    otaGateMachine.provide({
      actors: {
        checkForUpdate: fromPromise(async () => {
          const check = await Updates.checkForUpdateAsync();
          return check.isAvailable || check.isRollBackToEmbedded;
        }),
        fetchUpdate: fromPromise(async () => {
          const fetched = await Updates.fetchUpdateAsync();
          return fetched.isNew || fetched.isRollBackToEmbedded;
        }),
        // Teardown detaches the root view a poster snapshot looks up; none may start after this.
        reload: fromPromise<unknown>(() => {
          stopPosterCaptures();
          return Updates.reloadAsync();
        }),
      },
    }),
    { input: { appState: appStateName(AppState.currentState), signals: readSignals() } },
  );
  let sent = gate.getSnapshot().context.signals;
  // The call stores tick with levels and timers: only a change the guard reads goes to the gate.
  const report = (): void => {
    const next = readSignals();
    if (
      next.legacyCall === sent.legacyCall &&
      next.liveCall === sent.liveCall &&
      next.commandsOutstanding === sent.commandsOutstanding &&
      next.dictationIdle === sent.dictationIdle &&
      next.composerBusy === sent.composerBusy
    )
      return;
    sent = next;
    gate.send({ type: "ota.signals", signals: next });
  };
  useCallStore.subscribe(report);
  useLiveCallStore.subscribe(report);
  dictationActor.subscribe(report);
  subscribeComposerBusy(report);
  AppState.addEventListener("change", (state) => {
    gate.send({ type: "ota.appState", state: appStateName(state) });
  });
  let recheck: ReturnType<typeof setInterval> | undefined;
  gate.subscribe((snapshot) => {
    const waiting = snapshot.matches("ready");
    if (waiting && recheck === undefined) recheck = setInterval(report, RECHECK_MS);
    if (!waiting && recheck !== undefined) {
      clearInterval(recheck);
      recheck = undefined;
    }
  });
  return gate.start();
}

const gate = otaEnabled ? startGate() : null;

/**
 * Asks the server for a newer bundle and downloads it; it restarts into it at once when nothing is
 * running, else resolves `waiting` and restarts the moment things go quiet. One check at a time.
 */
export async function applyLatestUpdate(): Promise<UpdateOutcome> {
  if (gate === null) return "disabled";
  gate.send({ type: "ota.check" });
  const settled = await waitFor(gate, (snapshot) => snapshot.matches("idle") || snapshot.matches("ready") || snapshot.matches("reloading"));
  if (settled.matches("ready")) return "waiting";
  if (settled.matches("reloading")) return "reloading";
  if (settled.context.result === "failed") throw new Error("update check failed");
  return "up-to-date";
}

/** The bundle this launch runs: the one shipped in the build, or a downloaded update. */
export interface RunningUpdate {
  /** First 8 characters of the update id, or "Built-in" for the embedded bundle. */
  label: string;
  createdAt: Date | null;
  runtimeVersion: string | null;
}

export function runningUpdate(): RunningUpdate {
  const id = Updates.updateId;
  return {
    label: Updates.isEmbeddedLaunch || id === null ? "Built-in" : id.slice(0, 8),
    createdAt: Updates.createdAt,
    runtimeVersion: Updates.runtimeVersion,
  };
}

/**
 * Mounted once in the root layout: checks on launch. The gate checks again on every return from
 * the background (not on a Face ID or Notification Center bounce) and restarts only when quiet.
 */
export function useOtaUpdates(): void {
  useEffect(() => {
    // Off the tailnet the server is unreachable; the next return to the app tries again.
    gate?.send({ type: "ota.check" });
  }, []);
}
