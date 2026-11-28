// Ask Astra to re-plan (PLAN T7.3): `replan {projectId, milestoneId?}` asks Astra in a private,
// read-only item session (`relay://timeline/<projectId>[/<milestoneId>]`, the existing
// AstraSessions with ITEM_SESSION_TOOLS and no provider credentials) to propose due dates,
// priorities and orders for the milestone's tickets as one fenced JSON block. Her answer is checked
// by `validateProposal` against the tickets as they were when Isaac asked; nothing is written
// anywhere: Apply on the device stays the gate's confirmed `applyPlan`.

import type { AstraItem, TicketBoardFacts, TicketsOp, TicketsResult } from "@relay/protocol";
import { ASK_MARK, ITEM_SESSION_TOOLS, type AstraSessions, type seedPrompt } from "../reviews/astra";
import type { SessionClock } from "../session";
import { UNREADABLE_PLAN, validateProposal } from "./plan";

/** The assistant every re-plan asks. */
export const REPLAN_AGENT = "astra";
/** The device gives up at 120 s; the host answers before that. */
export const REPLAN_TIMEOUT_MS = 110_000;
/** How often a running re-plan looks at Astra's session for her answer. */
export const REPLAN_POLL_MS = 2_000;

type Answer = Omit<TicketsResult, "rid">;
type ReplanOp = Extract<TicketsOp, { kind: "replan" }>;
type SeedInput = Parameters<typeof seedPrompt>[0];

/** The item session of a project's (or one milestone's) Timeline. */
export function replanUrl(projectId: string, milestoneId?: string): string {
  const milestone = milestoneId === undefined ? "" : `/${encodeURIComponent(milestoneId)}`;
  return `relay://timeline/${encodeURIComponent(projectId)}${milestone}`;
}

function inScope(op: ReplanOp): (t: TicketBoardFacts) => boolean {
  return (t) => t.project?.id === op.projectId && (op.milestoneId === undefined || t.milestone?.id === op.milestoneId);
}

/** "Timeline: Project / Milestone" from the first ticket in scope. */
function labelOf(op: ReplanOp, t: TicketBoardFacts): string {
  const project = t.project?.name ?? op.projectId;
  return op.milestoneId === undefined ? `Timeline: ${project}` : `Timeline: ${project} / ${t.milestone?.name ?? op.milestoneId}`;
}

function ticketLine(t: TicketBoardFacts): string {
  const start = t.plannedStart ?? (t.startedAt === null ? "none" : new Date(t.startedAt).toISOString().slice(0, 10));
  const parts = [`priority ${String(t.priority)}`, `order ${String(t.prioritySortOrder)}`, `due ${t.dueDate ?? "none"}`, `planned start ${start}`, `updated ${new Date(t.updatedAt).toISOString()}`];
  return `- ${t.key}: ${t.title} (${parts.join(", ")})`;
}

/** The scope's tickets as Astra reads them (her first message's item, and every later turn). */
export function ticketList(label: string, tickets: readonly TicketBoardFacts[]): string {
  return [`### ${label}: ${String(tickets.length)} tickets`, "", ...tickets.map(ticketLine)].join("\n");
}

/** What Isaac asks, with the answer's exact shape. */
export function replanQuestion(label: string): string {
  return `Re-plan ${label}: propose due dates, priorities and the order within each priority for the tickets listed above, so the milestone lands by its target date. Answer with a short reason per change and end with exactly one fenced \`\`\`json block:
{"summary": "one line", "changes": [{"key": "ENG-1", "dueDate": "YYYY-MM-DD", "start": "YYYY-MM-DD", "priority": 2, "prioritySortOrder": 10.5, "reason": "why"}]}
Only keys from the list; leave out a field you keep as it is. Priority: 1 Urgent, 2 High, 3 Medium, 4 Low, 0 None. Nothing is written: Isaac reviews your proposal in Relay and applies what he wants.`;
}

/** The first message of a Timeline session: her prime, memory, the tickets and the question. */
export function timelineSeed(o: SeedInput): string {
  const memory = o.memory === null || o.memory.trim() === "" ? "(empty)" : o.memory.trim();
  return `${o.prime}

---
This session is not your main thread. Isaac opened it from the Timeline in Relay to plan one project: ${o.label} (${o.url}). It is titled "${o.title}" and every re-plan he asks for this scope comes here. It stays private in Relay: nothing here is posted to Linear, GitHub or Slack.
- This session can only read: its tools are ${ITEM_SESSION_TOOLS.split(",").join(", ")}, and it has no Linear or GitHub credentials, so nothing you do here can change anything.
- Leave your thread memory file alone unless he asks.

## Your thread memory

${memory}

## The tickets

${o.context.trim()}${ASK_MARK}${o.question.trim()}`;
}

/** The last fenced block that parses as JSON (else the whole answer); null: none. */
export function proposalOf(answer: string): unknown {
  const blocks = [...answer.matchAll(/```[a-z]*\s*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "").reverse();
  for (const text of [...blocks, answer]) {
    try {
      return JSON.parse(text.trim()) as unknown;
    } catch {
      // the next one
    }
  }
  return null;
}

type Outcome = { ok: true; text: string } | { ok: false; error: string } | null;

/** Her finished answer, why there is none, or null while she works. */
function outcomeOf(item: AstraItem): Outcome {
  if (item.error !== null) return { ok: false, error: item.error };
  if (item.working) return null;
  if (item.waiting !== null) return { ok: false, error: item.waiting };
  const last = item.turns.at(-1);
  return last?.role === "assistant" && !last.streaming ? { ok: true, text: last.text } : null;
}

export interface ReplannerDeps {
  /** The Timeline's own AstraSessions (read-only, `timelineSeed`). */
  readonly sessions: Pick<AstraSessions, "ask" | "snapshot" | "agentName" | "stop">;
  readonly clock: SessionClock;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

/** Re-plans one scope at a time per session; the answer is validated, never written. */
export class Replanner {
  private readonly waiting = new Map<string, (item: AstraItem) => void>();

  constructor(private readonly deps: ReplannerDeps) {}

  /** The sessions' emit: a change of a session someone waits on settles it sooner than the poll. */
  observe(item: AstraItem): void {
    this.waiting.get(item.url)?.(item);
  }

  stop(): void {
    this.deps.sessions.stop();
  }

  /** `tickets`: the board now (read when asked, and again for the stale check). */
  async replan(op: ReplanOp, tickets: () => readonly TicketBoardFacts[]): Promise<Answer> {
    const scope = tickets().filter(inScope(op));
    const first = scope[0];
    if (first === undefined) return { ok: false, error: "No tickets of this milestone are on the board" };
    const url = replanUrl(op.projectId, op.milestoneId);
    if (this.waiting.has(url)) return { ok: false, error: "Astra is still re-planning this" };
    const label = labelOf(op, first);
    const at = Object.fromEntries(scope.map((t) => [t.key, t.updatedAt]));
    const list = ticketList(label, scope);
    const question = replanQuestion(label);
    const title = `${this.deps.sessions.agentName(REPLAN_AGENT)} · ${label}`;
    const answer = await this.answer(url, () => this.deps.sessions.ask(url, title, label, () => Promise.resolve(list), question, `${list}${ASK_MARK}${question}`, REPLAN_AGENT));
    const now = Object.fromEntries(tickets().map((t) => [t.key, t.updatedAt]));
    const check = validateProposal(proposalOf(answer), { at, now });
    if (!check.ok) return { ok: false, refused: { code: "invalid", message: UNREADABLE_PLAN } };
    return { ok: true, proposal: { ...check.proposal, ...(check.stale.length > 0 && { stale: check.stale }) } };
  }

  /** Asks, then waits for her finished answer (emit or poll), the session's error, or the timeout. */
  private async answer(url: string, ask: () => Promise<AstraItem>): Promise<string> {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    let stopPoll = (): void => undefined;
    let cancelTimeout = (): void => undefined;
    const finish = (): void => {
      cancelTimeout();
      stopPoll();
      this.waiting.delete(url);
    };
    const settle = (item: AstraItem): void => {
      const out = outcomeOf(item);
      if (out === null) return;
      finish();
      if (out.ok) resolve(out.text);
      else reject(new Error(out.error));
    };
    cancelTimeout = this.deps.clock.after(this.deps.timeoutMs ?? REPLAN_TIMEOUT_MS, () => {
      finish();
      reject(new Error("Astra didn't answer in time. Ask again to pick up her answer."));
    });
    this.waiting.set(url, settle);
    const poll = (): void => {
      stopPoll = this.deps.clock.after(this.deps.pollMs ?? REPLAN_POLL_MS, () => {
        // A failed read is retried on the next poll; the timeout ends the wait.
        const next = (item: AstraItem | null): void => {
          if (item !== null && this.waiting.has(url)) settle(item);
          if (this.waiting.has(url)) poll();
        };
        void this.deps.sessions.snapshot(url, REPLAN_AGENT).then(next, () => next(null));
      });
    };
    try {
      settle(await ask());
    } catch (error) {
      finish();
      throw error;
    }
    if (this.waiting.has(url)) poll();
    return promise;
  }
}
