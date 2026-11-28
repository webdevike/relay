// Tickets on the host (PLAN T0.3, §2.8, §2.9): Isaac's Linear issues and their PRs, synced under the
// shared provider budgets by the tickets sync machine, kept in a revisioned store, with Attention
// worked out per card and every write through the MutationGate. Only built when host.json has
// `features.tickets: true`; `writes` only with `features.ticketsWrites: true` and no dry run.
//
// `handle(deviceId, op)` answers every `tickets.req`. Pushes (`tickets.snapshot`, `tickets.delta`,
// `tickets.status`) go through `onPush`, which the server sends only to sockets that subscribed.

import { TERMINAL_TICKET_STATE_TYPES, type Attention, type PrMutation, type ServerMessage, type TicketBoardFacts, type TicketsBoard, type TicketsOp, type TicketsResult, type TicketsStatus } from "@relay/protocol";
import { join } from "node:path";
import { AstraSessions, type AstraSessionsDeps } from "../reviews/astra";
import type { ToolRun } from "../reviews/exec";
import { ghCall, ghGraphql, type GhGraphql } from "../reviews/github";
import { githubExecutor, RelayAutoMerge, relayAutoMergeWatch } from "../reviews/github-writes";
import { linearGql, type Fetch, type LinearGql } from "../reviews/linear";
import type { TicketsRelaying } from "../seams";
import { ticketsSyncActor, type TicketsSyncActor, type TicketsSyncOptions } from "./actor";
import { AnchorStore } from "./anchors";
import { applyHandled, attentionOf, type AttentionMe } from "./attention";
import { RateLimited, type Budgets } from "./budget";
import { MutationGate, type CommitRequest, type GateIdentity } from "./gate";
import { GithubSync, prInputs } from "./github-sync";
import { identityChanged, NO_IDENTITY, resolveIdentity, type HostIdentity } from "./identity";
import { LinearSync, type LinearViewer } from "./linear-sync";
import { linearExecutor } from "./linear-writes";
import { PlanStore } from "./plan";
import { Replanner, timelineSeed } from "./replan";
import { HandledStore, SeenStore, TicketsStore, type IssueEntry } from "./store";
import { SummaryCache, type SummarySnapshot, type SummaryWriter } from "./summary";
import type { IdentifyOutput, LinearStepOutput } from "./sync.machine";

export type TicketsPush = Extract<ServerMessage, { t: "tickets.snapshot" | "tickets.delta" | "tickets.status" }>;
type Answer = Omit<TicketsResult, "rid">;
type Op<K extends TicketsOp["kind"]> = Extract<TicketsOp, { kind: K }>;

/** The gate as the service uses it (MutationGate; a stub in tests). */
export type TicketsGate = Pick<MutationGate, "prepare" | "commit" | "preparePr" | "commitPr" | "invalidate">;

export interface TicketsServiceDeps {
  /** `$XDG_CONFIG_HOME/relay/tickets`: tickets.json, handled.json, seen.json, ops.json. */
  readonly dir: string;
  /** Linear's GraphQL with the host's key, through `budgets.linear`. */
  readonly gql: LinearGql;
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
  readonly ghWrites?: { readonly run: ToolRun; readonly gh: string };
  /** Astra's re-plans (a private read-only item session); absent: `replan` answers an error. */
  readonly replanner?: Pick<Replanner, "replan" | "stop">;
}

const NO_ATTENTION: Attention = { waiting: [], needsYou: null };
const clip = (s: string | null): string | null => (s === null ? null : s.slice(0, 2000));
const text = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class TicketsService implements TicketsRelaying {
  readonly writes: boolean;
  /** The server's sender to subscribed sockets; null drops pushes. */
  onPush: ((message: TicketsPush) => void) | null = null;
  private readonly store: TicketsStore;
  private readonly handled: HandledStore;
  private readonly seen: SeenStore;
  private readonly plan: PlanStore;
  private readonly anchors: AnchorStore;
  private readonly linear: LinearSync;
  private readonly github: GithubSync;
  private readonly gate: TicketsGate;
  private readonly actor: TicketsSyncActor;
  private readonly summaries: SummaryCache | null;
  private linearNames: readonly string[] = [];
  private errors: TicketsStatus["errors"] = { linear: null, github: null };
  /** The account changed (or was never confirmed this run): writes wait for a full cycle. */
  private verified = false;
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
    const autoMerge = new RelayAutoMerge(deps.dir);
    const github =
      deps.ghWrites === undefined
        ? undefined
        : githubExecutor({ ...deps.ghWrites, graphql: deps.ghGraphql, budget: deps.budgets.github, login: () => this.gateIdentity().ghLogin, autoMerge });
    this.github = new GithubSync(deps.ghGraphql, this.store, github === undefined ? null : relayAutoMergeWatch(github, autoMerge, deps.log));
    this.gate =
      deps.gate ??
      new MutationGate({
        dir: deps.dir,
        writesEnabled: () => deps.writes,
        identity: () => this.gateIdentity(),
        linear: linearExecutor(deps.gql, () => this.gateIdentity().linearViewerId),
        ...(github === undefined ? {} : { github }),
        now: deps.now,
        log: deps.log,
      });
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
      return { ok: false, error: text(error).slice(0, 2000) };
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
      prepare: (o) => this.gate.prepare({ deviceId }, o.mutation, this.gateIdentity()),
      commit: (o) => this.commit(deviceId, o),
      summary: (o) => this.summary(o.key),
      plan: (o) => {
        this.plan.set(o.rows);
        this.publish();
        return { ok: true };
      },
      replan: (o) => (this.deps.replanner === undefined ? { ok: false, error: "Astra is not available on this host" } : this.deps.replanner.replan(o, () => this.board().tickets)),
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

  /** The board at its rev: pending changes go out as a delta first, so the answer matches the rev. */
  private boardAnswer(): Answer {
    this.publish();
    return { ok: true, board: this.board(), rev: this.store.rev, status: this.status() };
  }

  private board(): TicketsBoard {
    return { tickets: this.store.board((e) => this.facts(e)), teams: [...this.store.sync.teams] };
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
      // Linear unreachable: the stored card, if any, rather than nothing.
      entry = this.store.issue(key) ?? null;
      if (entry === null) throw error;
    }
    if (entry === null) {
      if (this.store.issue(key) !== undefined) this.store.tombstone(key, true);
      this.publish();
      return { ok: false, error: `${key} is not in Linear or this account can't see it` };
    }
    this.publish();
    return { ok: true, ticket: { ...this.facts(entry), description: entry.ticket.description, comments: this.anchors.attach(entry.comments.slice(-500)) } };
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

  private async commit(deviceId: string, op: Op<"commit">): Promise<Answer> {
    const answer = await this.gate.commit({ deviceId }, { opId: op.opId, mutation: op.mutation, ...(op.approvalId === undefined ? {} : { approvalId: op.approvalId }) }, this.gateIdentity());
    // An inline comment made here keeps where its quote sat (Relay-only); a lost answer may still
    // have landed under the opId, Linear's id for it.
    const m = op.mutation;
    if (m.kind === "comment" && m.anchor !== undefined && answer.outcome !== undefined && answer.outcome.state !== "failed") {
      this.anchors.set(answer.outcome.result?.id ?? op.opId, m.anchor);
    }
    // The board shows the write once Linear has it: one coalesced cycle.
    if (answer.outcome?.state === "done") this.actor.send({ type: "sync.now" });
    return answer;
  }

  /** A confirmed PR write's approval (reviews `prPrepare`), as the identity this host acts as. */
  preparePr(deviceId: string, mutation: PrMutation): Promise<Answer> {
    return this.gate.preparePr({ deviceId }, mutation, this.gateIdentity());
  }

  /** A PR write (reviews `prCommit`); the board's PR facts follow in one coalesced cycle. */
  async commitPr(deviceId: string, req: CommitRequest<PrMutation>): Promise<Answer> {
    const answer = await this.gate.commitPr({ deviceId }, req, this.gateIdentity());
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
    const plannedStart = this.plan.get(ticket.key);
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

  private gateIdentity(): GateIdentity {
    const identity = this.store.sync.identity;
    if (!this.verified || identity === null) return { linearViewerId: null, ghLogin: null };
    return { linearViewerId: identity.linear?.viewerId ?? null, ghLogin: identity.github?.login ?? null };
  }

  // ---- Sync steps ----

  private async identify(): Promise<IdentifyOutput> {
    const prev = this.store.sync.identity;
    const resolved = await resolveIdentity(this.deps.gql, this.deps.ghLogin, prev);
    this.linearNames = resolved.linearNames;
    this.errors = resolved.errors;
    if (identityChanged(prev, resolved.identity)) {
      this.pending = resolved.identity;
      this.verified = false;
      this.gate.invalidate("the host's Linear or GitHub account changed");
      return { kind: "changed" };
    }
    this.store.setSync({ identity: resolved.identity });
    return { kind: resolved.identity.linear === null ? "off" : "same" };
  }

  private viewer(): LinearViewer {
    const linear = this.store.sync.identity?.linear;
    if (!linear) throw new Error("No Linear account resolved");
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
      this.errors = { ...this.errors, github: text(error) };
      this.deps.log(`tickets: github sync failed: ${text(error)}`);
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

/** The service as the host runs it: the shared budgets, the host's key and gh's login. */
export function hostTicketsService(o: HostTicketsOptions): TicketsService {
  return new TicketsService({
    dir: o.dir,
    gql: linearGql(o.linearKey, o.fetch, o.budgets.linear),
    ghGraphql: ghGraphql(o.run, o.gh, o.budgets.github),
    ghLogin: async () => {
      try {
        return (await ghCall(o.run, o.gh, o.budgets.github, ["api", "user", "--jq", ".login"])).trim() || null;
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
