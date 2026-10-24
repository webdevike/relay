import { useEffect } from "react";
import { AppState } from "react-native";
import * as Updates from "expo-updates";

/**
 * Over-the-air JS updates from the self-hosted server on the Mac mini (`apps/ota-server`, URL in
 * app.json `updates.url`). Off in development and in builds without expo-updates enabled.
 */
export const otaEnabled = !__DEV__ && Updates.isEnabled;

export type UpdateOutcome = "disabled" | "up-to-date" | "reloading";

let inFlight: Promise<UpdateOutcome> | null = null;

async function checkFetchReload(): Promise<UpdateOutcome> {
  const check = await Updates.checkForUpdateAsync();
  if (!check.isAvailable && !check.isRollBackToEmbedded) return "up-to-date";
  const fetched = await Updates.fetchUpdateAsync();
  if (!fetched.isNew && !fetched.isRollBackToEmbedded) return "up-to-date";
  await Updates.reloadAsync();
  return "reloading";
}

/** Asks the server for a newer bundle, downloads it and restarts into it. One check at a time. */
export function applyLatestUpdate(): Promise<UpdateOutcome> {
  if (!otaEnabled) return Promise.resolve("disabled");
  inFlight ??= checkFetchReload().finally(() => {
    inFlight = null;
  });
  return inFlight;
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

/** Mounted once in the root layout: checks on launch and every time the app comes back to the front. */
export function useOtaUpdates(): void {
  useEffect(() => {
    if (!otaEnabled) return;
    const check = (): void => {
      // Off the tailnet the server is unreachable; the next foreground tries again.
      applyLatestUpdate().catch(() => undefined);
    };
    check();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
    });
    return () => {
      subscription.remove();
    };
  }, []);
}
