// Pending approvals of the tickets MutationGate (PLAN §2.5): in memory only, single use, 120 s.
// A host restart drops them, so a confirm open across a restart is asked again.

import { randomUUID } from "node:crypto";
import type { TicketApproval } from "@relay/protocol";

export const APPROVAL_TTL_MS = 120_000;

/** What one approval is good for; `commit` must match every field. */
export interface ApprovalBinding {
  readonly deviceId: string;
  /** The Linear viewer id Isaac saw when he confirmed. */
  readonly identity: string;
  readonly kind: string;
  /** SHA-256 of the mutation's canonical JSON. */
  readonly hash: string;
  /** Live provider state from `check()` at prepare (state id, reply count, ...). */
  readonly revision: string;
}

interface Pending {
  readonly binding: ApprovalBinding;
  readonly expiresAt: number;
}

export type TakenApproval = { ok: true; binding: ApprovalBinding } | { ok: false; message: string };

export class Approvals {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly now: () => number,
    private readonly ttlMs = APPROVAL_TTL_MS,
  ) {}

  create(binding: ApprovalBinding, summary: string): TicketApproval {
    this.prune();
    const id = randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    this.pending.set(id, { binding, expiresAt });
    return { id, expiresAt, summary };
  }

  /** Removes the approval (single use, also when the commit then refuses) and answers its binding. */
  take(id: string): TakenApproval {
    const found = this.pending.get(id);
    this.pending.delete(id);
    if (found === undefined) return { ok: false, message: "This confirm was already used or cancelled. Confirm again." };
    if (this.now() > found.expiresAt) return { ok: false, message: "This confirm expired. Confirm again." };
    return { ok: true, binding: found.binding };
  }

  /** Identity change or revocation: nothing confirmed before it may be written. */
  clear(): void {
    this.pending.clear();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, p] of this.pending) if (now > p.expiresAt) this.pending.delete(id);
  }
}
