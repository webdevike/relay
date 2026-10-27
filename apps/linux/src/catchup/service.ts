// Catch Up deck: the feed `catchup-build` writes in the Eva hub (`work/elysia/catchup.json`) plus
// the state this host keeps per item in `$XDG_CONFIG_HOME/relay/catchup-state.json`: when it was
// read, which assistant it was handed to, and an assistant's bounce. The feed file is watched (its
// directory, since the builder replaces it by rename) and every change of feed or state goes out to
// all phones as one `catchup.snapshot`.
//
// Handoff (`catchup.handoff`): the item goes to the assistant's thread as Isaac's turn, with the
// instructions in `handoffMessage`, and is marked read and handed at once (a failed delivery puts it
// back). Bounce (`catchup.bounce`, or `POST /catchup/bounce` from `.omp/tools/catchup.ts`): the
// assistant hands it back, so it is unread again, no longer handed, and first in the deck with its reason.
// Note (`catchup.note`): Isaac says why a card does or does not need him; the note and the card's
// fields are appended as one JSON line to Nova's `catchup-notes.jsonl` (the heartbeat brings each new
// line to Nova, who turns it into the feed's rules). The card's state does not change.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CatchUpFeed, untagged, type CatchUpCard, type CatchUpItem, type CatchUpSignal, type CatchUpSnapshot } from "@relay/protocol";
import { z } from "zod";

/** Marks for ids that left the feed are dropped after this long. */
export const CATCHUP_READ_TTL_MS = 30 * 86_400_000;
/** Coalesces the burst of events one atomic replace produces. */
export const CATCHUP_RELOAD_DEBOUNCE_MS = 150;

export const EMPTY_CATCHUP: CatchUpSnapshot = { items: [], unreadCount: 0 };

const Handed = z.object({ agent: z.string().min(1), at: z.string(), note: z.string().optional() });
const Bounced = z.object({ agent: z.string().min(1), reason: z.string().min(1), at: z.string() });
/** Per item id: when it was read, who it was handed to, and an open bounce (all ISO times). */
const CatchUpState = z.object({
  read: z.record(z.string().min(1), z.string()),
  handed: z.record(z.string().min(1), Handed).default({}),
  bounced: z.record(z.string().min(1), Bounced).default({}),
});
type CatchUpState = z.infer<typeof CatchUpState>;

const EMPTY_STATE: CatchUpState = { read: {}, handed: {}, bounced: {} };

export function defaultCatchUpStatePath(): string {
  const base = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(base, "relay", "catchup-state.json");
}

/** The hub's feed: `RELAY_CATCHUP_FEED`, else `<agentHome>/work/elysia/catchup.json`. */
export function defaultCatchUpFeedPath(agentHome: string | null): string | null {
  const override = process.env["RELAY_CATCHUP_FEED"];
  if (override !== undefined && override !== "") return override;
  return agentHome === null ? null : join(agentHome, "work", "elysia", "catchup.json");
}

/** Isaac's notes for Nova: `RELAY_CATCHUP_NOTES`, else `<agentHome>/work/eva/agents/nova/catchup-notes.jsonl`. */
export function defaultCatchUpNotesPath(agentHome: string | null): string | null {
  const override = process.env["RELAY_CATCHUP_NOTES"];
  if (override !== undefined && override !== "") return override;
  return agentHome === null ? null : join(agentHome, "work", "eva", "agents", "nova", "catchup-notes.jsonl");
}

/** One line of `catchup-notes.jsonl`: Isaac's note and the card it is about. */
export interface CatchUpNote {
  at: string;
  cardId: string;
  source: CatchUpItem["source"];
  label: string;
  title: string;
  kind?: string;
  workspace?: string;
  assistant?: string;
  signal?: CatchUpSignal;
  text: string;
}

/** What an assistant receives for a handed card: the card, Isaac's note, and how to act or bounce. */
export function handoffMessage(item: CatchUpItem, note: string | undefined): string {
  return [
    `[Catch Up handoff] ${item.label}: ${item.title}`,
    item.body.trim(),
    item.url === undefined ? "" : `Link: ${item.url}`,
    note === undefined || note.trim() === "" ? "" : `Isaac's note: ${note.trim()}`,
    "",
    "Work this within your normal permissions. Anything that posts, sends or reviews as Isaac (Slack, email, GitHub comments or reviews) needs his approval first.",
    "If it is outside your scope (Astra: eCard Systems work only; Nova: personal only), you lack the access, or it needs Isaac's own decision, do not guess: bounce it with a one-line reason:",
    `  bun ~/Eva/.omp/tools/catchup.ts bounce ${item.id} "<reason>"`,
    "If you can do part of it, do that part and reply here with the one question you need answered.",
  ]
    .filter((line, index, lines) => line !== "" || (index > 0 && lines[index - 1] !== ""))
    .join("\n");
}

export interface CatchUpServiceDeps {
  feedPath: string;
  statePath: string;
  /** Where `note` appends; absent, notes are refused. */
  notesPath?: string | null;
  /** Called with the new snapshot whenever the feed or state changes. */
  emit: (snapshot: CatchUpSnapshot) => void;
  /** Sends `text` to assistant `agent`'s thread as Isaac's turn; rejects when it cannot. Absent: handoffs are refused. */
  deliver?: (agent: string, text: string) => Promise<void>;
  /** Whether `agent` is an assistant on this host. */
  knows?: (agent: string) => boolean;
  log: (line: string) => void;
  now?: () => number;
}

/** What a phone session needs from the deck. */
export interface CatchUpDeck {
  snapshot(): CatchUpSnapshot;
  /** false when nothing changed (unknown id, or already in that state); a change is emitted to every phone. */
  mark(id: string, read: boolean): boolean;
  /** Hands `id` to `agent`; false (nothing changed) for an unknown id or agent. Delivery runs in the background. */
  handoff(id: string, agent: string, note?: string): boolean;
  /** `agent` hands `id` back; false for an unknown id. */
  bounce(id: string, agent: string, reason: string): boolean;
  /** Appends Isaac's note on `id` for Nova; false (nothing written) for an unknown id, an empty note or no notes file. */
  note(id: string, text: string, signal?: CatchUpSignal): boolean;
}

export class CatchUpService implements CatchUpDeck {
  private items: CatchUpItem[] = [];
  private state: CatchUpState;
  private watcher: FSWatcher | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;

  constructor(private readonly deps: CatchUpServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.state = this.loadState();
    this.loadFeed();
  }

  /**
   * Every feed item in deck order with its state: bounced first (newest bounce first), then the feed's own
   * order, which the builder sets (pinned by Isaac's rules, then importance, then newest, then downranked).
   * A card quoting one of Isaac's prompts shows it without the client's surface tag.
   */
  snapshot(): CatchUpSnapshot {
    const { read, handed, bounced } = this.state;
    const cards: CatchUpCard[] = this.items.map((item) => {
      const bounce = bounced[item.id];
      const to = handed[item.id]?.agent;
      return {
        ...item,
        title: untagged(item.title) || item.label,
        body: untagged(item.body),
        ...(item.why === undefined ? {} : { why: untagged(item.why) }),
        read: item.id in read,
        ...(to === undefined ? {} : { handedTo: to }),
        ...(bounce === undefined ? {} : { bounce: { agent: bounce.agent, reason: bounce.reason, at: bounce.at } }),
      };
    });
    const bounceAt = (card: CatchUpCard): number => (card.bounce === undefined || card.read ? 0 : Date.parse(card.bounce.at) || 1);
    // A stable sort: everything not bounced keeps its place in the feed.
    const items = cards.sort((a, b) => bounceAt(b) - bounceAt(a));
    return { items, unreadCount: items.filter((item) => !item.read).length };
  }

  /** Records `read` for `id` (reading a bounced card closes the bounce); false when nothing changed. */
  mark(id: string, read: boolean): boolean {
    if (!this.has(id)) return false;
    if ((id in this.state.read) === read) return false;
    this.update(id, { read: read ? this.stamp() : null, ...(read ? { bounced: null } : {}) });
    return true;
  }

  handoff(id: string, agent: string, note?: string): boolean {
    const item = this.items.find((candidate) => candidate.id === id);
    const deliver = this.deps.deliver;
    if (item === undefined || deliver === undefined || this.deps.knows?.(agent) === false) return false;
    const trimmed = note?.trim();
    const handed = { agent, at: this.stamp(), ...(trimmed === undefined || trimmed === "" ? {} : { note: trimmed }) };
    this.update(id, { read: this.stamp(), handed, bounced: null });
    deliver(agent, handoffMessage(item, trimmed)).then(
      () => {
        this.deps.log(`catchup: handed ${id} to ${agent}`);
      },
      (error: unknown) => {
        this.deps.log(`catchup: handing ${id} to ${agent} failed: ${error instanceof Error ? error.message : String(error)}`);
        // Back in the deck, unless something else happened to it meanwhile.
        if (this.state.handed[id]?.at === handed.at) this.update(id, { read: null, handed: null });
      },
    );
    return true;
  }

  bounce(id: string, agent: string, reason: string): boolean {
    if (!this.has(id) || reason.trim() === "") return false;
    this.update(id, { read: null, handed: null, bounced: { agent, reason: reason.trim(), at: this.stamp() } });
    this.deps.log(`catchup: ${agent} bounced ${id}: ${reason.trim()}`);
    return true;
  }

  note(id: string, text: string, signal?: CatchUpSignal): boolean {
    const item = this.items.find((candidate) => candidate.id === id);
    const path = this.deps.notesPath;
    const trimmed = text.trim();
    if (item === undefined || path === undefined || path === null || (trimmed === "" && signal === undefined)) return false;
    const line: CatchUpNote = {
      at: this.stamp(),
      cardId: id,
      source: item.source,
      label: item.label,
      title: item.title,
      ...(item.kind === undefined ? {} : { kind: item.kind }),
      ...(item.workspace === undefined ? {} : { workspace: item.workspace }),
      ...(item.assistant === undefined ? {} : { assistant: item.assistant }),
      ...(signal === undefined ? {} : { signal }),
      text: trimmed,
    };
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(line)}\n`);
    } catch (error) {
      this.deps.log(`catchup: cannot write note to ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    this.deps.log(`catchup: note on ${id}${signal === undefined ? "" : ` (${signal})`}`);
    return true;
  }

  /** Re-reads the feed; emits when the snapshot changed. */
  reload(): void {
    const before = JSON.stringify(this.snapshot());
    this.loadFeed();
    const after = this.snapshot();
    if (JSON.stringify(after) !== before) this.deps.emit(after);
  }

  /** Watches the feed's directory; a missing directory is logged and leaves the deck as loaded. */
  start(): void {
    const dir = dirname(this.deps.feedPath);
    const name = basename(this.deps.feedPath);
    if (!existsSync(dir)) {
      this.deps.log(`catchup: ${dir} missing, feed not watched`);
      return;
    }
    try {
      this.watcher = watch(dir, (_event, filename) => {
        if (filename !== null && filename !== name) return;
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          this.reloadTimer = undefined;
          this.reload();
        }, CATCHUP_RELOAD_DEBOUNCE_MS);
      });
      this.watcher.on("error", (error) => {
        this.deps.log(`catchup: watch failed: ${error.message}`);
      });
    } catch (error) {
      this.deps.log(`catchup: cannot watch ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    clearTimeout(this.reloadTimer);
    this.reloadTimer = undefined;
  }

  private has(id: string): boolean {
    return this.items.some((item) => item.id === id);
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  /** Sets (a value) or clears (`null`) each part of `id`'s state, persists, and emits. */
  private update(
    id: string,
    change: { read?: string | null; handed?: z.infer<typeof Handed> | null; bounced?: z.infer<typeof Bounced> | null },
  ): void {
    const put = <V>(record: Record<string, V>, value: V | null | undefined): Record<string, V> => {
      if (value === undefined) return record;
      const rest = Object.fromEntries(Object.entries(record).filter(([key]) => key !== id));
      return value === null ? rest : { ...rest, [id]: value };
    };
    this.state = {
      read: put(this.state.read, change.read),
      handed: put(this.state.handed, change.handed),
      bounced: put(this.state.bounced, change.bounced),
    };
    this.persistState();
    this.deps.emit(this.snapshot());
  }

  /** A missing feed is an empty deck; an unreadable or invalid one keeps the last good items. */
  private loadFeed(): void {
    if (!existsSync(this.deps.feedPath)) {
      this.items = [];
      return;
    }
    try {
      const parsed = CatchUpFeed.safeParse(JSON.parse(readFileSync(this.deps.feedPath, "utf8")));
      if (!parsed.success) {
        this.deps.log(`catchup: ${this.deps.feedPath} invalid: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
        return;
      }
      this.items = parsed.data.items;
    } catch (error) {
      this.deps.log(`catchup: cannot read ${this.deps.feedPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private loadState(): CatchUpState {
    if (!existsSync(this.deps.statePath)) return EMPTY_STATE;
    try {
      const parsed = CatchUpState.safeParse(JSON.parse(readFileSync(this.deps.statePath, "utf8")));
      if (parsed.success) return parsed.data;
      this.deps.log(`catchup: ${this.deps.statePath} invalid, starting with nothing read`);
    } catch (error) {
      this.deps.log(`catchup: cannot read ${this.deps.statePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return EMPTY_STATE;
  }

  /** Writes the state, dropping old entries for ids no longer in the feed. */
  private persistState(): void {
    const live = new Set(this.items.map((item) => item.id));
    const cutoff = this.now() - CATCHUP_READ_TTL_MS;
    const keep = (id: string, at: string): boolean => live.has(id) || Date.parse(at) >= cutoff;
    this.state = {
      read: Object.fromEntries(Object.entries(this.state.read).filter(([id, at]) => keep(id, at))),
      handed: Object.fromEntries(Object.entries(this.state.handed).filter(([id, entry]) => keep(id, entry.at))),
      bounced: Object.fromEntries(Object.entries(this.state.bounced).filter(([id, entry]) => keep(id, entry.at))),
    };
    mkdirSync(dirname(this.deps.statePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.deps.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.deps.statePath);
  }
}
