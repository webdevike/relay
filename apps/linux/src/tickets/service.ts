// Tickets on the host (PLAN T0.3, §2.8, §2.9): Isaac's Linear issues and their PRs, synced under the
// shared provider budgets by the tickets sync machine, kept in a revisioned store, with Attention
// worked out per card and every write through the MutationGate. Only built when host.json has
// `features.tickets: true`; `writes` only with `features.ticketsWrites: true` and no dry run.
//
// `handle(deviceId, op)` answers every `tickets.req`. Pushes (`tickets.snapshot`, `tickets.delta`,
// `tickets.status`) go through `onPush`, which the server sends only to sockets that subscribed.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_TICKET_COMMENTS, TERMINAL_TICKET_STATE_TYPES, type Attention, type PrMutation, type ServerMessage, type TicketBoardFacts, type TicketComment, type TicketDetail, type TicketMutation, type TicketOutcome, type TicketPlanRow, type TicketsBoard, type TicketsOp, type TicketsResult, type TicketsStatus } from "@relay/protocol";
import { ticketsFeatures, type HostConfig } from "../host-config";
import { AstraSessions, type AstraSessionsDeps } from "../reviews/astra";
import type { ToolRun } from "../reviews/exec";
import { ghCall, ghGraphql, type GhGraphql } from "../reviews/github";
import { githubExecutor, StaleGithubCredential } from "../reviews/github-writes";
import { PrGate, type GithubPin, type PrCommitRequest } from "../reviews/pr-gate";
import { linearGql, type Fetch, type LinearGql } from "../reviews/linear";
import type { TicketsRelaying } from "../seams";
import { ticketsSyncActor, type TicketsSyncActor, type TicketsSyncOptions } from "./actor";
import { AnchorStore } from "./anchors";
import { applyHandled, attentionOf, type AttentionMe } from "./attention";
import { providerBudgets, RateLimited, type Budgets } from "./budget";
import { HostError, ProviderRejected, publicError, StaleCredential } from "./errors";
import { MutationGate, type GatePin } from "./gate";
import { GithubSync, prInputs } from "./github-sync";
import { identityChanged, NO_IDENTITY, resolveIdentity, type HostIdentity } from "./identity";
import { LinearSync, type LinearViewer } from "./linear-sync";
import { linearExecutor, startsSaveCheck } from "./linear-writes";
import { planFreshness, PlanStore, START_MOVED, type LiveIssue, type StartRow } from "./plan";
import { Replanner, timelineSeed } from "./replan";
import { boundComments, boundTeams, clipBytes, fitLists, HandledStore, jsonBytes, newestFitting, SeenStore, TicketsStore, WORST_CLIPPED, type IssueEntry } from "./store";
import { SummaryCache, type SummarySnapshot, type SummaryWriter } from "./summary";
import type { IdentifyOutput, LinearStepOutput } from "./sync.machine";

export type TicketsPush = Extract<ServerMessage, { t: "tickets.snapshot" | "tickets.delta" | "tickets.status" }>;
type Answer = Omit<TicketsResult, "rid">;
type Op<K extends TicketsOp["kind"]> = Extract<TicketsOp, { kind: K }>;

/** The gate as the service uses it (MutationGate; a stub in tests). */
export type TicketsGate = Pick<MutationGate, "prepare" | "commit" | "invalidate">;

export interface TicketsServiceDeps {
  /** `$XDG_CONFIG_HOME/relay/tickets`: tickets.json, handled.json, seen.json, ops.json. */
  readonly dir: string;
  /** Linear's GraphQL for the sync's reads (the host's key, re-read per call; background lane). */
  readonly gql: LinearGql;
  /** The host's Linear key now. */
  readonly linearKey: () => string | null;
  /** Linear's GraphQL with exactly this key (identity and writes pin one key per op; interactive lane). */
  readonly keyedGql: (key: string) => LinearGql;
  /** GitHub's GraphQL through gh, through `budgets.github`. */
  readonly ghGraphql: GhGraphql;
  /** gh's login; null when gh is signed out. */
  readonly ghLogin: () => Promise<string | null>;
  readonly budgets: Budgets;
  /** host.json features.ticketsWrites and no RELAY_REVIEWS_DRY_RUN. */
  readonly writes: boolean;
  readonly now: () => number;
  readonly log: (line: string) => void;
  /** xstate clock and timing for the sync machine (tests). */
  readonly sync?: Pick<TicketsSyncOptions, "clock" | "timing">;
  /** Test seam; default: MutationGate over linearExecutor. */
  readonly gate?: TicketsGate;
  /** Writes ticket summaries (`claudeWriter`); absent: `summary` answers an error. */
  readonly summaryWriter?: SummaryWriter;
  /** gh for PR writes (reviews `prPrepare`/`prCommit`); absent: the gate refuses them. */
  readonly ghWrites?: GhWrites;
  /** Astra's re-plans (a private read-only item session); absent: `replan` answers an error. */
  readonly replanner?: Pick<Replanner, "replan" | "stop">;
}

export interface GhWrites {
  readonly run: ToolRun;
  readonly gh: string;
}

const PR_WRITES_OFF: Answer = { ok: false, refused: { code: "writesOff", message: "Writing to GitHub is off on this host" } };
const NO_ATTENTION: Attention = { waiting: [], needsYou: null };
const clip = (s: string | null): string | null => (s === null ? null : s.slice(0, 2000));
const text = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** A key is compared by its hash; the key itself is never kept. */
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
/** A plan row with no Linear field: its only effect is its Relay start. */
const startOnlyRow = (r: TicketPlanRow): boolean => r.plannedStart !== undefined && r.dueDate === undefined && r.priority === undefined && r.prioritySortOrder === undefined;
/** A ticket page's description (UTF-8 bytes), each comment body and all comment bodies, before the frame cap. */
const MAX_DETAIL_DESCRIPTION_BYTES = 256 * 1024;
const MAX_DETAIL_COMMENT_BYTES = 64 * 1024;
const MAX_DETAIL_COMMENTS_BYTES = 768 * 1024;
/** The whole `tickets.res` frame carrying a ticket page, serialized: the hard limit. */
export const MAX_DETAIL_FRAME_BYTES = 1024 * 1024;
/** The largest envelope around a page (`rid` at its 64-character maximum). */
const DETAIL_ENVELOPE = { t: "tickets.res", rid: "r".repeat(64), ok: true } as const;
/** `gh auth token` reads gh's own config: no network. */
const GH_TOKEN_TIMEOUT_MS = 10_000;

export class TicketsService implements TicketsRelaying {
  readonly writes: boolean;
  /** The server's sender to subscribed sockets; null drops pushes. */
  onPush: ((message: TicketsPush) => void) | null = null;
  private readonly store: TicketsStore;
  private readonly handled: HandledStore;
  private readonly seen: SeenStore;
  private readonly anchors: AnchorStore;
  private readonly plan: PlanStore;
  /** Relay starts a running plan commit holds (`viewerId issueId` -> its batch opId). */
  private readonly startHolds = new Map<string, string>();
  private readonly linear: LinearSync;
  private readonly github: GithubSync;
  private readonly gate: TicketsGate;
  /** GitHub PR writes (reviews `prPrepare`/`prCommit`); null without `ghWrites`. */
  private readonly prGate: PrGate | null;
  private readonly actor: TicketsSyncActor;
  private readonly summaries: SummaryCache | null;
  private linearNames: readonly string[] = [];
  private errors: TicketsStatus["errors"] = { linear: null, github: null };
  /** The account changed (or was never confirmed this run): writes wait for a full cycle. */
  private verified = false;
  /** SHA-256 of the key the last identity resolution used; writes pin exactly that key. */
  private keyHash: string | null = null;
  /** Moves on every account or key change: approvals and in-flight writes of an older one stop. */
  private generation = 0;
  /** The identity a detected change moves to, applied by the wipe. */
  private pending: HostIdentity | null = null;
  private readonly watches = new Map<string, { keys: readonly string[]; until: number }>();
  private lastStatus = "";
  private lastState = "";

  constructor(private readonly deps: TicketsServiceDeps) {
    this.writes = deps.writes;
    this.store = new TicketsStore(deps.dir, deps.now);
    this.handled = new HandledStore(deps.dir);
    this.summaries = deps.summaryWriter === undefined ? null : new SummaryCache(deps.dir, deps.summaryWriter, deps.now);
    this.seen = new SeenStore(deps.dir);
    this.anchors = new AnchorStore(deps.dir, deps.now);
    this.plan = new PlanStore(deps.dir);
    this.linear = new LinearSync({ gql: deps.gql, store: this.store, now: deps.now });
    this.github = new GithubSync(deps.ghGraphql, this.store);
    this.gate =
      deps.gate ??
      new MutationGate({
        dir: deps.dir,
        writesEnabled: () => deps.writes,
        pin: () => this.pin(),
        current: (pin) => this.current(pin),
        now: deps.now,
        log: deps.log,
      });
    this.prGate =
      deps.ghWrites === undefined
        ? null
        : new PrGate({ dir: deps.dir, writesEnabled: () => deps.writes, pin: () => this.ghPin(), current: (pin) => this.ghCurrent(pin), now: deps.now, log: deps.log });
    this.actor = ticketsSyncActor({
      steps: {
        identify: () => this.identify(),
        linear: (signal) => this.linearStep(signal),
        github: (signal) => this.githubStep(signal),
        reconcile: (signal) => this.reconcileStep(signal),
        wipe: () => this.wipe(),
      },
      ...deps.sync,
    });
    this.actor.subscribe(() => {
      this.onTransition();
    });
    // What devices get first: the stored cards as the next rev (later reads answer it as is).
    this.publish();
  }

  start(): void {
    this.actor.start();
  }

  stop(): void {
    this.actor.stop();
    this.deps.replanner?.stop();
  }

  /** Never rejects: a failure is `{ ok: false, error }`. */
  async handle(deviceId: string, op: TicketsOp): Promise<Answer> {
    try {
      return await this.run(deviceId, op);
    } catch (error) {
      return { ok: false, error: publicError(error).slice(0, 2000) };
    }
  }

  private run(deviceId: string, op: TicketsOp): Promise<Answer> {
    const ops: { [K in TicketsOp["kind"]]: (op: Op<K>) => Promise<Answer> | Answer } = {
      board: () => this.boardAnswer(),
      subscribe: (o) => (o.on ? this.boardAnswer() : { ok: true }),
      ticket: (o) => this.detail(o.key),
      watch: (o) => this.watch(deviceId, o),
      sync: () => {
        this.actor.send({ type: "sync.now" });
        return { ok: true, status: this.status() };
      },
      seen: (o) => ({ ok: true, previousSeenAt: this.seen.visit(o.key, this.deps.now()) }),
      handled: (o) => this.markHandled(o),
      prepare: (o) => this.prepare(deviceId, o),
      commit: (o) => this.commit(deviceId, o),
      summary: (o) => this.summary(o.key),
      replan: (o) => (this.deps.replanner === undefined ? { ok: false, error: "Astra is not available on this host" } : this.deps.replanner.replan(o, { tickets: () => this.board().tickets, live: (ids) => this.liveIssues(ids), viewerId: this.me().linearViewerId })),
    };
    const answer = (ops[op.kind] as (o: TicketsOp) => Promise<Answer> | Answer)(op);
    return Promise.resolve(answer);
  }

  // ---- Answers ----

  status(): TicketsStatus {
    const snap = this.actor.getSnapshot();
    return {
      identity: this.store.sync.identity ?? NO_IDENTITY,
      features: { tickets: true, writes: this.writes },
      freshness: { lastSyncAt: this.store.sync.lastSyncAt, lastError: clip(snap.context.lastError ?? this.errors.linear), state: this.stateName() },
      errors: { linear: clip(this.errors.linear), github: clip(this.errors.github) },
      budget: { linear: this.deps.budgets.linear.facts(), github: this.deps.budgets.github.facts() },
    };
  }

  private stateName(): TicketsStatus["freshness"]["state"] {
    const value = this.actor.getSnapshot().value;
    return (typeof value === "string" ? value : Object.keys(value)[0]) as TicketsStatus["freshness"]["state"];
  }

  /** The published board at its rev: every change publishes itself, so a read does no work and no disk. */
  private boardAnswer(): Answer {
    return { ok: true, board: this.board(), rev: this.store.rev, status: this.status() };
  }

  /** The published cards (each within MAX_CARD_BYTES) and the teams within MAX_TEAMS_BYTES: a frame within MAX_BOARD_FRAME_BYTES. */
  private board(): TicketsBoard {
    return { tickets: this.store.board(), teams: boundTeams(this.store.sync.teams) };
  }

  private async summary(key: string): Promise<Answer> {
    if (this.summaries === null) return { ok: false, error: "Claude is not available on this host" };
    const snapshot = this.summarySnapshot(key);
    if (snapshot === undefined) return { ok: false, error: `${key} is not on the board` };
    const s = await this.summaries.read(snapshot, () => this.summarySnapshot(key));
    const summary = { key, text: s.text, at: s.at };
    return s.error === null ? { ok: true, summary } : { ok: false, error: s.error.slice(0, 2000), summary };
  }

  private summarySnapshot(key: string): SummarySnapshot | undefined {
    const entry = this.store.issue(key);
    return entry && { entry, prs: prInputs(this.store, entry.ticket.prs).map((p) => p.facts) };
  }

  private async detail(key: string): Promise<Answer> {
    let entry: IssueEntry | null;
    try {
      entry = await this.linear.detail(key, this.store.sync.identity?.linear?.viewerId ?? null);
    } catch (error) {
      // Linear answered no (a refused key, no permission, not found): evicted below, never the stale copy.
      if (error instanceof ProviderRejected) entry = null;
      else {
        // Linear unreachable (network, 5xx, rate limit): the stored card, if any, rather than nothing.
        entry = this.store.issue(key) ?? null;
        if (entry === null) throw error;
      }
    }
    if (entry === null) {
      if (this.store.issue(key) !== undefined) this.store.tombstone(key, true);
      this.publish();
      return { ok: false, error: `${key} is not in Linear or this account can't see it` };
    }
    this.publish();
    return { ok: true, ticket: this.detailFrame(entry) };
  }

  /**
   * The ticket page whose whole `tickets.res` frame is at most MAX_DETAIL_FRAME_BYTES serialized:
   * waiting mentions halved to an eighth, lists and description halved to half, then the newest
   * comments that fit the rest; `clipped` says what was left out.
   */
  private detailFrame(entry: IssueEntry): TicketDetail {
    const description = clipBytes(entry.ticket.description, MAX_DETAIL_DESCRIPTION_BYTES);
    // Inline comments made in Relay carry where their quote sat (anchors.json), counted in the bounds.
    const bounded = this.anchors.attach(boundComments(entry.comments.slice(-MAX_TICKET_COMMENTS), MAX_DETAIL_COMMENT_BYTES, MAX_DETAIL_COMMENTS_BYTES).comments);
    const facts = this.facts(entry);
    let waiting = facts.attention.waiting;
    while (waiting.length > 0 && jsonBytes(waiting) > MAX_DETAIL_FRAME_BYTES / 8) waiting = waiting.slice(0, Math.floor(waiting.length / 2));
    const page = fitLists({ ...facts, attention: { ...facts.attention, waiting }, description, comments: [] as TicketComment[] }, MAX_DETAIL_FRAME_BYTES / 2);
    const comments = newestFitting(bounded, jsonBytes({ ...DETAIL_ENVELOPE, ticket: { ...page, clipped: WORST_CLIPPED } }), MAX_DETAIL_FRAME_BYTES);
    const clipped = { description: page.description.length < entry.ticket.description.length || entry.clipped?.description === true, comments: entry.comments.length - comments.length + (entry.clipped?.comments ?? 0) };
    const detail = { ...page, comments };
    return clipped.description || clipped.comments > 0 ? { ...detail, clipped } : detail;
  }

  private watch(deviceId: string, op: Op<"watch">): Answer {
    this.watches.set(deviceId, { keys: op.keys, until: this.deps.now() + op.ttlMs });
    if (op.keys.some((k) => this.store.issue(k) === undefined)) this.actor.send({ type: "sync.now" });
    return { ok: true };
  }

  /** Keys some device watches now; expired watches drop out. */
  private watched(): string[] {
    const now = this.deps.now();
    const keys = new Set<string>();
    for (const [device, w] of this.watches) {
      if (w.until <= now) this.watches.delete(device);
      else for (const k of w.keys) keys.add(k);
    }
    return [...keys];
  }

  private markHandled(op: Op<"handled">): Answer {
    const itemId = op.target.itemId;
    const entry = this.store.issue(itemId) ?? this.store.entries().find((e) => e.ticket.prs.some((p) => `${p.repo}#${String(p.number)}` === itemId));
    const current = entry === undefined ? NO_ATTENTION : this.facts(entry).attention;
    this.handled.set(applyHandled(this.handled.state, op.target, op.undo === true, current));
    this.publish();
    return { ok: true };
  }

  /** A confirmed write's approval; a plan made from a Relay start another device has moved since is refused. */
  private async prepare(deviceId: string, op: Op<"prepare">): Promise<Answer> {
    const answer = await this.gate.prepare({ deviceId }, op.mutation, op.viewerId);
    if (answer.approval === undefined || op.mutation.kind !== "applyPlan") return answer;
    const moved = op.mutation.rows.find((r) => (r.plannedStart !== undefined || r.basePlannedStart !== undefined) && this.plan.get(op.viewerId, r.issueId) !== (r.basePlannedStart ?? null));
    return moved === undefined ? answer : { ok: false, refused: { code: "conflict", message: `${moved.key}: ${START_MOVED}` } };
  }

  private async commit(deviceId: string, op: Op<"commit">): Promise<Answer> {
    const m = op.mutation;
    if (m.kind === "applyPlan") return this.commitPlan(deviceId, op, m.rows);
    const answer = await this.gateCommit(deviceId, op);
    if (m.kind === "comment") this.keepAnchor(m, op.opId, answer);
    return answer;
  }

  private async gateCommit(deviceId: string, op: Op<"commit">): Promise<Answer> {
    const answer = await this.gate.commit({ deviceId }, { opId: op.opId, mutation: op.mutation, ...(op.approvalId === undefined ? {} : { approvalId: op.approvalId }) }, op.viewerId);
    // The board shows the write once Linear has it (any plan row of it): one coalesced cycle.
    if (answer.outcome?.result?.rows?.some((r) => r.state === "done") ?? answer.outcome?.state === "done") this.actor.send({ type: "sync.now" });
    return answer;
  }

  /**
   * A plan's Relay starts are held for the whole commit (another batch changing one of them waits
   * its turn: refused), and a confirmed commit rechecks them before anything goes to Linear: a start
   * another device moved since the confirm refuses the plan with nothing written. A batch's own
   * saved starts (a replayed outcome) pass.
   */
  private async commitPlan(deviceId: string, op: Op<"commit">, rows: readonly TicketPlanRow[]): Promise<Answer> {
    const starts = rows.filter((r) => r.plannedStart !== undefined).map((r) => ({ row: r, hold: `${op.viewerId} ${r.issueId}` }));
    const busy = starts.find((s) => (this.startHolds.get(s.hold) ?? op.opId) !== op.opId);
    if (busy !== undefined) return { ok: false, refused: { code: "conflict", message: `${busy.row.key}: another Apply is changing its Relay start right now` } };
    const moved = op.approvalId === undefined ? undefined : rows.find((r) => this.startMoved(op.viewerId, r));
    if (moved !== undefined) return { ok: false, refused: { code: "conflict", message: `${moved.key}: ${START_MOVED}` } };
    for (const s of starts) this.startHolds.set(s.hold, op.opId);
    try {
      return await this.saveStarts(op.viewerId, rows, this.savedStarts(op.viewerId, rows, await this.gateCommit(deviceId, op)));
    } finally {
      for (const s of starts) if (this.startHolds.get(s.hold) === op.opId) this.startHolds.delete(s.hold);
    }
  }

  /** Whether another device moved this row's Relay start since its draft (its own saved start: no). */
  private startMoved(viewerId: string, r: TicketPlanRow): boolean {
    if (r.plannedStart === undefined && r.basePlannedStart === undefined) return false;
    if (this.plan.applied(viewerId, r.opId)) return false;
    const now = this.plan.get(viewerId, r.issueId);
    return now !== (r.basePlannedStart ?? null) && (r.plannedStart === undefined || now !== r.plannedStart);
  }

  /**
   * An inline comment made here keeps where its quote sat (Relay-only); a lost answer may still
   * have landed under the opId, Linear's id for it.
   */
  private keepAnchor(m: Extract<TicketMutation, { kind: "comment" }>, opId: string, answer: Answer): void {
    if (m.anchor !== undefined && answer.outcome !== undefined && answer.outcome.state !== "failed") this.anchors.set(answer.outcome.result?.id ?? opId, m.anchor);
  }

  /**
   * A start-only row's only effect is its Relay start: once this host saved it (its durable record
   * in plan.json), the row is done, whatever Linear shows now (a lost answer, a Check). Without that
   * record nothing is inferred here: the gate's live check decides it.
   */
  private savedStarts(viewerId: string, rows: readonly TicketPlanRow[], answer: Answer): Answer {
    const outcome = answer.outcome;
    const results = outcome?.result?.rows;
    const saved = new Set(rows.filter((r) => startOnlyRow(r) && this.plan.applied(viewerId, r.opId)).map((r) => r.opId));
    if (outcome === undefined || results === undefined || !results.some((o) => o.state !== "done" && saved.has(o.opId))) return answer;
    const next = results.map((o) => (saved.has(o.opId) ? { key: o.key, opId: o.opId, state: "done" as const } : o));
    const state: TicketOutcome["state"] = next.some((r) => r.state === "unknown") ? "unknown" : next.some((r) => r.state === "failed") ? "failed" : "done";
    const out: TicketOutcome = { ...outcome, state, result: { ...outcome.result, rows: next } };
    return state === "failed" ? { ok: false, error: answer.error ?? "Not every change was written", outcome: out } : { ok: true, outcome: out };
  }

  /**
   * applyPlan's Relay starts, under the same approved op: saved for each row the gate reports done
   * (a start-only row is done without a Linear write) that isn't already in plan.json's saved-start
   * record, only after a fresh Linear read still holds it up (a gate-done replay included) and while
   * its start is still the one the draft was made from; failed and unknown rows leave starts
   * untouched. A start that can't be saved turns its row failed with why, so the device never shows
   * it applied.
   */
  private async saveStarts(viewerId: string, rows: readonly TicketPlanRow[], answer: Answer): Promise<Answer> {
    const outcome = answer.outcome;
    const results = outcome?.result?.rows;
    if (outcome === undefined || results === undefined) return answer;
    const byOp = new Map(rows.map((r) => [r.opId, r]));
    const starts = results.flatMap((o): (TicketPlanRow & StartRow)[] => {
      const row = byOp.get(o.opId);
      const start = row?.plannedStart;
      return row !== undefined && start !== undefined && o.state === "done" && !this.plan.applied(viewerId, o.opId) ? [{ ...row, plannedStart: start }] : [];
    });
    const problems = await this.storeStarts(viewerId, starts);
    if (problems.size === 0) return answer;
    const next = results.map((o) => {
      const problem = problems.get(o.opId);
      const row = byOp.get(o.opId);
      const linear = row !== undefined && !startOnlyRow(row);
      return problem === undefined ? o : { ...o, state: "failed" as const, error: linear ? `Written to Linear, but ${problem}` : `Not saved: ${problem}` };
    });
    const state = next.some((r) => r.state === "unknown") ? "unknown" : "failed";
    return { ok: false, error: "Not every change was saved", outcome: { ...outcome, state, result: { ...outcome.result, rows: next } } };
  }

  /**
   * The one place a Relay start is saved: each start is checked against a fresh Linear read (its
   * issue still at the draft's revision, or still showing what the row wrote, with a valid
   * start/due pair), then against plan.json (still the draft's base), then all are saved in one
   * write; why each other one wasn't.
   */
  private async storeStarts(viewerId: string, rows: readonly (TicketPlanRow & StartRow)[]): Promise<Map<string, string>> {
    const problems = new Map<string, string>();
    if (rows.length === 0) return problems;
    const linear = await this.startsInLinear(rows);
    const ok = rows.filter((r) => {
      const problem = linear.get(r.opId) ?? this.plan.startProblem(viewerId, r);
      if (problem !== null) problems.set(r.opId, problem);
      return problem === null;
    });
    if (ok.length === 0) return problems;
    try {
      this.plan.save(viewerId, ok);
      this.publish();
    } catch (error) {
      for (const r of ok) problems.set(r.opId, `Relay couldn't save its start (${text(error)})`);
    }
    return problems;
  }

  /** Linear's verdict on each start before it is saved (one read with the host's own key); a failed read refuses them all. */
  private async startsInLinear(rows: readonly TicketPlanRow[]): Promise<ReadonlyMap<string, string | null>> {
    const key = this.deps.linearKey();
    try {
      if (key === null) throw new HostError("No Linear key on the host");
      return await startsSaveCheck(this.deps.keyedGql(key), rows);
    } catch (error) {
      return new Map(rows.map((r) => [r.opId, `Relay couldn't check Linear before saving its start (${publicError(error, "Linear")})`]));
    }
  }

  /** Linear now for a re-plan's freshness check: one read with the host's own key (interactive lane). */
  private liveIssues(ids: readonly string[]): Promise<ReadonlyMap<string, LiveIssue>> {
    const key = this.deps.linearKey();
    return key === null ? Promise.reject(new HostError("No Linear key on the host")) : planFreshness(this.deps.keyedGql(key), ids);
  }

  /** A confirmed PR write's approval (reviews `prPrepare`); `login`: the GitHub account the device showed. */
  preparePr(deviceId: string, mutation: PrMutation, login: string): Promise<Answer> {
    return this.prGate === null ? Promise.resolve(PR_WRITES_OFF) : this.prGate.prepare(deviceId, mutation, login);
  }

  /** A PR write (reviews `prCommit`); the board's PR facts follow in one coalesced cycle. */
  async commitPr(deviceId: string, req: PrCommitRequest, login: string): Promise<Answer> {
    if (this.prGate === null) return PR_WRITES_OFF;
    const answer = await this.prGate.commit(deviceId, req, login);
    if (answer.outcome?.state === "done") this.actor.send({ type: "sync.now" });
    return answer;
  }

  // ---- Board facts ----

  private me(): AttentionMe {
    const identity = this.store.sync.identity;
    return { linearViewerId: identity?.linear?.viewerId ?? null, linearNames: this.linearNames, ghLogin: identity?.github?.login ?? null };
  }

  private facts(entry: IssueEntry): TicketBoardFacts {
    const { description: _description, ...ticket } = entry.ticket;
    const prs = prInputs(this.store, ticket.prs);
    const attention = attentionOf({
      key: ticket.key,
      closed: TERMINAL_TICKET_STATE_TYPES[ticket.state.type],
      comments: entry.comments,
      notices: this.store.sync.notices.filter((n) => n.issueKey === ticket.key),
      prs,
      me: this.me(),
      handled: this.handled.state,
    });
    const plannedStart = this.plan.get(this.me().linearViewerId, ticket.id);
    return { ...ticket, ...(plannedStart !== null && { plannedStart }), prFacts: prs.map((p) => p.facts), attention };
  }

  /** Changed cards to subscribed devices as one delta. */
  private publish(): void {
    const delta = this.store.publish((e) => this.facts(e), new Set(this.watched()));
    if (delta === null) return;
    const status = this.status();
    this.lastStatus = JSON.stringify(status);
    this.onPush?.({ t: "tickets.delta", ...delta, status });
  }

  private snapshot(): void {
    this.store.bump();
    this.store.markPublished((e) => this.facts(e));
    const status = this.status();
    this.lastStatus = JSON.stringify(status);
    this.onPush?.({ t: "tickets.snapshot", rev: this.store.rev, board: this.board(), status });
  }

  private pushStatus(): void {
    const status = this.status();
    const json = JSON.stringify(status);
    if (json === this.lastStatus) return;
    this.lastStatus = json;
    this.onPush?.({ t: "tickets.status", status });
  }

  /** A finished cycle stamps lastSyncAt and confirms the account for writes. */
  private onTransition(): void {
    const state = this.stateName();
    if (state === "waiting" && this.lastState === "syncing") {
      this.store.setSync({ lastSyncAt: this.deps.now() });
      this.verified = true;
      this.store.save();
    }
    this.lastState = state;
    this.pushStatus();
  }

  /** The verified account with the key it was verified with, for one write; null when there is none. */
  private pin(): GatePin | null {
    const viewerId = this.verified ? (this.store.sync.identity?.linear?.viewerId ?? null) : null;
    const key = this.deps.linearKey();
    if (viewerId === null || key === null) return null;
    if (sha256(key) !== this.keyHash) {
      // The key changed since the account was confirmed: confirm it again before anything is written.
      this.actor.send({ type: "sync.now" });
      return null;
    }
    // The guard runs right before each mutation request: a key or account change after any read stops it.
    const guard = (): void => {
      if (!this.current(pin)) throw new StaleCredential();
    };
    const pin: GatePin = { viewerId, generation: this.generation, credential: sha256(`relay tickets credential ${key}`).slice(0, 16), linear: linearExecutor(this.deps.keyedGql(key), () => viewerId, guard) };
    return pin;
  }

  /** Whether a pinned write may still go out: same generation, account still verified, same key on disk. */
  private current(pin: GatePin): boolean {
    const key = this.deps.linearKey();
    const viewerId = this.verified ? (this.store.sync.identity?.linear?.viewerId ?? null) : null;
    return pin.generation === this.generation && pin.viewerId === viewerId && key !== null && sha256(key) === this.keyHash;
  }

  /** gh's credential now (`gh auth token`, no network); null when gh is signed out. */
  private async ghToken(w: GhWrites): Promise<string | null> {
    const res = await w.run([w.gh, "auth", "token"], { cwd: homedir(), timeoutMs: GH_TOKEN_TIMEOUT_MS });
    const token = res.code === 0 && !res.timedOut ? res.stdout.trim() : "";
    return token === "" ? null : token;
  }

  /**
   * The verified GitHub account with gh pinned to the credential it has now: every gh call of the op
   * (check, write, reconcile) runs with exactly that token, and it must still sign in as the verified
   * login. Null when there is none (gh signed out, or signed in as someone else since the last sync).
   */
  private async ghPin(): Promise<GithubPin | null> {
    const w = this.deps.ghWrites;
    const login = this.verified ? (this.store.sync.identity?.github?.login ?? null) : null;
    if (w === undefined || login === null) return null;
    const token = await this.ghToken(w);
    if (token === null) return null;
    const run: ToolRun = (argv, options) => w.run(argv, { ...options, env: { ...options.env, GH_TOKEN: token } });
    const budget = this.deps.budgets.github;
    const live = (await ghCall(run, w.gh, budget, ["api", "user", "--jq", ".login"])).trim();
    if (live.toLowerCase() !== login.toLowerCase()) {
      // gh now signs in as another account: confirm it again before anything is written.
      this.actor.send({ type: "sync.now" });
      return null;
    }
    // The guard runs right before each gh write: a credential or account change after any read stops it.
    const guard = async (): Promise<void> => {
      if (!(await this.ghCurrent(pin))) throw new StaleGithubCredential();
    };
    const github = githubExecutor({ run, gh: w.gh, graphql: ghGraphql(run, w.gh, budget), budget, login: () => login, guard });
    const pin: GithubPin = { login, generation: this.generation, credential: sha256(token), github };
    return pin;
  }

  /** Whether a pinned PR write may still go out: same generation, same verified login, same gh credential. */
  private async ghCurrent(pin: GithubPin): Promise<boolean> {
    const w = this.deps.ghWrites;
    const login = this.verified ? (this.store.sync.identity?.github?.login ?? null) : null;
    if (w === undefined || pin.generation !== this.generation || login !== pin.login) return false;
    const token = await this.ghToken(w);
    return token !== null && sha256(token) === pin.credential;
  }

  // ---- Sync steps ----

  /** Resolves who the host's key acts as, reading the key once; a new key or account voids pending writes. */
  private async identify(): Promise<IdentifyOutput> {
    const prev = this.store.sync.identity;
    const key = this.deps.linearKey();
    const resolved = await resolveIdentity(key === null ? this.deps.gql : this.deps.keyedGql(key), this.deps.ghLogin, prev);
    this.linearNames = resolved.linearNames;
    this.errors = resolved.errors;
    const keyHash = key === null ? null : sha256(key);
    if (keyHash !== this.keyHash) {
      if (this.keyHash !== null) this.gate.invalidate("the host's Linear key changed");
      this.keyHash = keyHash;
      this.generation += 1;
    }
    if (identityChanged(prev, resolved.identity)) {
      this.pending = resolved.identity;
      this.verified = false;
      this.generation += 1;
      this.gate.invalidate("the host's Linear or GitHub account changed");
      this.prGate?.invalidate("the host's Linear or GitHub account changed");
      return { kind: "changed" };
    }
    this.store.setSync({ identity: resolved.identity });
    return { kind: resolved.identity.linear === null ? "off" : "same" };
  }

  private viewer(): LinearViewer {
    const linear = this.store.sync.identity?.linear;
    if (!linear) throw new HostError("No Linear account resolved");
    return { id: linear.viewerId, url: this.linearNames.find((n) => n.startsWith("https://")) ?? null };
  }

  private async linearStep(signal: AbortSignal): Promise<LinearStepOutput> {
    try {
      return await this.linear.pass(this.viewer(), this.watched(), signal);
    } finally {
      this.publish();
    }
  }

  /** A GitHub failure is reported and skipped (Linear's cards stand); only a rate limit backs off. */
  private async githubStep(signal: AbortSignal): Promise<void> {
    const login = this.store.sync.identity?.github?.login;
    if (login === undefined) return;
    try {
      await this.github.pass(login, signal);
      this.errors = { ...this.errors, github: null };
    } catch (error) {
      this.errors = { ...this.errors, github: publicError(error, "GitHub") };
      this.deps.log(`tickets: github sync failed: ${publicError(error, "GitHub")}`);
      if (error instanceof RateLimited) throw error;
    } finally {
      this.publish();
    }
  }

  private async reconcileStep(signal: AbortSignal): Promise<void> {
    try {
      await this.linear.reconcile(this.viewer(), this.watched(), signal);
    } finally {
      this.publish();
    }
  }

  /** Another account: nothing of the old one stays; devices get an empty snapshot. */
  private wipe(): Promise<void> {
    this.store.wipe(this.pending ?? NO_IDENTITY);
    this.plan.wipe();
    this.pending = null;
    this.deps.log("tickets: account changed, synced tickets wiped");
    this.snapshot();
    return Promise.resolve();
  }
}

export interface HostTicketsOptions {
  /** `$XDG_CONFIG_HOME/relay/tickets`. */
  readonly dir: string;
  /** The host's own Linear key (`linearKey(agentHome)`); never another one. */
  readonly linearKey: () => string | null;
  readonly gh: string;
  readonly run: ToolRun;
  readonly fetch: Fetch;
  readonly budgets: Budgets;
  readonly writes: boolean;
  readonly log: (line: string) => void;
  /** `claudeWriter` for ticket summaries. */
  readonly summaryWriter: SummaryWriter;
  /** Astra's item sessions for `replan` (the agents bridge); absent: `replan` answers an error. */
  readonly astra?: Pick<AstraSessionsDeps, "agents" | "launch" | "sessionFile" | "agentHome" | "socketPath" | "clock">;
}

/** Re-plans in the Timeline's own read-only Astra sessions (`tickets/astra.json`). */
function timelineReplanner(o: HostTicketsOptions, astra: NonNullable<HostTicketsOptions["astra"]>): Replanner {
  let replanner: Replanner | null = null;
  const sessions = new AstraSessions({
    ...astra,
    storePath: join(o.dir, "astra.json"),
    emit: (item) => replanner?.observe(item),
    log: o.log,
    seed: timelineSeed,
    readOnly: true,
  });
  replanner = new Replanner({ sessions, clock: astra.clock });
  return replanner;
}

/** gh signed out (as opposed to failing): its login is then nobody's. */
const GH_SIGNED_OUT = /auth login|not logged in/i;

/**
 * The service as the host runs it: the sync on the budgets' background lane, identity and writes on
 * the interactive one with exactly the key they pinned, and gh's login.
 */
export function hostTicketsService(o: HostTicketsOptions): TicketsService {
  const linear = o.budgets.linear.background;
  const github = o.budgets.github.background;
  return new TicketsService({
    dir: o.dir,
    gql: linearGql(o.linearKey, o.fetch, linear),
    linearKey: o.linearKey,
    keyedGql: (key) => linearGql(() => key, o.fetch, o.budgets.linear),
    ghGraphql: ghGraphql(o.run, o.gh, github),
    ghLogin: async () => {
      try {
        return (await ghCall(o.run, o.gh, github, ["api", "user", "--jq", ".login"])).trim() || null;
      } catch (error) {
        if (GH_SIGNED_OUT.test(text(error))) return null;
        throw error;
      }
    },
    budgets: o.budgets,
    writes: o.writes,
    ghWrites: { run: o.run, gh: o.gh },
    summaryWriter: o.summaryWriter,
    now: () => Date.now(),
    log: o.log,
    ...(o.astra === undefined ? {} : { replanner: timelineReplanner(o, o.astra) }),
  });
}

export interface HostTickets {
  /** Null unless host.json has `features.tickets: true`. */
  readonly tickets: TicketsService | null;
  /**
   * The budgets Reviews' clients share with the sync (interactive lane, with a reserve the sync
   * can't spend); null with tickets off, so Reviews calls Linear and GitHub exactly as without tickets.
   */
  readonly reviewsBudgets: Budgets | null;
}

/** What `serve` builds for tickets from host.json and the environment (the only construction path). */
export function hostTickets(config: HostConfig | null, env: Readonly<Record<string, string | undefined>>, o: Omit<HostTicketsOptions, "budgets" | "writes">): HostTickets {
  const on = ticketsFeatures(config, env);
  if (!on.sync) return { tickets: null, reviewsBudgets: null };
  const budgets = providerBudgets(() => Date.now());
  return { tickets: hostTicketsService({ ...o, budgets, writes: on.writes }), reviewsBudgets: budgets };
}
