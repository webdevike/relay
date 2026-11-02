/** What the Reviews screens do with an item: open its screen, mark it Done, Unread or seen, snooze it. */
import { useEffect, useRef } from "react";
import type { Router } from "expo-router";
import type { ReviewItem } from "@relay/protocol";
import { reviewsRequest } from "@/connection";
import { useReviewsStore } from "@/state/reviews";
import { reviewRoute } from "./model";

/** The item's own screen: PR, ticket or Slack thread. */
export function openReviewItem(router: Router, item: Pick<ReviewItem, "url" | "ref">): void {
  router.push(reviewRoute(item.url, item.ref));
}

/**
 * Hides the row at once and tells the host; it stays hidden until the item changes past
 * `updatedAt`. A refused or unanswered Done shows the row again. Resolves with the host's error.
 */
export async function markReviewDone(url: string, updatedAt: number): Promise<string | null> {
  const store = useReviewsStore.getState();
  store.markDone(url, updatedAt, true);
  const result = await reviewsRequest({ kind: "done", url, updatedAt, done: true });
  if (result.ok) return null;
  useReviewsStore.getState().markDone(url, updatedAt, false);
  return result.error ?? "Could not mark it Done.";
}

/** Hides the row until `until` at once and tells the host; a refused snooze shows it again. Resolves with the host's error. */
export async function snoozeReview(url: string, until: number): Promise<string | null> {
  const before = useReviewsStore.getState().queue?.snoozed[url] ?? null;
  useReviewsStore.getState().markSnoozed(url, until);
  const result = await reviewsRequest({ kind: "snooze", url, until });
  if (result.ok) return null;
  useReviewsStore.getState().markSnoozed(url, before);
  return result.error ?? "Could not snooze it.";
}

/** Marks the item seen (`read`) or unread again, at once and on the host. Resolves with the host's error. */
export async function markReviewRead(url: string, updatedAt: number, read: boolean): Promise<string | null> {
  useReviewsStore.getState().markRead(url, updatedAt, read);
  const result = await reviewsRequest({ kind: "read", url, updatedAt, read });
  return result.ok ? null : (result.error ?? (read ? "Could not mark it seen." : "Could not mark it unread."));
}

/** Opening an item marks it seen, once per visit, as soon as its `updatedAt` is known. */
export function useMarkSeen(url: string, updatedAt: number | undefined): void {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current || updatedAt === undefined) return;
    sent.current = true;
    void markReviewRead(url, updatedAt, true);
  }, [url, updatedAt]);
}
