/**
 * Routes Reviews' server frames into the reviews store: `reviews.queue` replaces the queue,
 * `reviews.astra` one item's Astra session, and `reviews.res` settles the `reviews.req` waiting on
 * its rid after storing what it carried under the key its op names (a Guide or a Slack thread does
 * not say which PR or thread it belongs to).
 */
import type { ReviewsOp, ReviewsResult, ServerMessage } from "@relay/protocol";
import { prKey, threadKey, type ReviewsStore } from "@/state/reviews";

export type ReviewsFrameRouter = (message: ServerMessage) => void;

/** How long a Reviews request waits for the host's answer before it counts as failed. */
export const REVIEWS_TIMEOUT_MS = 30_000;
/** The slow ones: a model writes the Guide, Slack is read through Claude, Astra answers. */
export const REVIEWS_SLOW_TIMEOUT_MS = 300_000;

export function reviewsTimeout(op: ReviewsOp): number {
  if (op.kind === "guide" || op.kind === "astraAsk" || (op.kind === "slack" && op.refresh)) return REVIEWS_SLOW_TIMEOUT_MS;
  return REVIEWS_TIMEOUT_MS;
}

/** `reviews.req` requests sent and not yet answered, by rid, each with its op. */
export class PendingReviews {
  private readonly waiting = new Map<string, { op: ReviewsOp; resolve: (result: ReviewsResult) => void; timer: number }>();

  /** Resolves with the host's answer to `rid`, or a failure after the op's timeout or `cancelAll`. */
  add(rid: string, op: ReviewsOp): Promise<ReviewsResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.settle({ rid, ok: false, error: "Your Mac did not answer." });
      }, reviewsTimeout(op));
      this.waiting.set(rid, { op, resolve, timer });
    });
  }

  /** The op `rid` was sent with, while it waits. */
  op(rid: string): ReviewsOp | undefined {
    return this.waiting.get(rid)?.op;
  }

  settle(result: ReviewsResult): void {
    const entry = this.waiting.get(result.rid);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.waiting.delete(result.rid);
    entry.resolve(result);
  }

  /** The connection went to another host: nothing still waiting will be answered. */
  cancelAll(): void {
    for (const rid of [...this.waiting.keys()]) this.settle({ rid, ok: false, error: "Disconnected." });
  }
}

type Sink = Pick<ReviewsStore, "setQueue" | "setDone" | "setPr" | "setGuide" | "setTicket" | "setThread" | "setAstra">;

/** Stores what a successful answer to `op` carried. */
export function applyReviewsResult(store: Sink, op: ReviewsOp, result: ReviewsResult): void {
  if (!result.ok) return;
  if (result.queue !== undefined) store.setQueue(result.queue);
  if (result.done !== undefined) store.setDone(result.done);
  if (result.pr !== undefined) store.setPr(result.pr);
  if (result.guide !== undefined && op.kind === "guide") store.setGuide(prKey(op.repo, op.number), result.guide);
  if (result.ticket !== undefined) store.setTicket(result.ticket);
  // A cached read that is not there yet (`null`) must not wipe a thread already showing.
  if (result.thread !== undefined && op.kind === "slack" && (result.thread !== null || op.refresh)) store.setThread(threadKey(op.channel, op.threadTs), result.thread);
  if (result.astra !== undefined && result.astra !== null) store.setAstra(result.astra);
}

export function createReviewsFrameRouter(store: Sink, pending: PendingReviews): ReviewsFrameRouter {
  // Every other frame belongs to the session machine, the command queue or another router.
  return (message) => {
    if (message.t === "reviews.queue") store.setQueue(message.queue);
    if (message.t === "reviews.astra") store.setAstra(message.item);
    if (message.t === "reviews.res") {
      const op = pending.op(message.rid);
      if (op !== undefined) applyReviewsResult(store, op, message);
      pending.settle(message);
    }
  };
}
