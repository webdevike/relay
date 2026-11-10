/** Pure rules of the Feed screen (`app/feed.tsx`): which cards show, the interest chips, where an image loads from. */
import type { FeedAction, FeedItem } from "@relay/protocol";

/** Interest chips: every tag on a card that has not been skipped, sorted. */
export function feedTags(items: readonly FeedItem[], acted: Readonly<Record<string, FeedAction>>): string[] {
  const tags = new Set<string>();
  for (const item of items) if (item.tag !== undefined && acted[item.id] !== "skip") tags.add(item.tag);
  return [...tags].sort();
}

/** The cards to scroll: file order, a skipped card gone, and with a `tag` only that interest. */
export function visibleFeed(items: readonly FeedItem[], acted: Readonly<Record<string, FeedAction>>, tag: string | null): FeedItem[] {
  return items.filter((item) => acted[item.id] !== "skip" && (tag === null || item.tag === tag));
}

/**
 * Where a card's image loads from: an https URL as is, a `/feed/media/<file>` path (a thumbnail the
 * container cached because X, Behance and twimg are blocked on the phone) from the host, or nothing
 * while no host is connected.
 */
export function feedImageUri(image: string | undefined, hostBase: string | null): string | null {
  if (image === undefined) return null;
  if (!image.startsWith("/")) return image;
  return hostBase === null ? null : `${hostBase}${image}`;
}
