/**
 * How a bubble's long-press menu bookmarks its turn without knowing the screen's turns: the screen
 * (through `useTurnRail`) registers a `Bookmarker` under its reaction thread, and the menu
 * (`agents/BubbleMenu`) asks for it by the thread it shows.
 */
import { toggleTurnBookmark } from "@/connection";
import { notifyHaptic, tapHaptic } from "@/lib/haptics";

/** The turn the bubble with reaction key `bubbleKey` belongs to: whether it is bookmarked, and a toggle; null for a bubble in none. */
export type Bookmarker = (bubbleKey: string) => { on: boolean; toggle: () => void } | null;

const registry = new Map<string, Bookmarker>();

/** `thread`'s screen answers for its bubbles; returns the unregister. */
export function registerBookmarker(thread: string, bookmarker: Bookmarker): () => void {
  registry.set(thread, bookmarker);
  return () => {
    if (registry.get(thread) === bookmarker) registry.delete(thread);
  };
}

/** The bookmarker of the screen showing `thread`, if one is. */
export function bookmarkerOf(thread: string | null): Bookmarker | undefined {
  return thread === null ? undefined : registry.get(thread);
}

/** A bookmarker over a screen's turns: `turnOf` maps a bubble key to its turn's key, `marked` the bookmarked turn keys. */
export function createBookmarker(thread: string, turnOf: ReadonlyMap<string, string>, marked: ReadonlySet<string>): Bookmarker {
  return (bubbleKey) => {
    const turnKey = turnOf.get(bubbleKey);
    if (turnKey === undefined) return null;
    return {
      on: marked.has(turnKey),
      toggle: () => {
        if (toggleTurnBookmark(thread, turnKey)) tapHaptic();
        else notifyHaptic("warning");
      },
    };
  };
}
