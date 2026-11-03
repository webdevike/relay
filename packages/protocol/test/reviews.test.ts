import { describe, expect, it } from "vitest";
import { isReviewDone, isReviewUnread, liveReviewItems, mentionsAstra, parseClientMessage, parseServerMessage, reviewAgo, reviewDayGroups, type ReviewItem } from "../src/index";

const item = (over: Partial<ReviewItem> = {}): ReviewItem => ({
  url: "https://github.com/eCardSystems/api/pull/170",
  ref: { kind: "github", repo: "eCardSystems/api", number: 170 },
  title: "feat: filters",
  actor: "webdevike",
  reason: "requested your review",
  label: "#170",
  updatedAt: 1000,
  unread: true,
  ...over,
});

describe("reviews frames", () => {
  it("parses requests and answers", () => {
    const req = (op: unknown) => parseClientMessage(JSON.stringify({ t: "reviews.req", rid: "r1", op })).ok;
    expect(req({ kind: "queue", refresh: false })).toBe(true);
    expect(req({ kind: "pr", repo: "eCardSystems/api", number: 170 })).toBe(true);
    expect(req({ kind: "slack", channel: "C0123ABC", threadTs: "1793368143.899439", refresh: true })).toBe(true);
    expect(req({ kind: "slack", channel: "C0123ABC", threadTs: null, refresh: false })).toBe(true);
    expect(req({ kind: "linear", key: "ENG-6406" })).toBe(true);
    expect(req({ kind: "comment", repo: "eCardSystems/api", number: 170, body: "" })).toBe(false);
    expect(req({ kind: "astraAsk", url: "https://x", ref: { kind: "linear", key: "eng-1" }, text: "hi" })).toBe(false);
    expect(req({ kind: "slackSend", channel: "C0123ABC", threadTs: null, text: "Thanks" })).toBe(true);

    const queue = { items: [item()], done: {}, sources: { github: { loading: false, error: null, fetchedAt: 1 }, linear: { loading: true, error: null, fetchedAt: null }, slack: { loading: false, error: "off", fetchedAt: null } } };
    expect(parseServerMessage(JSON.stringify({ t: "reviews.queue", queue })).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify({ t: "reviews.res", rid: "r1", ok: true, queue })).ok).toBe(true);
    expect(parseServerMessage(JSON.stringify({ t: "reviews.res", rid: "r1", ok: true, thread: null })).ok).toBe(true);
    const astra = { url: "https://x", title: "Astra · #170", sessionId: null, turns: [{ id: "1", role: "user", text: "Why?", streaming: false }], working: true, waiting: null, error: null };
    expect(parseServerMessage(JSON.stringify({ t: "reviews.astra", item: astra })).ok).toBe(true);
  });
});

describe("reviews helpers", () => {
  it("hides a Done item until it changes again", () => {
    expect(isReviewDone(item(), {})).toBe(false);
    expect(isReviewDone(item(), { [item().url]: 1000 })).toBe(true);
    expect(isReviewDone(item({ updatedAt: 1001 }), { [item().url]: 1000 })).toBe(false);
  });

  it("filters by source, newest first", () => {
    const linear = item({ url: "https://linear.app/x/issue/ENG-1", ref: { kind: "linear", key: "ENG-1" }, updatedAt: 3000 });
    const done = item({ url: "https://github.com/a/b/pull/2", updatedAt: 2000 });
    const queue = { items: [item(), done, linear], done: { [done.url]: 2000 } };
    expect(liveReviewItems(queue).map((i) => i.updatedAt)).toEqual([3000, 1000]);
    expect(liveReviewItems(queue, "github").map((i) => i.url)).toEqual([item().url]);
  });

  it("groups Today and Earlier around local midnight", () => {
    const now = new Date(2026, 9, 31, 15, 0).getTime();
    const today = item({ updatedAt: new Date(2026, 9, 31, 1, 0).getTime() });
    const earlier = item({ updatedAt: new Date(2026, 9, 30, 23, 0).getTime() });
    expect(reviewDayGroups([today, earlier], now).map((g) => [g.label, g.items.length])).toEqual([["Today", 1], ["Earlier", 1]]);
    expect(reviewDayGroups([earlier], now).map((g) => g.label)).toEqual(["Earlier"]);
  });

  it("hides a snoozed item until its time, and reads unread from the seen marks", () => {
    const queue = { items: [item()], done: {}, snoozed: { [item().url]: 5000 } };
    expect(liveReviewItems(queue, null, 4999)).toEqual([]);
    expect(liveReviewItems(queue, null, 5000)).toHaveLength(1);
    expect(isReviewUnread(item(), {})).toBe(true);
    expect(isReviewUnread(item(), { [item().url]: 1000 })).toBe(false);
    expect(isReviewUnread(item({ updatedAt: 2000 }), { [item().url]: 1000 })).toBe(true);
    expect(isReviewUnread(item({ unread: false }), {})).toBe(false);
  });

  it("parses snooze, read and upload ops, and an old host's queue without the new marks", () => {
    const req = (op: unknown) => parseClientMessage(JSON.stringify({ t: "reviews.req", rid: "r", op })).ok;
    expect(req({ kind: "snooze", url: "https://x", until: 5 })).toBe(true);
    expect(req({ kind: "snooze", url: "https://x", until: null })).toBe(true);
    expect(req({ kind: "read", url: "https://x", updatedAt: 5, read: false })).toBe(true);
    expect(req({ kind: "linearUpload", name: "a.jpg", mime: "image/jpeg", data: "QUJD" })).toBe(true);
    expect(req({ kind: "linearUpload", name: "a.svg", mime: "image/svg+xml", data: "QUJD" })).toBe(false);
    const old = parseServerMessage(JSON.stringify({ t: "reviews.queue", queue: { items: [], done: {}, sources: { github: { loading: false, error: null, fetchedAt: 1 }, linear: { loading: false, error: null, fetchedAt: 1 }, slack: { loading: false, error: null, fetchedAt: 1 } } } }));
    expect(old.ok && old.value.t === "reviews.queue" ? [old.value.queue.snoozed, old.value.queue.read] : null).toEqual([{}, {}]);
  });

  it("parses the Approve ops and their answer", () => {
    const req = (op: unknown) => parseClientMessage(JSON.stringify({ t: "reviews.req", rid: "r", op })).ok;
    expect(req({ kind: "approvable", repo: "eCardSystems/api", number: 172 })).toBe(true);
    expect(req({ kind: "approve", repo: "eCardSystems/api", number: 172 })).toBe(true);
    expect(req({ kind: "approve", repo: "not a repo", number: 172 })).toBe(false);
    const res = (approve: unknown) => parseServerMessage(JSON.stringify({ t: "reviews.res", rid: "r", ok: true, approve })).ok;
    expect(res({ key: "ENG-6648", state: "ready" })).toBe(true);
    expect(res(null)).toBe(true);
    expect(res({ key: "ENG-6648", state: "later" })).toBe(false);
  });

  it("formats ages and spots @Astra", () => {
    expect(reviewAgo(0, 3_000)).toBe("just now");
    expect(reviewAgo(0, 3 * 3_600_000)).toBe("3h");
    expect(reviewAgo(0, 5 * 86_400_000)).toBe("5d");
    expect(mentionsAstra("@Astra what changed?")).toBe(true);
    expect(mentionsAstra("ping @astraccount")).toBe(false);
  });
});
