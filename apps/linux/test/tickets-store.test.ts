import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PrThreadComment } from "../src/tickets/attention";
import { toEntry } from "../src/tickets/linear-sync";
import { MAX_STORED_ENTRY_BYTES, TicketsStore } from "../src/tickets/store";
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
    s.store.setPr({ ref: { repo: "acme/app", number: 1 }, fingerprint: "f", noAccess: false, input: { facts, comments, viewerIsAuthor: false, viewerRequested: false, viewerReviewedHead: false, relayAutoMergeDisarmed: false } });
    s.store.save();
    const kept = s.store.pr({ repo: "acme/app", number: 1 });
    expect(bytes(kept)).toBeLessThanOrEqual(MAX_STORED_ENTRY_BYTES);
    expect(kept?.input?.comments.at(-1)?.id).toBe("pc-299");
    expect(s.file()).not.toContain("eyJsecret");
  });
});
