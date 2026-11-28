// The tickets MutationGate (PLAN §2.5): the only way a device's `tickets.req prepare/commit` writes to
// Linear as Isaac. Every write passes, in order: writes enabled on this host, the actor the device saw
// equals the identity the host acts as, the op store (a repeated opId answers its stored outcome;
// one left unknown is reconciled with the provider before anything is written again), the
// executor's live check, and for a confirmed kind a single-use approval bound to the device, the
// identity, the kind, the payload hash and the revision check() saw at prepare.

import { createHash } from "node:crypto";
import { ticketMutationConfirmed, type TicketMutation, type TicketOutcome, type TicketsRefusalCode, type TicketsResult, type TicketStateType } from "@relay/protocol";
import { Approvals } from "./approvals";
import { OpResult, OpsStore, type OpRecord } from "./ops-store";

export interface GateContext {
  readonly deviceId: string;
}

export interface GateIdentity {
  readonly linearViewerId: string | null;
  readonly ghLogin: string | null;
}

export type CheckResult =
  | {
      ok: true;
      /** Live state the approval binds to; a different one at commit refuses `conflict`. */
      revision: string;
      /** What exactly will be written, for the confirm. */
      summary: string;
      /** `setState`: the target state's type (a terminal one needs an approval). */
      toStateType?: TicketStateType;
    }
  | { ok: false; code: "conflict" | "invalid"; message: string };

export interface MutationExecutor<M> {
  /** Reads live provider state; refuses when the mutation no longer applies. */
  check(m: M): Promise<CheckResult>;
  /** The write; idempotent by opId where the provider allows. Throws ProviderRejected when the provider said no. */
  run(m: M, opId: string): Promise<unknown>;
  /** After a lost response or a restart: whether the write took effect. */
  reconcile(m: M, opId: string, startedAt: number): Promise<"done" | "notDone" | "unknown">;
}

/** The provider answered and refused the write: nothing was written (any other throw is a lost response). */
export class ProviderRejected extends Error {
  override readonly name = "ProviderRejected";
}

export interface MutationGateDeps {
  readonly dir: string;
  readonly writesEnabled: () => boolean;
  readonly identity: () => GateIdentity;
  readonly linear: MutationExecutor<TicketMutation>;
  readonly now: () => number;
  readonly log: (line: string) => void;
}

type GateAnswer = Omit<TicketsResult, "rid">;
type Checked = Extract<CheckResult, { ok: true }>;
interface CommitRequest {
  readonly approvalId?: string;
  readonly opId: string;
  readonly mutation: TicketMutation;
}

const MAX_LINE = 2000;
const line = (text: string): string => (text.length > MAX_LINE ? `${text.slice(0, MAX_LINE - 3)}...` : text);
const refuse = (code: TicketsRefusalCode, message: string): GateAnswer => ({ ok: false, refused: { code, message: line(message) } });
const errorText = (e: unknown): string => line(e instanceof Error ? e.message : String(e));

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

/** applyPlan: the whole op is done only when every row is. */
function stateOf(result: OpResult | undefined): TicketOutcome["state"] {
  const rows = result?.rows ?? [];
  if (rows.some((r) => r.state === "unknown")) return "unknown";
  return rows.some((r) => r.state === "failed") ? "failed" : "done";
}

function answerOf(opId: string, rec: OpRecord): GateAnswer {
  const state = rec.state === "running" ? "unknown" : rec.state;
  const result = rec.error === undefined ? rec.result : { ...rec.result, error: rec.error };
  const outcome: TicketOutcome = result === undefined ? { opId, state } : { opId, state, result };
  return state === "failed" ? { ok: false, error: rec.error ?? "Not every change was written", outcome } : { ok: true, outcome };
}

export class MutationGate {
  private readonly approvals: Approvals;
  private readonly ops: OpsStore;
  private readonly inflight = new Map<string, { hash: string; answer: Promise<GateAnswer> }>();

  constructor(private readonly deps: MutationGateDeps) {
    this.approvals = new Approvals(deps.now);
    this.ops = new OpsStore(deps.dir, deps.now);
  }

  async prepare(ctx: GateContext, mutation: TicketMutation, actor: GateIdentity): Promise<GateAnswer> {
    const identity = this.allowed(actor);
    if (typeof identity !== "string") return identity;
    const checked = await this.check(mutation);
    if (!checked.ok) return checked.answer;
    const binding = { deviceId: ctx.deviceId, identity, kind: mutation.kind, hash: mutationHash(mutation), revision: checked.revision };
    return { ok: true, approval: this.approvals.create(binding, line(checked.summary)) };
  }

  async commit(ctx: GateContext, req: CommitRequest, actor: GateIdentity): Promise<GateAnswer> {
    const identity = this.allowed(actor);
    if (typeof identity !== "string") return identity;
    const hash = mutationHash(req.mutation);
    const running = this.inflight.get(req.opId);
    if (running !== undefined) return running.hash === hash ? running.answer : refuse("invalid", "This write id was used for a different change");
    const rec = this.ops.get(req.opId);
    if (rec !== undefined && rec.hash !== hash) return refuse("invalid", "This write id was used for a different change");
    const answer = rec === undefined ? this.fresh(ctx, req, identity, hash) : this.resume(req, rec);
    this.inflight.set(req.opId, { hash, answer });
    try {
      return await answer;
    } finally {
      this.inflight.delete(req.opId);
    }
  }

  /** Identity change or revocation: pending approvals are void. */
  invalidate(reason: string): void {
    this.approvals.clear();
    this.deps.log(`tickets gate: approvals dropped (${reason})`);
  }

  /** The Linear viewer id the host acts as, or the refusal. */
  private allowed(actor: GateIdentity): string | GateAnswer {
    if (!this.deps.writesEnabled()) return refuse("writesOff", "Writing to Linear is off on this host");
    const live = this.deps.identity().linearViewerId;
    if (live === null) return refuse("identity", "The host has no Linear account resolved yet");
    if (actor.linearViewerId !== live) return refuse("identity", "The host now writes as a different Linear account. Reload and try again.");
    return live;
  }

  private async check(m: TicketMutation): Promise<Checked | { ok: false; answer: GateAnswer }> {
    try {
      const checked = await this.deps.linear.check(m);
      return checked.ok ? checked : { ok: false, answer: refuse(checked.code, checked.message) };
    } catch (e) {
      return { ok: false, answer: { ok: false, error: `Couldn't check Linear: ${errorText(e)}` } };
    }
  }

  private async fresh(ctx: GateContext, req: CommitRequest, identity: string, hash: string): Promise<GateAnswer> {
    const checked = await this.check(req.mutation);
    if (!checked.ok) return checked.answer;
    const needsApproval = ticketMutationConfirmed(req.mutation, checked.toStateType) || req.approvalId !== undefined;
    const refused = needsApproval ? this.spendApproval(ctx, req, { identity, hash, revision: checked.revision }) : null;
    return refused ?? this.write(req.mutation, req.opId, hash);
  }

  /** Null when the commit's approval matches every binding; it is spent either way. */
  private spendApproval(ctx: GateContext, req: CommitRequest, live: { identity: string; hash: string; revision: string }): GateAnswer | null {
    if (req.approvalId === undefined) return refuse("approval", "Confirm this change first");
    const taken = this.approvals.take(req.approvalId);
    if (!taken.ok) return refuse("approval", taken.message);
    const b = taken.binding;
    const same = b.deviceId === ctx.deviceId && b.identity === live.identity && b.kind === req.mutation.kind && b.hash === live.hash;
    if (!same) return refuse("approval", "This confirm was for a different change. Confirm again.");
    return b.revision === live.revision ? null : refuse("conflict", "Changed in Linear since you confirmed. Check it and confirm again.");
  }

  /** A known opId: its stored outcome, or (unknown) the provider's answer before any second write. */
  private async resume(req: CommitRequest, rec: OpRecord): Promise<GateAnswer> {
    if (rec.state === "done" || rec.state === "failed") return answerOf(req.opId, rec);
    const status = await this.deps.linear.reconcile(req.mutation, req.opId, rec.at).catch(() => "unknown" as const);
    this.deps.log(`tickets gate: reconciled ${rec.kind} ${req.opId}: ${status}`);
    if (status === "unknown") return answerOf(req.opId, { ...rec, state: "unknown" });
    if (status === "done") {
      const { error: _lost, ...written } = rec;
      const done: OpRecord = { ...written, state: "done" };
      this.ops.put(req.opId, done);
      return answerOf(req.opId, done);
    }
    return this.rewrite(req, rec);
  }

  /** Reconciled as not written: check the live state again, then write with the same opId. */
  private async rewrite(req: CommitRequest, rec: OpRecord): Promise<GateAnswer> {
    const checked = await this.check(req.mutation);
    if (checked.ok) return this.write(req.mutation, req.opId, rec.hash);
    if (checked.answer.refused !== undefined) this.ops.put(req.opId, { ...rec, state: "failed", error: checked.answer.refused.message });
    return checked.answer;
  }

  private async write(m: TicketMutation, opId: string, hash: string): Promise<GateAnswer> {
    const at = this.deps.now();
    this.ops.put(opId, { state: "running", kind: m.kind, hash, at });
    let rec: OpRecord;
    try {
      const parsed = OpResult.safeParse(await this.deps.linear.run(m, opId));
      const result = parsed.success ? parsed.data : undefined;
      rec = { state: stateOf(result), kind: m.kind, hash, at, ...(result === undefined ? {} : { result }) };
    } catch (e) {
      rec = { state: e instanceof ProviderRejected ? "failed" : "unknown", kind: m.kind, hash, at, error: errorText(e) };
    }
    this.ops.put(opId, rec);
    this.deps.log(`tickets gate: ${m.kind} ${opId}: ${rec.state}`);
    return answerOf(opId, rec);
  }
}
