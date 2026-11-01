import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AstraItem, ReviewGuide, ReviewItem, ReviewQueue, SlackThread } from "@relay/protocol";

vi.mock("@/state/storage", () => ({
  fileStorage: { getItem: () => Promise.resolve(null), setItem: () => undefined, removeItem: () => undefined },
}));

import { useReviewsStore } from "@/state/reviews";
import { withPendingAsk } from "@/reviews/model";
import { createReviewsFrameRouter, PendingReviews, REVIEWS_SLOW_TIMEOUT_MS, REVIEWS_TIMEOUT_MS, reviewsTimeout, type ReviewsFrameRouter } from "./reviews";

const idle = { loading: false, error: null, fetchedAt: 1 };

function item(url: string, updatedAt: number): ReviewItem {
  return { url, ref: { kind: "linear", key: "ENG-1" }, title: "T", actor: "Steve", reason: "mentioned you", label: "ENG-1", updatedAt, unread: true };
}

function queue(items: ReviewItem[], done: Record<string, number> = {}): ReviewQueue {
  return { items, done, snoozed: {}, read: {}, sources: { github: idle, linear: idle, slack: idle } };
}

const guide: ReviewGuide = { headSha: "abc", source: "model", error: null, sections: [{ title: "Filters", why: "w", files: ["a.ts"] }] };
const thread: SlackThread = { channel: "C1", channelName: "#ui-ux", threadTs: "1.2", messages: [], fetchedAt: 5 };
const astra: AstraItem = { url: "u", title: "T", sessionId: "s1", turns: [{ id: "1", role: "assistant", text: "Hi", streaming: true }], working: true, waiting: null, error: null };

let pending: PendingReviews;
let route: ReviewsFrameRouter;

beforeEach(() => {
  vi.useFakeTimers();
  useReviewsStore.getState().clear();
  pending = new PendingReviews();
  route = createReviewsFrameRouter(useReviewsStore.getState(), pending);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pushed frames", () => {
  it("replace the queue and an item's Astra session", () => {
    route({ t: "reviews.queue", queue: queue([item("a", 1)]) });
    route({ t: "reviews.astra", item: astra });
    expect(useReviewsStore.getState().queue?.items.map((i) => i.url)).toEqual(["a"]);
    expect(useReviewsStore.getState().astra["u"]?.sessionId).toBe("s1");
  });
});

describe("an ask on an item with no session yet", () => {
  const url = "https://linear.app/x/issue/ENG-1";
  const shown = () => withPendingAsk(useReviewsStore.getState().astra[url], url, useReviewsStore.getState().asks[url]);
  const session = (turns: AstraItem["turns"], working: boolean): AstraItem => ({ url, title: "Astra · ENG-1", sessionId: "s1", turns, working, waiting: null, error: null });

  it("shows the question and Astra working at once, through the new session's first pushes, then her streamed answer", () => {
    useReviewsStore.getState().ask(url, "@Astra what does Todd want?");
    expect(shown()).toMatchObject({ working: true, turns: [{ role: "user", text: "@Astra what does Todd want?" }] });

    // The launched omp registered before its first prompt reached the transcript: no turns yet.
    route({ t: "reviews.astra", item: session([], false) });
    expect(shown()).toMatchObject({ sessionId: "s1", working: true, turns: [{ id: "pending-ask", role: "user" }] });

    route({ t: "reviews.astra", item: session([{ id: "m1", role: "user", text: "@Astra what does Todd want?", streaming: false }, { id: "m2", role: "assistant", text: "A yes or n", streaming: true }], true) });
    expect(useReviewsStore.getState().asks[url]).toBeUndefined();
    expect(shown()?.turns.map((t) => [t.id, t.text])).toEqual([
      ["m1", "@Astra what does Todd want?"],
      ["m2", "A yes or n"],
    ]);
  });

  it("asking the same words again waits for the new turn, not the old one", () => {
    const asked = [{ id: "m1", role: "user" as const, text: "@Astra again?", streaming: false }, { id: "m2", role: "assistant" as const, text: "Yes.", streaming: false }];
    route({ t: "reviews.astra", item: session(asked, false) });
    useReviewsStore.getState().ask(url, "@Astra again?");
    route({ t: "reviews.astra", item: session(asked, false) });
    expect(shown()?.turns.at(-1)).toMatchObject({ id: "pending-ask" });
    route({ t: "reviews.astra", item: session([...asked, { id: "m3", role: "user", text: "@Astra again?", streaming: false }], true) });
    expect(shown()?.turns.at(-1)).toMatchObject({ id: "m3" });
  });

  it("a refused ask leaves no bubble behind", () => {
    useReviewsStore.getState().ask(url, "@Astra hi");
    useReviewsStore.getState().dropAsk(url);
    expect(shown()).toBeUndefined();
  });
});

describe("reviews.res", () => {
  it("settles the request waiting on its rid", async () => {
    const answer = pending.add("r1", { kind: "queue", refresh: false });
    route({ t: "reviews.res", rid: "r1", ok: true, queue: queue([item("a", 1)]) });
    await expect(answer).resolves.toMatchObject({ rid: "r1", ok: true });
    expect(useReviewsStore.getState().queue?.items).toHaveLength(1);
  });

  it("stores a Guide under the PR its op named", () => {
    void pending.add("g", { kind: "guide", repo: "o/r", number: 170 });
    route({ t: "reviews.res", rid: "g", ok: true, guide });
    expect(useReviewsStore.getState().guides["o/r#170"]).toEqual(guide);
  });

  it("stores a Slack thread under its op's key, and a cached miss never wipes one already read", () => {
    void pending.add("s1", { kind: "slack", channel: "C1", threadTs: "1.2", refresh: true });
    route({ t: "reviews.res", rid: "s1", ok: true, thread });
    void pending.add("s2", { kind: "slack", channel: "C1", threadTs: "1.2", refresh: false });
    route({ t: "reviews.res", rid: "s2", ok: true, thread: null });
    expect(useReviewsStore.getState().threads["C1/1.2"]).toEqual(thread);
  });

  it("applies Done marks the host answered with", () => {
    route({ t: "reviews.queue", queue: queue([item("a", 1)]) });
    void pending.add("d", { kind: "done", url: "a", updatedAt: 1, done: true });
    route({ t: "reviews.res", rid: "d", ok: true, done: { a: 1 } });
    expect(useReviewsStore.getState().queue?.done).toEqual({ a: 1 });
  });

  it("stores nothing from a failure or an answer nobody waits for", async () => {
    const answer = pending.add("p", { kind: "pr", repo: "o/r", number: 1 });
    route({ t: "reviews.res", rid: "other", ok: true, queue: queue([item("x", 1)]) });
    route({ t: "reviews.res", rid: "p", ok: false, error: "gh failed" });
    await expect(answer).resolves.toMatchObject({ ok: false, error: "gh failed" });
    expect(useReviewsStore.getState().queue).toBeNull();
  });

  it("times out after the op's own wait", async () => {
    const quick = pending.add("q", { kind: "pr", repo: "o/r", number: 1 });
    const slow = pending.add("g", { kind: "guide", repo: "o/r", number: 1 });
    vi.advanceTimersByTime(REVIEWS_TIMEOUT_MS);
    await expect(quick).resolves.toEqual({ rid: "q", ok: false, error: "Your Mac did not answer." });
    expect(pending.op("g")).toBeDefined();
    vi.advanceTimersByTime(REVIEWS_SLOW_TIMEOUT_MS);
    await expect(slow).resolves.toMatchObject({ ok: false });
  });

  it("fails everything still waiting when the host changes", async () => {
    const one = pending.add("r1", { kind: "astra", url: "u" });
    pending.cancelAll();
    await expect(one).resolves.toMatchObject({ ok: false, error: "Disconnected." });
  });
});

describe("reviewsTimeout", () => {
  it("gives the Guide, a Slack read and an Astra ask five minutes", () => {
    expect(reviewsTimeout({ kind: "guide", repo: "o/r", number: 1 })).toBe(REVIEWS_SLOW_TIMEOUT_MS);
    expect(reviewsTimeout({ kind: "slack", channel: "C1", threadTs: null, refresh: true })).toBe(REVIEWS_SLOW_TIMEOUT_MS);
    expect(reviewsTimeout({ kind: "astraAsk", url: "u", ref: { kind: "linear", key: "ENG-1" }, text: "?" })).toBe(REVIEWS_SLOW_TIMEOUT_MS);
    expect(reviewsTimeout({ kind: "slack", channel: "C1", threadTs: null, refresh: false })).toBe(REVIEWS_TIMEOUT_MS);
    expect(reviewsTimeout({ kind: "queue", refresh: true })).toBe(REVIEWS_TIMEOUT_MS);
  });
});

describe("optimistic Done", () => {
  it("hides a row at once and puts it back on undo", () => {
    route({ t: "reviews.queue", queue: queue([item("a", 5)]) });
    useReviewsStore.getState().markDone("a", 5, true);
    expect(useReviewsStore.getState().queue?.done).toEqual({ a: 5 });
    useReviewsStore.getState().markDone("a", 5, false);
    expect(useReviewsStore.getState().queue?.done).toEqual({});
  });
});
