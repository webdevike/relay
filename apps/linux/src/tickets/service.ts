// Tickets on the host (PLAN T0.3, §2.8, §2.9): Isaac's Linear issues and their PRs, synced under the
// shared provider budgets by the tickets sync machine, kept in a revisioned store, with Attention
// worked out per card and every write through the MutationGate. Only built when host.json has
// `features.tickets: true`; `writes` only with `features.ticketsWrites: true` and no dry run.
//
// `handle(deviceId, op)` answers every `tickets.req`. Pushes (`tickets.snapshot`, `tickets.delta`,
// `tickets.status`) go through `onPush`, which the server sends only to sockets that subscribed.

import { createHash } from "node:crypto";
import { TERMINAL_TICKET_STATE_TYPES, type Attention, type ServerMessage, type TicketBoardFacts, type TicketsBoard, type TicketsOp, type TicketsResult, type TicketsStatus } from "@relay/protocol";
import { ticketsFeatures, type HostConfig } from "../host-config";
import type { ToolRun } from "../reviews/exec";
import { ghCall, ghGraphql, type GhGraphql } from "../reviews/github";
import { linearGql, type Fetch, type LinearGql } from "../reviews/linear";
import type { TicketsRelaying } from "../seams";
import { ticketsSyncActor, type TicketsSyncActor, type TicketsSyncOptions } from "./actor";
import { applyHandled, attentionOf, type AttentionMe } from "./attention";
import { providerBudgets, RateLimited, type Budgets } from "./budget";
import { MutationGate, type GatePin } from "./gate";
import { GithubSync, prInputs } from "./github-sync";
import { identityChanged, NO_IDENTITY, resolveIdentity, type HostIdentity } from "./identity";
import { LinearSync, type LinearViewer } from "./linear-sync";
import { linearExecutor } from "./linear-writes";
import { HandledStore, SeenStore, TicketsStore, type IssueEntry } from "./store";
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
}

const UNAVAILABLE: Answer = { ok: false, error: "Not available yet" };
const NO_ATTENTION: Attention = { waiting: [], needsYou: null };
const clip = (s: string | null): string | null => (s === null ? null : s.slice(0, 2000));
const text = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** A key is compared by its hash; the key itself is never kept. */
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export class TicketsService implements TicketsRelaying {
  readonly writes: boolean;
  /** The server's sender to subscribed sockets; null drops pushes. */
  onPush: ((message: TicketsPush) => void) | null = null;
  private readonly store: TicketsStore;
  private readonly handled: HandledStore;
  private readonly seen: SeenStore;
  private readonly linear: LinearSync;
  private readonly github: GithubSync;
  private readonly gate: TicketsGate;
  private readonly actor: TicketsSyncActor;
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
    this.seen = new SeenStore(deps.dir);
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
      prepare: (o) => this.gate.prepare({ deviceId }, o.mutation, o.viewerId),
      commit: (o) => this.commit(deviceId, o),
      summary: () => UNAVAILABLE,
      plan: () => UNAVAILABLE,
      replan: () => UNAVAILABLE,
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
    return { ok: true, ticket: { ...this.facts(entry), description: entry.ticket.description, comments: entry.comments.slice(-500) } };
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
    const answer = await this.gate.commit({ deviceId }, { opId: op.opId, mutation: op.mutation, ...(op.approvalId === undefined ? {} : { approvalId: op.approvalId }) }, op.viewerId);
    // The board shows the write once Linear has it: one coalesced cycle.
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
    return { ...ticket, prFacts: prs.map((p) => p.facts), attention };
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
    return { viewerId, generation: this.generation, linear: linearExecutor(this.deps.keyedGql(key), () => viewerId) };
  }

  /** Whether a pinned write may still go out: same generation, account still verified, same key on disk. */
  private current(pin: GatePin): boolean {
    const key = this.deps.linearKey();
    const viewerId = this.verified ? (this.store.sync.identity?.linear?.viewerId ?? null) : null;
    return pin.generation === this.generation && pin.viewerId === viewerId && key !== null && sha256(key) === this.keyHash;
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
    now: () => Date.now(),
    log: o.log,
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
