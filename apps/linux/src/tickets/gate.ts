// The tickets MutationGate (PLAN §2.5): the only way a device's `tickets.req prepare/commit` writes to
// Linear as Isaac. Every write passes, in order: writes enabled on this host; the account the device
// showed (`viewerId`) equals the account the host's verified key acts as, pinned with that key for
// the whole op; the op store (a repeated opId answers its stored outcome, only to the account and
// device that started it; one left unknown is reconciled with the provider, and only a create with a
// stable provider id is ever sent again, under its original approval revision); the executor's live
// check; for a confirmed kind a single-use approval bound to the device, the account, the key
// generation, the kind, the payload hash and the revision check() saw at prepare; and right before
// the side effect, the pin is checked again (a key rotation or account change during validation
// stops the write). applyPlan also keeps each row's own opId and hash: a row an earlier op of the
// same account and device wrote, or may have written, is never sent again under a new batch opId
// (done stays done; unknown is reconciled row by row), so only new rows and definite failures go out.

import { createHash } from "node:crypto";
import { TicketConfirm, ticketMutationConfirmed, type TicketMutation, type TicketOutcome, type TicketPlanRow, type TicketsRefusalCode, type TicketsResult, type TicketStateType } from "@relay/protocol";
import { Approvals } from "./approvals";
import { ProviderRejected, publicError, StaleCredential } from "./errors";
import { OpResult, OpsStore, type OpRecord } from "./ops-store";

export interface GateContext {
  readonly deviceId: string;
}

export type CheckResult =
  | ({
      ok: true;
      /** Live state the approval binds to; a different one at commit refuses `conflict`. */
      revision: string;
      /** `setState`: the target state's type (a terminal one needs an approval). */
      toStateType?: TicketStateType;
    } & TicketConfirm)
  | { ok: false; code: "conflict" | "invalid"; message: string };

export interface MutationExecutor<M> {
  /** Reads live provider state; refuses when the mutation no longer applies. */
  check(m: M): Promise<CheckResult>;
  /** The write; idempotent by opId where the provider allows. Throws ProviderRejected when the provider said no. */
  run(m: M, opId: string): Promise<unknown>;
  /** After a lost response or a restart: whether the write took effect. */
  reconcile(m: M, opId: string, startedAt: number): Promise<"done" | "notDone" | "unknown">;
  /** applyPlan: the opIds of the rows Linear shows at their values now (one read). Absent: `reconcile` per row. */
  reconcileRows?(rows: readonly TicketPlanRow[]): Promise<ReadonlySet<string>>;
}

/** The account and credential one op runs as, from the host's last identity resolution. */
export interface GatePin {
  /** The Linear viewer the pinned key resolved to. */
  readonly viewerId: string;
  /** Moves on every account or key change: approvals and ops pinned to an older one never write. */
  readonly generation: number;
  /** A non-secret, restart-stable fingerprint of the pinned key (kept with each op). */
  readonly credential: string;
  /** The executor bound to exactly the pinned key (check, run and reconcile all use it). */
  readonly linear: MutationExecutor<TicketMutation>;
}

export interface MutationGateDeps {
  readonly dir: string;
  readonly writesEnabled: () => boolean;
  /** The verified account and key now; null while none is verified or the key changed since. */
  readonly pin: () => GatePin | null;
  /** Whether `pin` is still the host's account, key and generation (asked right before each write). */
  readonly current: (pin: GatePin) => boolean;
  readonly now: () => number;
  readonly log: (line: string) => void;
}

type GateAnswer = Omit<TicketsResult, "rid">;
type Checked = Extract<CheckResult, { ok: true }>;
type PlanMutation = Extract<TicketMutation, { kind: "applyPlan" }>;
type RowOutcome = NonNullable<OpResult["rows"]>[number];
type WriteBase = Omit<OpRecord, "state" | "result" | "error">;
interface CommitRequest {
  readonly approvalId?: string;
  readonly opId: string;
  readonly mutation: TicketMutation;
}
/** Who started an op: only they may retry it or read its outcome. */
interface Authority {
  readonly viewerId: string;
  readonly deviceId: string;
}

/**
 * Creates sent with `id: opId` (Linear's CommentCreateInput.id and IssueCreateInput.id): Linear
 * refuses a second create with that id, so after reconcile found no entity with it, sending it again
 * can't make a duplicate. Every other kind is never sent again on our own after an unknown outcome.
 */
const STABLE_ID_CREATES: ReadonlySet<TicketMutation["kind"]> = new Set(["comment", "createIssue"]);

const MAX_LINE = 2000;
const line = (text: string): string => (text.length > MAX_LINE ? `${text.slice(0, MAX_LINE - 3)}...` : text);
const refuse = (code: TicketsRefusalCode, message: string): GateAnswer => ({ ok: false, refused: { code, message: line(message) } });
const errorText = (e: unknown): string => line(publicError(e, "Linear"));
const STALE_PIN = "The host's Linear key or account changed while checking. Reload and try again.";
const sameAuthority = (a: Authority, b: Authority): boolean => a.viewerId === b.viewerId && a.deviceId === b.deviceId;

/** JSON with sorted keys and no undefined fields, so equal mutations hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const obj = value as Readonly<Record<string, unknown>>;
  const fields = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${fields.join(",")}}`;
}

export function mutationHash(m: TicketMutation): string {
  return createHash("sha256").update(canonicalJson(m)).digest("hex");
}

/** A plan row's identity beyond its opId: the same opId with other values is another change. */
function rowHash(row: TicketPlanRow): string {
  return createHash("sha256").update(canonicalJson(row)).digest("hex");
}

/** applyPlan: the whole op is done only when every row is. */
function stateOf(result: OpResult | undefined): TicketOutcome["state"] {
  const rows = result?.rows ?? [];
  if (rows.some((r) => r.state === "unknown")) return "unknown";
  return rows.some((r) => r.state === "failed") ? "failed" : "done";
}

function landedRow(row: RowOutcome): RowOutcome {
  const { error: _lost, ...rest } = row;
  return { ...rest, state: "done" };
}

/** The stored result as a device sees it (row hashes stay on the host). */
function shownResult(rec: OpRecord): TicketOutcome["result"] {
  const rows = rec.result?.rows?.map(({ hash: _hash, ...row }) => row);
  const result = rows === undefined ? rec.result : { ...rec.result, rows };
  return rec.error === undefined ? result : { ...result, error: rec.error };
}

function answerOf(opId: string, rec: OpRecord): GateAnswer {
  const state = rec.state === "running" ? "unknown" : rec.state;
  const result = shownResult(rec);
  const outcome: TicketOutcome = result === undefined ? { opId, state } : { opId, state, result };
  return state === "failed" ? { ok: false, error: rec.error ?? "Not every change was written", outcome } : { ok: true, outcome };
}

export class MutationGate {
  private readonly approvals: Approvals;
  private readonly ops: OpsStore;
  private readonly inflight = new Map<string, { hash: string; authority: Authority; answer: Promise<GateAnswer> }>();

  constructor(private readonly deps: MutationGateDeps) {
    this.approvals = new Approvals(deps.now);
    this.ops = new OpsStore(deps.dir, deps.now);
  }

  /** `viewerId`: the Linear account the device showed. */
  async prepare(ctx: GateContext, mutation: TicketMutation, viewerId: string): Promise<GateAnswer> {
    const pin = this.allowed(viewerId);
    if (!("generation" in pin)) return pin;
    const checked = await this.check(pin, mutation);
    if (!checked.ok) return checked.answer;
    if (!this.deps.current(pin)) return refuse("identity", STALE_PIN);
    // The confirm shows the whole change or nothing: too large to show in full is refused, never clipped.
    const { ok: _ok, revision: _revision, toStateType: _type, ...shown } = checked;
    const confirm = TicketConfirm.safeParse(shown);
    if (!confirm.success) return refuse("invalid", "This change is too large to show in full for confirming; nothing was written");
    const binding = { deviceId: ctx.deviceId, identity: pin.viewerId, generation: pin.generation, kind: mutation.kind, hash: mutationHash(mutation), revision: checked.revision };
    return { ok: true, approval: this.approvals.create(binding, confirm.data) };
  }

  /** `viewerId`: the Linear account the device showed when Isaac acted. */
  async commit(ctx: GateContext, req: CommitRequest, viewerId: string): Promise<GateAnswer> {
    const pin = this.allowed(viewerId);
    if (!("generation" in pin)) return pin;
    const hash = mutationHash(req.mutation);
    const authority: Authority = { viewerId: pin.viewerId, deviceId: ctx.deviceId };
    const running = this.inflight.get(req.opId);
    if (running !== undefined) return this.join(running, hash, authority);
    const rec = this.ops.get(req.opId);
    if (rec !== undefined && rec.hash !== hash) return refuse("invalid", "This write id was used for a different change");
    if (rec !== undefined && !sameAuthority(rec, authority)) return refuse("identity", "This change was started as another Linear account or on another device");
    const answer = rec === undefined ? this.fresh(ctx, req, pin, hash) : this.resume(req, rec, pin);
    this.inflight.set(req.opId, { hash, authority, answer });
    try {
      return await answer;
    } finally {
      this.inflight.delete(req.opId);
    }
  }

  /** Identity or key change, or revocation: pending approvals are void. */
  invalidate(reason: string): void {
    this.approvals.clear();
    this.deps.log(`tickets gate: approvals dropped (${reason})`);
  }

  /** The pinned account and key when the device saw that account, or the refusal. */
  private allowed(viewerId: string): GatePin | GateAnswer {
    if (!this.deps.writesEnabled()) return refuse("writesOff", "Writing to Linear is off on this host");
    const pin = this.deps.pin();
    if (pin === null) return refuse("identity", "The host hasn't confirmed its Linear account yet. Try again in a moment.");
    if (pin.viewerId !== viewerId) return refuse("identity", "The host now writes as a different Linear account. Reload and try again.");
    return pin;
  }

  /** A retry while the first try still runs: the same answer, only for the same change, account and device. */
  private join(running: { hash: string; authority: Authority; answer: Promise<GateAnswer> }, hash: string, authority: Authority): Promise<GateAnswer> | GateAnswer {
    if (running.hash !== hash) return refuse("invalid", "This write id was used for a different change");
    if (!sameAuthority(running.authority, authority)) return refuse("identity", "This change was started as another Linear account or on another device");
    return running.answer;
  }

  private async check(pin: GatePin, m: TicketMutation): Promise<Checked | { ok: false; answer: GateAnswer }> {
    try {
      const checked = await pin.linear.check(m);
      return checked.ok ? checked : { ok: false, answer: refuse(checked.code, checked.message) };
    } catch (e) {
      return { ok: false, answer: { ok: false, error: errorText(e) } };
    }
  }

  private async fresh(ctx: GateContext, req: CommitRequest, pin: GatePin, hash: string): Promise<GateAnswer> {
    const checked = await this.check(pin, req.mutation);
    if (!checked.ok) return checked.answer;
    const needsApproval = ticketMutationConfirmed(req.mutation, checked.toStateType) || req.approvalId !== undefined;
    const refused = needsApproval ? this.spendApproval(ctx, req, { pin, hash, revision: checked.revision }) : null;
    return refused ?? this.write(pin, req, { hash, deviceId: ctx.deviceId, revision: checked.revision }, false);
  }

  /** Null when the commit's approval matches every binding; it is spent either way. */
  private spendApproval(ctx: GateContext, req: CommitRequest, live: { pin: GatePin; hash: string; revision: string }): GateAnswer | null {
    if (req.approvalId === undefined) return refuse("approval", "Confirm this change first");
    const taken = this.approvals.take(req.approvalId);
    if (!taken.ok) return refuse("approval", taken.message);
    const b = taken.binding;
    const same = b.deviceId === ctx.deviceId && b.identity === live.pin.viewerId && b.generation === live.pin.generation && b.kind === req.mutation.kind && b.hash === live.hash;
    if (!same) return refuse("approval", "This confirm was for a different change. Confirm again.");
    return b.revision === live.revision ? null : refuse("conflict", "Changed in Linear since you confirmed. Check it and confirm again.");
  }

  /**
   * A known opId: its stored outcome, or (unknown) what the provider says now. A write the provider
   * doesn't show is never reapplied from a read of current state, except a stable-id create.
   */
  private async resume(req: CommitRequest, rec: OpRecord, pin: GatePin): Promise<GateAnswer> {
    if (rec.state === "done" || rec.state === "failed") return answerOf(req.opId, rec);
    if (req.mutation.kind === "applyPlan") return this.resumePlan(pin, req.opId, req.mutation, rec);
    const status = await pin.linear.reconcile(req.mutation, req.opId, rec.at).catch(() => "unknown" as const);
    this.deps.log(`tickets gate: reconciled ${rec.kind} ${req.opId}: ${status}`);
    if (status === "done") {
      const { error: _lost, ...written } = rec;
      const done: OpRecord = { ...written, state: "done" };
      this.ops.put(req.opId, done);
      return answerOf(req.opId, done);
    }
    if (status === "notDone" && STABLE_ID_CREATES.has(req.mutation.kind)) return this.recreate(req, rec, pin);
    return answerOf(req.opId, { ...rec, state: "unknown" });
  }

  /** A stable-id create Linear doesn't have: sent again with the same id, only at the approved revision. */
  private async recreate(req: CommitRequest, rec: OpRecord, pin: GatePin): Promise<GateAnswer> {
    if (rec.credential !== pin.credential) return refuse("identity", "The host's Linear key changed since this was sent; not sent again. Check Linear and confirm again.");
    const checked = await this.check(pin, req.mutation);
    if (!checked.ok) return checked.answer;
    if (checked.revision !== rec.revision) return refuse("conflict", "Changed in Linear since you confirmed; not sent again. Check it and confirm again.");
    return this.write(pin, req, { hash: rec.hash, deviceId: rec.deviceId, revision: rec.revision }, true);
  }

  /**
   * The side effect, after one last pin check. `again`: a resend of a stable-id create, where a
   * refusal may be Linear seeing the first one land late, so it stays unknown.
   */
  private async write(pin: GatePin, req: CommitRequest, base: { hash: string; deviceId: string; revision: string }, again: boolean): Promise<GateAnswer> {
    if (!this.deps.current(pin)) return refuse("identity", STALE_PIN);
    const m = req.mutation;
    const rec0 = { kind: m.kind, hash: base.hash, at: this.deps.now(), viewerId: pin.viewerId, deviceId: base.deviceId, revision: base.revision, credential: pin.credential };
    if (m.kind === "applyPlan") return this.writePlan(pin, req.opId, m, rec0);
    this.ops.put(req.opId, { ...rec0, state: "running" });
    let rec: OpRecord;
    try {
      const parsed = OpResult.safeParse(await pin.linear.run(m, req.opId));
      const result = parsed.success ? parsed.data : undefined;
      rec = { ...rec0, state: stateOf(result), ...(result === undefined ? {} : { result }) };
    } catch (e) {
      // A guard refusal (StaleCredential) means that mutation never went out, even on a resend.
      const definite = e instanceof StaleCredential || (e instanceof ProviderRejected && !again);
      rec = { ...rec0, state: definite ? "failed" : "unknown", error: errorText(e) };
    }
    this.ops.put(req.opId, rec);
    this.deps.log(`tickets gate: ${m.kind} ${req.opId}: ${rec.state}`);
    return answerOf(req.opId, rec);
  }

  /** This account's and device's latest outcome of each row opId, when it was the same change. */
  private priorRows(rows: readonly TicketPlanRow[], authority: Authority): Map<string, RowOutcome> {
    const want = new Map(rows.map((r) => [r.opId, rowHash(r)]));
    const prior = new Map<string, RowOutcome>();
    for (const rec of this.ops.records()) {
      if (rec.kind !== "applyPlan" || !sameAuthority(rec, authority)) continue;
      for (const r of rec.result?.rows ?? []) if (r.hash !== undefined && want.get(r.opId) === r.hash) prior.set(r.opId, r);
    }
    return prior;
  }

  /** Which of these rows Linear shows at their values now; a failed read: none (they stay unknown). */
  private async landed(pin: GatePin, rows: readonly TicketPlanRow[]): Promise<ReadonlySet<string>> {
    if (rows.length === 0) return new Set();
    const exec = pin.linear;
    try {
      if (exec.reconcileRows !== undefined) return await exec.reconcileRows(rows);
      const each = await Promise.all(rows.map(async (r) => ((await exec.reconcile({ kind: "applyPlan", rows: [r] }, r.opId, 0)) === "done" ? [r.opId] : [])));
      return new Set(each.flat());
    } catch {
      return new Set();
    }
  }

  /**
   * Rows an earlier plan op of this account and device wrote (done) or may have written (unknown,
   * reconciled now) are never sent again, whatever opId the batch has; only new rows and definite
   * failures go out.
   */
  private async settlePrior(pin: GatePin, rows: readonly TicketPlanRow[], authority: Authority): Promise<{ known: Map<string, RowOutcome>; send: TicketPlanRow[] }> {
    const prior = this.priorRows(rows, authority);
    const landed = await this.landed(
      pin,
      rows.filter((r) => prior.get(r.opId)?.state === "unknown"),
    );
    const known = new Map<string, RowOutcome>();
    const send: TicketPlanRow[] = [];
    for (const r of rows) {
      const p = prior.get(r.opId);
      if (p === undefined || p.state === "failed") send.push(r);
      else known.set(r.opId, landed.has(r.opId) ? landedRow(p) : p);
    }
    return { known, send };
  }

  /** applyPlan's side effect: one record per batch with each row's outcome and identity (hash). */
  private async writePlan(pin: GatePin, opId: string, m: PlanMutation, base: WriteBase): Promise<GateAnswer> {
    const { known, send } = await this.settlePrior(pin, m.rows, base);
    const rowsAs = (state: RowOutcome["state"], ran?: ReadonlyMap<string, RowOutcome>): RowOutcome[] =>
      m.rows.map((r) => known.get(r.opId) ?? { ...(ran?.get(r.opId) ?? { key: r.key, opId: r.opId, state }), hash: rowHash(r) });
    this.ops.put(opId, { ...base, state: "running", result: { rows: rowsAs("unknown") } });
    let rec: OpRecord;
    try {
      const ran = send.length === 0 ? undefined : OpResult.safeParse(await pin.linear.run({ kind: "applyPlan", rows: send }, opId)).data?.rows;
      // A run that answered without per-row outcomes wrote all it was given.
      const rows = rowsAs(ran === undefined ? "done" : "unknown", ran && new Map(ran.map((r) => [r.opId, r])));
      rec = { ...base, state: stateOf({ rows }), result: { rows } };
    } catch (e) {
      const rows = rowsAs(e instanceof StaleCredential || e instanceof ProviderRejected ? "failed" : "unknown");
      rec = { ...base, state: stateOf({ rows }), result: { rows }, error: errorText(e) };
    }
    this.ops.put(opId, rec);
    this.deps.log(`tickets gate: applyPlan ${opId}: ${rec.state} (${String(send.length)} of ${String(m.rows.length)} rows sent)`);
    return answerOf(opId, rec);
  }

  /** A plan op whose answer was lost: rows still unknown are reconciled one by one, never sent again. */
  private async resumePlan(pin: GatePin, opId: string, m: PlanMutation, rec: OpRecord): Promise<GateAnswer> {
    const stored = new Map((rec.result?.rows ?? []).map((r) => [r.opId, r]));
    const before = m.rows.map((r) => stored.get(r.opId) ?? { key: r.key, opId: r.opId, state: "unknown" as const, hash: rowHash(r) });
    const landed = await this.landed(
      pin,
      m.rows.filter((r) => stored.get(r.opId)?.state !== "done" && stored.get(r.opId)?.state !== "failed"),
    );
    const rows = before.map((r) => (r.state === "unknown" && landed.has(r.opId) ? landedRow(r) : r));
    const state = stateOf({ rows });
    const { error, ...written } = rec;
    const next: OpRecord = { ...written, state, result: { ...rec.result, rows }, ...(state !== "done" && error !== undefined && { error }) };
    this.ops.put(opId, next);
    this.deps.log(`tickets gate: reconciled applyPlan ${opId}: ${state}`);
    return answerOf(opId, next);
  }
}
