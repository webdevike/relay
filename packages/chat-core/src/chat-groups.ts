/** A chat file written within this window counts as running while Relay is unreachable. */
export const RECENTLY_ACTIVE_MS = 600_000

export function isRecentlyActive(mtimeMs: number, nowMs: number): boolean {
  return nowMs - mtimeMs < RECENTLY_ACTIVE_MS
}
