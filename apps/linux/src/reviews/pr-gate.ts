// The GitHub side of the host's write gate (PLAN §2.5, §2.6): the only way a device's `reviews.req
// prPrepare/prCommit` writes to GitHub as Isaac, by the tickets MutationGate's rules. Every write
// passes, in order: writes enabled on this host; the gh login the device showed equals the login the
// host verified, with gh pinned to the credential it has now for the whole op (`GithubPin`); the op
// store (a repeated opId answers its stored outcome, only to the login and device that started it;
// one left unknown is only read back from GitHub, never sent again); the executor's live check; for
// a confirmed kind a single-use approval bound to the device, the login, the account generation,
// the kind, the payload hash and the revision check() saw at prepare (head, base and outcome for a
// merge); and right before the side effect, the pin is checked again.
//
// Approvals and op records are the tickets gate's own (`Approvals`, `OpsStore`); GitHub's op records
// live apart (`<tickets dir>/github/ops.json`), so the Linear gate's store stays its own.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { prMutationConfirmed, TicketConfirm, type PrMutation, type TicketOutcome, type TicketsRefusalCode, type TicketsResult } from "@relay/protocol";
import { Approvals } from "../tickets/approvals";
import { ProviderRejected, publicError } from "../tickets/errors";
import { canonicalJson, type CheckResult, type MutationExecutor } from "../tickets/gate";
import { OpResult, OpsStore, type OpRecord } from "../tickets/ops-store";

/** The GitHub account and gh credential one PR op runs as. */
export interface GithubPin {
  /** The gh login the pinned credential acts as. */
  readonly login: string;
  /** The host's account generation: moves on every account change, voiding older approvals. */
  readonly generation: number;
  /** SHA-256 of the gh token pinned (the token itself is never kept). */
  readonly credential: string;
  /** The executor over a gh pinned to exactly that credential (check, run and reconcile). */
  readonly github: MutationExecutor<PrMutation>;
}

export interface PrGateDeps {
  /** `<tickets dir>`; records go to `github/ops.json` under it. */
  readonly dir: string;
  readonly writesEnabled: () => boolean;
  /** The verified gh account with gh pinned to its credential now; null while none is verified. */
  readonly pin: () => Promise<GithubPin | null>;
  /** Whether `pin` is still gh's credential, the verified login and generation (asked right before each write). */
  readonly current: (pin: GithubPin) => Promise<boolean>;
  readonly now: () => number;
  readonly log: (line: string) => void;
}

export interface PrCommitRequest {
  readonly approvalId?: string;
  readonly opId: string;
  readonly mutation: PrMutation;
}

type GateAnswer = Omit<TicketsResult, "rid">;
type Checked = Extract<CheckResult, { ok: true }>;
/** Who started an op: only they may retry it or read its outcome. */
interface Authority {
  readonly login: string;
  readonly deviceId: string;
}
interface Running {
  readonly hash: string;
  readonly authority: Authority;
  readonly answer: Promise<GateAnswer>;
}

const MAX_LINE = 2000;
const line = (text: string): string => (text.length > MAX_LINE ? `${text.slice(0, MAX_LINE - 3)}...` : text);
const refuse = (code: TicketsRefusalCode, message: string): GateAnswer => ({ ok: false, refused: { code, message: line(message) } });
const REUSED_ID = refuse("invalid", "This write id was used for a different change");
const OTHER_AUTHORITY = refuse("identity", "This change was started as another GitHub account or on another device");
const STALE_PIN = "The host's GitHub sign-in or account changed while checking. Reload and try again.";
/** Op-store and approval kind (`merge` -> `github.merge`). */
const kindOf = (m: PrMutation): string => `github.${m.kind}`;
const prHash = (m: PrMutation): string => createHash("sha256").update(canonicalJson(m)).digest("hex");

function answerOf(opId: string, rec: OpRecord): GateAnswer {
  const state = rec.state === "running" ? "unknown" : rec.state;
  const result = rec.error === undefined ? rec.result : { ...rec.result, error: rec.error };
  const outcome: TicketOutcome = result === undefined ? { opId, state } : { opId, state, result };
  return state === "failed" ? { ok: false, error: rec.error ?? "Nothing was written", outcome } : { ok: true, outcome };
}

export class PrGate {
  private readonly approvals: Approvals;
  private readonly ops: OpsStore;
  private readonly inflight = new Map<string, Running>();

  constructor(private readonly deps: PrGateDeps) {
    this.approvals = new Approvals(deps.now);
    this.ops = new OpsStore(join(deps.dir, "github"), deps.now);
  }

  /** A confirmed PR write's approval (reviews `prPrepare`); `login`: the GitHub account the device showed. */
  async prepare(deviceId: string, mutation: PrMutation, login: string): Promise<GateAnswer> {
    const pin = await this.allowed(login);
    if (!("generation" in pin)) return pin;
    const checked = await this.check(pin, mutation);
    if (!checked.ok) return checked.answer;
    if (!(await this.deps.current(pin))) return refuse("identity", STALE_PIN);
    // The confirm shows the whole change or nothing: too large to show in full is refused, never clipped.
    const { ok: _ok, revision: _revision, toStateType: _type, ...shown } = checked;
    const confirm = TicketConfirm.safeParse(shown);
    if (!confirm.success) return refuse("invalid", "This change is too large to show in full for confirming; nothing was written");
    const binding = { deviceId, identity: pin.login, generation: pin.generation, kind: kindOf(mutation), hash: prHash(mutation), revision: checked.revision };
    return { ok: true, approval: this.approvals.create(binding, confirm.data) };
  }

  /** A PR write (reviews `prCommit`); `login`: the GitHub account the device showed when Isaac acted. */
  async commit(deviceId: string, req: PrCommitRequest, login: string): Promise<GateAnswer> {
    const pin = await this.allowed(login);
    if (!("generation" in pin)) return pin;
    const hash = prHash(req.mutation);
    const authority: Authority = { login: pin.login, deviceId };
    const running = this.inflight.get(req.opId);
    if (running !== undefined) return this.join(running, hash, authority);
    const rec = this.ops.get(req.opId);
    if (rec !== undefined && rec.hash !== hash) return REUSED_ID;
    if (rec !== undefined && (rec.viewerId !== authority.login || rec.deviceId !== deviceId)) return OTHER_AUTHORITY;
    const answer = rec === undefined ? this.fresh(deviceId, req, pin, hash) : this.resume(req, rec, pin);
    this.inflight.set(req.opId, { hash, authority, answer });
    try {
      return await answer;
    } finally {
      this.inflight.delete(req.opId);
    }
  }

  /** Account or credential change, or revocation: pending approvals are void. */
  invalidate(reason: string): void {
    this.approvals.clear();
    this.deps.log(`reviews pr gate: approvals dropped (${reason})`);
  }

  /** The pinned account and credential when the device saw that login, or the refusal. */
  private async allowed(login: string): Promise<GithubPin | GateAnswer> {
    if (!this.deps.writesEnabled()) return refuse("writesOff", "Writing to GitHub is off on this host");
    let pin: GithubPin | null;
    try {
      pin = await this.deps.pin();
    } catch (e) {
      return { ok: false, error: line(publicError(e, "GitHub")) };
    }
    if (pin === null) return refuse("identity", "The host hasn't confirmed its GitHub account yet. Try again in a moment.");
    if (pin.login !== login) return refuse("identity", "The host now writes as a different GitHub account. Reload and try again.");
    return pin;
  }

  /** A retry while the first try still runs: the same answer, only for the same change, login and device. */
  private join(running: Running, hash: string, authority: Authority): Promise<GateAnswer> | GateAnswer {
    if (running.hash !== hash) return REUSED_ID;
    if (running.authority.login !== authority.login || running.authority.deviceId !== authority.deviceId) return OTHER_AUTHORITY;
    return running.answer;
  }

  private async check(pin: GithubPin, m: PrMutation): Promise<Checked | { ok: false; answer: GateAnswer }> {
    try {
      const checked = await pin.github.check(m);
      return checked.ok ? checked : { ok: false, answer: refuse(checked.code, checked.message) };
    } catch (e) {
      return { ok: false, answer: { ok: false, error: line(publicError(e, "GitHub")) } };
    }
  }

  private async fresh(deviceId: string, req: PrCommitRequest, pin: GithubPin, hash: string): Promise<GateAnswer> {
    const checked = await this.check(pin, req.mutation);
    if (!checked.ok) return checked.answer;
    const needsApproval = prMutationConfirmed(req.mutation) || req.approvalId !== undefined;
    const refused = needsApproval ? this.spendApproval(deviceId, req, { pin, hash, revision: checked.revision }) : null;
    return refused ?? this.write(pin, req, { hash, deviceId, revision: checked.revision });
  }

  /** Null when the commit's approval matches every binding; it is spent either way. */
  private spendApproval(deviceId: string, req: PrCommitRequest, live: { pin: GithubPin; hash: string; revision: string }): GateAnswer | null {
    if (req.approvalId === undefined) return refuse("approval", "Confirm this change first");
    const taken = this.approvals.take(req.approvalId);
    if (!taken.ok) return refuse("approval", taken.message);
    const b = taken.binding;
    const same = b.deviceId === deviceId && b.identity === live.pin.login && b.generation === live.pin.generation && b.kind === kindOf(req.mutation) && b.hash === live.hash;
    if (!same) return refuse("approval", "This confirm was for a different change. Confirm again.");
    return b.revision === live.revision ? null : refuse("conflict", "Changed on GitHub since you confirmed. Check it and confirm again.");
  }

  /**
   * A known opId: its stored outcome, or (unknown) what GitHub shows now. GitHub writes have no
   * caller id, so one GitHub doesn't show stays unknown and is never sent again from here.
   */
  private async resume(req: PrCommitRequest, rec: OpRecord, pin: GithubPin): Promise<GateAnswer> {
    if (rec.state === "done" || rec.state === "failed") return answerOf(req.opId, rec);
    if (rec.credential !== pin.credential) return refuse("identity", "The host's GitHub sign-in changed since this was sent; not sent again. Check the PR on GitHub.");
    const status = await pin.github.reconcile(req.mutation, req.opId, rec.at).catch(() => "unknown" as const);
    this.deps.log(`reviews pr gate: reconciled ${rec.kind} ${req.opId}: ${status}`);
    if (status !== "done") return answerOf(req.opId, { ...rec, state: "unknown" });
    const { error: _lost, ...written } = rec;
    const done: OpRecord = { ...written, state: "done" };
    this.ops.put(req.opId, done);
    return answerOf(req.opId, done);
  }

  /** The side effect, after one last pin check; the record keeps who wrote it and the approved revision. */
  private async write(pin: GithubPin, req: PrCommitRequest, base: { hash: string; deviceId: string; revision: string }): Promise<GateAnswer> {
    if (!(await this.deps.current(pin))) return refuse("identity", STALE_PIN);
    const kind = kindOf(req.mutation);
    const rec0 = { kind, hash: base.hash, at: this.deps.now(), viewerId: pin.login, deviceId: base.deviceId, revision: base.revision, credential: pin.credential };
    this.ops.put(req.opId, { ...rec0, state: "running" });
    let rec: OpRecord;
    try {
      const parsed = OpResult.safeParse(await pin.github.run(req.mutation, req.opId));
      rec = { ...rec0, state: "done", ...(parsed.success ? { result: parsed.data } : {}) };
    } catch (e) {
      rec = { ...rec0, state: e instanceof ProviderRejected ? "failed" : "unknown", error: line(publicError(e, "GitHub")) };
    }
    this.ops.put(req.opId, rec);
    this.deps.log(`reviews pr gate: ${kind} ${req.opId}: ${rec.state}`);
    return answerOf(req.opId, rec);
  }
}
