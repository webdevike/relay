/** Context windows models ship with; a derived estimate within 6% of one snaps to it. */
const COMMON_WINDOWS = [128_000, 200_000, 256_000, 272_000, 400_000, 500_000, 1_000_000, 2_000_000]

/**
 * The context window of a session running on another Mac (Relay mode), from what it reports:
 * the host sends the share of the window in use (`contextUsed`, 0..1) and the session file gives
 * the tokens. Null when either is missing or the share is too small to divide by.
 */
export function windowFromShare(
  tokens: number | null,
  used: number | null | undefined,
): number | null {
  if (tokens === null || tokens <= 0 || typeof used !== 'number' || !(used >= 0.02)) return null
  const raw = tokens / used
  const near = COMMON_WINDOWS.find((w) => Math.abs(raw - w) / w <= 0.06)
  return near ?? Math.round(raw / 1000) * 1000
}
