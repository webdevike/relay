// Key moments: the few things in a call worth jumping back to (decisions, asks of Isaac, actions,
// notable claims). The host finds them in the live transcript with a small model
// (apps/linux/src/meetings/key-moments.ts) and keeps them on the recording; both clients render
// them with these helpers and the notes list them.
import type { KeyMoment, KeyMomentKind, LiveLine, MeetingRow, MeetingShot } from "./meetings";

/** How many key moments the Now view shows (the Moments tab has all of them). */
export const NOW_MOMENTS = 8;

/** A snapshot this long before a moment (or up to SHOT_AFTER_MS after it) is what it refers to. */
export const SHOT_BEFORE_MS = 120_000;
export const SHOT_AFTER_MS = 10_000;

export const KEY_MOMENT_LABEL: Record<KeyMomentKind, string> = {
  decision: "Decision",
  ask: "Asks you",
  action: "Action",
  claim: "Claim",
};

/** The Now list: newest first, at most `limit`. */
export function nowMoments(moments: readonly KeyMoment[], limit = NOW_MOMENTS): KeyMoment[] {
  return moments.slice().reverse().slice(0, limit);
}

/** The transcript row a moment sits in (the last row starting at or before it), for jumping to it. */
export function momentRowId(rows: readonly MeetingRow[], atMs: number): string | null {
  let id: string | null = rows[0]?.id ?? null;
  for (const r of rows) {
    if (r.startMs > atMs) break;
    id = r.id;
  }
  return id;
}

/** An ask of Isaac he has answered: his mic said something (not echo) after it. */
export function askAnswered(m: Pick<KeyMoment, "kind" | "atMs">, lines: readonly LiveLine[]): boolean {
  return (
    m.kind === "ask" &&
    lines.some((l) => l.track === "mic" && l.echo !== true && l.text.trim() !== "" && l.startMs > m.atMs)
  );
}

/** The snapshot a moment at `atMs` refers to: the newest one shown shortly before (or just after) it. */
export function shotNear(shots: readonly Pick<MeetingShot, "n" | "atMs">[], atMs: number): number | null {
  let best: number | null = null;
  let bestAt = -Infinity;
  for (const s of shots) {
    if (s.atMs < atMs - SHOT_BEFORE_MS || s.atMs > atMs + SHOT_AFTER_MS) continue;
    if (s.atMs > bestAt) {
      best = s.n;
      bestAt = s.atMs;
    }
  }
  return best;
}

/** `ms` as whole minutes since the start ("14m"), the transcript's coarse stamp. */
export const momentStamp = (ms: number): string => `${Math.floor(ms / 60_000)}m`;
