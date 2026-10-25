/** Pure Catch Up deck rules: which cards are left and in what order, and the optimistic read flip. */
import type { CatchUpCard, CatchUpSource } from "@relay/protocol";
import type { SFSymbol } from "expo-symbols";

/**
 * The cards still to go through: unread ones in the host's order (importance, then newest), with
 * the ones kept unread this session moved to the back in the order they were kept.
 */
export function deckCards(items: readonly CatchUpCard[], deferred: readonly string[]): CatchUpCard[] {
  const unread = items.filter((item) => !item.read);
  const back = new Set(deferred);
  const front = unread.filter((item) => !back.has(item.id));
  const kept = deferred.flatMap((id) => unread.filter((item) => item.id === id));
  return [...front, ...kept];
}

/** `items` with `id` flipped to `read`, and the unread count that follows. */
export function markRead(items: readonly CatchUpCard[], id: string, read: boolean): { items: CatchUpCard[]; unreadCount: number } {
  const next = items.map((item) => (item.id === id ? { ...item, read } : item));
  return { items: next, unreadCount: next.filter((item) => !item.read).length };
}

/** The glyph beside a card's source label. */
export const SOURCE_SYMBOL: Record<CatchUpSource, SFSymbol> = {
  slack: "number",
  github: "arrow.triangle.pull",
  meeting: "person.2.fill",
  work: "checklist",
};
