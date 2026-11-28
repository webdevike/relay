import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_TICKETS, type TicketBoardFacts, type TicketsStatus, type TicketTeam } from "@relay/protocol";
import type { PrThreadComment } from "../src/tickets/attention";
import { toEntry } from "../src/tickets/linear-sync";
import { boundTeams, MAX_BOARD_FRAME_BYTES, MAX_CARD_BYTES, MAX_STORED_ENTRY_BYTES, TicketsStore, type IssueEntry } from "../src/tickets/store";
import { issueNode, T0 } from "./tickets-fakes";

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");
const store = (): { store: TicketsStore; file: () => string } => {
  const dir = mkdtempSync(join(tmpdir(), "relay-tickets-store-"));
  return { store: new TicketsStore(dir, () => T0), file: () => readFileSync(join(dir, "tickets.json"), "utf8") };
};
const JWT = "https://private-user-images.githubusercontent.com/1/a.png?jwt=eyJsecret";

describe("tickets cache byte caps (serialized, both providers)", () => {
  it("holds a populated issue (long quotes, many reactions, long link lists) to the entry cap", () => {
    const users = Array.from({ length: 50 }, (_, i) => ({ id: `u-${String(i)}`, name: `Person ${String(i)}`, avatarUrl: null }));
    const comments = Array.from({ length: 50 }, (_, i) => ({
      id: `c-${String(i)}`,
      body: `${String(i)} ${"b".repeat(3000)}`,
      url: `https://linear.app/acme/issue/ENG-1#c-${String(i)}`,
      createdAt: new Date(T0 - (50 - i) * 60_000).toISOString(),
      editedAt: null,
      resolvedAt: null,
      quotedText: "q".repeat(20_000),
      documentContentId: "doc-1",
      parent: null,
      user: users[0],
      resolvingUser: null,
      reactionData: Array.from({ length: 50 }, (_, e) => ({ emoji: `e${String(e)}`, reactions: users.map((u) => ({ user: u })) })),
    }));
    const link = (i: number) => ({ id: `id-${String(i)}`, identifier: `ENG-${String(i + 10)}`, title: "t".repeat(500), state: { type: "started" } });
    const node = { ...issueNode("ENG-1", T0), comments: { nodes: comments }, children: { nodes: Array.from({ length: 200 }, (_, i) => link(i)) } };
    const s = store();
    s.store.upsert(toEntry(node as Parameters<typeof toEntry>[0], "user-me"));
    s.store.save();
    const kept = s.store.issue("ENG-1");
    expect(bytes(kept)).toBeLessThanOrEqual(MAX_STORED_ENTRY_BYTES);
    expect(kept?.comments.at(-1)?.id).toBe("c-49");
    expect(kept?.clipped?.comments).toBeGreaterThan(0);
    expect(Buffer.byteLength(s.file(), "utf8")).toBeLessThan(MAX_STORED_ENTRY_BYTES + 4096);
  });

  it("holds a PR with hundreds of long comment bodies to the entry cap, newest kept, media made safe", () => {
    const comments: PrThreadComment[] = Array.from({ length: 300 }, (_, i) => ({ id: `pc-${String(i)}`, rootId: "conversation", kind: "conversation", author: "octo", body: `![s](${JWT}) ${"x".repeat(20_000)}`, at: T0 + i, viewerReacted: false }));
    const facts = { repo: "acme/app", number: 1, title: "PR", url: "https://github.com/acme/app/pull/1", author: "octo", state: "open" as const, draft: false, checks: { state: "pass" as const, passed: 1, failed: 0, pending: 0 }, decision: null, mergeState: "CLEAN", headSha: "abc", updatedAt: T0 };
    const s = store();
    s.store.setPr({ ref: { repo: "acme/app", number: 1 }, fingerprint: "f", noAccess: false, input: { facts, comments, viewerIsAuthor: false, viewerRequested: false, viewerReviewedHead: false } });
    s.store.save();
    const kept = s.store.pr({ repo: "acme/app", number: 1 });
    expect(bytes(kept)).toBeLessThanOrEqual(MAX_STORED_ENTRY_BYTES);
    expect(kept?.input?.comments.at(-1)?.id).toBe("pc-299");
    expect(s.file()).not.toContain("eyJsecret");
  });

  it("holds a metadata-heavy issue with no comments (500-unit Unicode and escaped titles) to 65,536 bytes serialized", () => {
    for (const unit of ["😀".repeat(250), "\u0001".repeat(500), "é".repeat(500)]) {
      const link = (i: number) => ({ id: `id-${String(i)}`, identifier: `ENG-${String(i + 10)}`, title: unit });
      const node = {
        ...issueNode("ENG-1", T0),
        title: unit,
        description: unit.repeat(20),
        comments: { nodes: [] },
        labels: { nodes: Array.from({ length: 50 }, (_, i) => ({ id: `l-${String(i)}`, name: unit, color: "#fff" })) },
        children: { nodes: Array.from({ length: 200 }, (_, i) => ({ ...link(i), state: { type: "started" } })) },
        relations: { nodes: Array.from({ length: 100 }, (_, i) => ({ type: "related", relatedIssue: link(i + 300) })) },
        inverseRelations: { nodes: Array.from({ length: 100 }, (_, i) => ({ type: "blocks", issue: link(i + 600) })) },
      };
      const s = store();
      s.store.upsert(toEntry(node as unknown as Parameters<typeof toEntry>[0], "user-me"));
      s.store.save();
      expect(bytes(s.store.issue("ENG-1"))).toBeLessThanOrEqual(65_536);
      const file = JSON.parse(s.file()) as { issues: Record<string, unknown> };
      expect(bytes(file.issues["ENG-1"])).toBeLessThanOrEqual(65_536);
    }
  });

  it("bounds every card and the whole snapshot and delta frames of a maximum board", () => {
    // Control characters escape to six bytes each: the worst case for every free-text field.
    const texts = new Map<number, string>();
    const x = (n: number): string => texts.get(n) ?? (texts.set(n, "\u0001".repeat(n)).get(n) as string);
    const actor = { id: "u-1", name: x(500), avatarUrl: null };
    const link = (i: number) => ({ id: `id-${String(i)}`, key: `ENG-${String(i + 1000)}`, title: x(500) });
    const pr = (i: number) => ({ repo: "acme/app", number: i + 1, title: x(500), url: `https://github.com/acme/app/pull/${String(i + 1)}`, author: "octo", state: "open" as const, draft: false, checks: { state: "pass" as const, passed: 1, failed: 0, pending: 0 }, decision: null, mergeState: "CLEAN", headSha: "a".repeat(40), updatedAt: T0 });
    const waiting = (i: number) => ({ provider: "linear" as const, itemId: "ENG-1", rootId: `r-${String(i)}`, commentId: `c-${String(i)}`, author: actor, at: T0, excerpt: x(500), count: 1, anchor: { kind: "inline" as const, documentContentId: "doc-1", quotedText: x(20_000) } });
    const heavy = (e: IssueEntry): TicketBoardFacts => {
      const { description: _d, ...ticket } = e.ticket;
      return {
        ...ticket,
        title: x(500),
        state: { ...ticket.state, name: x(500) },
        assignee: actor,
        creator: actor,
        labels: Array.from({ length: 50 }, (_, i) => ({ id: `l-${String(i)}`, name: x(500), color: "#fff" })),
        project: { id: "p-1", name: x(500), targetDate: null },
        milestone: { id: "m-1", name: x(500), targetDate: null, sortOrder: 1 },
        parent: link(0),
        children: Array.from({ length: 200 }, (_, i) => ({ ...link(i), done: false })),
        relations: Array.from({ length: 200 }, (_, i) => ({ ...link(i), kind: "related" as const })),
        prFacts: Array.from({ length: 20 }, (_, i) => pr(i)),
        attention: { waiting: Array.from({ length: 50 }, (_, i) => waiting(i)), needsYou: { kind: "waiting", text: x(2000), action: { kind: "reply", label: x(200) }, evidence: x(200) } },
      };
    };
    const s = store();
    for (let i = 1; i <= MAX_TICKETS; i++) s.store.upsert(toEntry(issueNode(`ENG-${String(i)}`, T0 - i) as unknown as Parameters<typeof toEntry>[0], "user-me"));
    const err = x(2000);
    const status: TicketsStatus = {
      identity: { linear: { viewerId: "u-1", name: x(500), email: "a@b.c", org: x(500) }, github: { login: "octo" } },
      features: { tickets: true, writes: true },
      freshness: { lastSyncAt: T0, lastError: err, state: "idle" },
      errors: { linear: err, github: err },
      budget: { linear: { remaining: 1, resetAt: T0, backoffUntil: null }, github: { remaining: 1, resetAt: T0, backoffUntil: null } },
    };
    const delta = s.store.publish(heavy, new Set());
    expect(delta?.upserts).toHaveLength(MAX_TICKETS);
    for (const card of delta?.upserts ?? []) expect(bytes(card)).toBeLessThanOrEqual(MAX_CARD_BYTES);
    expect(bytes({ t: "tickets.delta", ...delta, status })).toBeLessThanOrEqual(MAX_BOARD_FRAME_BYTES);
    const state = (i: number) => ({ id: `s-${String(i)}`, name: x(500), type: "started" as const, color: "#fff", position: i });
    const teams: TicketTeam[] = Array.from({ length: 20 }, (_, t) => ({ id: `t-${String(t)}`, key: `T${String(t)}`, states: Array.from({ length: 60 }, (_, i) => state(i)) }));
    const snapshot = { t: "tickets.snapshot", rev: s.store.rev, board: { tickets: s.store.board(), teams: boundTeams(teams) }, status };
    expect(bytes(snapshot)).toBeLessThanOrEqual(MAX_BOARD_FRAME_BYTES);
    expect(snapshot.board.teams.length).toBeGreaterThan(0);
    // A card keeps what fits: its waiting mentions and key facts, not every link.
    expect(delta?.upserts[0]?.attention.waiting.length).toBeGreaterThan(0);
  }, 30_000);
});
