/**
 * Tiny dev-only logger for the connection subsystem. `__DEV__` branches are stripped from
 * production bundles by Metro, so none of this survives into a release build.
 */

/* eslint-disable no-console -- the sanctioned sink for connection diagnostics */
function emit(level: "debug" | "info" | "warn", scope: string, args: unknown[]): void {
  if (!__DEV__) return;
  console[level](`[relay:${scope}]`, ...args);
}
/* eslint-enable no-console */

export function debug(scope: string, ...args: unknown[]): void {
  emit("debug", scope, args);
}

export function info(scope: string, ...args: unknown[]): void {
  emit("info", scope, args);
}

export function warn(scope: string, ...args: unknown[]): void {
  emit("warn", scope, args);
}
