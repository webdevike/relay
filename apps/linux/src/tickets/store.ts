// The host's tickets data under `$XDG_CONFIG_HOME/relay/tickets/` (PLAN T0.3, §2.9): synced issues
// and PR facts with the sync's cursor and watermark (`tickets.json`), Relay-only handled marks
// (`handled.json`) and seen watermarks (`seen.json`). Every file is versioned `{v: 1}`; an older host
// ignores them, a file of another version starts empty. The board is revisioned: `publish` compares
// each card's facts with what devices last got and answers one delta (upserts, tombstones) with the
// next `rev`.

import { join } from "node:path";
import { MAX_TICKETS, Ticket, TicketComment, type TicketBoardFacts, type TicketPrRef, type TicketTeam } from "@relay/protocol";
import { z } from "zod";
import { readJson, writeJson } from "../reviews/exec";
import { EMPTY_HANDLED, type HandledState, type LinearNotice, type PrAttentionInput } from "./attention";
import type { HostIdentity } from "./identity";

export const MAX_STORED_PRS = 200;

export interface IssueEntry {
  readonly ticket: Ticket;
  /** The newest comments, oldest first (the ticket page reads all of them live). */
  readonly comments: readonly TicketComment[];
}

/** One PR's last probe and facts; `input` null: never read or no access. */
export interface PrEntry {
  readonly ref: TicketPrRef;
  readonly fingerprint: string | null;
  readonly input: PrAttentionInput | null;
  readonly noAccess: boolean;
}

/** A pass cut short by the page limit: resumed with the same filter. */
export interface SyncCursor {
  readonly since: number;
  readonly first: boolean;
  readonly after: string | null;
  readonly maxSeen: number;
}

export interface SyncState {
  readonly identity: HostIdentity | null;
  readonly cursor: SyncCursor | null;
  /** Issues changed after this were not read yet; null before the first full pass. */
  readonly watermark: number | null;
  readonly reconciledAt: number | null;
  readonly notices: readonly LinearNotice[];
  readonly noticesAt: number | null;
  readonly lastSyncAt: number | null;
  /** The synced tickets' teams with their workflow states, and when they were read. */
  readonly teams: readonly TicketTeam[];
  readonly teamsAt: number | null;
}

const EMPTY_SYNC: SyncState = { identity: null, cursor: null, watermark: null, reconciledAt: null, notices: [], noticesAt: null, lastSyncAt: null, teams: [], teamsAt: null };

const Entry = z.object({ ticket: Ticket, comments: z.array(TicketComment) });
const StoreFile = z.object({
  v: z.literal(1),
  rev: z.number().int().nonnegative(),
  issues: z.record(z.string(), z.unknown()),
  prs: z.record(z.string(), z.unknown()),
  tombstones: z.record(z.string(), z.object({ at: z.number(), accessLost: z.boolean() })),
  sync: z.record(z.string(), z.unknown()),
});

export const prId = (ref: TicketPrRef): string => `${ref.repo}#${String(ref.number)}`;

export interface BoardDelta {
  readonly rev: number;
  readonly base: number;
  readonly upserts: TicketBoardFacts[];
  readonly tombstones: string[];
}

function loadIssues(raw: Record<string, unknown>): Map<string, IssueEntry> {
  const issues = new Map<string, IssueEntry>();
  for (const [key, value] of Object.entries(raw)) {
    const parsed = Entry.safeParse(value);
    if (parsed.success) issues.set(key, parsed.data);
  }
  return issues;
}

export class TicketsStore {
  private readonly path: string;
  rev = 0;
  private readonly issues: Map<string, IssueEntry>;
  private readonly prs: Map<string, PrEntry>;
  /** Keys gone from the board in the last 24 h, and whether Linear stopped answering them. */
  private readonly tombstones: Map<string, { at: number; accessLost: boolean }>;
  sync: SyncState;
  /** The facts devices last got, as JSON, by key: what `publish` compares against. */
  private readonly published = new Map<string, string>();

  constructor(
    readonly dir: string,
    private readonly now: () => number,
  ) {
    this.path = join(dir, "tickets.json");
    const file = StoreFile.safeParse(readJson(this.path, null));
    // Missing, unreadable or another version: start empty.
    const data = file.success ? file.data : { v: 1, rev: 0, issues: {}, prs: {}, tombstones: {}, sync: {} };
    this.rev = data.rev;
    this.issues = loadIssues(data.issues);
    this.prs = new Map(Object.entries(data.prs as Record<string, PrEntry>));
    this.tombstones = new Map(Object.entries(data.tombstones));
    this.sync = { ...EMPTY_SYNC, ...(data.sync as Partial<SyncState>) };
  }

  issue(key: string): IssueEntry | undefined {
    return this.issues.get(key);
  }

  keys(): string[] {
    return [...this.issues.keys()];
  }

  entries(): IssueEntry[] {
    return [...this.issues.values()];
  }

  upsert(entry: IssueEntry): void {
    this.issues.set(entry.ticket.key, entry);
    this.tombstones.delete(entry.ticket.key);
  }

  /** Gone from the board: out of membership, over the cap, or `accessLost` (Linear no longer answers it). */
  tombstone(key: string, accessLost = false): void {
    this.issues.delete(key);
    this.tombstones.set(key, { at: this.now(), accessLost });
  }

  /** Lost access within the last 24 h: not read again by key until then. */
  accessLost(key: string): boolean {
    return this.tombstones.get(key)?.accessLost === true;
  }

  purgeTombstones(keepMs: number): void {
    const cutoff = this.now() - keepMs;
    for (const [key, t] of this.tombstones) if (t.at < cutoff) this.tombstones.delete(key);
  }

  pr(ref: TicketPrRef): PrEntry | undefined {
    return this.prs.get(prId(ref));
  }

  setPr(entry: PrEntry): void {
    this.prs.set(prId(entry.ref), entry);
  }

  /** PRs the stored tickets link, newest tickets first, capped; PR entries no ticket links are dropped. */
  linkedPrs(): TicketPrRef[] {
    const refs = new Map<string, TicketPrRef>();
    const tickets = this.entries().sort((a, b) => b.ticket.updatedAt - a.ticket.updatedAt);
    for (const { ticket } of tickets) for (const ref of ticket.prs) if (refs.size < MAX_STORED_PRS) refs.set(prId(ref), ref);
    for (const id of this.prs.keys()) if (!refs.has(id)) this.prs.delete(id);
    return [...refs.values()];
  }

  setSync(patch: Partial<SyncState>): void {
    this.sync = { ...this.sync, ...patch };
  }

  /** Another account: every issue, PR, cursor and watermark goes; the identity is kept. */
  wipe(identity: HostIdentity): void {
    this.issues.clear();
    this.prs.clear();
    this.tombstones.clear();
    this.sync = { ...EMPTY_SYNC, identity };
  }

  /** Over MAX_TICKETS: the least recently updated tickets not in `keep` are tombstoned. */
  private cap(keep: ReadonlySet<string>): void {
    if (this.issues.size <= MAX_TICKETS) return;
    const order = this.entries()
      .filter((e) => !keep.has(e.ticket.key))
      .sort((a, b) => a.ticket.updatedAt - b.ticket.updatedAt);
    for (const e of order.slice(0, this.issues.size - MAX_TICKETS)) this.tombstone(e.ticket.key);
  }

  /** The board as devices see it, with every card's facts from `facts`. */
  board(facts: (entry: IssueEntry) => TicketBoardFacts): TicketBoardFacts[] {
    return this.entries().map(facts);
  }

  /**
   * Cards whose facts changed since the last publish, and keys gone: one delta with the next rev,
   * or null when nothing changed. Saves the store either way.
   */
  publish(facts: (entry: IssueEntry) => TicketBoardFacts, keep: ReadonlySet<string>): BoardDelta | null {
    this.cap(keep);
    const upserts: TicketBoardFacts[] = [];
    for (const entry of this.issues.values()) {
      const card = facts(entry);
      const json = JSON.stringify(card);
      if (this.published.get(card.key) === json) continue;
      this.published.set(card.key, json);
      upserts.push(card);
    }
    const tombstones = [...this.published.keys()].filter((key) => !this.issues.has(key));
    for (const key of tombstones) this.published.delete(key);
    const changed = upserts.length > 0 || tombstones.length > 0;
    const base = this.rev;
    if (changed) this.rev += 1;
    this.save();
    return changed ? { rev: this.rev, base, upserts, tombstones } : null;
  }

  /** Marks every card published at the current rev (a snapshot went out). */
  markPublished(facts: (entry: IssueEntry) => TicketBoardFacts): void {
    this.published.clear();
    for (const entry of this.issues.values()) this.published.set(entry.ticket.key, JSON.stringify(facts(entry)));
  }

  /** A snapshot-worthy change (wipe): the next rev with nothing to diff against. */
  bump(): void {
    this.rev += 1;
    this.published.clear();
    this.save();
  }

  save(): void {
    writeJson(this.path, {
      v: 1,
      rev: this.rev,
      issues: Object.fromEntries(this.issues),
      prs: Object.fromEntries(this.prs),
      tombstones: Object.fromEntries(this.tombstones),
      sync: this.sync,
    });
  }
}

const HandledFile = z.object({
  v: z.literal(1),
  mentions: z.record(z.string(), z.object({ commentId: z.string(), at: z.number() })),
  needs: z.record(z.string(), z.string()),
});
const SeenFile = z.object({ v: z.literal(1), seen: z.record(z.string(), z.number()) });

/** `handled.json`: Mark as handled, Relay-only (§2.14). */
export class HandledStore {
  private readonly path: string;
  state: HandledState;

  constructor(dir: string) {
    this.path = join(dir, "handled.json");
    const parsed = HandledFile.safeParse(readJson(this.path, null));
    this.state = parsed.success ? parsed.data : EMPTY_HANDLED;
  }

  set(state: HandledState): void {
    this.state = state;
    writeJson(this.path, state);
  }
}

/** `seen.json`: when Isaac last opened each ticket. */
export class SeenStore {
  private readonly path: string;
  private readonly seen: Record<string, number>;

  constructor(dir: string) {
    this.path = join(dir, "seen.json");
    const parsed = SeenFile.safeParse(readJson(this.path, null));
    this.seen = parsed.success ? parsed.data.seen : {};
  }

  /** Stores `now` for `key`; answers the visit before (null on a first visit). */
  visit(key: string, now: number): number | null {
    const previous = this.seen[key] ?? null;
    this.seen[key] = now;
    writeJson(this.path, { v: 1, seen: this.seen });
    return previous;
  }
}
