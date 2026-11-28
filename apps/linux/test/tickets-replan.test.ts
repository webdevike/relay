// Ask Astra to re-plan (PLAN T7.3) on a fake agents bridge: the real AstraSessions launches a fake
// omp (no herdr, no omp, no claude), the test plays Astra's answer, and the Replanner validates it.
// Nothing reaches Linear: the replanner has no writer at all.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentSession, TicketBoardFacts } from "@relay/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchOptions } from "../src/agents/herdr";
import { ASK_MARK, AstraSessions, ITEM_SESSION_TOOLS } from "../src/reviews/astra";
import { systemClock } from "../src/session";
import { UNREADABLE_PLAN } from "../src/tickets/plan";
import { proposalOf, Replanner, replanUrl, timelineSeed } from "../src/tickets/replan";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tickets-replan-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const T0 = Date.parse("2026-11-20T10:00:00.000Z");
const URL = "relay://timeline/project-1/ms-1";

function ticket(key: string, milestone: string, over: Partial<TicketBoardFacts> = {}): TicketBoardFacts {
  return {
    key,
    title: `Ticket ${key}`,
    priority: 2,
    prioritySortOrder: 10,
    dueDate: "2026-12-01",
    startedAt: null,
    updatedAt: T0,
    project: { id: "project-1", name: "Board", targetDate: "2026-12-18" },
    milestone: { id: milestone, name: milestone === "ms-1" ? "Beta" : "Later", targetDate: "2026-12-18", sortOrder: 1 },
    ...over,
  } as TicketBoardFacts;
}

function home(): string {
  const root = join(dir, "home");
  mkdirSync(join(root, ".omp", "assistant", "agents", "astra"), { recursive: true });
  writeFileSync(join(root, ".omp", "assistant", "agents", "astra", "prime.md"), "You are astra.");
  writeFileSync(join(root, ".omp", "assistant", "agents.json"), JSON.stringify({ agents: [{ id: "astra", title: "Astra" }] }));
  return root;
}

const live = (id: string): AgentSession => ({ id, provider: "omp", title: "x", projectPath: "/eva", status: "idle", lastActivity: "", lastActivityAt: 0, canRespond: true });

/** The Timeline's sessions on a fake bridge; `answer(text)` plays Astra's finished reply. */
function setup() {
  const launches: LaunchOptions[] = [];
  const joins: ((id: string) => void)[] = [];
  const sessions: AgentSession[] = [];
  let rows: AgentMessage[] = [];
  let replanner: Replanner | null = null;
  const astra = new AstraSessions({
    agents: {
      sessions,
      conversation: () => Promise.resolve(rows),
      reply: () => Promise.resolve(),
      configure: () => Promise.resolve(),
    },
    launch: (options) => {
      launches.push(options);
      const { promise, resolve } = Promise.withResolvers<string>();
      joins.push(resolve);
      return Promise.resolve({ joined: promise });
    },
    sessionFile: () => null,
    agentHome: home(),
    socketPath: "/tmp/test-agents.sock",
    storePath: join(dir, "tickets", "astra.json"),
    emit: (item) => replanner?.observe(item),
    clock: systemClock,
    log: () => undefined,
    seed: timelineSeed,
    readOnly: true,
  });
  replanner = new Replanner({ sessions: astra, clock: systemClock, pollMs: 5, timeoutMs: 5_000 });
  const answer = async (text: string): Promise<void> => {
    await vi.waitFor(() => {
      expect(launches).toHaveLength(1);
    });
    rows = [
      { id: "u1", role: "user", text: launches[0]?.prompt ?? "", at: T0 },
      { id: "a1", role: "assistant", text, at: T0 + 1 },
    ];
    sessions.push(live("s1"));
    joins[0]?.("s1");
  };
  return { replanner, astra, launches, answer };
}

const fenced = (o: unknown): string => `Here is the plan.\n\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\`\n`;
const change = (key: string, over: Record<string, unknown> = {}) => ({ key, dueDate: "2026-12-09", reason: "fits the release", ...over });
const op = { kind: "replan", projectId: "project-1", milestoneId: "ms-1" } as const;

describe("replan", () => {
  it("asks Astra in a private read-only session for the milestone and answers her validated proposal", async () => {
    const t = setup();
    const board = [ticket("ENG-1", "ms-1"), ticket("ENG-2", "ms-1", { priority: 1 }), ticket("ENG-3", "ms-2")];
    const res = t.replanner.replan(op, () => board);
    await t.answer(fenced({ summary: "Ship Beta by the 18th", changes: [change("ENG-1", { priority: 1, prioritySortOrder: 5 }), change("ENG-2")] }));
    expect(await res).toEqual({
      ok: true,
      proposal: { summary: "Ship Beta by the 18th", changes: [change("ENG-1", { priority: 1, prioritySortOrder: 5 }), change("ENG-2")] },
    });

    const launch = t.launches[0];
    expect(launch?.label).toBe("Astra · Timeline: Board / Beta");
    expect(launch?.ompArgs).toContain(`--tools=${ITEM_SESSION_TOOLS}`);
    expect(launch?.env).toMatchObject({ LINEAR_API_KEY: "", GH_TOKEN: "", GITHUB_TOKEN: "" });
    const prompt = launch?.prompt ?? "";
    expect(prompt.startsWith("You are astra.")).toBe(true);
    expect(prompt).toContain(URL);
    expect(prompt).toContain("- ENG-1: Ticket ENG-1 (priority 2, order 10, due 2026-12-01, planned start none, updated 2026-11-20T10:00:00.000Z)");
    expect(prompt).toContain("ENG-2");
    expect(prompt).not.toContain("ENG-3");
    expect(prompt.slice(prompt.lastIndexOf(ASK_MARK))).toContain("fenced ```json block");
    // Astra's own session for this scope, under the bare url (her store key).
    const store = JSON.parse(readFileSync(join(dir, "tickets", "astra.json"), "utf8")) as Record<string, { sessionId: string | null; readOnly?: boolean }>;
    expect(store[URL]).toMatchObject({ sessionId: "s1", readOnly: true });
    expect(await t.astra.snapshot(URL)).toMatchObject({ url: URL, sessionId: "s1" });
    t.replanner.stop();
  });

  it("drops keys outside the milestone at the baseline and impossible dates", async () => {
    const t = setup();
    const res = t.replanner.replan(op, () => [ticket("ENG-1", "ms-1"), ticket("ENG-3", "ms-2")]);
    await t.answer(fenced({ summary: "s", changes: [change("ENG-1"), change("ENG-3"), change("ENG-99"), change("ENG-1", { dueDate: "2026-02-30" })] }));
    const out = await res;
    expect(out.ok && out.proposal?.changes.map((c) => c.key)).toEqual(["ENG-1"]);
    t.replanner.stop();
  });

  it("marks a row stale when its ticket changed while Astra thought", async () => {
    const t = setup();
    const board = [ticket("ENG-1", "ms-1"), ticket("ENG-2", "ms-1")];
    const res = t.replanner.replan(op, () => board);
    board[1] = ticket("ENG-2", "ms-1", { updatedAt: T0 + 60_000 });
    await t.answer(fenced({ summary: "s", changes: [change("ENG-1"), change("ENG-2")] }));
    const out = await res;
    expect(out.proposal?.stale).toEqual(["ENG-2"]);
    expect(out.proposal?.changes.map((c) => c.key)).toEqual(["ENG-1", "ENG-2"]);
    t.replanner.stop();
  });

  it("refuses an answer that isn't a plan", async () => {
    for (const text of ["I'd move everything up a week.", "```json\n{\"summary\": \"s\", \"changes\": [{\"key\": \"ENG-1\", \"priority\": 7, \"reason\": \"r\"}]}\n```"]) {
      rmSync(join(dir, "tickets"), { recursive: true, force: true });
      const t = setup();
      const res = t.replanner.replan(op, () => [ticket("ENG-1", "ms-1")]);
      await t.answer(text);
      expect(await res).toEqual({ ok: false, refused: { code: "invalid", message: UNREADABLE_PLAN } });
      t.replanner.stop();
    }
  });

  it("answers why when the scope has no tickets, and keeps one re-plan per scope at a time", async () => {
    const t = setup();
    expect(await t.replanner.replan({ kind: "replan", projectId: "project-9" }, () => [ticket("ENG-1", "ms-1")])).toEqual({ ok: false, error: "No tickets of this milestone are on the board" });
    const first = t.replanner.replan(op, () => [ticket("ENG-1", "ms-1")]);
    await vi.waitFor(() => {
      expect(t.launches).toHaveLength(1);
    });
    expect(await t.replanner.replan(op, () => [ticket("ENG-1", "ms-1")])).toEqual({ ok: false, error: "Astra is still re-planning this" });
    await t.answer(fenced({ summary: "s", changes: [] }));
    expect(await first).toEqual({ ok: true, proposal: { summary: "s", changes: [] } });
    t.replanner.stop();
  });

  it("reads the last fenced JSON block, else the whole answer", () => {
    expect(proposalOf("```json\n{\"a\":1}\n```\nthen\n```json\n{\"a\":2}\n```")).toEqual({ a: 2 });
    expect(proposalOf("```\n{\"a\":3}\n```")).toEqual({ a: 3 });
    expect(proposalOf("{\"a\":4}")).toEqual({ a: 4 });
    expect(proposalOf("no plan")).toBeNull();
    expect(replanUrl("p 1")).toBe("relay://timeline/p%201");
  });
});
