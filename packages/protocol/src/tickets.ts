// Tickets: Isaac's Linear issues and their PRs on Relay Desktop's Board, synced by the host.
//
// The host (`apps/linux/src/tickets/`) syncs Linear and GitHub incrementally under one budget,
// keeps a revisioned board, works out what waits on Isaac (Attention) and is the only writer: every
// Linear write goes through its MutationGate as Isaac. Clients ask `tickets.req {rid, op}` and get
// `tickets.res` with the same rid. A device that sent `subscribe {on: true}` gets the board as
// `tickets.snapshot` and then `tickets.delta` frames (a gap in `rev` means ask `board` again) and
// `tickets.status` whenever sync health or identity changes. Hot frames carry board facts only
// (no description, no comments); `ticket` answers carry those.
//
// Writes: `prepare {viewerId, mutation}` answers a single-use approval for a confirmed kind
// (CONFIRMED_TICKET_MUTATIONS, and moves into a terminal state); `commit {viewerId, approvalId?,
// opId, mutation}` writes, where `opId` is minted by the client when Isaac acts and reused on retry,
// so a repeated commit answers the stored outcome instead of writing twice. `viewerId` is the Linear
// account the device showed (`tickets.status` identity.linear.viewerId): the host refuses
// `identity` when it no longer acts as that account, so a stale client never writes as another one.
//
// Only sent to a host whose `welcome.features` has TICKETS_FEATURE; `prepare`/`commit` only when it
// also has TICKETS_WRITES_FEATURE. An older host closes the socket on an unknown frame.
//
// Pure module: zod only, no imports from the rest of the protocol (index.ts re-exports it).
import { z } from "zod";

/** Synced tickets: `tickets.req`, `tickets.snapshot`, `tickets.delta`, `tickets.status`. */
export const TICKETS_FEATURE = "tickets";
/** The host's MutationGate is open: `prepare`/`commit` write to Linear as Isaac. */
export const TICKETS_WRITES_FEATURE = "tickets.writes";
/** Reviews PR actions (merge, rerun, request review, reactions, inline comments) on `reviews.req`. */
export const REVIEWS_ACTIONS_FEATURE = "reviews.actions";
/** Reviews Guide v2 on `reviews.req`. */
export const REVIEWS_GUIDE2_FEATURE = "reviews.guide2";
/** Reviews item sessions with any registry assistant: `agent` on `astraAsk`/`astra`. */
export const REVIEWS_ASSISTANTS_FEATURE = "reviews.assistants";

/** Tickets on the board (the host's store cap). */
export const MAX_TICKETS = 500;
/** A comment body, a title or a new issue's description as Isaac wrote it. */
export const MAX_TICKET_TEXT = 20_000;
/** An issue description as Linear holds it. */
export const MAX_TICKET_DESCRIPTION = 100_000;
export const MAX_TICKET_COMMENTS = 500;
/** PRs linked to one ticket. */
export const MAX_TICKET_PRS = 20;
/** Keys one `watch` asks for. */
export const MAX_TICKET_WATCH = 50;
/** Rows one Apply plan writes. */
export const MAX_TICKET_PLAN_ROWS = 200;
/** A `watch` lasts at most this long; devices refresh it. */
export const MAX_TICKET_WATCH_TTL_MS = 60 * 60_000;

const ms = z.number().finite();
const Id = z.string().min(1).max(200);
const Name = z.string().max(500);
const Url = z.string().max(2000);
const Short = z.string().max(2000);
const Body = z.string().min(1).max(MAX_TICKET_TEXT);
const Count = z.number().int().nonnegative();

export const TicketKey = z
  .string()
  .regex(/^[A-Z][A-Z0-9]*-\d+$/)
  .max(40);
export type TicketKey = z.infer<typeof TicketKey>;
const RepoName = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/)
  .max(200);
/** A date-only `YYYY-MM-DD` (Linear's TimelessDate): a local calendar day, no time zone. */
export const TimelessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export type TimelessDate = z.infer<typeof TimelessDate>;
/** Linear priority: 0 None, 1 Urgent, 2 High, 3 Medium, 4 Low. */
export const TicketPriority = z.number().int().min(0).max(4);
/** Client-minted id of one write (UUID v4), reused on every retry of it. */
export const TicketOpId = z.string().uuid();
export const TicketsRid = z.string().min(1).max(64);

/** A Linear user (or GitHub login as `id` and `name` for GitHub authors). */
export const TicketActor = z.object({
  id: Id,
  name: Name,
  avatarUrl: Url.nullable(),
  /** The Linear profile page; a link to it in a comment is a mention. Absent: unknown. */
  url: Url.optional(),
});
export type TicketActor = z.infer<typeof TicketActor>;

export const TicketStateType = z.enum([
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
]);
export type TicketStateType = z.infer<typeof TicketStateType>;
/** Moves into a terminal state type (true) are confirmed (§2.5); others are unconfirmed with Undo. */
export const TERMINAL_TICKET_STATE_TYPES: Readonly<Record<TicketStateType, boolean>> = {
  triage: false,
  backlog: false,
  unstarted: false,
  started: false,
  completed: true,
  canceled: true,
};

export const TicketState = z.object({
  id: Id,
  name: Name,
  type: TicketStateType,
  color: z.string().max(40),
});
export type TicketState = z.infer<typeof TicketState>;

/** A PR linked to a ticket (from Linear attachments, the card PR or a search). */
export const TicketPrRef = z.object({ repo: RepoName, number: z.number().int().positive() });
export type TicketPrRef = z.infer<typeof TicketPrRef>;

const TicketLink = z.object({ id: Id, key: TicketKey, title: Name });

export const Ticket = z.object({
  key: TicketKey,
  id: Id,
  /** The description's document content: the parent of inline (quoted) comments on it. */
  documentContentId: Id.nullable(),
  title: Name,
  description: z.string().max(MAX_TICKET_DESCRIPTION),
  url: Url,
  state: TicketState,
  team: z.object({ id: Id, key: z.string().min(1).max(40) }),
  priority: TicketPriority,
  prioritySortOrder: z.number().finite(),
  assignee: TicketActor.nullable(),
  creator: TicketActor.nullable(),
  labels: z.array(z.object({ id: Id, name: Name, color: z.string().max(40) })).max(50),
  project: z.object({ id: Id, name: Name, targetDate: TimelessDate.nullable() }).nullable(),
  milestone: z
    .object({
      id: Id,
      name: Name,
      targetDate: TimelessDate.nullable(),
      sortOrder: z.number().finite(),
    })
    .nullable(),
  parent: TicketLink.nullable(),
  children: z.array(TicketLink.extend({ done: z.boolean() })).max(200),
  relations: z
    .array(
      TicketLink.extend({
        kind: z.enum(["blocks", "blockedBy", "related", "duplicate", "duplicateOf", "similar"]),
      }),
    )
    .max(200),
  prs: z.array(TicketPrRef).max(MAX_TICKET_PRS),
  dueDate: TimelessDate.nullable(),
  /** Relay-only Timeline start (host `plan.json`), never written to Linear. Absent: none. */
  plannedStart: TimelessDate.nullable().optional(),
  startedAt: ms.nullable(),
  createdAt: ms,
  updatedAt: ms,
  /** Isaac is subscribed to the issue. */
  subscribed: z.boolean(),
});
export type Ticket = z.infer<typeof Ticket>;

/**
 * Where an inline comment's quote sat when Isaac made it in Relay: the description's text just
 * before and after it, whitespace removed. Relay-only (host `anchors.json`), never sent to Linear.
 */
export const TicketAnchorContext = z.object({
  prefix: z.string().max(200),
  suffix: z.string().max(200),
});
export type TicketAnchorContext = z.infer<typeof TicketAnchorContext>;

export const TicketComment = z.object({
  id: Id,
  /** The root comment of its thread; null for a root. */
  parentId: Id.nullable(),
  /** Set for an inline comment on the description. */
  documentContentId: Id.nullable(),
  quotedText: z.string().max(MAX_TICKET_TEXT).nullable(),
  /** Null for an integration or deleted user. */
  author: TicketActor.nullable(),
  body: z.string().max(MAX_TICKET_TEXT),
  at: ms,
  editedAt: ms.nullable(),
  resolvedAt: ms.nullable(),
  resolvingUser: TicketActor.nullable(),
  reactions: z
    .array(z.object({ emoji: z.string().min(1).max(64), users: z.array(TicketActor).max(50) }))
    .max(50),
  url: Url,
  /** An inline comment Isaac made in Relay: the context that picks its occurrence of the quote. */
  anchor: TicketAnchorContext.optional(),
});
export type TicketComment = z.infer<typeof TicketComment>;

export const TicketPrFacts = TicketPrRef.extend({
  title: Name,
  url: Url,
  author: z.string().max(200),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  checks: z.object({
    state: z.enum(["pass", "fail", "pending", "none"]),
    passed: Count,
    failed: Count,
    pending: Count,
  }),
  /** GitHub `reviewDecision`. */
  decision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
  /** GitHub `mergeStateStatus` (`CLEAN`, `BLOCKED`, `BEHIND`, `DIRTY`, ...). */
  mergeState: z.string().max(40).nullable(),
  headSha: z.string().max(64),
  updatedAt: ms,
});
export type TicketPrFacts = z.infer<typeof TicketPrFacts>;

export const AttentionProvider = z.enum(["linear", "github"]);
export type AttentionProvider = z.infer<typeof AttentionProvider>;

/** Where a waiting mention sits, to open and quote it. */
export const AttentionAnchor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("comment") }),
  z.object({
    kind: z.literal("inline"),
    documentContentId: Id,
    quotedText: z.string().max(MAX_TICKET_TEXT),
  }),
  z.object({ kind: z.literal("pr-conversation"), pr: TicketPrRef }),
  z.object({
    kind: z.literal("pr-review-line"),
    pr: TicketPrRef,
    path: z.string().min(1).max(1000),
    line: z.number().int().positive(),
    side: z.enum(["LEFT", "RIGHT"]),
  }),
]);
export type AttentionAnchor = z.infer<typeof AttentionAnchor>;

/** Someone asked Isaac something he hasn't answered; one per thread root, newest mention shown. */
export const WaitingMention = z.object({
  provider: AttentionProvider,
  /** The ticket key (`ENG-1`) or PR (`owner/repo#12`) it is on. */
  itemId: Id,
  rootId: Id,
  /** The newest waiting mention in that thread. */
  commentId: Id,
  author: TicketActor,
  at: ms,
  excerpt: z.string().max(500),
  /** Waiting mentions on the item this chip stands for (tooltip). */
  count: z.number().int().positive(),
  anchor: AttentionAnchor,
});
export type WaitingMention = z.infer<typeof WaitingMention>;

export const NeedsYouKind = z.enum(["waiting", "agent", "merge", "review", "autoMergeOff"]);
export type NeedsYouKind = z.infer<typeof NeedsYouKind>;

/** The one deterministic thing Isaac should do on the item, and the evidence it rests on. */
export const NeedsYou = z.object({
  kind: NeedsYouKind,
  text: Short,
  action: z.object({
    kind: z.enum(["reply", "openPr", "merge", "review", "open"]),
    label: z.string().max(200),
    pr: TicketPrRef.optional(),
  }),
  /** Comment id, PR head + review state, request id or agent reason hash; new evidence returns it. */
  evidence: Id,
});
export type NeedsYou = z.infer<typeof NeedsYou>;

export const Attention = z.object({
  waiting: z.array(WaitingMention).max(50),
  needsYou: NeedsYou.nullable(),
});
export type Attention = z.infer<typeof Attention>;

/** One board card's facts: the ticket without its description, its PRs' facts and Attention. */
export const TicketBoardFacts = Ticket.omit({ description: true }).extend({
  prFacts: z.array(TicketPrFacts).max(MAX_TICKET_PRS),
  attention: Attention,
});
export type TicketBoardFacts = z.infer<typeof TicketBoardFacts>;

/** A team's workflow states in Linear's order, for mapping a Board column to a state (drag-to-move). */
export const TicketTeam = z.object({
  id: Id,
  key: z.string().min(1).max(40),
  states: z.array(TicketState.extend({ position: z.number().finite() })).max(60),
});
export type TicketTeam = z.infer<typeof TicketTeam>;

export const TicketsBoard = z.object({
  tickets: z.array(TicketBoardFacts).max(MAX_TICKETS),
  /** The synced tickets' teams; sent with `board` answers and snapshots, not deltas. Absent: unknown. */
  teams: z.array(TicketTeam).max(20).optional(),
});
export type TicketsBoard = z.infer<typeof TicketsBoard>;

/** The ticket page: board facts plus description and its comments (oldest first). */
export const TicketDetail = TicketBoardFacts.extend({
  description: Ticket.shape.description,
  comments: z.array(TicketComment).max(MAX_TICKET_COMMENTS),
  /**
   * Set when the host bounded the page (about 1 MiB) or answered from its cache during an outage:
   * the description was cut, and how many older comments were left out (open it in Linear for them).
   */
  clipped: z.object({ description: z.boolean(), comments: Count }).optional(),
});
export type TicketDetail = z.infer<typeof TicketDetail>;

const ProviderBudget = z.object({
  /** Requests (or complexity points) left in the window; null before the first answer. */
  remaining: z.number().nonnegative().nullable(),
  resetAt: ms.nullable(),
  /** No calls until then (429, `Retry-After`, secondary limit). */
  backoffUntil: ms.nullable(),
});

export const TicketsSyncState = z.enum([
  "off",
  "idle",
  "syncing",
  "waiting",
  "backingOff",
  "identityChanged",
]);
export type TicketsSyncState = z.infer<typeof TicketsSyncState>;

export const TicketsStatus = z.object({
  /** The accounts the host acts as; null when not resolved (no key, revoked, no gh login). */
  identity: z.object({
    linear: z
      .object({ viewerId: Id, name: Name, email: z.string().max(320), org: Name })
      .nullable(),
    github: z.object({ login: z.string().min(1).max(100) }).nullable(),
  }),
  /** Host config: sync on (`features.tickets`), writes open (`features.ticketsWrites`, no dry run). */
  features: z.object({ tickets: z.boolean(), writes: z.boolean() }),
  freshness: z.object({
    lastSyncAt: ms.nullable(),
    /** One line for the toolbar (also why sync is off). */
    lastError: Short.nullable(),
    state: TicketsSyncState,
  }),
  /** The last error per provider. */
  errors: z.object({ linear: Short.nullable(), github: Short.nullable() }),
  budget: z.object({ linear: ProviderBudget, github: ProviderBudget }),
});
export type TicketsStatus = z.infer<typeof TicketsStatus>;

/** One Timeline Apply row; omitted fields are left as they are. */
export const TicketPlanRow = z.object({
  key: TicketKey,
  issueId: Id,
  /** The row's own write id (retries reuse it). */
  opId: TicketOpId,
  /** The issue's `updatedAt` the draft was made from; changed since: the row is stale. */
  baseUpdatedAt: ms,
  dueDate: TimelessDate.nullable().optional(),
  priority: TicketPriority.optional(),
  prioritySortOrder: z.number().finite().optional(),
  /** Relay-only start, saved only when the row's write succeeded. */
  plannedStart: TimelessDate.nullable().optional(),
});
export type TicketPlanRow = z.infer<typeof TicketPlanRow>;

/** Every Linear write Isaac can make from Relay (PLAN §5). */
export const TicketMutation = z.discriminatedUnion("kind", [
  /** Refused unless the live state is still `fromStateId`; Undo is the swapped move. */
  z.object({ kind: z.literal("setState"), issueId: Id, fromStateId: Id, toStateId: Id }),
  /** A comment, a reply (`parentId`: the root) or an inline comment (`documentContentId` + `quotedText`). */
  z.object({
    kind: z.literal("comment"),
    issueId: Id,
    documentContentId: Id.optional(),
    parentId: Id.optional(),
    quotedText: z.string().max(MAX_TICKET_TEXT).optional(),
    /** Relay-only: kept by the host for the created comment, not written to Linear. */
    anchor: TicketAnchorContext.optional(),
    body: Body,
  }),
  z.object({ kind: z.literal("editComment"), commentId: Id, body: Body }),
  /** `replyCount`: the replies Isaac was told also go (a root's delete takes them). */
  z.object({ kind: z.literal("deleteComment"), commentId: Id, replyCount: Count }),
  z.object({ kind: z.literal("resolve"), rootId: Id, on: z.boolean() }),
  /** Desired state: the host no-ops when it is already so. */
  z.object({
    kind: z.literal("react"),
    commentId: Id,
    emoji: z.string().min(1).max(64),
    on: z.boolean(),
  }),
  z.object({ kind: z.literal("subscribe"), issueId: Id, on: z.boolean() }),
  /** New issue from a comment, created with `id: opId`. */
  z.object({
    kind: z.literal("createIssue"),
    teamId: Id,
    stateId: Id,
    templateId: Id.nullable(),
    projectId: Id.nullable(),
    title: z.string().min(1).max(500),
    description: z.string().max(MAX_TICKET_TEXT),
    sourceCommentId: Id,
    referenceCommentId: Id,
  }),
  z.object({
    kind: z.literal("applyPlan"),
    rows: z.array(TicketPlanRow).min(1).max(MAX_TICKET_PLAN_ROWS),
  }),
]);
export type TicketMutation = z.infer<typeof TicketMutation>;
export type TicketMutationKind = TicketMutation["kind"];

/** Kinds that always need `prepare` then `commit {approvalId}`; `setState` does when its target is terminal. */
export const CONFIRMED_TICKET_MUTATIONS: ReadonlySet<TicketMutationKind> = new Set([
  "comment",
  "deleteComment",
  "createIssue",
  "applyPlan",
]);

/** Whether a mutation needs an approval; `toStateType` is the target state's type for `setState`. */
export function ticketMutationConfirmed(
  mutation: TicketMutation,
  toStateType?: TicketStateType,
): boolean {
  if (mutation.kind === "setState") {
    return toStateType !== undefined && TERMINAL_TICKET_STATE_TYPES[toStateType];
  }
  return CONFIRMED_TICKET_MUTATIONS.has(mutation.kind);
}

/** What Mark as handled clears (Relay-only, host `handled.json`). */
export const HandledTarget = z.discriminatedUnion("kind", [
  /** Every waiting mention on the item up to and including `throughCommentId`. */
  z.object({
    kind: z.literal("mention"),
    provider: AttentionProvider,
    itemId: Id,
    throughCommentId: Id,
  }),
  z.object({ kind: z.literal("needs"), itemId: Id, reasonKind: NeedsYouKind, evidence: Id }),
]);
export type HandledTarget = z.infer<typeof HandledTarget>;

export const TicketsOp = z.discriminatedUnion("kind", [
  /** The whole board; answers `board` and `rev`. */
  z.object({ kind: z.literal("board") }),
  /** One ticket's page; answers `ticket`. */
  z.object({ kind: z.literal("ticket"), key: TicketKey }),
  /** Start (or stop) pushes to this device; on: answered by `board`, then `tickets.snapshot`/`delta`. */
  z.object({ kind: z.literal("subscribe"), on: z.boolean() }),
  /** Keep these keys synced for this device although they aren't Isaac's (agent cards); refreshed before `ttlMs`. */
  z.object({
    kind: z.literal("watch"),
    keys: z.array(TicketKey).max(MAX_TICKET_WATCH),
    ttlMs: z.number().int().positive().max(MAX_TICKET_WATCH_TTL_MS),
  }),
  /** Sync now (coalesced on the host). */
  z.object({ kind: z.literal("sync") }),
  /** Isaac opened the ticket; answers the watermark from before (`previousSeenAt`). */
  z.object({ kind: z.literal("seen"), key: TicketKey }),
  /** Mark as handled, or (`undo`) bring it back. */
  z.object({ kind: z.literal("handled"), target: HandledTarget, undo: z.boolean().optional() }),
  /** The 2-3 sentence summary; answers `summary`. */
  z.object({ kind: z.literal("summary"), key: TicketKey }),
  /** A confirmed kind's approval; answers `approval`. */
  z.object({ kind: z.literal("prepare"), viewerId: Id, mutation: TicketMutation }),
  /** The write; answers `outcome`. A repeated `opId` answers the stored outcome. */
  z.object({
    kind: z.literal("commit"),
    viewerId: Id,
    approvalId: Id.optional(),
    opId: TicketOpId,
    mutation: TicketMutation,
  }),
  /** Relay-only Timeline starts (no Linear write); null clears one. */
  z.object({
    kind: z.literal("plan"),
    rows: z
      .array(z.object({ key: TicketKey, plannedStart: TimelessDate.nullable() }))
      .max(MAX_TICKET_PLAN_ROWS),
  }),
  /** Ask Astra (private item session) to re-plan a project or milestone; answers `proposal`. */
  z.object({ kind: z.literal("replan"), projectId: Id, milestoneId: Id.optional() }),
]);
export type TicketsOp = z.infer<typeof TicketsOp>;
export type TicketsOpKind = TicketsOp["kind"];

export const TicketsRefusalCode = z.enum([
  "writesOff",
  "identity",
  "approval",
  "conflict",
  "invalid",
  "unknownOutcome",
]);
export type TicketsRefusalCode = z.infer<typeof TicketsRefusalCode>;

/**
 * What the confirm shows, in full: the host resolves the target and names it with live keys and
 * titles; a change too large to show whole is refused (`invalid`) rather than clipped.
 */
export const TicketApproval = z.object({
  id: Id,
  expiresAt: ms,
  /** One line: what is written where (`Reply on ENG-12 (Title) as you`, `Move ENG-12 to Done`). */
  summary: Short,
  /** The exact text written (comment body, new issue description). */
  text: z.string().max(MAX_TICKET_TEXT).optional(),
  /** The description text an inline comment quotes. */
  quote: z.string().max(MAX_TICKET_TEXT).optional(),
  /** applyPlan: every row it writes, by the issue's live key and title. */
  rows: z
    .array(z.object({ key: TicketKey, title: Name, change: Short }))
    .max(MAX_TICKET_PLAN_ROWS)
    .optional(),
});
export type TicketApproval = z.infer<typeof TicketApproval>;
/** What check() shows for a confirm (the approval without its id and expiry). */
export const TicketConfirm = TicketApproval.omit({ id: true, expiresAt: true });
export type TicketConfirm = z.infer<typeof TicketConfirm>;

export const TicketOutcomeState = z.enum(["done", "failed", "unknown"]);
export type TicketOutcomeState = z.infer<typeof TicketOutcomeState>;

export const TicketOutcome = z.object({
  opId: TicketOpId,
  /** `unknown`: the response was lost; the host reconciles and never rewrites on its own. */
  state: TicketOutcomeState,
  result: z
    .object({
      /** The created or changed comment/issue. */
      id: Id.optional(),
      key: TicketKey.optional(),
      url: Url.optional(),
      error: Short.optional(),
      /** A PR merge (reviews `prCommit`), read back after the write. */
      merge: z.enum(["merged", "queued", "autoMergeArmed"]).optional(),
      /** `applyPlan`: each row's own outcome. */
      rows: z
        .array(
          z.object({
            key: TicketKey,
            opId: TicketOpId,
            state: TicketOutcomeState,
            error: Short.optional(),
          }),
        )
        .max(MAX_TICKET_PLAN_ROWS)
        .optional(),
    })
    .optional(),
});
export type TicketOutcome = z.infer<typeof TicketOutcome>;

export const TicketSummary = z.object({
  key: TicketKey,
  /** Null: no valid summary (facts only). */
  text: z.string().max(2000).nullable(),
  at: ms,
});
export type TicketSummary = z.infer<typeof TicketSummary>;

/** Astra's re-plan, validated; rows outside the milestone at the baseline are dropped by the host. */
export const TicketPlanProposal = z.object({
  summary: Short,
  changes: z
    .array(
      z.object({
        key: TicketKey,
        start: TimelessDate.nullable().optional(),
        dueDate: TimelessDate.nullable().optional(),
        priority: TicketPriority.optional(),
        prioritySortOrder: z.number().finite().optional(),
        reason: Short,
      }),
    )
    .max(MAX_TICKET_PLAN_ROWS),
});
export type TicketPlanProposal = z.infer<typeof TicketPlanProposal>;

export const TicketsResult = z.object({
  rid: TicketsRid,
  ok: z.boolean(),
  /** Why it failed, one line for the UI. */
  error: Short.optional(),
  /** The gate said no; nothing was written. */
  refused: z.object({ code: TicketsRefusalCode, message: Short }).optional(),
  board: TicketsBoard.optional(),
  /** The board's revision (with `board`). */
  rev: Count.optional(),
  ticket: TicketDetail.optional(),
  approval: TicketApproval.optional(),
  outcome: TicketOutcome.optional(),
  /** Answer to `seen`: the watermark before this visit; null on a first visit. */
  previousSeenAt: ms.nullable().optional(),
  summary: TicketSummary.optional(),
  status: TicketsStatus.optional(),
  proposal: TicketPlanProposal.optional(),
});
export type TicketsResult = z.infer<typeof TicketsResult>;

/** Frames a client sends (only to a host with TICKETS_FEATURE). */
export const TicketsClientFrames = [
  /** One tickets op; answered by `tickets.res` with the same `rid`. */
  z.object({ t: z.literal("tickets.req"), rid: TicketsRid, op: TicketsOp }),
] as const;

/** Frames the host sends; pushes only to devices that subscribed. */
export const TicketsServerFrames = [
  /** Answer to `tickets.req`. */
  TicketsResult.extend({ t: z.literal("tickets.res") }),
  /** The whole board at `rev`: on subscribe and after a client gap. */
  z.object({
    t: z.literal("tickets.snapshot"),
    rev: Count,
    board: TicketsBoard,
    status: TicketsStatus,
  }),
  /** Changes from `base` to `rev`; `base` not the client's rev: ask `board` again. */
  z.object({
    t: z.literal("tickets.delta"),
    rev: Count,
    base: Count,
    upserts: z.array(TicketBoardFacts).max(MAX_TICKETS),
    /** Keys gone from the board (out of membership, access lost). */
    tombstones: z.array(TicketKey).max(MAX_TICKETS),
    status: TicketsStatus.optional(),
  }),
  /** Sync health or identity changed. */
  z.object({ t: z.literal("tickets.status"), status: TicketsStatus }),
] as const;
