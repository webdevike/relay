// What is happening in the background, for the status pill and the card spinners: the agent's live
// state (thinking, adding cards, waiting on a handoff) from presence, cards the agent added in this
// burst, and live-widget queries and prototype frames still loading.
import { useSyncExternalStore } from "react";
import type { Presence } from "../../canvas-live/src/shared";

export interface Activity {
  /** Avatar URL (host-relative) of whoever is working, when it has one. */
  avatar: string | undefined;
  color: string;
  text: string;
  /** Animated dot: something is acting now, not just waited on. */
  working: boolean;
}

const MAX_TASK = 48;

function clip(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > MAX_TASK ? `${one.slice(0, MAX_TASK - 1)}…` : one;
}

/** The one line the pill shows, or null when nothing is going on. Agents first (the busiest wins), then widgets. */
export function describeActivity(input: {
  presences: Iterable<Presence>;
  added: number;
  widgetsLoading: number;
}): Activity | null {
  let found: Activity | null = null;
  let rank = 0;
  for (const p of input.presences) {
    if (p.user?.kind !== "agent") continue;
    const { name, color, avatar } = p.user;
    const status = p.status ?? "idle";
    let next: Activity | null = null;
    let nextRank = 0;
    if (status === "thinking") {
      next = { avatar, color, text: `${name} is thinking…`, working: true };
      nextRank = 3;
    } else if (status !== "idle") {
      const text =
        input.added > 0
          ? `${name} is adding ${input.added === 1 ? "a card" : `${String(input.added)} cards`}`
          : status === "drawing"
            ? `${name} is connecting cards`
            : `${name} is working…`;
      next = { avatar, color, text, working: true };
      nextRank = 4;
    } else if (p.task) {
      next = {
        avatar,
        color,
        text: `Waiting on ${name}: ${clip(p.task)} (handoff)`,
        working: false,
      };
      nextRank = 2;
    }
    if (next !== null && nextRank > rank) {
      found = next;
      rank = nextRank;
    }
  }
  if (found !== null) return found;
  if (input.widgetsLoading > 0)
    return { avatar: undefined, color: "", text: "Live widgets refreshing", working: true };
  return null;
}

// ---------- loading cards: live-widget queries and prototype frames in flight ----------

const loading = new Map<string, number>();
const listeners = new Set<() => void>();
let total = 0;

function emit(): void {
  for (const l of listeners) l();
}

/** Marks card `id` loading until the returned function is called (once). */
export function beginLoad(id: string): () => void {
  loading.set(id, (loading.get(id) ?? 0) + 1);
  total++;
  emit();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (loading.get(id) ?? 1) - 1;
    if (n <= 0) loading.delete(id);
    else loading.set(id, n);
    total--;
    emit();
  };
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export function useCardLoading(id: string): boolean {
  return useSyncExternalStore(subscribe, () => loading.has(id));
}

export function useWidgetsLoading(): number {
  return useSyncExternalStore(subscribe, () => total);
}
