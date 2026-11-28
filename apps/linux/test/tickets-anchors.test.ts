import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnchorStore } from "../src/tickets/anchors";
import { FakeLinear, T0, ticketsHarness } from "./tickets-fakes";

const OP_ID = "00000000-0000-4000-8000-000000000000";
const anchor = { prefix: "Theflow,as", suffix: "andagain" };

describe("AnchorStore", () => {
  it("keeps an anchor across restarts and attaches it only to quoted comments", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-anchors-"));
    new AnchorStore(dir, () => T0).set("c-1", anchor);
    const again = new AnchorStore(dir, () => T0);
    expect(again.get("c-1")).toEqual(anchor);
    const base = { parentId: null, documentContentId: "doc", author: null, body: "b", at: T0, editedAt: null, resolvedAt: null, resolvingUser: null, reactions: [], url: "https://linear.app/x" };
    const [quoted, plain] = again.attach([
      { ...base, id: "c-1", quotedText: "drawn" },
      { ...base, id: "c-2", quotedText: null },
    ]);
    expect(quoted?.anchor).toEqual(anchor);
    expect(plain).not.toHaveProperty("anchor");
  });

  it("drops the oldest past the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-anchors-"));
    let now = T0;
    const store = new AnchorStore(dir, () => now, 3);
    for (let i = 0; i <= 3; i += 1) {
      now += 1;
      store.set(`c-${String(i)}`, anchor);
    }
    expect(store.get("c-0")).toBeNull();
    expect(store.get("c-3")).toEqual(anchor);
    expect(new AnchorStore(dir, () => now).get("c-1")).toEqual(anchor);
  });
});

describe("inline comments through the service", () => {
  it("a committed inline comment keeps its context; the ticket page carries it back", async () => {
    const linear = new FakeLinear();
    linear.add("ENG-1", T0 - 60_000);
    const node = linear.members.get("ENG-1")! as { comments: { nodes: Record<string, unknown>[] } };
    node.comments.nodes.push({ ...node.comments.nodes[0], id: OP_ID, quotedText: "drawn", documentContentId: "doc-template" });
    const h = ticketsHarness({ linear, writes: true });
    h.service.start();
    await h.settled();
    const mutation = { kind: "comment" as const, issueId: "id-ENG-1", documentContentId: "doc-template", quotedText: "drawn", anchor, body: "Why?" };
    const res = await h.service.handle("desk", { kind: "commit", approvalId: "approval-1", opId: OP_ID, mutation });
    expect(res.outcome?.state).toBe("done");
    expect(JSON.parse(readFileSync(join(h.dir, "anchors.json"), "utf8"))).toMatchObject({ v: 1, anchors: { [OP_ID]: anchor } });
    const page = await h.service.handle("desk", { kind: "ticket", key: "ENG-1" });
    expect(page.ticket?.comments.find((c) => c.id === OP_ID)?.anchor).toEqual(anchor);
    expect(page.ticket?.comments.find((c) => c.id === "comment-1")).not.toHaveProperty("anchor");
  });

  it("a refused or anchorless commit keeps nothing", async () => {
    const h = ticketsHarness({ writes: true });
    h.gate.commit.mockResolvedValueOnce({ ok: false, refused: { code: "writesOff", message: "off" } } as never);
    await h.service.handle("desk", { kind: "commit", opId: OP_ID, mutation: { kind: "comment", issueId: "i", quotedText: "q", anchor, body: "b" } });
    await h.service.handle("desk", { kind: "commit", opId: OP_ID, mutation: { kind: "comment", issueId: "i", body: "b" } });
    expect(new AnchorStore(h.dir, () => T0).get(OP_ID)).toBeNull();
  });
});
