// Open asks, the keeping half: the questions an assistant thread asked Isaac that he has not
// answered, in `$XDG_CONFIG_HOME/relay/assistants/<id>.asks.json` (dir 0700, file 0600, written
// atomically like `store.ts`). Three sources feed it:
//   - assistant rows that end on a `[[replies: a | b]]` token, which the thread's snapshots hand
//     over every time (`observe`); a row is known by its time and question, not its message id,
//     since an earlier context's rows get new ids after the nightly rollover;
//   - omp `ask` tool cards, as the bridge reports them (`addCard`, `cardResolved`);
//   - questions another omp session puts to Isaac through the thread (`relay-linux asks add`,
//     `addSession`), whose answer goes back to that session, not into the thread.
// An ask closes when Isaac taps an answer (the `assistant.ask.resolve` command), dismisses it, or
// the assistant resolves it (`relay-linux asks resolve`). The thread's own asks (the first two
// sources) also close on their own from his later turns: one that is exactly one of its answers or
// names it in an `[answer to: "..."]` tag answers it; one a model judge reads as clearly answering
// or settling it answers it (`unjudged`/`judged`, run by the service); and `ASK_LAPSE_TURNS` later
// turns that did neither leave it behind (resolved). A session's ask never closes from the thread:
// its answer goes back to the asking session. `since` is when the file was first made: rows older
// than it never become asks, so an upgrade does not flood the badges with the thread's history.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type AgentAsk, answerExcerpt, answerTagOf, type AssistantMessage, MAX_ASK_LABEL, MAX_ASK_QUESTION, MAX_OPEN_ASKS, OpenAsk } from "@relay/protocol";
import { z } from "zod";
import { askId, askKey, askLabel, askQuestion, clipAt, withoutLeadIn } from "./asks";

/** How long a closed ask is kept (so its rows cannot raise it again) before it is pruned. */
export const CLOSED_ASK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Most answers an ask carries, and their longest (the protocol's limits). */
export const MAX_ASK_REPLIES = 8;
export const MAX_ASK_REPLY = 80;
/** Longest `from` of a session's ask (the protocol's limit). */
export const MAX_ASK_FROM = 80;
/** Isaac's turns after a thread's ask that neither answer it nor name it before it closes as left behind. */
export const ASK_LAPSE_TURNS = 3;

export type AskState = "open" | "answered" | "dismissed" | "resolved";

const StoredAsk = OpenAsk.extend({
  state: z.enum(["open", "answered", "dismissed", "resolved"]),
  closedAt: z.number().int().nonnegative().optional(),
  /** Every source key this ask was seen under: `<at>:<askKey>` for a replies row, `ask:<session>:<ask id>` for a card, `session:<session|none>:<askKey>:<at>` for a session's ask. */
  keys: z.array(z.string().min(1)),
  /** What Isaac answered, when the answer came with words (a session's ask). */
  answer: z.string().min(1).optional(),
  /** A session's ask: its answer reached the asking session. */
  delivered: z.boolean().optional(),
  /** The time of his latest later turn the judge has read for this ask; turns up to it are not judged again. */
  judgedTo: z.number().int().nonnegative().optional(),
});
export type StoredAsk = z.infer<typeof StoredAsk>;

/** A thread's open ask with turns of Isaac's after it the judge has not read yet (`AskStore.unjudged`). */
export interface AskCase {
  readonly id: string;
  readonly question: string;
  /** Every turn of his after the ask, oldest first. */
  readonly said: readonly string[];
  /** The assistant's reply after his latest turn, when it has one. */
  readonly reply?: string;
  /** The time of his latest turn: what `judged` records. */
  readonly upTo: number;
}

/** A question another omp session puts to Isaac (`addSession`). */
export interface SessionAskInput {
  /** The asking session's title, e.g. "Golf". */
  readonly from: string;
  /** The live session the answer goes to; undefined when the asker named none. */
  readonly sessionId?: string;
  readonly question: string;
  readonly options: readonly string[];
  /** What the session goes with unless Isaac says otherwise; one of `options`. */
  readonly default?: string;
}

const AskRecord = z.object({ since: z.number().int().nonnegative(), asks: z.array(StoredAsk) });
type AskRecord = z.infer<typeof AskRecord>;

/** The asks file of registry agent `id`, beside its thread file. */
export function defaultAsksPath(id: string): string {
  const base = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(base, "relay", "assistants", `${id}.asks.json`);
}

/** One thread's open asks; `path` null keeps them in memory only (tests). `now` is the clock. */
export class AskStore {
  private record: AskRecord | null = null;

  constructor(
    private readonly path: string | null,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Takes the thread as a snapshot shows it. `asking` holds the ids of the settled assistant rows
   * that end on answers, with their `[[ask-label]]` when they gave one. A row since `since` with a
   * question becomes an ask, or refreshes the open ask that asks the same thing. A user row after
   * an open ask of the thread that is exactly one of its answers (case aside), or whose answer tag
   * names its question, answers it; the `ASK_LAPSE_TURNS`th that does neither resolves it. True
   * when anything changed.
   */
  observe(rows: readonly AssistantMessage[], asking: ReadonlyMap<string, string | undefined>): boolean {
    const record = this.load();
    let changed = this.prune(record);
    const byKey = new Map<string, StoredAsk>();
    for (const ask of record.asks) for (const key of ask.keys) byKey.set(key, ask);
    const position = new Map<string, number>();
    rows.forEach((row, index) => position.set(row.id, index));
    /** Isaac's turns after each open ask so far that did not close it. */
    const passed = new Map<string, number>();
    rows.forEach((row, index) => {
      if (row.role === "user") {
        const said = row.text.trim();
        const tag = answerTagOf(said);
        for (const ask of record.asks) {
          if (ask.state !== "open" || ask.source === "session" || !this.after(ask, row, index, position)) continue;
          const answers = tag === null ? ask.replies.some((reply) => reply.toLowerCase() === said.toLowerCase()) : tag.question === answerExcerpt(ask.question);
          if (answers) {
            changed = this.close(ask, "answered") || changed;
            if (tag !== null && tag.answer.trim() !== "") ask.answer = tag.answer.trim();
            continue;
          }
          const n = (passed.get(ask.id) ?? 0) + 1;
          passed.set(ask.id, n);
          if (n >= ASK_LAPSE_TURNS) changed = this.close(ask, "resolved") || changed;
        }
        return;
      }
      if (row.role !== "assistant" || !asking.has(row.id) || row.at < record.since) return;
      const question = askQuestion(row.text);
      if (question === "") return;
      const key = `${row.at}:${askKey(question)}`;
      const known = byKey.get(key);
      if (known !== undefined) {
        // The same row under a new id (an earlier context read back after the rollover).
        if (known.messageId !== row.id && known.source === "replies") {
          known.messageId = row.id;
          changed = true;
        }
        return;
      }
      const ask = this.take(record, key, {
        source: "replies",
        label: askLabel(question, asking.get(row.id)),
        question,
        replies: row.replies ?? [],
        at: row.at,
        messageId: row.id,
      });
      byKey.set(key, ask);
      changed = true;
    });
    if (changed) this.save(record);
    return changed;
  }

  /**
   * The thread's open asks with a turn of Isaac's after them the judge has not read (newer than
   * `judgedTo`), from the same rows `observe` just took: the question, all his turns after it, and
   * the assistant's reply after the latest. A session's ask is never judged (its answer has a recipient).
   */
  unjudged(rows: readonly AssistantMessage[]): AskCase[] {
    const position = new Map<string, number>();
    rows.forEach((row, index) => position.set(row.id, index));
    const cases: AskCase[] = [];
    for (const ask of this.load().asks) {
      if (ask.state !== "open" || ask.source === "session") continue;
      const later = rows.flatMap((row, index) => (row.role === "user" && this.after(ask, row, index, position) ? [{ row, index }] : []));
      const last = later.at(-1);
      if (last === undefined || last.row.at <= (ask.judgedTo ?? -1)) continue;
      const reply = rows.slice(last.index + 1).find((row) => row.role === "assistant")?.text.trim();
      cases.push({
        id: ask.id,
        question: ask.question,
        said: later.map(({ row }) => row.text.trim()),
        ...(reply === undefined || reply === "" ? {} : { reply }),
        upTo: last.row.at,
      });
    }
    return cases;
  }

  /** The judge has read Isaac's turns on ask `id` up to the one at `upTo`. */
  judged(id: string, upTo: number): void {
    const ask = this.get(id);
    if (ask === undefined || (ask.judgedTo ?? -1) >= upTo) return;
    ask.judgedTo = upTo;
    this.save(this.load());
  }

  /** The bridge reported an `ask` card on session `sessionId`: its first question becomes an ask. True when anything changed. */
  addCard(sessionId: string, card: AgentAsk): boolean {
    const record = this.load();
    const key = `ask:${sessionId}:${card.id}`;
    if (record.asks.some((ask) => ask.keys.includes(key))) return false;
    const first = card.questions[0];
    const question = first === undefined ? "" : clipAt(first.question.trim().replace(/\s+/g, " "), MAX_ASK_QUESTION);
    if (first === undefined || question === "") return false;
    const replies = first.options
      .map((option) => option.label.trim().replace(/\s+/g, " "))
      .filter((label) => label !== "" && label.length <= MAX_ASK_REPLY)
      .slice(0, MAX_ASK_REPLIES);
    this.prune(record);
    this.take(record, key, { source: "ask", label: askLabel(question, first.header), question, replies, at: this.now(), sessionId, askId: card.id });
    this.save(record);
    return true;
  }

  /** The bridge reported card `cardId` of `sessionId` closed: answered closes its ask, a cancel leaves it open. True when it closed. */
  cardResolved(sessionId: string, cardId: string, answered: boolean): boolean {
    if (!answered) return false;
    const record = this.load();
    const key = `ask:${sessionId}:${cardId}`;
    const ask = record.asks.find((stored) => stored.state === "open" && stored.keys.includes(key));
    if (ask === undefined || !this.close(ask, "answered")) return false;
    this.save(record);
    return true;
  }

  /**
   * A session asked Isaac something (input already checked: options 1 to 8 of 1 to 80 characters,
   * the default one of them). The same question from the same session while it is open refreshes
   * that ask. The badge reads `<from>: <question>`. Returns the ask.
   */
  addSession(input: SessionAskInput): StoredAsk {
    const record = this.load();
    this.prune(record);
    const at = this.now();
    const question = clipAt(input.question.trim().replace(/\s+/g, " "), MAX_ASK_QUESTION);
    const ask = this.take(record, `session:${input.sessionId ?? "none"}:${askKey(question)}:${String(at)}`, {
      source: "session",
      label: clipAt(`${input.from}: ${withoutLeadIn(question)}`, MAX_ASK_LABEL),
      question,
      replies: [...input.options],
      at,
      from: input.from,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.default === undefined ? {} : { default: input.default }),
    });
    this.save(record);
    return ask;
  }

  /** Closes open ask `id` as `how`, keeping Isaac's `answer` when one came; false when no open ask has that id. */
  resolve(id: string, how: Exclude<AskState, "open">, answer?: string): boolean {
    const record = this.load();
    const ask = record.asks.find((stored) => stored.id === id && stored.state === "open");
    if (ask === undefined) return false;
    this.close(ask, how);
    if (answer !== undefined) ask.answer = answer;
    this.prune(record);
    this.save(record);
    return true;
  }

  /** Ask `id` in whatever state, while it is kept (closed ones for `CLOSED_ASK_TTL_MS`). */
  get(id: string): StoredAsk | undefined {
    return this.load().asks.find((ask) => ask.id === id);
  }

  /** The answer to session ask `id` reached the asking session. */
  markDelivered(id: string): void {
    const ask = this.get(id);
    if (ask === undefined || ask.delivered === true) return;
    ask.delivered = true;
    this.save(this.load());
  }

  /** The open asks, oldest first, the newest `MAX_OPEN_ASKS` of them, without the bookkeeping (the schema drops it). */
  open(): OpenAsk[] {
    return this.load()
      .asks.filter((ask) => ask.state === "open")
      .sort((a, b) => a.at - b.at)
      .slice(-MAX_OPEN_ASKS)
      .map((ask) => OpenAsk.parse(ask));
  }

  /**
   * Records a new source `key`: it refreshes the open ask with the same question (in place), else
   * becomes a new ask. A session's ask only refreshes the same session's; the thread's own never do.
   */
  private take(record: AskRecord, key: string, fields: Omit<OpenAsk, "id">): StoredAsk {
    const same = askKey(fields.question);
    const session = fields.source === "session";
    const repeated = record.asks.find(
      (ask) => ask.state === "open" && askKey(ask.question) === same && (ask.source === "session") === session && (!session || ask.sessionId === fields.sessionId),
    );
    if (repeated !== undefined) {
      delete repeated.messageId;
      delete repeated.sessionId;
      delete repeated.askId;
      delete repeated.from;
      delete repeated.default;
      Object.assign(repeated, fields);
      repeated.keys.push(key);
      return repeated;
    }
    let id = askId(key);
    for (let n = 1; record.asks.some((ask) => ask.id === id); n += 1) id = askId(`${key}#${n}`);
    const ask: StoredAsk = { id, ...fields, state: "open", keys: [key] };
    record.asks.push(ask);
    return ask;
  }

  /** `row` (at `index` of the rows `position` maps) comes after `ask`'s bubble, or after its time when it has none in them. */
  private after(ask: StoredAsk, row: AssistantMessage, index: number, position: ReadonlyMap<string, number>): boolean {
    const at = ask.messageId === undefined ? undefined : position.get(ask.messageId);
    return at === undefined ? ask.at < row.at : at < index;
  }

  private close(ask: StoredAsk, how: Exclude<AskState, "open">): boolean {
    if (ask.state !== "open") return false;
    ask.state = how;
    ask.closedAt = this.now();
    return true;
  }

  /** Drops asks closed longer than `CLOSED_ASK_TTL_MS` ago, raising `since` past them so their rows cannot raise them again. */
  private prune(record: AskRecord): boolean {
    const cutoff = this.now() - CLOSED_ASK_TTL_MS;
    const stale = record.asks.filter((ask) => ask.state !== "open" && (ask.closedAt ?? 0) < cutoff);
    if (stale.length === 0) return false;
    record.asks = record.asks.filter((ask) => !stale.includes(ask));
    record.since = Math.max(record.since, ...stale.map((ask) => ask.at + 1));
    return true;
  }

  /** The record, read once; a missing or unreadable file starts a new one from now. */
  private load(): AskRecord {
    if (this.record !== null) return this.record;
    const path = this.path;
    if (path !== null && existsSync(path)) {
      try {
        const parsed = AskRecord.safeParse(JSON.parse(readFileSync(path, "utf8")));
        if (parsed.success) return (this.record = parsed.data);
      } catch {
        // A broken file starts over, like a missing one.
      }
    }
    this.record = { since: this.now(), asks: [] };
    this.save(this.record);
    return this.record;
  }

  private save(record: AskRecord): void {
    if (this.path === null) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}
