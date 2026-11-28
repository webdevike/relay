import { describe, expect, it } from "vitest";
import { LINEAR_MAX_PAGES, RECONCILE_EVERY_MS } from "../src/tickets/linear-sync";
import { FakeGh, FakeLinear, prNode, T0, ticketsHarness } from "./tickets-fakes";

const MIN = 60_000;
/** One full wait between cycles at the harness's jitter draw (the middle): 120 s. */
const INTERVAL = 2 * MIN;

/** The next cycle: the cooldown, then the rest of the interval. */
function nextCycle(h: ReturnType<typeof ticketsHarness>): Promise<void> {
  h.advance(30_000);
  h.advance(INTERVAL - 30_000);
  return h.settled();
}

const boardKeys = (h: ReturnType<typeof ticketsHarness>): Promise<string[]> =>
  h.service.handle("desk", { kind: "board" }).then((r) => (r.board?.tickets ?? []).map((t) => t.key).sort());

describe("tickets sync", () => {
  it("cold start with several clients and their reconnects is one sync, not one per client", async () => {
    const linear = new FakeLinear();
    linear.add("ENG-1", T0 - MIN);
    linear.add("ENG-2", T0 - 2 * MIN);
    const h = ticketsHarness({ linear });
    h.service.start();
    const answers = await Promise.all(["desk-a", "desk-b", "phone"].map((d) => h.service.handle(d, { kind: "subscribe", on: true })));
    await h.settled();
    for (const d of ["desk-a", "desk-b", "phone"]) await h.service.handle(d, { kind: "subscribe", on: true });
    expect(answers.every((a) => a.ok && a.rev !== undefined && a.status !== undefined)).toBe(true);
    expect(linear.count("viewer")).toBe(1);
    expect(linear.count("issues")).toBe(1);
    expect(await boardKeys(h)).toEqual(["ENG-1", "ENG-2"]);
    const board = await h.service.handle("desk-a", { kind: "board" });
    expect(board.board?.teams?.[0]?.states.map((s) => s.name)).toEqual(["Todo", "In Progress", "Done"]);
    expect(board.status?.identity).toEqual({ linear: { viewerId: "user-me", name: "Pat Example", email: "pat@example.com", org: "Acme" }, github: { login: "pat-example" } });
  });

  it("a 9-page burst reads 8 pages, keeps the watermark, and resumes from the cursor next cycle", async () => {
    const linear = new FakeLinear();
    for (let i = 1; i <= 9 * 25; i++) linear.add(`ENG-${String(i)}`, T0 - i * MIN);
    const h = ticketsHarness({ linear });
    h.service.start();
    await h.settled();
    expect(linear.count("issues")).toBe(LINEAR_MAX_PAGES);
    expect(h.file().sync.watermark).toBeNull();
    expect(h.file().sync.cursor).toMatchObject({ after: "200", first: true });
    expect(Object.keys(h.file().issues)).toHaveLength(200);
    await nextCycle(h);
    expect(linear.count("issues")).toBe(LINEAR_MAX_PAGES + 1);
    expect(h.file().sync.cursor).toBeNull();
    // The newest updatedAt seen minus 60 s.
    expect(h.file().sync.watermark).toBe(T0 - MIN - 60_000);
    expect(Object.keys(h.file().issues)).toHaveLength(225);
    // Nothing changed since: one page (the newest issue, inside the 60 s slack).
    await nextCycle(h);
    expect(linear.count("issues")).toBe(LINEAR_MAX_PAGES + 2);
  });

  it("backs off on 429 for Retry-After and makes no call before then", async () => {
    const linear = new FakeLinear();
    linear.add("ENG-1", T0 - MIN);
    const h = ticketsHarness({ linear });
    linear.queued.push(new Response("{}", { status: 429, headers: { "retry-after": "300" } }));
    h.service.start();
    await h.settled();
    const status = h.service.status();
    expect(status.freshness.state).toBe("backingOff");
    expect(status.freshness.lastError).toMatch(/rate limit/i);
    expect(status.budget.linear.backoffUntil).toBe(T0 + 300_000);
    const calls = linear.calls.length;
    h.advance(299_000);
    expect(linear.calls.length).toBe(calls);
    expect((await h.service.handle("desk", { kind: "sync" })).status?.freshness.state).toBe("backingOff");
    h.advance(1000);
    await h.settled();
    expect(h.service.status().freshness.state).toBe("waiting");
    expect(await boardKeys(h)).toEqual(["ENG-1"]);
  });

  it("skips a PR in a repo gh can't see (No access) and keeps the others' facts", async () => {
    const linear = new FakeLinear();
    linear.add("ENG-1", T0 - MIN, ["acme/app#1", "secret/repo#9"]);
    const gh = new FakeGh();
    gh.prs.set("acme/app#1", prNode("acme/app#1"));
    gh.prs.set("secret/repo#9", null);
    const h = ticketsHarness({ linear, gh });
    h.service.start();
    await h.settled();
    const card = (await h.service.handle("desk", { kind: "board" })).board?.tickets[0];
    expect(card?.prs).toEqual([{ repo: "acme/app", number: 1 }, { repo: "secret/repo", number: 9 }]);
    expect(card?.prFacts.map((p) => `${p.repo}#${String(p.number)}`)).toEqual(["acme/app#1"]);
    expect(card?.prFacts[0]?.checks).toEqual({ state: "pending", passed: 1, failed: 0, pending: 1 });
    expect(h.service.status().errors.github).toBeNull();
    expect(gh.calls.filter((c) => c.kind === "facts").flatMap((c) => c.refs)).toEqual(["acme/app#1"]);
  });

  it("a check or reaction change without an updatedAt bump refreshes only that PR's facts", async () => {
    const linear = new FakeLinear();
    linear.add("ENG-1", T0 - MIN, ["acme/app#1", "acme/app#2"]);
    const gh = new FakeGh();
    gh.prs.set("acme/app#1", prNode("acme/app#1"));
    gh.prs.set("acme/app#2", prNode("acme/app#2"));
    const h = ticketsHarness({ linear, gh });
    h.service.start();
    await h.settled();
    expect(gh.count("facts")).toBe(1);
    // Same cycle shape, nothing moved: probe only.
    await nextCycle(h);
    expect(gh.count("probe")).toBe(2);
    expect(gh.count("facts")).toBe(1);
    // PR 1's checks go green and PR 2 gets Isaac's reaction; neither updatedAt moves.
    const green = prNode("acme/app#1");
    green["commits"] = { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] } } } }] };
    gh.prs.set("acme/app#1", green);
    await nextCycle(h);
    expect(gh.calls.at(-1)).toEqual({ kind: "facts", refs: ["acme/app#1"] });
    const reacted = prNode("acme/app#2");
    reacted["comments"] = { nodes: [{ id: "ic-1", body: "Looks fine so far", createdAt: "2026-11-20T10:00:00Z", author: { login: "robin-sample" }, reactionGroups: [{ viewerHasReacted: true }] }] };
    gh.prs.set("acme/app#2", reacted);
    await nextCycle(h);
    expect(gh.calls.at(-1)).toEqual({ kind: "facts", refs: ["acme/app#2"] });
    const card = (await h.service.handle("desk", { kind: "board" })).board?.tickets[0];
    expect(card?.prFacts[0]?.checks.state).toBe("pass");
    const delta = h.pushes.filter((p) => p.t === "tickets.delta").at(-1);
    expect(delta?.t === "tickets.delta" ? delta.upserts.map((u) => u.key) : []).toEqual(["ENG-1"]);
  });

  it("an account change wipes the store, drops pending approvals and pushes an empty snapshot", async () => {
    const linear = new FakeLinear();
    linear.add("ENG-1", T0 - MIN);
    const h = ticketsHarness({ linear });
    h.service.start();
    await h.settled();
    expect(Object.keys(h.file().issues)).toEqual(["ENG-1"]);
    linear.viewer = { ...linear.viewer, id: "user-someone-else", name: "Someone Else" };
    linear.members.clear();
    await nextCycle(h);
    expect(h.gate.invalidate).toHaveBeenCalledOnce();
    expect(Object.keys(h.file().issues)).toEqual([]);
    const snapshot = h.pushes.find((p) => p.t === "tickets.snapshot");
    expect(snapshot?.t === "tickets.snapshot" ? snapshot.board.tickets : null).toEqual([]);
    expect(h.service.status().identity.linear?.viewerId).toBe("user-someone-else");
  });

  it("tombstones an issue that left membership at reconcile, and one Linear stopped answering", async () => {
    const linear = new FakeLinear();
    linear.add("ENG-1", T0 - MIN);
    linear.add("ENG-2", T0 - MIN);
    linear.others.set("OPS-7", { ...(linear.members.get("ENG-1") ?? {}), identifier: "OPS-7", id: "id-OPS-7" });
    const h = ticketsHarness({ linear });
    h.service.start();
    await h.service.handle("desk", { kind: "watch", keys: ["OPS-7"], ttlMs: 60 * MIN });
    await h.settled();
    await nextCycle(h);
    expect(await boardKeys(h)).toEqual(["ENG-1", "ENG-2", "OPS-7"]);
    // ENG-2 leaves membership; OPS-7 becomes unreadable (access lost).
    linear.members.delete("ENG-2");
    linear.others.delete("OPS-7");
    await nextCycle(h);
    expect(await boardKeys(h)).toEqual(["ENG-1", "ENG-2"]);
    for (let t = 0; t < RECONCILE_EVERY_MS; t += INTERVAL) await nextCycle(h);
    expect(await boardKeys(h)).toEqual(["ENG-1"]);
    const tombstones = h.pushes.flatMap((p) => (p.t === "tickets.delta" ? p.tombstones : []));
    expect(tombstones).toEqual(["OPS-7", "ENG-2"]);
  });

  it("bounds the calls in one cycle", async () => {
    const linear = new FakeLinear();
    for (let i = 1; i <= 20 * 25; i++) linear.add(`ENG-${String(i)}`, T0 - i * 1000, [`acme/app#${String(i)}`]);
    const gh = new FakeGh();
    for (let i = 1; i <= 500; i++) gh.prs.set(`acme/app#${String(i)}`, prNode(`acme/app#${String(i)}`));
    const h = ticketsHarness({ linear, gh });
    h.service.start();
    await h.settled();
    // viewer + 8 issue pages + notifications + teams + reconcile (one id call per 50 stored keys).
    expect(linear.calls.length).toBeLessThanOrEqual(1 + LINEAR_MAX_PAGES + 1 + 1 + (LINEAR_MAX_PAGES * 25) / 50);
    expect(linear.count("issues")).toBe(LINEAR_MAX_PAGES);
    // 200 stored PRs at most: 10 probes and 20 facts calls, plus gh's login.
    expect(gh.count("probe")).toBeLessThanOrEqual(10);
    expect(gh.count("facts")).toBeLessThanOrEqual(20);
    expect(gh.calls.flatMap((c) => c.refs).length).toBeLessThanOrEqual(400);
  });

  it("completes membership reconciliation with more than 2,000 members and tombstones what left", async () => {
    const linear = new FakeLinear();
    for (let i = 1; i <= 2100; i++) linear.add(`ENG-${String(i)}`, T0 - i * 1000);
    const h = ticketsHarness({ linear });
    h.service.start();
    await h.settled();
    expect(await boardKeys(h)).toContain("ENG-5");
    linear.members.delete("ENG-5");
    const idsBefore = linear.count("ids");
    for (let t = 0; t <= RECONCILE_EVERY_MS; t += INTERVAL) await nextCycle(h);
    expect(await boardKeys(h)).not.toContain("ENG-5");
    expect(await boardKeys(h)).toContain("ENG-6");
    // One membership check of at most 500 stored keys, 50 per call.
    expect(linear.count("ids") - idsBefore).toBeLessThanOrEqual(10);
  });

  it("reads an inline mention on an issue it hadn't cached before moving the notice checkpoint past it", async () => {
    const linear = new FakeLinear();
    linear.add("ENG-1", T0 - MIN);
    linear.others.set("OPS-9", { ...(linear.members.get("ENG-1") ?? {}), identifier: "OPS-9", id: "id-OPS-9" });
    const h = ticketsHarness({ linear });
    h.service.start();
    await h.settled();
    const checkpoint = (): number | null => h.file().sync.noticesAt;
    const before = checkpoint();
    linear.notices = [{ type: "issueCommentMention", createdAt: new Date(T0 + MIN).toISOString(), issue: { identifier: "OPS-9" }, comment: { id: "comment-1" } }];
    // Linear fails the by-key read: the checkpoint stays, so the next cycle asks again.
    linear.failing.add("keys");
    await nextCycle(h);
    expect(checkpoint()).toBe(before);
    expect(await boardKeys(h)).toEqual(["ENG-1"]);
    linear.failing.clear();
    for (let i = 0; i < 10 && !(await boardKeys(h)).includes("OPS-9"); i++) await nextCycle(h);
    expect(await boardKeys(h)).toEqual(["ENG-1", "OPS-9"]);
    expect(checkpoint()).toBe(T0 + MIN);
  });

  it("withholds a ticket Linear now refuses to show, and keeps the stored card only through an outage", async () => {
    const linear = new FakeLinear();
    linear.add("ENG-1", T0 - MIN);
    const h = ticketsHarness({ linear });
    h.service.start();
    await h.settled();
    linear.failing.add("detail");
    expect((await h.service.handle("desk", { kind: "ticket", key: "ENG-1" })).ticket?.key).toBe("ENG-1");
    linear.failing.clear();
    const denied = { errors: [{ message: "Forbidden", extensions: { code: "FORBIDDEN" } }] };
    linear.queued.push(new Response(JSON.stringify(denied), { status: 200, headers: { "content-type": "application/json" } }));
    const res = await h.service.handle("desk", { kind: "ticket", key: "ENG-1" });
    expect(res.ok).toBe(false);
    expect(res.ticket).toBeUndefined();
    const last = h.pushes.at(-1);
    expect(last?.t === "tickets.delta" ? last.tombstones : null).toEqual(["ENG-1"]);
    expect(await boardKeys(h)).toEqual([]);
  });
});
