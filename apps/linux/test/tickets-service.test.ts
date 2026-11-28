import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ticketsFeatures, type HostConfig } from "../src/host-config";
import { FakeLinear, T0, ticketsHarness } from "./tickets-fakes";

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

  it("hands prepare and commit to the gate as this device and the host's identity; a done commit syncs once", async () => {
    const h = started();
    await h.settled();
    const mutation = { kind: "comment" as const, issueId: "id-ENG-1", body: "On it" };
    await h.service.handle("desk-a", { kind: "prepare", mutation });
    expect(h.gate.prepare).toHaveBeenCalledWith({ deviceId: "desk-a" }, mutation, { linearViewerId: "user-me", ghLogin: "pat-example" });
    const before = h.linear.count("viewer");
    const res = await h.service.handle("desk-a", { kind: "commit", approvalId: "approval-1", opId: OP_ID, mutation });
    expect(res.outcome?.state).toBe("done");
    expect(h.gate.commit).toHaveBeenCalledWith({ deviceId: "desk-a" }, { approvalId: "approval-1", opId: OP_ID, mutation }, { linearViewerId: "user-me", ghLogin: "pat-example" });
    h.advance(30_000);
    await h.settled();
    expect(h.linear.count("viewer")).toBe(before + 1);
  });

  it("refuses writes as nobody until a full cycle after an account change", async () => {
    const h = started();
    await h.settled();
    h.linear.viewer = { ...h.linear.viewer, id: "user-new" };
    // The new account's first issues page hangs: the cycle after the wipe is still running.
    const { promise, resolve } = Promise.withResolvers<void>();
    h.linear.blocked = promise;
    h.advance(30_000);
    h.advance(90_000);
    await vi.waitFor(() => {
      expect(h.gate.invalidate).toHaveBeenCalledOnce();
      expect(h.linear.count("issues")).toBe(2);
    });
    const mutation = { kind: "subscribe" as const, issueId: "id-ENG-1", on: true };
    await h.service.handle("desk", { kind: "prepare", mutation });
    expect(h.gate.prepare).toHaveBeenLastCalledWith({ deviceId: "desk" }, mutation, { linearViewerId: null, ghLogin: null });
    resolve();
    await h.settled();
    await h.service.handle("desk", { kind: "prepare", mutation });
    expect(h.gate.prepare).toHaveBeenLastCalledWith({ deviceId: "desk" }, mutation, { linearViewerId: "user-new", ghLogin: "pat-example" });
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
