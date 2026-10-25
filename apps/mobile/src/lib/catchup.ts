/** Pure Catch Up deck rules: which cards are left and in what order, optimistic changes, and handoff targets. */
import type { CatchUpCard, CatchUpSource } from "@relay/protocol";
import type { SFSymbol } from "expo-symbols";

/** Who gets a card handed over without a choice: the feed's lane (Astra for eCard work), else Nova (personal). */
export const FALLBACK_ASSISTANT = "nova";

/**
 * The cards still to go through: unread ones in the host's order (bounced first, then importance,
 * then newest), with the ones kept unread this session moved to the back in the order they were kept.
 */
export function deckCards(items: readonly CatchUpCard[], deferred: readonly string[]): CatchUpCard[] {
  const unread = items.filter((item) => !item.read);
  const back = new Set(deferred);
  const front = unread.filter((item) => !back.has(item.id));
  const kept = deferred.flatMap((id) => unread.filter((item) => item.id === id));
  return [...front, ...kept];
}

/** `items` with `id` flipped to `read` (and handed to `handedTo`, when given), and the unread count that follows. */
export function markRead(
  items: readonly CatchUpCard[],
  id: string,
  read: boolean,
  handedTo?: string,
): { items: CatchUpCard[]; unreadCount: number } {
  const next = items.map((item): CatchUpCard => {
    if (item.id !== id) return item;
    // A plain unread keeps whatever the host said; reading or handing a card closes its bounce.
    if (!read) return { ...item, read };
    const { bounce, ...rest } = item;
    if (bounce === undefined && handedTo === undefined) return { ...item, read };
    return handedTo === undefined ? { ...rest, read } : { ...rest, read, handedTo };
  });
  return { items: next, unreadCount: next.filter((item) => !item.read).length };
}

/**
 * A card an assistant bounced comes back to the front even if it was kept for later before:
 * every bounce not seen yet (by its time) takes its card out of `deferred`.
 */
export function refreshDeferred(
  items: readonly CatchUpCard[],
  deferred: readonly string[],
  seenBounces: Readonly<Record<string, string>>,
): { deferred: string[]; seenBounces: Record<string, string> } {
  const fresh = new Set<string>();
  const seen: Record<string, string> = {};
  for (const item of items) {
    if (item.bounce === undefined) continue;
    seen[item.id] = item.bounce.at;
    if (seenBounces[item.id] !== item.bounce.at) fresh.add(item.id);
  }
  return { deferred: deferred.filter((id) => !fresh.has(id)), seenBounces: seen };
}

/** The card's default handoff target. */
export function defaultAssistant(card: CatchUpCard): string {
  return card.assistant ?? FALLBACK_ASSISTANT;
}

/** The glyph beside a card's source label. */
export const SOURCE_SYMBOL: Record<CatchUpSource, SFSymbol> = {
  slack: "number",
  github: "arrow.triangle.pull",
  meeting: "person.2.fill",
  work: "checklist",
};
