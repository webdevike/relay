// Cards that appear while this viewer is watching arrive as a skeleton at their final spot, then
// their content shows (text types in, images and live pages cross-fade once they have loaded).
// Purely client-side: nothing here touches the doc or delays anyone's edits.

/** The skeleton stays at least this long, so a fast card still reads as arriving. */
export const MIN_SKELETON_MS = 350;
/** A card whose content never reports in (a stuck frame) is revealed after this anyway. */
export const READY_TIMEOUT_MS = 8000;
/** The cross-fade and typing window; the arrival is over once it ends. */
export const REVEAL_MS = 900;
/** The longest any one text field takes to type in. */
export const TYPE_MS = 700;
/** Short fields type at least this fast (characters per millisecond). */
const MIN_TYPE_RATE = 0.06;

export type ArrivalPhase = "skeleton" | "reveal";

/**
 * Tells nodes that arrived while watching from the ones the board opened with. Ids seen before
 * `baseline` (the initial sync, and every later resync) never animate; after it, the first sight of
 * an id is an arrival. Disarmed (offline, syncing) it only records what it sees.
 */
export class ArrivalTracker {
  private armed = false;
  private known = new Set<string>();

  /** The board is in sync: these ids are the starting point, later new ids are arrivals. */
  baseline(ids: Iterable<string>): void {
    this.known = new Set(ids);
    this.armed = true;
  }

  /** The doc is catching up (connecting or resyncing): ids that show up now are not arrivals. */
  disarm(): void {
    this.armed = false;
  }

  /** Every id on the board now; returns the ones that just arrived. Ids that left are forgotten. */
  observe(ids: readonly string[]): string[] {
    const present = new Set(ids);
    const fresh: string[] = [];
    for (const id of ids) {
      if (this.known.has(id)) continue;
      this.known.add(id);
      if (this.armed) fresh.push(id);
    }
    for (const id of this.known) if (!present.has(id)) this.known.delete(id);
    return fresh;
  }
}

/** How many characters of a `total`-long field are typed `elapsed` ms after its reveal began. */
export function typedLength(total: number, elapsed: number): number {
  if (elapsed <= 0) return 0;
  const rate = Math.max(total / TYPE_MS, MIN_TYPE_RATE);
  return Math.min(total, Math.floor(rate * elapsed));
}

interface Entry {
  phase: ArrivalPhase;
  revealAt: number;
  minDone: boolean;
  ready: boolean;
}

/** Arrival state per card id: skeleton until content is ready (and the minimum has passed), then reveal, then gone. */
export class ArrivalStore {
  private entries = new Map<string, Entry>();
  private subs = new Set<() => void>();

  /** `ready`: the card has nothing to wait for (text); otherwise it calls `markReady`. */
  start(id: string, ready: boolean): void {
    if (this.entries.has(id)) return;
    this.entries.set(id, { phase: "skeleton", revealAt: 0, minDone: false, ready });
    setTimeout(() => this.update(id, (e) => void (e.minDone = true)), MIN_SKELETON_MS);
    setTimeout(() => this.update(id, (e) => void (e.ready = true)), READY_TIMEOUT_MS);
    this.emit();
  }

  /** The card's content has loaded or rendered (or failed: its own error state takes over). */
  markReady(id: string): void {
    this.update(id, (e) => void (e.ready = true));
  }

  phase(id: string): ArrivalPhase | null {
    return this.entries.get(id)?.phase ?? null;
  }

  revealAt(id: string): number {
    return this.entries.get(id)?.revealAt ?? 0;
  }

  subscribe = (cb: () => void): (() => void) => {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  };

  private update(id: string, change: (e: Entry) => void): void {
    const e = this.entries.get(id);
    if (!e) return;
    change(e);
    if (e.phase === "skeleton" && e.minDone && e.ready) {
      e.phase = "reveal";
      e.revealAt = Date.now();
      setTimeout(() => {
        this.entries.delete(id);
        this.emit();
      }, REVEAL_MS);
      this.emit();
    }
  }

  private emit(): void {
    for (const cb of this.subs) cb();
  }
}
