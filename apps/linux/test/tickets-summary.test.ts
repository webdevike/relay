import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ticket, TicketComment, TicketPrFacts } from "@relay/protocol";
import { describe, expect, it, vi, type Mock } from "vitest";
import { SNAPSHOT_CHANGED, SummaryCache, snapshotKey, summaryViolation, type SummarySnapshot } from "../src/tickets/summary";

const T = Date.parse("2026-11-27T12:00:00.000Z");
const GOOD = "The board needs a summary card. Isaac settled the wording and the pull request is still a draft.";

function snap(id: string, over: { updatedAt?: number; comments?: number; head?: string } = {}): SummarySnapshot {
  const ticket = {
    id,
    key: `ENG-${id}`,
    title: "Summary card",
    description: "Write it.",
    state: { id: "s", name: "In Progress", type: "started", color: "#000" },
    priority: 2,
    assignee: null,
    project: null,
    children: [],
    relations: [],
    prs: [],
    updatedAt: over.updatedAt ?? T,
  } as unknown as Ticket;
  const comments = Array.from({ length: over.comments ?? 1 }, (_, i) => ({ id: `c${String(i)}`, author: null, body: "ok", at: T }) as unknown as TicketComment);
  const prs = [{ repo: "ecard/app", number: 7, title: "PR", state: "open", draft: true, checks: { state: "none" }, decision: null, mergeState: null, headSha: over.head ?? "abc", updatedAt: T } as unknown as TicketPrFacts];
  return { entry: { ticket, comments }, prs };
}

function cache(answers: string[] | ((prompt: string) => Promise<string>)): { c: SummaryCache; write: Mock<(prompt: string) => Promise<string>>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "relay-summary-"));
  const write = vi.fn(typeof answers === "function" ? answers : () => Promise.resolve(answers.shift() ?? GOOD));
  return { c: new SummaryCache(dir, write, () => T), write, dir };
}

describe("summary validation", () => {
  it("accepts 2-3 plain sentences and names what is wrong otherwise", () => {
    expect(summaryViolation(GOOD)).toBeNull();
    expect(summaryViolation("One sentence only.")).toMatch(/1 sentences/);
    expect(summaryViolation("It moved \u2014 fast. Then it stopped.")).toMatch(/em dash/);
    expect(summaryViolation("ENG-12 is done. Next is review.")).toMatch(/ticket ID/);
    expect(summaryViolation("See https://x.io for it. It is done.")).toMatch(/link/);
    expect(summaryViolation("It is 0b9c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b. Done.")).toMatch(/ID/);
    expect(summaryViolation(`${"word ".repeat(61)}. Done.`)).toMatch(/over 60/);
  });
});

describe("SummaryCache", () => {
  it("writes once per snapshot, again when the snapshot changes, and keys by issue id", async () => {
    const { c, write, dir } = cache([]);
    const a = snap("1");
    expect(await c.read(a, () => a)).toEqual({ text: GOOD, error: null, at: T });
    await c.read(a, () => a);
    expect(write).toHaveBeenCalledTimes(1);
    const b = snap("1", { comments: 2 });
    await c.read(b, () => b);
    const pr = snap("1", { comments: 2, head: "def" });
    await c.read(pr, () => pr);
    expect(write).toHaveBeenCalledTimes(3);
    const other = snap("2");
    expect(snapshotKey(other)).not.toBe(snapshotKey(a));
    await c.read(other, () => other);
    expect(write).toHaveBeenCalledTimes(4);
    const file = JSON.parse(readFileSync(join(dir, "summaries.json"), "utf8")) as { v: number; entries: object };
    expect(file.v).toBe(1);
    expect(Object.keys(file.entries)).toHaveLength(4);
  });

  it("dedupes concurrent reads of one snapshot", async () => {
    const gate = Promise.withResolvers<string>();
    const { c, write } = cache(() => gate.promise);
    const a = snap("1");
    const both = Promise.all([c.read(a, () => a), c.read(a, () => a)]);
    gate.resolve(GOOD);
    const [x, y] = await both;
    expect(x.text).toBe(GOOD);
    expect(y).toBe(x);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("drops an answer for a snapshot that changed meanwhile", async () => {
    const { c, write } = cache([]);
    const a = snap("1");
    const newer = snap("1", { updatedAt: T + 1 });
    expect(await c.read(a, () => newer)).toEqual({ text: null, error: SNAPSHOT_CHANGED, at: T });
    await c.read(a, () => a);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("retries once with the violation named, then answers facts only", async () => {
    const { c, write } = cache(["Too short.", GOOD]);
    const a = snap("1");
    expect((await c.read(a, () => a)).text).toBe(GOOD);
    expect(write.mock.calls[1]?.[0]).toMatch(/rejected: it was 1 sentences/);
    const bad = cache(["It went \u2014 well. Done now.", "Still \u2014 bad. Yes."]);
    expect(await bad.c.read(a, () => a)).toMatchObject({ text: null, error: expect.stringMatching(/em dash/) });
    expect(bad.write).toHaveBeenCalledTimes(2);
    await bad.c.read(a, () => a);
    expect(bad.write).toHaveBeenCalledTimes(3);
  });

  it("answers the writer's failure as an error", async () => {
    const { c } = cache(() => Promise.reject(new Error("claude exited 127")));
    const a = snap("1");
    expect(await c.read(a, () => a)).toEqual({ text: null, error: "claude exited 127", at: T });
  });
});
