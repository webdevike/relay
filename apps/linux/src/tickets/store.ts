// The host's tickets data under `$XDG_CONFIG_HOME/relay/tickets/` (PLAN T0.3, §2.9): synced issues
// and PR facts with the sync's cursor and watermark (`tickets.json`), Relay-only handled marks
// (`handled.json`) and seen watermarks (`seen.json`). Every file is versioned `{v: 1}`; an older host
// ignores them, a file of another version starts empty. The board is revisioned: `publish` compares
// each card's facts with what devices last got and answers one delta (upserts, tombstones) with the
// next `rev`, and keeps those cards, so a read (`board`, subscribe) answers the published revision
// without recomputing or touching the disk. The file is written only when something in it changed.
// Byte caps keep the hot cache bounded: a retained description, each retained comment and all of
// one issue's retained comments are cut to fixed UTF-8 sizes (the ticket page reads them live).

import { join } from "node:path";
import { MAX_TICKETS, Ticket, TicketComment, type TicketBoardFacts, type TicketPrRef, type TicketTeam } from "@relay/protocol";
import { z } from "zod";
import { readJson, writeJson } from "../reviews/exec";
import { EMPTY_HANDLED, type HandledState, type LinearNotice, type PrAttentionInput } from "./attention";
import type { HostIdentity } from "./identity";
import { safeTicketText } from "./linear-sync";

export const MAX_STORED_PRS = 200;
/** UTF-8 bytes of a description kept in the hot cache. */
export const MAX_STORED_DESCRIPTION_BYTES = 8 * 1024;
/** UTF-8 bytes of one comment body kept in the hot cache (a quote: a quarter of it). */
export const MAX_STORED_COMMENT_BYTES = 4 * 1024;
/** UTF-8 bytes of one issue's kept comment bodies together, newest first. */
export const MAX_STORED_COMMENTS_BYTES = 32 * 1024;
/** UTF-8 bytes one cached issue or PR takes serialized: quotes, reactions, links and metadata included. */
export const MAX_STORED_ENTRY_BYTES = 64 * 1024;

/** UTF-8 bytes one board card takes serialized (it carries no description or comments). */
export const MAX_CARD_BYTES = 16 * 1024;
/** UTF-8 bytes of the teams a board answer or snapshot carries. */
export const MAX_TEAMS_BYTES = 256 * 1024;
/** A whole board frame (`tickets.snapshot`, `tickets.delta`, a `board` answer) serialized: every card at its cap, the teams and the status. */
export const MAX_BOARD_FRAME_BYTES = MAX_TICKETS * MAX_CARD_BYTES + MAX_TEAMS_BYTES + 64 * 1024;
/** UTF-8 bytes a card's waiting previews and, once its lists are gone, its titles and names keep. */
const CARD_NAME_BYTES = 100;

/**
 * A card `size` bytes over the cap with its link, label and PR lists cut to the share that fits
 * (at least halved, so it ends); null when they are empty.
 */
function shrinkCardLists(c: TicketBoardFacts, size: number): TicketBoardFacts | null {
  const longest = Math.max(c.children.length, c.relations.length, c.labels.length, c.prFacts.length);
  if (longest === 0) return null;
  const n = Math.min(Math.floor(longest / 2), Math.floor((longest * MAX_CARD_BYTES) / size));
  return { ...c, children: c.children.slice(0, n), relations: c.relations.slice(0, n), labels: c.labels.slice(0, n), prFacts: c.prFacts.slice(0, n) };
}

/** A card's free text cut to CARD_NAME_BYTES each (the last resort; ids, keys and dates stay whole). */
function shortNames(c: TicketBoardFacts): TicketBoardFacts {
  const cut = (s: string): string => clipBytes(s, CARD_NAME_BYTES);
  const person = (p: TicketBoardFacts["assignee"]): TicketBoardFacts["assignee"] => (p === null ? null : { ...p, name: cut(p.name) });
  const needsYou = c.attention.needsYou === null ? null : { ...c.attention.needsYou, text: cut(c.attention.needsYou.text), action: { ...c.attention.needsYou.action, label: cut(c.attention.needsYou.action.label) } };
  return {
    ...c,
    title: cut(c.title),
    state: { ...c.state, name: cut(c.state.name) },
    assignee: person(c.assignee),
    creator: person(c.creator),
    project: c.project === null ? null : { ...c.project, name: cut(c.project.name) },
    milestone: c.milestone === null ? null : { ...c.milestone, name: cut(c.milestone.name) },
    parent: c.parent === null ? null : { ...c.parent, title: cut(c.parent.title) },
    attention: { ...c.attention, needsYou },
  };
}

/** A card's waiting mentions as previews: excerpts, quotes and authors' names cut to CARD_NAME_BYTES. */
function previews(c: TicketBoardFacts): TicketBoardFacts {
  const cut = (s: string): string => clipBytes(s, CARD_NAME_BYTES);
  const waiting = c.attention.waiting.map((w) => ({ ...w, excerpt: cut(w.excerpt), author: { ...w.author, name: cut(w.author.name) }, anchor: w.anchor.kind === "inline" ? { ...w.anchor, quotedText: cut(w.anchor.quotedText) } : w.anchor }));
  return { ...c, attention: { ...c.attention, waiting } };
}

/**
 * A board card at most MAX_CARD_BYTES serialized, with its JSON. Its waiting mentions are always
 * previews (the ticket page has them whole); over the cap, in order until it fits: its link, label
 * and PR lists are cut, its titles and names are cut, and last its waiting mentions are halved.
 * Deterministic.
 */
export function boundCard(card: TicketBoardFacts): { card: TicketBoardFacts; json: string } {
  let cur = previews(card);
  let json = JSON.stringify(cur);
  // A UTF-16 unit is at most 3 UTF-8 bytes: most cards need no encoding to know they fit.
  if (json.length * 3 <= MAX_CARD_BYTES) return { card: cur, json };
  for (let size = Buffer.byteLength(json, "utf8"); size > MAX_CARD_BYTES; size = jsonBytes(cur)) {
    const next = shrinkCardLists(cur, size);
    if (next === null) break;
    cur = next;
  }
  if (jsonBytes(cur) > MAX_CARD_BYTES) cur = shortNames(cur);
  // Waiting mentions go last: they are what the card is for.
  while (cur.attention.waiting.length > 0 && jsonBytes(cur) > MAX_CARD_BYTES) cur = { ...cur, attention: { ...cur.attention, waiting: cur.attention.waiting.slice(0, Math.floor(cur.attention.waiting.length / 2)) } };
  json = JSON.stringify(cur);
  return { card: cur, json };
}

/** The teams within MAX_TEAMS_BYTES serialized: the first ones that fit, in order. */
export function boundTeams(teams: readonly TicketTeam[]): TicketTeam[] {
  const kept: TicketTeam[] = [];
  let total = 2;
  for (const team of teams) {
    const size = jsonBytes(team) + 1;
    if (total + size > MAX_TEAMS_BYTES) break;
    total += size;
    kept.push(team);
  }
  return kept;
}

/** A comment's reactions as the cache keeps them: 10 emoji, 10 people each. */
const fewReactions = (c: TicketComment): TicketComment =>
  c.reactions.length <= 10 && c.reactions.every((r) => r.users.length <= 10) ? c : { ...c, reactions: c.reactions.slice(0, 10).map((r) => ({ ...r, users: r.users.slice(0, 10) })) };

/** The newest items whose bodies (each cut to `each` UTF-8 bytes) fit `budget` together, oldest first. */
function newestWithin<T extends { readonly body: string }>(items: readonly T[], each: number, budget: number): T[] {
  const kept: T[] = [];
  let left = budget;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as T;
    const body = clipBytes(item.body, each);
    const size = Buffer.byteLength(body, "utf8");
    if (size > left) break;
    left -= size;
    kept.push({ ...item, body });
  }
  return kept.reverse();
}

/** What the host left out of an issue: the description was cut, `comments` older comments dropped. */
export interface Clipped {
  readonly description: boolean;
  readonly comments: number;
}

export interface IssueEntry {
  readonly ticket: Ticket;
  /** The newest comments, oldest first (the ticket page reads all of them live). */
  readonly comments: readonly TicketComment[];
  /** Set when the cache or a frame bound cut it. */
  readonly clipped?: Clipped | undefined;
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

const Entry = z.object({
  ticket: Ticket,
  comments: z.array(TicketComment),
  clipped: z.object({ description: z.boolean(), comments: z.number().int().nonnegative() }).optional(),
});
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

/** `s` cut to at most `max` UTF-8 bytes, at a character boundary. */
export function clipBytes(s: string, max: number): string {
  // A UTF-16 unit is at most 3 UTF-8 bytes: short strings need no encoding.
  if (s.length * 3 <= max) return s;
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return s;
  let cut = max;
  while (cut > 0 && ((buf[cut] ?? 0) & 0xc0) === 0x80) cut--;
  return buf.subarray(0, cut).toString("utf8");
}

/**
 * The newest comments whose bodies fit `budget` UTF-8 bytes together (each body first cut to
 * `each`, a quote to a quarter of it), oldest first, and how many older ones were left out.
 */
export function boundComments(comments: readonly TicketComment[], each: number, budget: number): { comments: TicketComment[]; dropped: number } {
  const kept: TicketComment[] = [];
  let left = budget;
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i] as TicketComment;
    const body = clipBytes(c.body, each);
    const size = Buffer.byteLength(body, "utf8");
    if (size > left) break;
    left -= size;
    kept.push({ ...c, body, quotedText: c.quotedText === null ? null : clipBytes(c.quotedText, Math.floor(each / 4)) });
  }
  return { comments: kept.reverse(), dropped: comments.length - kept.length };
}

/** UTF-8 bytes of `v` as JSON: what a cache entry or a frame actually takes. */
export const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");

/** The largest `clipped` an entry or page can carry, reserved before it is known. */
export const WORST_CLIPPED: Clipped = { description: true, comments: 9_999_999 };

/**
 * The newest `items` (oldest first) that fit `cap` serialized next to `base` bytes for the rest of
 * the object (each item counted with its separating comma). Deterministic: newest first, stop at the
 * first one that doesn't fit.
 */
export function newestFitting<T>(items: readonly T[], base: number, cap: number): T[] {
  const kept: T[] = [];
  let total = base;
  for (let i = items.length - 1; i >= 0; i--) {
    const size = jsonBytes(items[i]) + 1;
    if (total + size > cap) break;
    total += size;
    kept.push(items[i] as T);
  }
  return kept.reverse();
}

interface Listed {
  readonly children: readonly unknown[];
  readonly relations: readonly unknown[];
  readonly labels: readonly unknown[];
  readonly description: string;
}

/**
 * `x` (a ticket or a ticket page) halved until its JSON fits `budget`: its link and label lists by
 * half, then its description by half. Fields the protocol already bounds (titles, names) stay.
 */
export function fitLists<T extends Listed>(x: T, budget: number): T {
  let cur = x;
  while (jsonBytes(cur) > budget) {
    const longest = Math.max(cur.children.length, cur.relations.length, cur.labels.length);
    if (longest > 0) {
      const n = Math.floor(longest / 2);
      cur = { ...cur, children: cur.children.slice(0, n), relations: cur.relations.slice(0, n), labels: cur.labels.slice(0, n) };
    } else if (cur.description !== "") {
      cur = { ...cur, description: clipBytes(cur.description, Math.floor(Buffer.byteLength(cur.description, "utf8") / 2)) };
    } else break;
  }
  return cur;
}

/**
 * An issue as the hot cache keeps it, at most MAX_STORED_ENTRY_BYTES serialized (escapes, quotes,
 * reactions and metadata included): description, comments and their total cut to the byte caps and
 * reactions thinned; then the ticket's lists and description halved until it takes at most half;
 * then the newest comments that fit the rest.
 */
function retained(entry: IssueEntry): IssueEntry {
  const description = clipBytes(entry.ticket.description, MAX_STORED_DESCRIPTION_BYTES);
  const bounded = boundComments(entry.comments.map(fewReactions), MAX_STORED_COMMENT_BYTES, MAX_STORED_COMMENTS_BYTES);
  const ticket = fitLists(description === entry.ticket.description ? entry.ticket : { ...entry.ticket, description }, MAX_STORED_ENTRY_BYTES / 2);
  const comments = newestFitting(bounded.comments, jsonBytes({ ticket, comments: [], clipped: WORST_CLIPPED }), MAX_STORED_ENTRY_BYTES);
  const dropped = entry.comments.length - comments.length;
  const clipped = { description: ticket.description.length < entry.ticket.description.length || entry.clipped?.description === true, comments: dropped + (entry.clipped?.comments ?? 0) };
  return clipped.description || clipped.comments > 0 ? { ticket, comments, clipped } : { ticket, comments };
}

/**
 * A PR as the cache keeps it, at most MAX_STORED_ENTRY_BYTES serialized: thread comment bodies cut
 * like Linear's (4 KiB each, 32 KiB together, newest kept) and then made media-safe (only what is
 * kept is parsed; a URL cut at the end is still redacted by its host or its signed parameter),
 * then the newest that fit the cap.
 */
function retainedPr(entry: PrEntry): PrEntry {
  if (entry.input === null) return entry;
  const kept = newestWithin(entry.input.comments, MAX_STORED_COMMENT_BYTES, MAX_STORED_COMMENTS_BYTES);
  const safe = kept.map((c) => ({ ...c, body: safeTicketText(c.body) }));
  const base = jsonBytes({ ...entry, input: { ...entry.input, comments: [] } });
  const comments = newestFitting(safe, base, MAX_STORED_ENTRY_BYTES);
  return { ...entry, input: { ...entry.input, comments } };
}

function loadIssues(raw: Record<string, unknown>): Map<string, IssueEntry> {
  const issues = new Map<string, IssueEntry>();
  for (const [key, value] of Object.entries(raw)) {
    const parsed = Entry.safeParse(value);
    if (parsed.success) issues.set(key, retained(parsed.data));
  }
  return issues;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export class TicketsStore {
  private readonly path: string;
  rev = 0;
  private readonly issues: Map<string, IssueEntry>;
  private readonly prs: Map<string, PrEntry>;
  /** Keys gone from the board in the last 24 h, and whether Linear stopped answering them. */
  private readonly tombstones: Map<string, { at: number; accessLost: boolean }>;
  sync: SyncState;
  /** The cards devices last got, with their JSON, by key: what `publish` compares and `board` answers. */
  private readonly published = new Map<string, { readonly json: string; readonly card: TicketBoardFacts }>();
  /** Something in tickets.json changed since it was last written. */
  private dirty = false;

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

  /** Keeps the issue cut to the byte caps; an unchanged one changes nothing. */
  upsert(entry: IssueEntry): void {
    const kept = retained(entry);
    const key = kept.ticket.key;
    if (this.tombstones.delete(key)) this.dirty = true;
    if (same(this.issues.get(key), kept)) return;
    this.issues.set(key, kept);
    this.dirty = true;
  }

  /** Gone from the board: out of membership, over the cap, or `accessLost` (Linear no longer answers it). */
  tombstone(key: string, accessLost = false): void {
    this.issues.delete(key);
    this.tombstones.set(key, { at: this.now(), accessLost });
    this.dirty = true;
  }

  /** Lost access within the last 24 h: not read again by key until then. */
  accessLost(key: string): boolean {
    return this.tombstones.get(key)?.accessLost === true;
  }

  purgeTombstones(keepMs: number): void {
    const cutoff = this.now() - keepMs;
    for (const [key, t] of this.tombstones) {
      if (t.at >= cutoff) continue;
      this.tombstones.delete(key);
      this.dirty = true;
    }
  }

  pr(ref: TicketPrRef): PrEntry | undefined {
    return this.prs.get(prId(ref));
  }

  setPr(entry: PrEntry): void {
    const id = prId(entry.ref);
    const kept = retainedPr(entry);
    if (same(this.prs.get(id), kept)) return;
    this.prs.set(id, kept);
    this.dirty = true;
  }

  /** PRs the stored tickets link, newest tickets first, capped; PR entries no ticket links are dropped. */
  linkedPrs(): TicketPrRef[] {
    const refs = new Map<string, TicketPrRef>();
    const tickets = this.entries().sort((a, b) => b.ticket.updatedAt - a.ticket.updatedAt);
    for (const { ticket } of tickets) for (const ref of ticket.prs) if (refs.size < MAX_STORED_PRS) refs.set(prId(ref), ref);
    for (const id of this.prs.keys()) {
      if (refs.has(id)) continue;
      this.prs.delete(id);
      this.dirty = true;
    }
    return [...refs.values()];
  }

  setSync(patch: Partial<SyncState>): void {
    const keys = Object.keys(patch) as (keyof SyncState)[];
    if (keys.every((k) => same(this.sync[k], patch[k]))) return;
    this.sync = { ...this.sync, ...patch };
    this.dirty = true;
  }

  /** Another account: every issue, PR, cursor and watermark goes; the identity is kept. */
  wipe(identity: HostIdentity): void {
    this.issues.clear();
    this.prs.clear();
    this.tombstones.clear();
    this.sync = { ...EMPTY_SYNC, identity };
    this.dirty = true;
  }

  /** Over MAX_TICKETS: the least recently updated tickets not in `keep` are tombstoned. */
  private cap(keep: ReadonlySet<string>): void {
    if (this.issues.size <= MAX_TICKETS) return;
    const order = this.entries()
      .filter((e) => !keep.has(e.ticket.key))
      .sort((a, b) => a.ticket.updatedAt - b.ticket.updatedAt);
    for (const e of order.slice(0, this.issues.size - MAX_TICKETS)) this.tombstone(e.ticket.key);
  }

  /** The board at `rev` as devices last got it: no recomputation, no disk. */
  board(): TicketBoardFacts[] {
    return [...this.published.values()].map((p) => p.card);
  }

  /**
   * Cards whose facts changed since the last publish, and keys gone: one delta with the next rev,
   * or null when nothing changed. Writes the store only when something in it changed.
   */
  publish(facts: (entry: IssueEntry) => TicketBoardFacts, keep: ReadonlySet<string>): BoardDelta | null {
    this.cap(keep);
    const upserts: TicketBoardFacts[] = [];
    for (const entry of this.issues.values()) {
      const { card, json } = boundCard(facts(entry));
      if (this.published.get(card.key)?.json === json) continue;
      this.published.set(card.key, { json, card });
      upserts.push(card);
    }
    const tombstones = [...this.published.keys()].filter((key) => !this.issues.has(key));
    for (const key of tombstones) this.published.delete(key);
    const changed = upserts.length > 0 || tombstones.length > 0;
    const base = this.rev;
    if (changed) {
      this.rev += 1;
      this.dirty = true;
    }
    this.save();
    return changed ? { rev: this.rev, base, upserts, tombstones } : null;
  }

  /** Marks every card published at the current rev (a snapshot went out). */
  markPublished(facts: (entry: IssueEntry) => TicketBoardFacts): void {
    this.published.clear();
    for (const entry of this.issues.values()) {
      const { card, json } = boundCard(facts(entry));
      this.published.set(card.key, { json, card });
    }
  }

  /** A snapshot-worthy change (wipe): the next rev with nothing to diff against. */
  bump(): void {
    this.rev += 1;
    this.published.clear();
    this.dirty = true;
    this.save();
  }

  /** Writes tickets.json when something in it changed since the last write. */
  save(): void {
    if (!this.dirty) return;
    writeJson(this.path, {
      v: 1,
      rev: this.rev,
      issues: Object.fromEntries(this.issues),
      prs: Object.fromEntries(this.prs),
      tombstones: Object.fromEntries(this.tombstones),
      sync: this.sync,
    });
    this.dirty = false;
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
