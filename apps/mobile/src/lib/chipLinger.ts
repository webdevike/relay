/**
 * How a running chip that had a fill leaves the header: instead of vanishing the moment its run
 * leaves the host's list it stays `LINGER_MS` as done (its fill runs to full, then the chip fades,
 * `agents/RunningChips`). Chips with no estimate never linger. Pure: the caller keeps the last
 * result and feeds it back with the live list and the time.
 */
import type { RunningChip } from "./activity";

/** Fill to full, then fade: the whole send-off. */
export const LINGER_MS = 1200;

export interface ShownChip {
  chip: RunningChip;
  /** Left the running list with an estimate: drawn full, then faded out. */
  done: boolean;
  /** When it was first seen done (epoch ms); null while running. */
  since: number | null;
}

/**
 * The chips to draw at `now`: the live ones in their order, plus each chip of `previous` that just
 * left the list with an estimate (and the ones still lingering) at its old place, until `LINGER_MS`
 * after it left. A chip that is live again takes its place back as running.
 */
export function settleChips(previous: readonly ShownChip[], live: readonly RunningChip[], now: number): ShownChip[] {
  const liveIds = new Set(live.map((chip) => chip.id));
  const out: ShownChip[] = live.map((chip) => ({ chip, done: false, since: null }));
  previous.forEach((shown, index) => {
    if (liveIds.has(shown.chip.id)) return;
    let since = shown.since;
    if (!shown.done) {
      if (shown.chip.eta === undefined) return;
      since = now;
    }
    if (since === null || now - since >= LINGER_MS) return;
    out.splice(Math.min(index, out.length), 0, { chip: shown.chip, done: true, since });
  });
  return out;
}

/** Milliseconds until the first lingering chip is gone (so the caller can settle again then); null when none lingers. */
export function lingerLeft(shown: readonly ShownChip[], now: number): number | null {
  const left = shown.filter((entry) => entry.done && entry.since !== null).map((entry) => Math.max(0, LINGER_MS - (now - (entry.since ?? now))));
  return left.length === 0 ? null : Math.min(...left);
}
