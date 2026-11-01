/**
 * Pure rules behind the Reviews screens: what a sent composer text does (a private Astra ask, or a
 * post that waits on the confirm sheet), the PR diff cut into per-file patches, Linear comments as
 * threads, a Slack thread's parent and replies, the Guide's progress and a PR's state badge, the
 * item's timeline with Astra's turns merged in by time, the snooze choices and @mention picking.
 */
import { mentionsAstra, type AstraItem, type AstraTurn, type LinearComment, type ReviewGuide, type ReviewPr, type ReviewsOp, type SlackMessage } from "@relay/protocol";
import type { ToneToken } from "@/theme";

/** Where the screen's composer posts: the item it sits on. */
export type ComposerTarget =
  | { kind: "github"; repo: string; number: number }
  | { kind: "linear"; issueId: string; key: string; reply: { parentId: string; name: string } | null }
  | { kind: "slack"; channel: string; threadTs: string | null; channelName: string };

export type ComposerIntent =
  | { kind: "astra"; text: string }
  /** Goes out only from the confirm sheet, which shows `destination` and the exact text. */
  | { kind: "post"; op: ReviewsOp; destination: string; action: string };

/** What sending `text` from the composer does; null for blank text. */
export function composerIntent(text: string, target: ComposerTarget): ComposerIntent | null {
  const body = text.trim();
  if (body === "") return null;
  if (mentionsAstra(body)) return { kind: "astra", text: body };
  switch (target.kind) {
    case "github":
      return {
        kind: "post",
        op: { kind: "comment", repo: target.repo, number: target.number, body },
        destination: `Post to GitHub ${target.repo}#${String(target.number)}`,
        action: "Post",
      };
    case "linear":
      return {
        kind: "post",
        op: { kind: "linearComment", issueId: target.issueId, parentId: target.reply?.parentId ?? null, body },
        destination: target.reply === null ? `Post to Linear ${target.key}` : `Reply to ${target.reply.name} on Linear ${target.key}`,
        action: "Post",
      };
    case "slack":
      return {
        kind: "post",
        op: { kind: "slackSend", channel: target.channel, threadTs: target.threadTs, text: body },
        destination: `Hand to Astra to send in Slack ${target.channelName}`,
        action: "Send",
      };
  }
}

/** `src/routes/get-tags.route.ts` as its folder (with the trailing slash) and name. */
export function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf("/");
  return at < 0 ? { dir: "", name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) };
}

/** `gh pr diff` output as one patch per file path, in order. */
export function splitDiffFiles(diff: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const chunk of diff.split(/^diff --git /m).slice(1)) {
    const head = chunk.split("\n", 1)[0] ?? "";
    const path = /^\+\+\+ b\/(.+)$/m.exec(chunk)?.[1] ?? / b\/(.+)$/.exec(head)?.[1] ?? head;
    const at = chunk.search(/^@@ /m);
    if (at >= 0) files.set(path, chunk.slice(at).replace(/\n+$/, ""));
  }
  return files;
}

export interface LinearThread {
  comment: LinearComment;
  replies: LinearComment[];
}

/** Top-level comments oldest first, each with its replies; a reply whose parent is gone stands alone. */
export function linearThreads(comments: readonly LinearComment[]): LinearThread[] {
  const sorted = [...comments].sort((a, b) => a.at - b.at);
  const tops = new Set(sorted.filter((c) => c.parentId === null || !sorted.some((p) => p.id === c.parentId)).map((c) => c.id));
  return sorted
    .filter((c) => tops.has(c.id))
    .map((comment) => ({ comment, replies: sorted.filter((c) => c.parentId === comment.id && !tops.has(c.id)) }));
}

/** Linear's uploads point at the host (`/reviews/media/...`); the phone loads them from it. */
export function withHostMedia(markdown: string, base: string | null): string {
  if (base === null) return markdown;
  return markdown.replace(/(\]\(|src=["'])\/reviews\/media\//g, `$1${base}/reviews/media/`);
}

/** A thread's first message is its parent (the "N replies" divider follows it); a DM has none. */
export function slackParts(messages: readonly SlackMessage[], threadTs: string | null): { parent: SlackMessage | null; replies: SlackMessage[] } {
  const sorted = [...messages].sort((a, b) => a.at - b.at);
  if (threadTs === null || sorted.length === 0) return { parent: null, replies: sorted };
  return { parent: sorted[0] ?? null, replies: sorted.slice(1) };
}

/** How many of the Guide's files are ticked. */
export function guideProgress(guide: ReviewGuide, reviewed: readonly string[]): { done: number; total: number } {
  const files = new Set(guide.sections.flatMap((s) => s.files));
  return { done: reviewed.filter((path) => files.has(path)).length, total: files.size };
}

/** The badge after the title: Draft, Merged, Closed or Open. */
export function prBadge(pr: Pick<ReviewPr, "state" | "draft">): { label: string; tone: ToneToken } {
  const state = pr.state.toUpperCase();
  if (state === "MERGED") return { label: "Merged", tone: "accent" };
  if (state === "CLOSED") return { label: "Closed", tone: "danger" };
  if (pr.draft) return { label: "Draft", tone: "textMuted" };
  return { label: "Open", tone: "ok" };
}

/** A card's answer for "Use as reply": its newest non-empty assistant turn; null when it has none yet. */
export function astraAnswer(turns: readonly AstraTurn[]): string | null {
  const answers = turns.filter((t) => t.role === "assistant" && t.text.trim() !== "");
  const turn = answers[answers.length - 1];
  return turn === undefined ? null : turn.text.trim();
}

/** An ask sent from the composer that the session may not show yet. */
export interface PendingAsk {
  text: string;
  /** How many of Isaac's turns with the same words the session showed when he sent it. */
  before: number;
  /** When he sent it (epoch ms): where it stands among the item's comments. */
  at: number;
}

/** Isaac's turns that carry the ask's words (a tag or the seed around them does not matter). */
function askCount(item: AstraItem | undefined, text: string): number {
  const asked = text.trim();
  return (item?.turns ?? []).filter((t) => t.role === "user" && t.text.includes(asked)).length;
}

/** The ask as sent at `at`, against what the session shows. */
export function pendingAsk(item: AstraItem | undefined, text: string, at: number): PendingAsk {
  return { text: text.trim(), before: askCount(item, text), at };
}

/** Whether the session now shows the ask as one of Isaac's turns. */
export function askLanded(item: AstraItem | undefined, ask: PendingAsk): boolean {
  return askCount(item, ask.text) > ask.before;
}

/**
 * The item's session as the panel shows it: an ask the session has not shown yet stands at the end
 * as Isaac's bubble with Astra working, from the tap until the session's own turn replaces it. A
 * brand-new session pushes before its first prompt reaches the transcript, so without this the
 * question vanished until the answer came.
 */
export function withPendingAsk(item: AstraItem | undefined, url: string, ask: PendingAsk | undefined): AstraItem | undefined {
  if (ask === undefined || askLanded(item, ask)) return item;
  const base = item ?? { url, title: "Astra", sessionId: null, turns: [], working: false, waiting: null, error: null };
  return { ...base, working: true, error: null, turns: [...base.turns, { id: "pending-ask", role: "user", text: ask.text, streaming: false, at: ask.at }] };
}

/** `https://github.com/owner/repo/pull/243` as its repo and number; null for any other link. */
export function githubPrOf(url: string): { repo: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url);
  return match?.[1] === undefined || match[2] === undefined ? null : { repo: match[1], number: Number(match[2]) };
}

/** One dated piece of an item's own timeline: a comment, a message, an activity line. */
export interface TimelineEntry<T> {
  key: string;
  at: number;
  entry: T;
}

/**
 * A row of the item's timeline: one of its own entries, Isaac's private ask to Astra (his card,
 * marked Private), or one Astra card (her answer with the tool work before it). `last` marks the
 * newest Astra card, the one that shows her working, waiting or failing and the Stop button.
 */
export type TimelineRow<T> =
  | { kind: "entry"; key: string; at: number; entry: T }
  | { kind: "ask"; key: string; at: number; text: string }
  | { kind: "astra"; key: string; at: number; turns: AstraTurn[]; last: boolean };

type AstraRow = Extract<TimelineRow<never>, { kind: "ask" | "astra" }>;

/**
 * The session's turns as cards: each of Isaac's asks alone, each run of her answers and tool work
 * as one card. A card stands at its first turn's time, never before the card ahead of it (session
 * order holds); a turn with no time (an older host) sends it and the rest to the end. A session
 * that works, waits or failed after his ask gets an empty card of hers to say so.
 */
function astraRows(item: AstraItem | undefined): AstraRow[] {
  if (item === undefined) return [];
  const rows: AstraRow[] = [];
  let floor = -Infinity;
  const place = (turn: AstraTurn): number => {
    floor = Math.max(floor, turn.at ?? Infinity);
    return floor;
  };
  for (const turn of item.turns) {
    const at = place(turn);
    const last = rows[rows.length - 1];
    if (turn.role === "user") rows.push({ kind: "ask", key: turn.id, at, text: turn.text });
    else if (last?.kind === "astra") last.turns.push(turn);
    else rows.push({ kind: "astra", key: turn.id, at, turns: [turn], last: false });
  }
  const busy = item.working || item.waiting !== null || item.error !== null;
  if (busy && rows[rows.length - 1]?.kind !== "astra") rows.push({ kind: "astra", key: "astra-status", at: floor === -Infinity ? Infinity : floor, turns: [], last: false });
  const newest = rows.filter((row) => row.kind === "astra").pop();
  if (newest !== undefined) newest.last = true;
  return rows;
}

/** The item's entries and its Astra session in one list, oldest first; at the same moment an entry goes before Astra. */
export function mergeTimeline<T>(entries: readonly TimelineEntry<T>[], astra: AstraItem | undefined): TimelineRow<T>[] {
  const rows: TimelineRow<T>[] = [...entries.map((e) => ({ kind: "entry" as const, ...e })), ...astraRows(astra)];
  // Array.prototype.sort is stable: equal times keep the order above.
  return rows.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1));
}

/** A Linear ticket's timeline entry: a comment thread or a history line. */
export type LinearEntry = { kind: "thread"; thread: LinearThread } | { kind: "activity"; actor: string; text: string; highlights: string[] };

export function linearEntries(comments: readonly LinearComment[], activity: readonly { at: number; actor: string; text: string; highlights: string[] }[]): TimelineEntry<LinearEntry>[] {
  return [
    ...linearThreads(comments).map((thread) => ({ key: thread.comment.id, at: thread.comment.at, entry: { kind: "thread" as const, thread } })),
    ...activity.map((line, i) => ({ key: `activity-${String(i)}`, at: line.at, entry: { kind: "activity" as const, actor: line.actor, text: line.text, highlights: line.highlights } })),
  ];
}

/** A PR conversation entry: a post (its description, a comment, a review with words) or a line (a push, a bare verdict). */
export type PrEntry = { kind: "post"; author: string; body: string; verdict: string | null } | { kind: "activity"; actor: string; text: string; highlights: string[] };

const BARE_VERDICT: Record<string, string> = {
  APPROVED: "approved these changes",
  CHANGES_REQUESTED: "requested changes",
  DISMISSED: "had a review dismissed",
};

/** The Conversation tab: the description, then comments, reviews and pushes; a verdict with no words is a line, a bare comment review nothing. */
export function prEntries(pr: Pick<ReviewPr, "author" | "body" | "createdAt" | "timeline">): TimelineEntry<PrEntry>[] {
  const entries: TimelineEntry<PrEntry>[] = [{ key: "description", at: pr.createdAt, entry: { kind: "post", author: pr.author.login, body: pr.body.trim() === "" ? "_No description._" : pr.body, verdict: null } }];
  pr.timeline.forEach((item, i) => {
    const key = `${item.kind}-${String(i)}`;
    if (item.kind === "commit") {
      const sha = item.state ?? "";
      entries.push({ key, at: item.at, entry: { kind: "activity", actor: item.author, text: `pushed ${sha}${item.body === "" ? "" : `: ${item.body}`}`, highlights: sha === "" ? [] : [sha] } });
    } else if (item.body.trim() !== "") {
      entries.push({ key, at: item.at, entry: { kind: "post", author: item.author, body: item.body, verdict: item.kind === "review" ? item.state : null } });
    } else if (item.kind === "review" && item.state !== null && BARE_VERDICT[item.state] !== undefined) {
      entries.push({ key, at: item.at, entry: { kind: "activity", actor: item.author, text: BARE_VERDICT[item.state] ?? "", highlights: [] } });
    }
  });
  return entries;
}

/** A Slack timeline entry: a message, or the "N replies" divider after a thread's parent. */
export type SlackEntry = { kind: "message"; message: SlackMessage } | { kind: "replies"; count: number };

export function slackEntries(messages: readonly SlackMessage[], threadTs: string | null): TimelineEntry<SlackEntry>[] {
  const { parent, replies } = slackParts(messages, threadTs);
  const message = (m: SlackMessage): TimelineEntry<SlackEntry> => ({ key: m.ts, at: m.at, entry: { kind: "message", message: m } });
  if (parent === null) return replies.map(message);
  const divider: TimelineEntry<SlackEntry>[] = replies.length === 0 ? [] : [{ key: "replies", at: parent.at, entry: { kind: "replies", count: replies.length } }];
  return [message(parent), ...divider, ...replies.map(message)];
}

const HOUR_MS = 3_600_000;

export interface SnoozeChoice {
  key: "later" | "tomorrow" | "next-week";
  label: string;
  /** Epoch ms the item comes back. */
  until: number;
}

/** Snooze's choices from `now`, in local time: three hours on, tomorrow at 9 AM, next Monday at 9 AM (a week on from a Monday). */
export function snoozeChoices(now: number): SnoozeChoice[] {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const monday = new Date(now);
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
  monday.setHours(9, 0, 0, 0);
  return [
    { key: "later", label: "Later today", until: now + 3 * HOUR_MS },
    { key: "tomorrow", label: "Tomorrow", until: tomorrow.getTime() },
    { key: "next-week", label: "Next week", until: monday.getTime() },
  ];
}

const TRAILING_MENTION = /(^|\s)@([^\s@]*)$/;

/** The name being typed after a trailing `@` (empty right after it); null when the draft does not end in one. */
export function mentionQuery(draft: string): string | null {
  return TRAILING_MENTION.exec(draft)?.[2] ?? null;
}

/** The draft with its trailing `@query` (or, without one, its end) replaced by `@Name `. */
export function insertMention(draft: string, name: string): string {
  if (mentionQuery(draft) !== null) return draft.replace(TRAILING_MENTION, (_, lead: string) => `${lead}@${name} `);
  return `${draft}${draft === "" || /\s$/.test(draft) ? "" : " "}@${name} `;
}

/** Who `@query` may name: Astra first, then the item's people once each, matched at the start of any word. */
export function mentionCandidates(people: readonly string[], query: string): string[] {
  const seen = new Set<string>();
  const names = ["Astra", ...people].map((name) => name.trim()).filter((name) => {
    const key = name.toLowerCase();
    if (name === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const q = query.toLowerCase();
  return names.filter((name) => q === "" || name.toLowerCase().split(/\s+/).some((word) => word.startsWith(q)));
}
