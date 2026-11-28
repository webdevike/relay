import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import signedImages from "@relay/protocol/fixtures/signed-images.json";
import { ticketsFeatures, type HostConfig } from "../src/host-config";
import { MAX_DETAIL_FRAME_BYTES } from "../src/tickets/service";
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

  it("serves provider and signed media as unavailable: neither the page nor the cache holds the URL", async () => {
    const linear = new FakeLinear();
    linear.add("ENG-1", T0 - MIN);
    const jwt = "https://private-user-images.githubusercontent.com/1/shot.png?jwt=eyJhbGciOi.secret.sig";
    const amz = "https://storage.example.com/u/shot.png?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA1";
    const upload = "https://uploads.linear.app/a/b/c.png";
    const plain = "https://example.com/docs?page=2";
    const description = `![shot](${jwt} "A \\"quoted\\" title") <img width="300" src="${amz}"> ![up](${upload}) see ${plain}`;
    const comment = { id: "c-1", body: `Look: ![x](<${jwt}>)`, url: "https://linear.app/acme/issue/ENG-1#c-1", createdAt: new Date(T0 - MIN).toISOString(), editedAt: null, resolvedAt: null, quotedText: `![q](${jwt})`, documentContentId: null, parent: null, user: null, resolvingUser: null, reactionData: [] };
    linear.members.set("ENG-1", { ...linear.members.get("ENG-1"), description, comments: { nodes: [comment] } });
    const h = ticketsHarness({ linear });
    h.service.start();
    await h.settled();
    const page = JSON.stringify((await h.service.handle("desk", { kind: "ticket", key: "ENG-1" })).ticket);
    const stored = readFileSync(join(h.dir, "tickets.json"), "utf8");
    for (const text of [page, stored]) {
      for (const secret of ["eyJhbGciOi", "deadbeef", "private-user-images", "storage.example.com", "uploads.linear.app"]) expect(text).not.toContain(secret);
      expect(text).toContain("/reviews/media/unavailable");
      expect(text).toContain(plain);
    }
  });

  it("redacts whole angle-bracket destinations with parentheses, links and bare URLs: no jwt in the frame or the cache", async () => {
    const linear = new FakeLinear();
    linear.add("ENG-1", T0 - MIN);
    const jwt = (tag: string) => `https://private-user-images.githubusercontent.com/1/shot(${tag}).png?jwt=eyJ${tag}`;
    const description = `![a](<${jwt("img")}> "t") [file](<${jwt("link")}>) (see ${jwt("bare")}) [ref]: <${jwt("def")}>`;
    const comment = { id: "c-1", body: `![b](<${jwt("cimg")}>)`, url: "https://linear.app/acme/issue/ENG-1#c-1", createdAt: new Date(T0 - MIN).toISOString(), editedAt: null, resolvedAt: null, quotedText: `<${jwt("quote")}>`, documentContentId: null, parent: null, user: null, resolvingUser: null, reactionData: [] };
    linear.members.set("ENG-1", { ...linear.members.get("ENG-1"), description, comments: { nodes: [comment] } });
    const h = ticketsHarness({ linear });
    h.service.start();
    await h.settled();
    const frame = JSON.stringify({ t: "tickets.res", rid: "r1", ...(await h.service.handle("desk", { kind: "ticket", key: "ENG-1" })) });
    const stored = readFileSync(join(h.dir, "tickets.json"), "utf8");
    for (const text of [frame, stored]) {
      expect(text).not.toContain("eyJ");
      expect(text).not.toContain("private-user-images");
    }
    // The shared media grammar: a private image points at the host's unavailable media, a bare
    // signed link becomes "(private link)" and a signed link's text stays without its destination.
    expect(frame).toContain("(see (private link))");
    expect(frame).toContain("/reviews/media/unavailable");
  });

  it("redacts duplicate and entity-encoded reference definitions and signed link labels: no credential in the frame or the cache", async () => {
    const linear = new FakeLinear();
    linear.add("ENG-1", T0 - MIN);
    const url = (tag: string) => `https://private-user-images.githubusercontent.com/1/${tag}.png?jwt=eyJ${tag}`;
    const description = [
      "![shot][ref]",
      "",
      `[ref]: ${url("first")}`,
      `[ref]: https&#58;//private-user-images.githubusercontent.com/1/second.png?jwt=eyJsecond`,
      `[REF]: https&#x3a;&#x2f;&#x2f;private-user-images.githubusercontent.com/1/third.png&#63;jwt&#61;eyJthird`,
      "",
      `See [${url("label")}](${url("label")}) and https&colon;//private-user-images.githubusercontent.com/1/bare.png?jwt=eyJbare`,
    ].join("\n");
    const comment = { id: "c-1", body: `[x]: https&#58;//private-user-images.githubusercontent.com/1/c.png?jwt=eyJcomment`, url: "https://linear.app/acme/issue/ENG-1#c-1", createdAt: new Date(T0 - MIN).toISOString(), editedAt: null, resolvedAt: null, quotedText: null, documentContentId: null, parent: null, user: null, resolvingUser: null, reactionData: [] };
    linear.members.set("ENG-1", { ...linear.members.get("ENG-1"), description, comments: { nodes: [comment] } });
    const h = ticketsHarness({ linear });
    h.service.start();
    await h.settled();
    const frame = JSON.stringify({ t: "tickets.res", rid: "r1", ...(await h.service.handle("desk", { kind: "ticket", key: "ENG-1" })) });
    const stored = readFileSync(join(h.dir, "tickets.json"), "utf8");
    for (const text of [frame, stored]) {
      expect(text).not.toContain("eyJ");
      expect(text).not.toContain("private-user-images");
    }
  });

  it("keeps no credential from any shared signed-media fixture (titles, parenthesized labels, code) in the frame or the cache", async () => {
    const linear = new FakeLinear();
    linear.add("ENG-1", T0 - MIN);
    const all = [...Object.values(signedImages.forms), ...Object.values(signedImages.links)];
    const comment = { id: "c-1", body: all.join("\n\n"), url: "https://linear.app/acme/issue/ENG-1#c-1", createdAt: new Date(T0 - MIN).toISOString(), editedAt: null, resolvedAt: null, quotedText: all.join(" "), documentContentId: null, parent: null, user: null, resolvingUser: null, reactionData: [] };
    linear.members.set("ENG-1", { ...linear.members.get("ENG-1"), description: all.join("\n\n"), comments: { nodes: [comment] } });
    const h = ticketsHarness({ linear });
    h.service.start();
    await h.settled();
    const frame = JSON.stringify({ t: "tickets.res", rid: "r1", ...(await h.service.handle("desk", { kind: "ticket", key: "ENG-1" })) });
    const stored = readFileSync(join(h.dir, "tickets.json"), "utf8");
    for (const text of [frame, stored]) for (const secret of signedImages.secrets) expect(text).not.toContain(secret);
  });

  it("keeps the whole ticket-page frame under its cap with 250 short comments carrying long quotes and full reactions", async () => {
    const linear = new FakeLinear();
    linear.add("ENG-1", T0 - MIN);
    const users = Array.from({ length: 10 }, (_, i) => ({ id: `u-${String(i)}`, name: `Person ${String(i)} ${"é".repeat(100)}`, avatarUrl: null }));
    const comment = (i: number) => ({ id: `c-${String(i)}`, body: `ok ${String(i)}`, url: `https://linear.app/acme/issue/ENG-1#c-${String(i)}`, createdAt: new Date(T0 - (250 - i) * MIN).toISOString(), editedAt: null, resolvedAt: null, quotedText: "\u0001".repeat(20_000), documentContentId: "doc-1", parent: null, user: users[0], resolvingUser: null, reactionData: Array.from({ length: 10 }, (_, e) => ({ emoji: `e${String(e)}`, reactions: users.map((u) => ({ user: u })) })) });
    linear.members.set("ENG-1", { ...linear.members.get("ENG-1"), comments: { nodes: Array.from({ length: 250 }, (_, i) => comment(i)) } });
    const h = ticketsHarness({ linear });
    h.service.start();
    await h.settled();
    const answer = await h.service.handle("desk", { kind: "ticket", key: "ENG-1" });
    const frame = JSON.stringify({ t: "tickets.res", rid: "r".repeat(64), ...answer });
    expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(MAX_DETAIL_FRAME_BYTES);
    expect(answer.ticket?.comments.at(-1)?.id).toBe("c-249");
    expect(answer.ticket?.clipped?.comments).toBe(250 - (answer.ticket?.comments.length ?? 0));
  }, 20_000);
});

describe("TicketsService ops", () => {
  it("replan needs Astra's sessions; there is no direct Relay-start op", async () => {
    const h = started();
    await h.settled();
    expect(await h.service.handle("desk", { kind: "replan", projectId: "project-1" })).toEqual({ ok: false, error: "Astra is not available on this host" });
    expect(await h.service.handle("desk", { kind: "plan", rows: [] } as never)).toMatchObject({ ok: false });
    expect(existsSync(join(h.dir, "plan.json"))).toBe(false);
  });

  it("summarizes a synced ticket once per snapshot; without Claude it answers an error", async () => {
    const text = "The ticket adds a board. It is in progress and the next step is review.";
    const linear = new FakeLinear();
    linear.add("ENG-1", T0 - MIN);
    const writer = vi.fn((_: string) => Promise.resolve(text));
    const h = ticketsHarness({ linear, summaryWriter: writer });
    h.service.start();
    await h.settled();
    const answer = await h.service.handle("desk", { kind: "summary", key: "ENG-1" });
    expect(answer).toEqual({ ok: true, summary: { key: "ENG-1", text, at: T0 } });
    await h.service.handle("desk", { kind: "summary", key: "ENG-1" });
    expect(writer).toHaveBeenCalledTimes(1);
    expect(await h.service.handle("desk", { kind: "summary", key: "ENG-9" })).toEqual({ ok: false, error: "ENG-9 is not on the board" });
    const bare = started();
    await bare.settled();
    expect(await bare.service.handle("desk", { kind: "summary", key: "ENG-1" })).toEqual({ ok: false, error: "Claude is not available on this host" });
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
    expect(page.ticket?.comments[0]).toMatchObject({ id: "comment-1", author: { id: "user-other", url: "https://linear.app/acme/profiles/robin" }, reactions: [{ emoji: "+1", users: [{ id: "user-other" }] }] });
    expect(page.ticket?.assignee).not.toHaveProperty("url");
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

describe("TicketsService PR writes as the gh account the device saw", () => {
  const H = "a".repeat(40);
  const MERGE = { kind: "merge" as const, repo: "o/r", number: 1, method: "squash" as const, intent: "merge" as const, expectHead: H, expectBase: "main", expectOutcome: "merge" as const };
  function prHost(): TicketsHarness {
    const linear = new FakeLinear();
    linear.add("ENG-1", T0 - MIN);
    const h = ticketsHarness({ linear, writes: true, ghWrites: true });
    h.service.start();
    return h;
  }
  const graphqlCalls = (h: TicketsHarness, from: number) => h.gh.envs.slice(from).filter((c) => c.argv.includes("graphql"));

  it("runs every gh call of the op with the one token it pinned", async () => {
    const h = prHost();
    await h.settled();
    const from = h.gh.envs.length;
    // The fake gh has no such PR: the check refuses, but only after reading as the pinned token.
    expect((await h.service.preparePr("desk", MERGE, "pat-example")).refused?.code).toBe("invalid");
    const calls = h.gh.envs.slice(from);
    expect(calls[0]?.argv).toEqual(["gh", "auth", "token"]);
    expect(calls.slice(1).map((c) => c.token)).toEqual(calls.slice(1).map(() => "gho_test"));
    expect(graphqlCalls(h, from)).toHaveLength(1);
  });

  it("refuses another login, a signed-out gh and a gh signed in as someone else, without reading the PR", async () => {
    const h = prHost();
    await h.settled();
    const from = h.gh.envs.length;
    expect((await h.service.commitPr("desk", { opId: OP_ID, mutation: MERGE }, "someone-else")).refused?.code).toBe("identity");
    h.gh.login = "someone-else";
    expect((await h.service.commitPr("desk", { opId: OP_ID, mutation: MERGE }, "pat-example")).refused?.code).toBe("identity");
    h.gh.token = null;
    expect((await h.service.preparePr("desk", MERGE, "pat-example")).refused?.code).toBe("identity");
    expect(graphqlCalls(h, from)).toEqual([]);
  });
});

describe("Timeline plan through the real gate: Relay starts and per-row retries", () => {
  const ME = "user-me";
  const id = (prefix: string, n: number): string => `6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f${prefix}${String(n).padStart(3, "0")}`;
  const ROW = (n: number): string => id("a", n);
  const BATCH = (n: number): string => id("b", n);
  type Fault = "lost" | "reject" | undefined;
  interface PlanIssue { id: string; identifier: string; title: string; updatedAt: string; dueDate: string | null; priority: number; prioritySortOrder: number }
  type Row = { key: string; issueId: string; opId: string; baseUpdatedAt: number; dueDate?: string | null; plannedStart?: string | null; basePlannedStart?: string | null };

  /**
   * Linear's plan reads and issueUpdates over two issues; `fault` loses (after applying) or refuses
   * one; `onRead` runs on every plan read (it may throw: a lost read), `onUpdate` while an update is
   * being applied (another change landing meanwhile).
   */
  interface PlanLinear { readonly linear: FakeLinear; readonly issues: Map<string, PlanIssue>; fault: (id: string) => Fault; onRead: () => void; onUpdate: (id: string) => void }
  function planLinear(): PlanLinear {
    const linear = new FakeLinear();
    linear.add("ENG-1", T0 - MIN);
    linear.add("ENG-2", T0 - MIN);
    const issues = new Map<string, PlanIssue>(["ENG-1", "ENG-2"].map((k) => [`id-${k}`, { id: `id-${k}`, identifier: k, title: `Title ${k}`, updatedAt: new Date(T0 - MIN).toISOString(), dueDate: null, priority: 2, prioritySortOrder: 100 }]));
    const ctl: PlanLinear = { linear, issues, fault: () => undefined, onRead: () => undefined, onUpdate: () => undefined };
    linear.gateOps.set("TicketPlanIssues", (v) => {
      ctl.onRead();
      return { issues: { nodes: (v["ids"] as string[]).flatMap((i) => issues.get(i) ?? []) } };
    });
    linear.gateOps.set("TicketIssueUpdate", (v) => {
      const issue = issues.get(String(v["id"]));
      const fault = ctl.fault(String(v["id"]));
      if (issue === undefined || fault === "reject") return { issueUpdate: { success: false } };
      Object.assign(issue, v["input"], { updatedAt: new Date(T0 + 1000).toISOString() });
      ctl.onUpdate(issue.id);
      if (fault === "lost") throw new Error("socket hang up");
      return { issueUpdate: { success: true, issue: { id: issue.id, identifier: issue.identifier, url: "https://linear.app/acme/issue/x" } } };
    });
    return ctl;
  }

  async function host(ctl: PlanLinear, o: { dir?: string; writes?: boolean } = {}): Promise<TicketsHarness> {
    const h = ticketsHarness({ linear: ctl.linear, writes: o.writes ?? true, realGate: true, ...(o.dir === undefined ? {} : { dir: o.dir }) });
    h.service.start();
    await h.settled();
    return h;
  }

  const row = (key: string, n: number, over: Partial<Row> = {}): Row => ({ key, issueId: `id-${key}`, opId: ROW(n), baseUpdatedAt: T0 - MIN, ...over });
  const plan = (rows: Row[]) => ({ kind: "applyPlan" as const, rows });
  const updates = (ctl: PlanLinear): number => ctl.linear.gateCalls.filter((c) => c.op === "TicketIssueUpdate").length;
  const starts = async (h: TicketsHarness) => Object.fromEntries(((await h.service.handle("desk", { kind: "board" })).board?.tickets ?? []).map((t) => [t.key, t.plannedStart ?? null]));

  /** Isaac's confirm, then the commit with its approval. */
  async function apply(h: TicketsHarness, rows: Row[], batch: string, device = "desk") {
    const prepared = await h.service.handle(device, { kind: "prepare", viewerId: ME, mutation: plan(rows) });
    if (prepared.approval === undefined) return prepared;
    return h.service.handle(device, { kind: "commit", viewerId: ME, approvalId: prepared.approval.id, opId: batch, mutation: plan(rows) });
  }

  it("saves start-only and mixed rows' Relay starts under the approved applyPlan; a fresh read and a restart show them", async () => {
    const ctl = planLinear();
    const h = await host(ctl);
    const confirm = await h.service.handle("desk", { kind: "prepare", viewerId: ME, mutation: plan([row("ENG-1", 1, { dueDate: "2026-12-09", plannedStart: "2026-12-01", basePlannedStart: null }), row("ENG-2", 2, { plannedStart: "2026-12-03", basePlannedStart: null })]) });
    expect(confirm.approval?.rows?.map((r) => r.change)).toEqual(["due 2026-12-09, start 2026-12-01 (Relay only)", "start 2026-12-03 (Relay only)"]);
    const res = await h.service.handle("desk", { kind: "commit", viewerId: ME, approvalId: confirm.approval?.id ?? "", opId: BATCH(1), mutation: plan([row("ENG-1", 1, { dueDate: "2026-12-09", plannedStart: "2026-12-01", basePlannedStart: null }), row("ENG-2", 2, { plannedStart: "2026-12-03", basePlannedStart: null })]) });
    expect(res.outcome?.state).toBe("done");
    expect(res.outcome?.result?.rows?.map((r) => [r.key, r.state])).toEqual([["ENG-1", "done"], ["ENG-2", "done"]]);
    // Only the mixed row's Linear part went to Linear; the start-only row wrote nothing there.
    expect(updates(ctl)).toBe(1);
    expect(await starts(h)).toEqual({ "ENG-1": "2026-12-01", "ENG-2": "2026-12-03" });
    h.service.stop();
    const again = await host(ctl, { dir: h.dir });
    expect(await starts(again)).toEqual({ "ENG-1": "2026-12-01", "ENG-2": "2026-12-03" });
  });

  it("leaves the start of a failed or unknown row untouched and reports a start it couldn't save as failed, not done", async () => {
    const ctl = planLinear();
    const h = await host(ctl);
    ctl.fault = (i) => (i === "id-ENG-1" ? "reject" : "lost");
    const res = await apply(h, [row("ENG-1", 1, { dueDate: "2026-12-09", plannedStart: "2026-12-01", basePlannedStart: null }), row("ENG-2", 2, { dueDate: "2026-12-10", plannedStart: "2026-12-02", basePlannedStart: null })], BATCH(1));
    expect(res.outcome?.result?.rows?.map((r) => r.state)).toEqual(["failed", "unknown"]);
    expect(await starts(h)).toEqual({ "ENG-1": null, "ENG-2": null });
    // plan.json can't be written: the start-only row is reported failed with why.
    ctl.fault = () => undefined;
    mkdirSync(join(h.dir, "plan.json"));
    const broken = await apply(h, [row("ENG-1", 3, { plannedStart: "2026-11-25", basePlannedStart: null })], BATCH(2));
    expect(broken.outcome?.state).toBe("failed");
    expect(broken.outcome?.result?.rows?.[0]).toMatchObject({ state: "failed", error: expect.stringMatching(/^Not saved: Relay couldn't save its start/) });
    expect(await starts(h)).toEqual({ "ENG-1": null, "ENG-2": null });
  });

  it("refuses a plan made from a Relay start another device moved, at confirm and again at commit before any Linear write", async () => {
    const ctl = planLinear();
    const h = await host(ctl);
    await apply(h, [row("ENG-1", 1, { plannedStart: "2026-12-01", basePlannedStart: null })], BATCH(1), "phone");
    expect((await apply(h, [row("ENG-1", 2, { plannedStart: "2026-12-05", basePlannedStart: null })], BATCH(2))).refused?.code).toBe("conflict");
    // A mixed row confirmed against 2026-12-01; the phone moves the start before the desk commits.
    const mine = [row("ENG-1", 3, { dueDate: "2026-12-09", plannedStart: "2026-12-05", basePlannedStart: "2026-12-01" })];
    const confirm = await h.service.handle("desk", { kind: "prepare", viewerId: ME, mutation: plan(mine) });
    expect(confirm.approval).toBeDefined();
    await apply(h, [row("ENG-1", 4, { plannedStart: "2026-12-02", basePlannedStart: "2026-12-01" })], BATCH(3), "phone");
    const res = await h.service.handle("desk", { kind: "commit", viewerId: ME, approvalId: confirm.approval?.id ?? "", opId: BATCH(4), mutation: plan(mine) });
    expect(res.refused).toEqual({ code: "conflict", message: expect.stringContaining("changed on another device") });
    // The due date never went to Linear; the phone's start stands.
    expect(updates(ctl)).toBe(0);
    expect(await starts(h)).toMatchObject({ "ENG-1": "2026-12-02" });
  });

  it("refuses a start-only row whose issue changed in Linear after the board was cached: plan.json stays as it was", async () => {
    const ctl = planLinear();
    const h = await host(ctl);
    const before = existsSync(join(h.dir, "plan.json")) ? readFileSync(join(h.dir, "plan.json"), "utf8") : null;
    // Linear moved on; the host's published board (and the device's draft) still has the old revision.
    ctl.issues.get("id-ENG-1")!.updatedAt = new Date(T0 + 5_000).toISOString();
    const res = await apply(h, [row("ENG-1", 1, { plannedStart: "2026-11-25", basePlannedStart: null })], BATCH(1));
    expect(res.refused).toEqual({ code: "conflict", message: "ENG-1: Changed in Linear since the plan was made" });
    expect(updates(ctl)).toBe(0);
    expect(await starts(h)).toEqual({ "ENG-1": null, "ENG-2": null });
    expect(existsSync(join(h.dir, "plan.json")) ? readFileSync(join(h.dir, "plan.json"), "utf8") : null).toBe(before);
  });

  it("refuses Relay starts with writes off, for another account, for an issue its key doesn't name, and a start after the unchanged due date", async () => {
    const ctl = planLinear();
    const off = await host(ctl, { writes: false });
    expect((await apply(off, [row("ENG-1", 1, { plannedStart: "2026-12-01", basePlannedStart: null })], BATCH(1))).refused?.code).toBe("writesOff");
    const live = planLinear();
    const h = await host(live);
    expect((await h.service.handle("desk", { kind: "prepare", viewerId: "user-old", mutation: plan([row("ENG-1", 1, { plannedStart: "2026-12-01" })]) })).refused?.code).toBe("identity");
    expect((await apply(h, [row("ENG-1", 1, { issueId: "id-ENG-2", plannedStart: "2026-12-01" })], BATCH(1))).refused?.code).toBe("invalid");
    expect((await apply(h, [row("ENG-9", 1, { plannedStart: "2026-12-01" })], BATCH(1))).refused?.code).toBe("invalid");
    await apply(h, [row("ENG-1", 2, { dueDate: "2026-12-09" })], BATCH(2));
    const after = Date.parse(live.issues.get("id-ENG-1")!.updatedAt);
    expect((await apply(h, [row("ENG-1", 3, { baseUpdatedAt: after, plannedStart: "2026-12-10", basePlannedStart: null })], BATCH(3))).refused?.message).toContain("would be after its due date");
    expect(await starts(h)).toEqual({ "ENG-1": null, "ENG-2": null });
  });

  it("never shows one account's starts to another account on the same keys (the wipe clears them)", async () => {
    const ctl = planLinear();
    const h = await host(ctl);
    await apply(h, [row("ENG-1", 1, { plannedStart: "2026-12-01", basePlannedStart: null })], BATCH(1));
    expect(await starts(h)).toMatchObject({ "ENG-1": "2026-12-01" });
    ctl.linear.viewer = { ...ctl.linear.viewer, id: "user-new" };
    h.advance(30_000);
    h.advance(90_000);
    await h.settled();
    await vi.waitFor(async () => {
      expect(await starts(h)).toEqual({ "ENG-1": null, "ENG-2": null });
    });
    expect(JSON.parse(readFileSync(join(h.dir, "plan.json"), "utf8"))).toEqual({ v: 2, accounts: {} });
  });

  it("a retry under a fresh batch id never resends a done or unknown row; only definite failures go out again", async () => {
    const ctl = planLinear();
    const h = await host(ctl);
    const rows = [row("ENG-1", 1, { dueDate: "2026-12-09" }), row("ENG-2", 2, { dueDate: "2026-12-10" })];
    ctl.fault = (i) => (i === "id-ENG-2" ? "lost" : undefined);
    expect((await apply(h, rows, BATCH(1))).outcome?.result?.rows?.map((r) => r.state)).toEqual(["done", "unknown"]);
    expect(updates(ctl)).toBe(2);
    ctl.fault = () => undefined;
    // The same rows under another batch id: ENG-1 is known done, ENG-2 is reconciled (it landed), nothing is sent.
    const again = await apply(h, rows, BATCH(2));
    expect(again.outcome?.state).toBe("done");
    expect(updates(ctl)).toBe(2);
    // A definite failure is the only kind that goes out again, after a fresh confirm.
    ctl.fault = (i) => (i === "id-ENG-2" ? "reject" : undefined);
    const failing = [row("ENG-1", 3, { dueDate: "2026-12-11", baseUpdatedAt: T0 + 1000 }), row("ENG-2", 4, { dueDate: "2026-12-12", baseUpdatedAt: T0 + 1000 })];
    const partial = await apply(h, failing, BATCH(3));
    expect(partial).toMatchObject({ ok: false, outcome: { state: "failed" } });
    expect(partial.outcome?.result?.rows?.map((r) => r.state)).toEqual(["done", "failed"]);
    expect(updates(ctl)).toBe(4);
    ctl.fault = () => undefined;
    expect((await apply(h, failing, BATCH(4))).outcome?.state).toBe("done");
    expect(ctl.linear.gateCalls.filter((c) => c.op === "TicketIssueUpdate").length).toBe(5);
  });

  it("checks a lost answer under the same batch id after a restart, and a delayed first commit answers the stored outcome", async () => {
    const ctl = planLinear();
    const h = await host(ctl);
    const rows = [row("ENG-1", 1, { dueDate: "2026-12-09" })];
    ctl.fault = () => "lost";
    expect((await apply(h, rows, BATCH(1))).outcome?.state).toBe("unknown");
    ctl.fault = () => undefined;
    h.service.stop();
    const again = await host(ctl, { dir: h.dir });
    // "Check": the same commit, no approval; the host reconciles the row with Linear and sends nothing.
    const check = await again.service.handle("desk", { kind: "commit", viewerId: ME, opId: BATCH(1), mutation: plan(rows) });
    expect(check.outcome).toEqual({ opId: BATCH(1), state: "done", result: { rows: [{ key: "ENG-1", opId: ROW(1), state: "done" }] } });
    expect(updates(ctl)).toBe(1);
    // A batch the host never got: the check is refused for a confirm; the late original commit then answers the same outcome.
    const late = [row("ENG-2", 2, { dueDate: "2026-12-10" })];
    const first = await again.service.handle("desk", { kind: "prepare", viewerId: ME, mutation: plan(late) });
    expect((await again.service.handle("desk", { kind: "commit", viewerId: ME, opId: BATCH(2), mutation: plan(late) })).refused?.code).toBe("approval");
    expect((await apply(again, late, BATCH(2))).outcome?.state).toBe("done");
    const delayed = await again.service.handle("desk", { kind: "commit", viewerId: ME, approvalId: first.approval?.id ?? "", opId: BATCH(2), mutation: plan(late) });
    expect(delayed.outcome?.state).toBe("done");
    expect(updates(ctl)).toBe(2);
  });

  const planFile = (h: TicketsHarness): string | null => (existsSync(join(h.dir, "plan.json")) ? readFileSync(join(h.dir, "plan.json"), "utf8") : null);
  /** ENG-2 as another device changes it in Linear: due Dec 3, a newer revision. */
  const moveEng2 = (ctl: PlanLinear): void => {
    Object.assign(ctl.issues.get("id-ENG-2")!, { dueDate: "2026-12-03", updatedAt: new Date(T0 + 9_000).toISOString() });
  };

  it("checks each row against Linear right before it: ENG-2 changed while ENG-1 was being written fails, its start unsaved", async () => {
    const ctl = planLinear();
    const h = await host(ctl);
    const before = planFile(h);
    // Linear moves ENG-2 (due Dec 3) while ENG-1's write is in progress.
    ctl.onUpdate = (id) => {
      if (id === "id-ENG-1") moveEng2(ctl);
    };
    const res = await apply(h, [row("ENG-1", 1, { dueDate: "2026-12-09" }), row("ENG-2", 2, { plannedStart: "2026-12-05", basePlannedStart: null })], BATCH(1));
    expect(res.outcome?.result?.rows).toEqual([
      { key: "ENG-1", opId: ROW(1), state: "done" },
      { key: "ENG-2", opId: ROW(2), state: "failed", error: "Changed in Linear since the plan was made" },
    ]);
    expect(await starts(h)).toEqual({ "ENG-1": null, "ENG-2": null });
    expect(planFile(h)).toBe(before);
    // A Linear row changed while an earlier row was written fails the same way, with no write of its own.
    ctl.onUpdate = (id) => {
      if (id === "id-ENG-1") Object.assign(ctl.issues.get("id-ENG-2")!, { updatedAt: new Date(T0 + 12_000).toISOString() });
    };
    const base = Date.parse(ctl.issues.get("id-ENG-2")!.updatedAt);
    const next = await apply(h, [row("ENG-1", 3, { dueDate: "2026-12-10", baseUpdatedAt: T0 + 1000 }), row("ENG-2", 4, { dueDate: "2026-12-11", baseUpdatedAt: base })], BATCH(2));
    expect(next.outcome?.result?.rows?.map((r) => r.state)).toEqual(["done", "failed"]);
    expect(ctl.linear.gateCalls.filter((c) => c.op === "TicketIssueUpdate")).toHaveLength(2);
  });

  it("a start-only row interrupted before its execution read is never taken as done by Check: the live check refuses it, plan.json unchanged", async () => {
    const ctl = planLinear();
    const h = await host(ctl);
    const before = planFile(h);
    const rows = [row("ENG-2", 1, { plannedStart: "2026-12-05", basePlannedStart: null })];
    const confirm = await h.service.handle("desk", { kind: "prepare", viewerId: ME, mutation: plan(rows) });
    // The commit's live check reads once; the execution read is lost.
    let reads = 0;
    ctl.onRead = () => {
      reads += 1;
      if (reads === 2) throw new Error("socket hang up");
    };
    const lost = await h.service.handle("desk", { kind: "commit", viewerId: ME, approvalId: confirm.approval?.id ?? "", opId: BATCH(1), mutation: plan(rows) });
    expect(lost.outcome?.state).toBe("unknown");
    ctl.onRead = () => undefined;
    moveEng2(ctl);
    h.service.stop();
    const again = await host(ctl, { dir: h.dir });
    const check = await again.service.handle("desk", { kind: "commit", viewerId: ME, opId: BATCH(1), mutation: plan(rows) });
    expect(check.outcome?.result?.rows).toEqual([{ key: "ENG-2", opId: ROW(1), state: "failed", error: "Changed in Linear since the plan was made" }]);
    expect(await starts(again)).toEqual({ "ENG-1": null, "ENG-2": null });
    expect(planFile(again)).toBe(before);
  });

  it("a start-only row whose start was saved before the answer was lost: Check answers done and saves nothing again", async () => {
    const ctl = planLinear();
    const h = await host(ctl);
    const rows = [row("ENG-2", 1, { plannedStart: "2026-11-25", basePlannedStart: null })];
    expect((await apply(h, rows, BATCH(1))).outcome?.state).toBe("done");
    const saved = planFile(h);
    // Linear moves on afterwards; the start already took effect under this batch.
    moveEng2(ctl);
    const check = await h.service.handle("desk", { kind: "commit", viewerId: ME, opId: BATCH(1), mutation: plan(rows) });
    expect(check.outcome?.result?.rows).toEqual([{ key: "ENG-2", opId: ROW(1), state: "done" }]);
    expect(planFile(h)).toBe(saved);
    expect(await starts(h)).toMatchObject({ "ENG-2": "2026-11-25" });
  });
});
