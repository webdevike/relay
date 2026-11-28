import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ticketsFeatures, type HostConfig } from "../src/host-config";
import { FakeLinear, T0, ticketsHarness, type TicketsHarness } from "./tickets-fakes";

const MIN = 60_000;
const config = (features: Record<string, boolean>): HostConfig => ({ features }) as unknown as HostConfig;
const OP_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

function started(): ReturnType<typeof ticketsHarness> {
  const linear = new FakeLinear();
  linear.add("ENG-1", T0 - MIN);
  const h = ticketsHarness({ linear, writes: true });
  h.service.start();
  return h;
}

describe("tickets opt-in (host.json)", () => {
  it("is off without host.json or features.tickets, and writes need ticketsWrites and no dry run", () => {
    expect(ticketsFeatures(null, {})).toEqual({ sync: false, writes: false });
    expect(ticketsFeatures(config({ reviews: true }), {})).toEqual({ sync: false, writes: false });
    expect(ticketsFeatures(config({ tickets: true }), {})).toEqual({ sync: true, writes: false });
    expect(ticketsFeatures(config({ tickets: true, ticketsWrites: true }), {})).toEqual({ sync: true, writes: true });
    expect(ticketsFeatures(config({ tickets: true, ticketsWrites: true }), { RELAY_REVIEWS_DRY_RUN: "1" })).toEqual({ sync: true, writes: false });
    expect(ticketsFeatures(config({ ticketsWrites: true }), {})).toEqual({ sync: false, writes: false });
  });
});

describe("TicketsService bounds and reads", () => {
  /** ENG-1 at the protocol's limits: a 100,000-unit description of 4-byte characters, 250 comments of 20,000 characters. */
  function maxSize(): TicketsHarness {
    const linear = new FakeLinear();
    linear.add("ENG-1", T0 - MIN);
    const at = (i: number): string => new Date(T0 - (250 - i) * MIN).toISOString();
    const user = { id: "user-other", name: "Robin Sample", avatarUrl: null };
    const comment = (i: number) => ({ id: `c-${String(i)}`, body: `${String(i)} ${"x".repeat(19_990)}`, url: `https://linear.app/acme/issue/ENG-1#c-${String(i)}`, createdAt: at(i), editedAt: null, resolvedAt: null, quotedText: null, documentContentId: null, parent: null, user, resolvingUser: null, reactionData: [] });
    linear.members.set("ENG-1", { ...linear.members.get("ENG-1"), description: "😀".repeat(50_000), comments: { nodes: Array.from({ length: 250 }, (_, i) => comment(i)) } });
    const h = ticketsHarness({ linear });
    h.service.start();
    return h;
  }

  it("keeps a maximum-size issue within the cache's byte caps", async () => {
    const h = maxSize();
    await h.settled();
    expect(statSync(join(h.dir, "tickets.json")).size).toBeLessThan(64 * 1024);
  });

  it("bounds the ticket page near 1 MiB, newest comments kept, and says what it left out", async () => {
    const h = maxSize();
    await h.settled();
    const page = (await h.service.handle("desk", { kind: "ticket", key: "ENG-1" })).ticket;
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThan(1.1 * 1024 * 1024);
    expect(page?.description).toBe("😀".repeat(50_000));
    expect(page?.comments.at(-1)?.id).toBe("c-249");
    expect(page?.clipped).toEqual({ description: false, comments: 250 - (page?.comments.length ?? 0) });
    expect(page?.clipped?.comments).toBeGreaterThan(0);
  });

  it("answers board, subscribe and an unchanged ticket page without rewriting tickets.json", async () => {
    const h = started();
    await h.settled();
    await h.service.handle("desk", { kind: "ticket", key: "ENG-1" });
    const rev = (await h.service.handle("desk", { kind: "board" })).rev;
    rmSync(join(h.dir, "tickets.json"));
    await h.service.handle("desk", { kind: "board" });
    await h.service.handle("phone", { kind: "subscribe", on: true });
    await h.service.handle("desk", { kind: "ticket", key: "ENG-1" });
    expect(existsSync(join(h.dir, "tickets.json"))).toBe(false);
    expect((await h.service.handle("desk", { kind: "board" })).rev).toBe(rev);
  });

  it("keeps signed attachment links' credentials out of ticket pages and the cache", async () => {
    const linear = new FakeLinear();
    linear.add("ENG-1", T0 - MIN);
    const signed = "https://storage.example.com/u/shot.png?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA1";
    const plain = "https://example.com/docs?page=2";
    linear.members.set("ENG-1", { ...linear.members.get("ENG-1"), description: `![shot](${signed}) see ${plain}` });
    const h = ticketsHarness({ linear });
    h.service.start();
    await h.settled();
    const page = (await h.service.handle("desk", { kind: "ticket", key: "ENG-1" })).ticket;
    expect(page?.description).toBe(`![shot](https://storage.example.com/u/shot.png) see ${plain}`);
    const stored = readFileSync(join(h.dir, "tickets.json"), "utf8");
    expect(stored).not.toContain("deadbeef");
    expect(stored).toContain(plain);
  });
});

describe("TicketsService ops", () => {
  it("answers summary, plan and replan as not available yet", async () => {
    const h = started();
    await h.settled();
    expect(await h.service.handle("desk", { kind: "summary", key: "ENG-1" })).toEqual({ ok: false, error: "Not available yet" });
    expect(await h.service.handle("desk", { kind: "plan", rows: [] })).toEqual({ ok: false, error: "Not available yet" });
    expect(await h.service.handle("desk", { kind: "replan", projectId: "project-1" })).toEqual({ ok: false, error: "Not available yet" });
  });

  it("seen answers the visit before and stores now", async () => {
    const h = started();
    expect((await h.service.handle("desk", { kind: "seen", key: "ENG-1" })).previousSeenAt).toBeNull();
    h.advance(5 * MIN);
    expect((await h.service.handle("desk", { kind: "seen", key: "ENG-1" })).previousSeenAt).toBe(T0);
  });

  it("works out who waits on Isaac, and Mark as handled (with undo) clears and returns it", async () => {
    const h = started();
    await h.settled();
    const card = async () => (await h.service.handle("desk", { kind: "board" })).board?.tickets[0];
    const waiting = (await card())?.attention.waiting[0];
    expect(waiting).toMatchObject({ provider: "linear", itemId: "ENG-1", commentId: "comment-1" });
    const target = { kind: "mention" as const, provider: "linear" as const, itemId: "ENG-1", throughCommentId: "comment-1" };
    expect((await h.service.handle("desk", { kind: "handled", target })).ok).toBe(true);
    expect((await card())?.attention.waiting).toEqual([]);
    await h.service.handle("desk", { kind: "handled", target, undo: true });
    expect((await card())?.attention.waiting).toHaveLength(1);
  });

  it("reads a ticket page with its description and every comment; a ticket Linear dropped is tombstoned", async () => {
    const h = started();
    await h.settled();
    const page = await h.service.handle("desk", { kind: "ticket", key: "ENG-1" });
    expect(page.ticket).toMatchObject({ key: "ENG-1", description: "A made-up ticket for host tests.", documentContentId: "doc-template" });
    expect(page.ticket?.comments[0]).toMatchObject({ id: "comment-1", reactions: [{ emoji: "+1", users: [{ id: "user-other" }] }] });
    h.linear.members.clear();
    const gone = await h.service.handle("desk", { kind: "ticket", key: "ENG-1" });
    expect(gone.ok).toBe(false);
    const last = h.pushes.at(-1);
    expect(last?.t === "tickets.delta" ? last.tombstones : null).toEqual(["ENG-1"]);
  });

  it("a watch for an unknown key asks for one coalesced sync", async () => {
    const h = started();
    await h.settled();
    const before = h.linear.count("viewer");
    await h.service.handle("desk", { kind: "watch", keys: ["OPS-1"], ttlMs: 10 * MIN });
    await h.service.handle("phone", { kind: "watch", keys: ["OPS-2"], ttlMs: 10 * MIN });
    h.advance(30_000);
    await h.settled();
    expect(h.linear.count("viewer")).toBe(before + 1);
  });

  it("hands prepare and commit to the gate as this device and the account it showed; a done commit syncs once", async () => {
    const h = started();
    await h.settled();
    const mutation = { kind: "comment" as const, issueId: "id-ENG-1", body: "On it" };
    await h.service.handle("desk-a", { kind: "prepare", viewerId: "user-me", mutation });
    expect(h.gate.prepare).toHaveBeenCalledWith({ deviceId: "desk-a" }, mutation, "user-me");
    const before = h.linear.count("viewer");
    const res = await h.service.handle("desk-a", { kind: "commit", viewerId: "user-me", approvalId: "approval-1", opId: OP_ID, mutation });
    expect(res.outcome?.state).toBe("done");
    expect(h.gate.commit).toHaveBeenCalledWith({ deviceId: "desk-a" }, { approvalId: "approval-1", opId: OP_ID, mutation }, "user-me");
    h.advance(30_000);
    await h.settled();
    expect(h.linear.count("viewer")).toBe(before + 1);
  });
});

describe("TicketsService writes as the account the device saw", () => {
  const SUBSCRIBE = { kind: "subscribe" as const, issueId: "id-ENG-1", on: true };
  const OPS = ["6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a41", "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a42", "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a43"] as const;

  /** A writing host with its real gate; Linear answers the subscribe check and write. */
  function writing(onCheck: () => void = () => undefined) {
    const linear = new FakeLinear();
    linear.add("ENG-1", T0 - MIN);
    const subscribers: string[] = [];
    linear.gateOps.set("TicketIssueSubscribers", () => {
      onCheck();
      return { issue: { id: "id-ENG-1", identifier: "ENG-1", subscribers: { nodes: subscribers.map((id) => ({ id })) } } };
    });
    linear.gateOps.set("TicketIssueSubscribe", () => {
      subscribers.push("user-me");
      return { issueSubscribe: { success: true } };
    });
    const h = ticketsHarness({ linear, writes: true, realGate: true });
    h.service.start();
    return h;
  }
  const writes = (h: TicketsHarness) => h.linear.gateCalls.filter((c) => c.op === "TicketIssueSubscribe");

  it("refuses a stale client's account with zero Linear calls", async () => {
    const h = writing();
    await h.settled();
    expect((await h.service.handle("desk", { kind: "commit", viewerId: "user-old", opId: OPS[0], mutation: SUBSCRIBE })).refused?.code).toBe("identity");
    expect((await h.service.handle("desk", { kind: "prepare", viewerId: "user-old", mutation: SUBSCRIBE })).refused?.code).toBe("identity");
    expect(h.linear.gateCalls).toEqual([]);
    expect((await h.service.handle("desk", { kind: "commit", viewerId: "user-me", opId: OPS[1], mutation: SUBSCRIBE })).outcome?.state).toBe("done");
    expect(writes(h)).toEqual([{ op: "TicketIssueSubscribe", key: "lin_api_test" }]);
  });

  it("refuses a write whose key rotated during validation, and writes with the new key only once it is confirmed", async () => {
    let rotate = true;
    const h = writing(() => {
      if (rotate) h.key.value = "lin_api_rotated";
      rotate = false;
    });
    await h.settled();
    expect((await h.service.handle("desk", { kind: "commit", viewerId: "user-me", opId: OPS[0], mutation: SUBSCRIBE })).refused?.code).toBe("identity");
    // Before a cycle confirms who the new key is, nothing is checked or written with it.
    const calls = h.linear.gateCalls.length;
    expect((await h.service.handle("desk", { kind: "commit", viewerId: "user-me", opId: OPS[1], mutation: SUBSCRIBE })).refused?.code).toBe("identity");
    expect(h.linear.gateCalls).toHaveLength(calls);
    expect(writes(h)).toEqual([]);
    h.advance(30_000);
    await h.settled();
    expect((await h.service.handle("desk", { kind: "commit", viewerId: "user-me", opId: OPS[2], mutation: SUBSCRIBE })).outcome?.state).toBe("done");
    expect(writes(h)).toEqual([{ op: "TicketIssueSubscribe", key: "lin_api_rotated" }]);
  });

  it("sends nothing when the key rotates during the executor's own read, after the gate's last check", async () => {
    let reads = 0;
    const h = writing(() => {
      // Read 1 is check(); read 2 is run()'s own read right before it subscribes.
      if (++reads === 2) h.key.value = "lin_api_rotated";
    });
    await h.settled();
    const res = await h.service.handle("desk", { kind: "commit", viewerId: "user-me", opId: OPS[0], mutation: SUBSCRIBE });
    expect(res.outcome?.state).toBe("failed");
    expect(writes(h)).toEqual([]);
  });

  it("drops an approval prepared before the key changed", async () => {
    const h = writing();
    await h.settled();
    const approval = (await h.service.handle("desk", { kind: "prepare", viewerId: "user-me", mutation: SUBSCRIBE })).approval;
    expect(approval).toBeDefined();
    h.key.value = "lin_api_rotated";
    h.advance(30_000);
    h.advance(90_000);
    await h.settled();
    const res = await h.service.handle("desk", { kind: "commit", viewerId: "user-me", approvalId: approval?.id ?? "", opId: OPS[0], mutation: SUBSCRIBE });
    expect(res.refused?.code).toBe("approval");
    expect(writes(h)).toEqual([]);
  });

  it("refuses writes until a full cycle after an account change, and the old account's clients after it", async () => {
    const h = writing();
    await h.settled();
    h.linear.viewer = { ...h.linear.viewer, id: "user-new" };
    // The new account's first issues page hangs: the cycle after the wipe is still running.
    const { promise, resolve } = Promise.withResolvers<void>();
    h.linear.blocked = promise;
    h.advance(30_000);
    h.advance(90_000);
    await vi.waitFor(() => {
      expect(h.linear.count("issues")).toBe(2);
    });
    expect((await h.service.handle("desk", { kind: "prepare", viewerId: "user-new", mutation: SUBSCRIBE })).refused?.code).toBe("identity");
    resolve();
    await h.settled();
    expect((await h.service.handle("desk", { kind: "prepare", viewerId: "user-me", mutation: SUBSCRIBE })).refused?.code).toBe("identity");
    expect((await h.service.handle("desk", { kind: "prepare", viewerId: "user-new", mutation: SUBSCRIBE })).approval).toBeDefined();
    expect(writes(h)).toEqual([]);
  });

  it("keeps the rev across restarts and starts empty from a tickets.json of another version", async () => {
    const h = started();
    await h.settled();
    const rev = h.file().rev;
    expect(rev).toBeGreaterThan(0);
    const again = ticketsHarness({ dir: h.dir, linear: h.linear });
    // The rev never goes back; a restarted host republishes its cards once as the next rev.
    expect((await again.service.handle("desk", { kind: "board" })).rev).toBe(rev + 1);
    writeFileSync(join(h.dir, "tickets.json"), JSON.stringify({ ...h.file(), v: 2 }));
    const newer = ticketsHarness({ dir: h.dir, linear: h.linear });
    const board = await newer.service.handle("desk", { kind: "board" });
    expect(board.board?.tickets).toEqual([]);
  });
});
