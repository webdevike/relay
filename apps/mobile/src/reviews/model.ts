/**
 * Pure rules behind the Reviews screens: what a sent composer text does (a private Astra ask, or a
 * post that waits on the confirm sheet), the PR diff cut into per-file patches, Linear comments as
 * threads, a Slack thread's parent and replies, the Guide's progress and a PR's state badge.
 */
import { mentionsAstra, type AstraItem, type LinearComment, type ReviewGuide, type ReviewPr, type ReviewsOp, type SlackMessage } from "@relay/protocol";
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

/** Astra's newest answer, for "Use as reply"; null before she has said anything. */
export function lastAstraAnswer(item: AstraItem | undefined): string | null {
  const answers = (item?.turns ?? []).filter((t) => t.role === "assistant" && t.text.trim() !== "");
  const turn = answers[answers.length - 1];
  return turn === undefined ? null : turn.text.trim();
}

/** An ask sent from the composer that the session may not show yet. */
export interface PendingAsk {
  text: string;
  /** How many of Isaac's turns with the same words the session showed when he sent it. */
  before: number;
}

/** Isaac's turns that carry the ask's words (a tag or the seed around them does not matter). */
function askCount(item: AstraItem | undefined, text: string): number {
  const asked = text.trim();
  return (item?.turns ?? []).filter((t) => t.role === "user" && t.text.includes(asked)).length;
}

/** The ask as sent now, against what the session shows. */
export function pendingAsk(item: AstraItem | undefined, text: string): PendingAsk {
  return { text: text.trim(), before: askCount(item, text) };
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
  return { ...base, working: true, error: null, turns: [...base.turns, { id: "pending-ask", role: "user", text: ask.text, streaming: false }] };
}

/** `https://github.com/owner/repo/pull/243` as its repo and number; null for any other link. */
export function githubPrOf(url: string): { repo: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url);
  return match?.[1] === undefined || match[2] === undefined ? null : { repo: match[1], number: Number(match[2]) };
}
