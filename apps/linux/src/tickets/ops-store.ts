// Durable op store of the tickets MutationGate (PLAN §2.5): `<tickets dir>/ops.json`, one record per
// client-minted opId, so a retried commit answers the stored outcome instead of writing twice. Each
// record keeps the authority it was written under (Linear account, device, approved revision): a
// retry from another account or device is refused, and a stable-id create is only resent at that
// revision. A record still `running` when the host stopped is `unknown` on load: the gate
// reconciles it with the provider and never reapplies it from a read of current state.

import { join } from "node:path";
import { z } from "zod";
import { readJson, writeJson } from "../reviews/exec";

const RowOutcome = z.object({
  key: z.string(),
  opId: z.string(),
  state: z.enum(["done", "failed", "unknown"]),
  error: z.string().optional(),
  /** applyPlan: SHA-256 of the row as sent; the gate dedupes a row opId only for the same change. */
  hash: z.string().optional(),
});

/** What a finished write answered (TicketOutcome.result without `error`). */
export const OpResult = z.object({
  id: z.string().optional(),
  key: z.string().optional(),
  url: z.string().optional(),
  /** A PR merge; an older record's `queued`/`autoMergeArmed` reads as absent rather than dropping the record. */
  merge: z.literal("merged").optional().catch(undefined),
  rows: z.array(RowOutcome).optional(),
});
export type OpResult = z.infer<typeof OpResult>;

export const OpState = z.enum(["running", "done", "failed", "unknown"]);
export type OpState = z.infer<typeof OpState>;

const OpRecord = z.object({
  state: OpState,
  kind: z.string(),
  /** SHA-256 of the mutation's canonical JSON: the same opId with another payload is refused. */
  hash: z.string(),
  /** When the write started (reconcile looks after it). */
  at: z.number(),
  result: OpResult.optional(),
  error: z.string().optional(),
  /** The Linear account the write ran as; "" (a record without one) matches nobody. */
  viewerId: z.string().default(""),
  /** The device that started it; only it may retry or read it. */
  deviceId: z.string().default(""),
  /** check()'s revision the write was approved at (`approval.revision` for a confirmed kind). */
  revision: z.string().default(""),
  /** A non-secret fingerprint of the key it was written with; a resend under another key is refused. */
  credential: z.string().default(""),
});
export type OpRecord = z.infer<typeof OpRecord>;

const OpsFile = z.object({ v: z.literal(1), ops: z.record(z.string(), z.unknown()) });

export const MAX_OPS = 2000;
export const OPS_TTL_MS = 14 * 24 * 60 * 60_000;

/** Readable records of a v1 file (a newer schema or a broken file starts empty). */
function loadOps(file: string): Map<string, OpRecord> {
  const ops = new Map<string, OpRecord>();
  const parsed = OpsFile.safeParse(readJson(file, null));
  if (!parsed.success) return ops;
  for (const [opId, raw] of Object.entries(parsed.data.ops)) {
    const rec = OpRecord.safeParse(raw);
    if (!rec.success) continue;
    ops.set(opId, rec.data.state === "running" ? { ...rec.data, state: "unknown" } : rec.data);
  }
  return ops;
}

export class OpsStore {
  private readonly file: string;
  private readonly ops: Map<string, OpRecord>;

  constructor(
    dir: string,
    private readonly now: () => number,
  ) {
    this.file = join(dir, "ops.json");
    this.ops = loadOps(this.file);
  }

  /** Every record (the gate's applyPlan looks up earlier rows by their own opId). */
  records(): IterableIterator<OpRecord> {
    return this.ops.values();
  }

  get(opId: string): OpRecord | undefined {
    return this.ops.get(opId);
  }

  /** Records the op and writes the file before the caller goes on (a crash after it is recoverable). */
  put(opId: string, record: OpRecord): void {
    this.ops.delete(opId);
    this.ops.set(opId, record);
    this.prune();
    writeJson(this.file, { v: 1, ops: Object.fromEntries(this.ops) });
  }

  private prune(): void {
    const oldest = this.now() - OPS_TTL_MS;
    for (const [opId, rec] of this.ops) if (rec.at < oldest) this.ops.delete(opId);
    if (this.ops.size <= MAX_OPS) return;
    const newest = [...this.ops].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_OPS);
    this.ops.clear();
    for (const [opId, rec] of newest.reverse()) this.ops.set(opId, rec);
  }
}
