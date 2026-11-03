// Reviews: what waits on Isaac's reply, on the phone as in Relay Desktop's Reviews page
// (evaos-electron apps/desktop/src/{main,renderer}/reviews): GitHub PRs that want his review,
// Linear tickets where someone asked him something, Slack threads and DMs waiting on him.
//
// The host reads every source (`apps/linux/src/reviews/`): GitHub with `gh`, Linear's GraphQL API
// with his key, Slack through the claude.ai Slack connector's read tools in headless `claude -p`
// (never a token, never a write). Clients ask `reviews.req {rid, op}` and get `reviews.res` with
// the same rid; the host also pushes `reviews.queue` whenever the queue changes (a source finished
// reading, an item marked Done anywhere) and `reviews.astra` for every change of an item's Astra
// session (streamed text, a turn ending).
//
// Nothing leaves for GitHub, Linear or Slack on its own: `comment`, `review` and `linearComment`
// post exactly the confirmed text, and `slackSend` only hands a "Slack send request" line to
// Astra's main thread, who posts it from the Slack desktop app. Test hosts refuse every write.
//
// Done: an item marked Done stays hidden until it changes again (its `updatedAt` moves past the
// one recorded with Done).
//
// Pure module: zod only, no imports from the rest of the protocol (index.ts re-exports it).
import { z } from "zod";

const ms = z.number().finite();
const nonEmpty = z.string().min(1);

export const MAX_REVIEW_TEXT = 20_000;
/** The diff a PR detail carries; a longer one is cut and `diffTruncated` set. */
export const MAX_REVIEW_DIFF = 400_000;
/** Base64 characters an uploaded image may carry (about 6 MB of image); the phone scales photos well under it. */
export const MAX_REVIEW_UPLOAD = 8_000_000;

export const ReviewSource = z.enum(["github", "linear", "slack"]);
export type ReviewSource = z.infer<typeof ReviewSource>;

const RepoName = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
const LinearKey = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/);
const SlackId = z.string().regex(/^[CDG][A-Z0-9]+$/);
const SlackTs = z.string().regex(/^\d+\.\d+$/);

/** Which item: a PR, a ticket, or a Slack thread (`threadTs`) or DM outside a thread (`threadTs` null). */
export const ReviewRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github"), repo: RepoName, number: z.number().int().positive() }),
  z.object({ kind: z.literal("linear"), key: LinearKey }),
  z.object({ kind: z.literal("slack"), channel: SlackId, threadTs: SlackTs.nullable() }),
]);
export type ReviewRef = z.infer<typeof ReviewRef>;

/** One row of the queue, whatever its source. */
export const ReviewItem = z.object({
  /** The item's web page: its identity for Done and for its Astra session. */
  url: nonEmpty,
  ref: ReviewRef,
  /** PR or ticket title; for Slack the newest message waiting on Isaac. */
  title: z.string(),
  /** Who wants him (PR author, Linear actor, Slack author). */
  actor: z.string(),
  /** How the row says why it is here: "requested your review", "mentioned you", "asked you". */
  reason: z.string(),
  /** The short place name after the reason: "#170", "ENG-6406", "#ui-ux", "DM". */
  label: z.string(),
  /** Epoch ms of the newest activity that put it here; Done holds until this moves. */
  updatedAt: ms,
  /** Linear's unread notification; GitHub and Slack rows are always unread until Done. */
  unread: z.boolean(),
  /** GitHub: a draft PR. */
  draft: z.boolean().optional(),
  /** GitHub: `needs` (review requested) or `reviewing` (he reviewed it, still open). */
  group: z.enum(["needs", "reviewing"]).optional(),
  /** Slack: a mention, a DM or group DM, or a reply in a thread he is in. */
  slackKind: z.enum(["mention", "dm", "reply"]).optional(),
  /** Linear: the ticket's workflow state type (`started`, `unstarted`, ...), for its status glyph. */
  stateType: z.string().optional(),
});
export type ReviewItem = z.infer<typeof ReviewItem>;

/** How one source's last read went. */
export const ReviewSourceState = z.object({
  /** A read is running (Slack's takes minutes). */
  loading: z.boolean(),
  /** Why the last read failed; the rows from before it stay. */
  error: z.string().max(2000).nullable(),
  /** When the rows were read; null before the first read. */
  fetchedAt: ms.nullable(),
});
export type ReviewSourceState = z.infer<typeof ReviewSourceState>;

export const ReviewQueue = z.object({
  /** Every source's rows, newest first, Done ones included (`liveReviewItems` drops them). */
  items: z.array(ReviewItem).max(500),
  /** Item urls marked Done, each with the item's `updatedAt` at that moment. */
  done: z.record(z.string(), ms),
  /** Item urls snoozed, each until that epoch ms; hidden until then (and back on their own). */
  snoozed: z.record(z.string(), ms).default({}),
  /** Item urls Isaac has seen, each with the item's `updatedAt` then; newer activity is unread again. "Unread" removes the mark. */
  read: z.record(z.string(), ms).default({}),
  sources: z.object({ github: ReviewSourceState, linear: ReviewSourceState, slack: ReviewSourceState }),
});
export type ReviewQueue = z.infer<typeof ReviewQueue>;

const Person = z.object({ login: z.string() });

export const ReviewCheck = z.object({
  name: z.string(),
  state: z.enum(["pass", "fail", "pending", "skipped"]),
  url: z.string().nullable(),
});
export type ReviewCheck = z.infer<typeof ReviewCheck>;

export const ReviewPr = z.object({
  repo: z.string(),
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  draft: z.boolean(),
  author: Person,
  createdAt: ms,
  updatedAt: ms,
  body: z.string(),
  base: z.string(),
  head: z.string(),
  headSha: z.string(),
  additions: z.number(),
  deletions: z.number(),
  reviewers: z.array(z.object({ login: z.string(), state: z.string() })),
  assignees: z.array(z.string()),
  labels: z.array(z.object({ name: z.string(), color: z.string() })),
  /** Conversation: issue comments, reviews with a body or a verdict, and pushed commits, oldest first. */
  timeline: z.array(
    z.object({
      kind: z.enum(["comment", "review", "commit"]),
      author: z.string(),
      /** Markdown; a commit's headline. */
      body: z.string(),
      /** A review's verdict (`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`); a commit's short sha. */
      state: z.string().nullable(),
      at: ms,
    }),
  ),
  checks: z.array(ReviewCheck),
  files: z.array(
    z.object({
      path: z.string(),
      additions: z.number(),
      deletions: z.number(),
      /** ADDED, MODIFIED, DELETED, RENAMED, ... as GitHub reports it. */
      change: z.string(),
    }),
  ),
  /** `gh pr diff` (unified, every file), cut at `MAX_REVIEW_DIFF`. */
  diff: z.string(),
  diffTruncated: z.boolean(),
});
export type ReviewPr = z.infer<typeof ReviewPr>;

/** The Guide: the PR's changed files grouped into sections a reviewer reads top to bottom. */
export const ReviewGuide = z.object({
  /** The head commit the Guide was written for (kept per head). */
  headSha: z.string(),
  /** `model`: written from the title, body and diff; `folders`: the fallback grouping. */
  source: z.enum(["model", "folders"]),
  /** Why the written walkthrough is missing, when `source` is `folders`. */
  error: z.string().nullable(),
  sections: z.array(z.object({ title: z.string(), why: z.string(), files: z.array(z.string()) })),
});
export type ReviewGuide = z.infer<typeof ReviewGuide>;

const LinearPerson = z.object({
  name: z.string(),
  handle: z.string(),
  /** Profile page; Linear treats a link to it in a comment as an @mention. */
  url: z.string(),
});
export type LinearPerson = z.infer<typeof LinearPerson>;

export const LinearComment = z.object({
  id: z.string(),
  /** Top-level comment this replies to; null for a thread's first comment. */
  parentId: z.string().nullable(),
  author: LinearPerson,
  /** Markdown; Linear's uploaded images point at the host (`/reviews/media/...`). */
  body: z.string(),
  at: ms,
  url: z.string(),
  mentionsMe: z.boolean(),
});
export type LinearComment = z.infer<typeof LinearComment>;

export const LinearTicket = z.object({
  /** Linear's issue id (a uuid): comments are posted against it. */
  id: z.string(),
  key: z.string(),
  title: z.string(),
  url: z.string(),
  description: z.string(),
  creator: z.string(),
  createdAt: ms,
  updatedAt: ms,
  state: z.object({ name: z.string(), type: z.string(), color: z.string() }),
  assignee: z.string().nullable(),
  priority: z.string(),
  labels: z.array(z.object({ name: z.string(), color: z.string() })),
  project: z.string().nullable(),
  team: z.string(),
  parent: z.object({ key: z.string(), title: z.string(), url: z.string() }).nullable(),
  children: z.array(z.object({ key: z.string(), title: z.string(), url: z.string(), state: z.string() })),
  /** Linked GitHub PRs and other attachments. */
  links: z.array(z.object({ title: z.string(), url: z.string(), kind: z.string() })),
  comments: z.array(LinearComment),
  /** People on the ticket, for @mentions in a reply. */
  people: z.array(LinearPerson),
  me: LinearPerson,
  /** Status changes and other history lines shown between comments ("changed status from In QA to Done"), oldest first. */
  activity: z
    .array(
      z.object({
        at: ms,
        actor: z.string(),
        /** What happened after the actor's name, e.g. "changed status from In QA to Done". */
        text: z.string(),
        /** Names in `text` drawn bright (state names). */
        highlights: z.array(z.string()),
      }),
    )
    .default([]),
});
export type LinearTicket = z.infer<typeof LinearTicket>;

export const SlackMessage = z.object({
  ts: z.string(),
  author: z.string(),
  /** Isaac's own message. */
  mine: z.boolean(),
  /** Markdown, mentions as @Name. */
  text: z.string(),
  mentionsMe: z.boolean(),
  reactions: z.array(z.object({ emoji: z.string(), count: z.number() })),
  files: z.array(z.string()),
  /**
   * The files with Slack's id and, for an image the host fetched through the Slack app, its host
   * path (`/reviews/media/<file>/<token>`); `src` null for other files. Older hosts send none.
   */
  attachments: z.array(z.object({ name: z.string(), id: z.string(), src: z.string().nullable() })).default([]),
  at: ms,
});
export type SlackMessage = z.infer<typeof SlackMessage>;

export const SlackThread = z.object({
  channel: z.string(),
  channelName: z.string(),
  threadTs: z.string().nullable(),
  messages: z.array(SlackMessage),
  fetchedAt: ms,
});
export type SlackThread = z.infer<typeof SlackThread>;

/** One turn of an item's Astra session as Reviews shows it. */
export const AstraTurn = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "tool"]),
  /** Markdown; for Isaac's first ask, only his question (the seed is not shown). */
  text: z.string(),
  streaming: z.boolean(),
  /** Epoch ms the turn was said, for placing it among an item's comments; absent on older hosts. */
  at: ms.optional(),
});
export type AstraTurn = z.infer<typeof AstraTurn>;

/**
 * An item's own Astra session: a full omp session with her setup, seeded with the item and her
 * thread memory, one per item and kept across restarts. Live sessions are in the Agent Inbox
 * under `sessionId` (Open session, Stop with `agent.abort`).
 */
export const AstraItem = z.object({
  url: z.string(),
  title: z.string(),
  /** The live session; null while starting or after it ended (the next ask resumes its file). */
  sessionId: z.string().nullable(),
  turns: z.array(AstraTurn),
  working: z.boolean(),
  /** A question or approval the session is blocked on, answered from the session. */
  waiting: z.string().nullable(),
  error: z.string().nullable(),
});
export type AstraItem = z.infer<typeof AstraItem>;

const Body = z.string().min(1).max(MAX_REVIEW_TEXT);

/**
 * Approve on an eCard auto-work draft PR: its ledger on the host is at "9 PR (draft)" with the move
 * on Isaac. `ready` may be tapped, `sent` was handed to Astra and waits for the ledger to move,
 * `running` is the self-review loop that follows.
 */
export const ReviewApprove = z.object({ key: z.string(), state: z.enum(["ready", "sent", "running"]) });
export type ReviewApprove = z.infer<typeof ReviewApprove>;

export const ReviewsOp = z.discriminatedUnion("kind", [
  /** The queue; `refresh` reads every source again (Slack in the background, pushed when done). */
  z.object({ kind: z.literal("queue"), refresh: z.boolean() }),
  z.object({ kind: z.literal("pr"), repo: RepoName, number: z.number().int().positive() }),
  /** Slow the first time per head commit (a model writes it). */
  z.object({ kind: z.literal("guide"), repo: RepoName, number: z.number().int().positive() }),
  z.object({ kind: z.literal("linear"), key: LinearKey }),
  /** The last read thread at once, or (`refresh`) a fresh read, which takes a minute or more. */
  z.object({ kind: z.literal("slack"), channel: SlackId, threadTs: SlackTs.nullable(), refresh: z.boolean() }),
  z.object({ kind: z.literal("done"), url: nonEmpty, updatedAt: ms, done: z.boolean() }),
  /** A GitHub PR comment, exactly `body`, after Isaac confirmed it. */
  z.object({ kind: z.literal("comment"), repo: RepoName, number: z.number().int().positive(), body: Body }),
  z.object({
    kind: z.literal("review"),
    repo: RepoName,
    number: z.number().int().positive(),
    event: z.enum(["approve", "request-changes", "comment"]),
    body: z.string().max(MAX_REVIEW_TEXT),
  }),
  z.object({ kind: z.literal("linearComment"), issueId: nonEmpty, parentId: nonEmpty.nullable(), body: Body }),
  /** Hands `text` to Astra's main thread as a Slack send request; she posts it from the Slack app. */
  z.object({ kind: z.literal("slackSend"), channel: SlackId, threadTs: SlackTs.nullable(), text: Body }),
  /** Isaac's question to the item's Astra session, starting or resuming it first. */
  z.object({ kind: z.literal("astraAsk"), url: nonEmpty, ref: ReviewRef, text: Body }),
  /** The item's Astra session, if it has one. */
  z.object({ kind: z.literal("astra"), url: nonEmpty }),
  /** Hides an item until `until` (epoch ms); null brings it back now. */
  z.object({ kind: z.literal("snooze"), url: nonEmpty, until: ms.nullable() }),
  /** Marks an item seen (`read`, with the `updatedAt` it was seen at) or unread again. */
  z.object({ kind: z.literal("read"), url: nonEmpty, updatedAt: ms, read: z.boolean() }),
  /** Whether the PR is an auto-work draft waiting on Isaac's approve (the host reads the ledgers); answers `approve`, null when not. */
  z.object({ kind: z.literal("approvable"), repo: RepoName, number: z.number().int().positive() }),
  /** Hands the approve of that draft PR to Astra's main thread; she runs ready.ts. Answers the new `approve`. */
  z.object({ kind: z.literal("approve"), repo: RepoName, number: z.number().int().positive() }),
  /** Uploads an image to Linear for a comment; answers its `url` to embed as Markdown. `data` is base64. */
  z.object({ kind: z.literal("linearUpload"), name: z.string().min(1).max(200), mime: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]), data: z.string().min(1).max(MAX_REVIEW_UPLOAD) }),
]);
export type ReviewsOp = z.infer<typeof ReviewsOp>;

export const ReviewsRid = z.string().min(1).max(64);

export const ReviewsResult = z.object({
  rid: ReviewsRid,
  ok: z.boolean(),
  /** Why it failed, one line for the UI. */
  error: z.string().max(2000).optional(),
  queue: ReviewQueue.optional(),
  pr: ReviewPr.optional(),
  guide: ReviewGuide.optional(),
  ticket: LinearTicket.optional(),
  thread: SlackThread.nullable().optional(),
  done: z.record(z.string(), ms).optional(),
  /** Where a posted comment landed. */
  url: z.string().optional(),
  astra: AstraItem.nullable().optional(),
  approve: ReviewApprove.nullable().optional(),
});
export type ReviewsResult = z.infer<typeof ReviewsResult>;

// ---------------------------------------------------------------------------------------------
// Shared helpers (both clients)
// ---------------------------------------------------------------------------------------------

/** Hidden after Done until it changes again. */
export function isReviewDone(item: Pick<ReviewItem, "url" | "updatedAt">, done: Readonly<Record<string, number>>): boolean {
  const at = done[item.url];
  return at !== undefined && item.updatedAt <= at;
}

/** Unread: the source says so and Isaac has not seen this activity here. */
export function isReviewUnread(item: Pick<ReviewItem, "url" | "updatedAt" | "unread">, read: Readonly<Record<string, number>>): boolean {
  const at = read[item.url];
  return item.unread && !(at !== undefined && item.updatedAt <= at);
}

/** The rows that still wait on Isaac (not Done, not snoozed at `now`), newest first, optionally from one source. */
export function liveReviewItems(queue: Pick<ReviewQueue, "items" | "done"> & Partial<Pick<ReviewQueue, "snoozed">>, source: ReviewSource | null = null, now = Date.now()): ReviewItem[] {
  const snoozed = queue.snoozed ?? {};
  return queue.items
    .filter((item) => (source === null || item.ref.kind === source) && !isReviewDone(item, queue.done) && !((snoozed[item.url] ?? 0) > now))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Rows split into Today (since local midnight of `now`) and Earlier; empty groups left out. */
export function reviewDayGroups(items: readonly ReviewItem[], now: number): Array<{ label: "Today" | "Earlier"; items: ReviewItem[] }> {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = items.filter((item) => item.updatedAt >= midnight.getTime());
  const earlier = items.filter((item) => item.updatedAt < midnight.getTime());
  return [
    ...(today.length > 0 ? [{ label: "Today" as const, items: today }] : []),
    ...(earlier.length > 0 ? [{ label: "Earlier" as const, items: earlier }] : []),
  ];
}

/** `3d`, `29m`, `just now`: the queue's and timeline's short ages. */
export function reviewAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return s < 5 ? "just now" : `${String(s)}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${String(m)}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${String(h)}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `${String(d)}d`;
  return `${String(Math.round(d / 30))}mo`;
}

/** Mentioning Astra makes a comment a private question to her instead of a post. */
export function mentionsAstra(text: string): boolean {
  return /(^|\s)@astra\b/i.test(text);
}
