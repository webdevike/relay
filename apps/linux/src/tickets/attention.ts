// Pure attention rules (PLAN T0.4, §2.14): which comments wait on Isaac's reply and the one
// deterministic thing he should do on an item. No IO and no clock: every time comes from the input.
import type {
  Attention,
  AttentionAnchor,
  HandledTarget,
  NeedsYou,
  NeedsYouKind,
  TicketActor,
  TicketComment,
  TicketPrFacts,
  WaitingMention,
} from "@relay/protocol";

export interface AttentionMe {
  readonly linearViewerId: string | null;
  readonly linearNames: readonly string[];
  readonly ghLogin: string | null;
}
export interface LinearNotice {
  readonly type: string;
  readonly issueKey: string;
  readonly commentId: string | null;
  readonly at: number;
}
export interface PrThreadComment {
  readonly id: string;
  readonly rootId: string;
  readonly kind: "conversation" | "review" | "review-line";
  readonly author: string;
  readonly body: string;
  readonly at: number;
  readonly viewerReacted: boolean;
  readonly path?: string;
  readonly line?: number;
  readonly side?: "LEFT" | "RIGHT";
  /** The review thread this comment is in is resolved on GitHub. Absent: not resolved. */
  readonly resolved?: boolean;
}
export interface PrAttentionInput {
  readonly facts: TicketPrFacts;
  readonly comments: readonly PrThreadComment[];
  readonly viewerIsAuthor: boolean;
  readonly viewerRequested: boolean;
  readonly viewerReviewedHead: boolean;
  readonly relayAutoMergeDisarmed: boolean;
}
/** Keys: mentions `${provider}|${itemId}`, needs `${itemId}|${reasonKind}` -> evidence. */
export interface HandledState {
  readonly v: 1;
  readonly mentions: Readonly<Record<string, { commentId: string; at: number }>>;
  readonly needs: Readonly<Record<string, string>>;
}
export interface AttentionInput {
  readonly key: string;
  readonly closed: boolean;
  readonly comments: readonly TicketComment[];
  readonly notices: readonly LinearNotice[];
  readonly prs: readonly PrAttentionInput[];
  readonly me: AttentionMe;
  readonly handled: HandledState;
}

export const EMPTY_HANDLED: HandledState = { v: 1, mentions: {}, needs: {} };

const MENTION_NOTICES = new Set(["issueCommentMention", "issueMention"]);
const EXCERPT_MAX = 140;
const MAX_WAITING = 50;

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The body without fenced code blocks and inline code spans: a mention there asks nobody. */
export function withoutCode(body: string): string {
  return body
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, " ")
    .replace(/(`+)[\s\S]*?\1/g, " ");
}

function linearMentionRe(names: readonly string[]): RegExp | null {
  const alts = names.filter((n) => n.length > 0).map(esc);
  if (alts.length === 0) return null;
  return new RegExp(`linear\\.app/[^/\\s)]+/profiles/(?:${alts.join("|")})(?![\\w-])`, "i");
}

function githubMentionRe(login: string | null): RegExp | null {
  if (!login) return null;
  return new RegExp(`(?:^|[^\\w@/.-])@${esc(login)}(?![\\w-])`, "i");
}

/** Mentions and profile links removed, whitespace collapsed, at most 140 chars. */
export function excerptOf(body: string): string {
  const text = body
    .replace(/\[[^\]]*\]\(https?:\/\/linear\.app\/[^)\s]+\/profiles\/[^)\s]+\)/gi, " ")
    .replace(/https?:\/\/linear\.app\/\S+\/profiles\/[\w.-]+/gi, " ")
    .replace(/(^|[^\w])@[A-Za-z0-9][\w-]*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= EXCERPT_MAX ? text : `${text.slice(0, EXCERPT_MAX - 1).trimEnd()}…`;
}

interface Candidate {
  readonly provider: "linear" | "github";
  readonly itemId: string;
  readonly rootId: string;
  readonly commentId: string;
  readonly author: TicketActor;
  readonly at: number;
  readonly body: string;
  readonly anchor: AttentionAnchor;
}

function handledThrough(handled: HandledState, provider: string, itemId: string): number {
  return handled.mentions[`${provider}|${itemId}`]?.at ?? Number.NEGATIVE_INFINITY;
}

// ---- Linear ----

const linearRoot = (c: TicketComment): string => c.parentId ?? c.id;

function linearAsks(c: TicketComment, noticed: ReadonlySet<string>, re: RegExp | null): boolean {
  return noticed.has(c.id) || (re !== null && re.test(withoutCode(c.body)));
}

function linearCleared(
  c: TicketComment,
  thread: readonly TicketComment[],
  viewerId: string | null,
): boolean {
  const root = thread.find((t) => t.id === linearRoot(c));
  if (root?.resolvedAt != null) return true;
  if (viewerId === null) return false;
  if (c.reactions.some((r) => r.users.some((u) => u.id === viewerId))) return true;
  return thread.some((t) => t.author?.id === viewerId && t.at > c.at);
}

function linearAnchor(c: TicketComment, root: TicketComment | undefined): AttentionAnchor {
  const doc = root?.documentContentId ?? c.documentContentId;
  if (doc === null) return { kind: "comment" };
  return {
    kind: "inline",
    documentContentId: doc,
    quotedText: root?.quotedText ?? c.quotedText ?? "",
  };
}

const UNKNOWN_ACTOR: TicketActor = { id: "unknown", name: "Linear", avatarUrl: null };

function linearCandidates(input: AttentionInput): Candidate[] {
  const viewerId = input.me.linearViewerId;
  const re = linearMentionRe(input.me.linearNames);
  const noticed = new Set(
    input.notices
      .filter(
        (n) => MENTION_NOTICES.has(n.type) && n.issueKey === input.key && n.commentId !== null,
      )
      .map((n) => n.commentId as string),
  );
  const since = handledThrough(input.handled, "linear", input.key);
  const out: Candidate[] = [];
  for (const c of input.comments) {
    if (
      (viewerId !== null && c.author?.id === viewerId) ||
      c.at <= since ||
      !linearAsks(c, noticed, re)
    )
      continue;
    const rootId = linearRoot(c);
    const thread = input.comments.filter((t) => linearRoot(t) === rootId);
    if (linearCleared(c, thread, viewerId)) continue;
    const anchor = linearAnchor(
      c,
      thread.find((t) => t.id === rootId),
    );
    out.push({
      provider: "linear",
      itemId: input.key,
      rootId,
      commentId: c.id,
      author: c.author ?? UNKNOWN_ACTOR,
      at: c.at,
      body: c.body,
      anchor,
    });
  }
  return out;
}

// ---- GitHub ----

const prRef = (f: TicketPrFacts): { repo: string; number: number } => ({
  repo: f.repo,
  number: f.number,
});

const sameLogin = (a: string, b: string | null): boolean =>
  b !== null && a.toLowerCase() === b.toLowerCase();

function prCleared(
  c: PrThreadComment,
  thread: readonly PrThreadComment[],
  login: string | null,
): boolean {
  if (c.viewerReacted || thread.some((t) => t.resolved === true)) return true;
  return thread.some((t) => sameLogin(t.author, login) && t.at > c.at);
}

function prAnchor(
  c: PrThreadComment,
  root: PrThreadComment | undefined,
  pr: TicketPrFacts,
): AttentionAnchor {
  const ref = prRef(pr);
  const at = root?.kind === "review-line" ? root : c;
  if (at.kind === "review-line" && at.path && at.line) {
    return {
      kind: "pr-review-line",
      pr: ref,
      path: at.path,
      line: at.line,
      side: at.side ?? "RIGHT",
    };
  }
  return { kind: "pr-conversation", pr: ref };
}

function prCandidates(pr: PrAttentionInput, me: AttentionMe, handled: HandledState): Candidate[] {
  const re = githubMentionRe(me.ghLogin);
  if (re === null || pr.facts.state !== "open") return [];
  const itemId = `${pr.facts.repo}#${pr.facts.number}`;
  const since = handledThrough(handled, "github", itemId);
  const out: Candidate[] = [];
  for (const c of pr.comments) {
    if (sameLogin(c.author, me.ghLogin) || c.at <= since || !re.test(withoutCode(c.body))) continue;
    const thread = pr.comments.filter((t) => t.rootId === c.rootId);
    if (prCleared(c, thread, me.ghLogin)) continue;
    const anchor = prAnchor(
      c,
      thread.find((t) => t.id === c.rootId),
      pr.facts,
    );
    const author = { id: c.author, name: c.author, avatarUrl: null };
    out.push({
      provider: "github",
      itemId,
      rootId: c.rootId,
      commentId: c.id,
      author,
      at: c.at,
      body: c.body,
      anchor,
    });
  }
  return out;
}

// ---- Waiting ----

/** One chip per item and provider: the newest waiting mention, `count` of all waiting there. */
function collapse(cands: readonly Candidate[]): WaitingMention | null {
  if (cands.length === 0) return null;
  const newest = cands.reduce((a, b) => (b.at > a.at ? b : a));
  const { body, ...rest } = newest;
  return { ...rest, excerpt: excerptOf(body), count: cands.length };
}

function waitingOf(input: AttentionInput): WaitingMention[] {
  const groups = [
    input.closed ? [] : linearCandidates(input),
    ...input.prs.map((p) => prCandidates(p, input.me, input.handled)),
  ];
  return groups
    .map(collapse)
    .filter((w): w is WaitingMention => w !== null)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_WAITING);
}

// ---- Needs you ----

const needsKey = (itemId: string, kind: NeedsYouKind): string => `${itemId}|${kind}`;

function autoMergeOffReason(p: PrAttentionInput): NeedsYou | null {
  if (!p.relayAutoMergeDisarmed || p.facts.state !== "open") return null;
  const n = p.facts.number;
  return {
    kind: "autoMergeOff",
    text: "Auto-merge turned off: new commits since you approved",
    action: { kind: "openPr", label: `Open PR #${n}`, pr: prRef(p.facts) },
    evidence: p.facts.headSha,
  };
}

function mergeReason(p: PrAttentionInput): NeedsYou | null {
  const f = p.facts;
  const ready =
    p.viewerIsAuthor &&
    f.decision === "APPROVED" &&
    f.checks.state === "pass" &&
    f.mergeState === "CLEAN";
  if (!ready || f.state !== "open" || f.draft) return null;
  return {
    kind: "merge",
    text: `Merge PR #${f.number}`,
    action: { kind: "merge", label: `Merge PR #${f.number}`, pr: prRef(f) },
    evidence: `${f.headSha}|APPROVED`,
  };
}

function reviewReason(p: PrAttentionInput): NeedsYou | null {
  const f = p.facts;
  if (!p.viewerRequested || p.viewerReviewedHead || f.state !== "open") return null;
  return {
    kind: "review",
    text: `Review PR #${f.number}`,
    action: { kind: "review", label: `Review PR #${f.number}`, pr: prRef(f) },
    evidence: `${f.headSha}|requested`,
  };
}

function waitingReason(waiting: readonly WaitingMention[]): NeedsYou | null {
  const newest = waiting[0];
  if (!newest) return null;
  return {
    kind: "waiting",
    text: "Waiting on your reply",
    action: { kind: "reply", label: "Reply" },
    evidence: newest.commentId,
  };
}

/** Rule order is priority order; a reason handled with the same evidence is skipped. */
function needsYouOf(input: AttentionInput, waiting: readonly WaitingMention[]): NeedsYou | null {
  const reasons = [
    waitingReason(waiting),
    ...[autoMergeOffReason, mergeReason, reviewReason].flatMap((rule) => input.prs.map(rule)),
  ];
  return (
    reasons.find(
      (r): r is NeedsYou =>
        r !== null && input.handled.needs[needsKey(input.key, r.kind)] !== r.evidence,
    ) ?? null
  );
}

export function attentionOf(input: AttentionInput): Attention {
  const waiting = waitingOf(input);
  return { waiting, needsYou: needsYouOf(input, waiting) };
}

// ---- Handled ----

function without<V>(rec: Readonly<Record<string, V>>, key: string): Record<string, V> {
  const next = { ...rec };
  delete next[key];
  return next;
}

function applyMention(
  state: HandledState,
  t: Extract<HandledTarget, { kind: "mention" }>,
  undo: boolean,
  current: Attention,
): HandledState {
  const key = `${t.provider}|${t.itemId}`;
  if (undo) return { ...state, mentions: without(state.mentions, key) };
  const shown = current.waiting.find(
    (w) => w.provider === t.provider && w.itemId === t.itemId && w.commentId === t.throughCommentId,
  );
  const prev = state.mentions[key];
  if (!shown) return state;
  const at = Math.max(shown.at, prev?.at ?? Number.NEGATIVE_INFINITY);
  return {
    ...state,
    mentions: { ...state.mentions, [key]: { commentId: t.throughCommentId, at } },
  };
}

/** Mark as handled (or undo it: the key is removed). Pure. */
export function applyHandled(
  state: HandledState,
  target: HandledTarget,
  undo: boolean,
  current: Attention,
): HandledState {
  if (target.kind === "mention") return applyMention(state, target, undo, current);
  const key = needsKey(target.itemId, target.reasonKind);
  if (undo) return { ...state, needs: without(state.needs, key) };
  return { ...state, needs: { ...state.needs, [key]: target.evidence } };
}
