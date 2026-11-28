// The PRs Isaac's tickets link (Linear attachments), kept fresh cheaply (PLAN T0.3): one batched
// GraphQL probe per cycle (at most 20 PRs a call) reads what moves a card (updatedAt, head, review
// decision, merge state, draft, the checks rollup, the newest comments and review threads with
// their reactions), so a check or reaction that does not bump `updatedAt` still changes the
// fingerprint. Only PRs whose fingerprint changed get the full facts read (at most 10 a call).
// No diffs here: those are Reviews' business. A repo or PR gh cannot see is "No access" and skipped.

import type { TicketPrFacts, TicketPrRef } from "@relay/protocol";
import type { GhGraphql } from "../reviews/github";
import type { PrAttentionInput, PrThreadComment } from "./attention";
import { HostError } from "./errors";
import type { TicketsStore } from "./store";

export const PROBES_PER_CALL = 20;
export const FACTS_PER_CALL = 10;

const REACTIONS = "reactionGroups { viewerHasReacted reactors { totalCount } }";
const PROBE_FIELDS = `updatedAt headRefOid reviewDecision mergeStateStatus isDraft state
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  comments(last: 10) { nodes { id updatedAt ${REACTIONS} } }
  reviewThreads(last: 10) { nodes { id isResolved comments(last: 1) { nodes { id updatedAt ${REACTIONS} } } } }`;
const COMMENT = "id body createdAt author { login } reactionGroups { viewerHasReacted }";
const FACT_FIELDS = `number title url state isDraft updatedAt headRefOid reviewDecision mergeStateStatus viewerDidAuthor
  author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
    __typename ... on CheckRun { status conclusion } ... on StatusContext { state } } } } } } }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } } } }
  comments(last: 30) { nodes { ${COMMENT} } }
  reviews(last: 20) { nodes { id body state submittedAt author { login } commit { oid } } }
  reviewThreads(last: 30) { nodes { id isResolved path line diffSide comments(first: 20) { nodes { ${COMMENT} } } } }`;

/** `p0: repository(owner: "o", name: "r") { pullRequest(number: 1) { ... } }` per PR. */
export function batchQuery(refs: readonly TicketPrRef[], fields: string): string {
  const parts = refs.map((ref, i) => {
    const [owner = "", name = ""] = ref.repo.split("/");
    return `p${String(i)}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${String(ref.number)}) { ${fields} } }`;
  });
  return `{ ${parts.join("\n")} }`;
}

/** The alias's PR node, or null when the repo or PR did not resolve (no access, gone). */
function nodeOf(data: Record<string, unknown> | null, i: number): Record<string, unknown> | null {
  const repo = data?.[`p${String(i)}`] as { pullRequest?: Record<string, unknown> | null } | null | undefined;
  return repo?.pullRequest ?? null;
}

interface Author {
  login: string;
}
interface RawComment {
  id: string;
  body: string;
  createdAt: string;
  author: Author | null;
  reactionGroups?: { viewerHasReacted: boolean }[];
}
interface RawFacts {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  updatedAt: string;
  headRefOid: string;
  reviewDecision: string | null;
  mergeStateStatus: string | null;
  viewerDidAuthor: boolean;
  author: Author | null;
  commits: { nodes: { commit: { statusCheckRollup: { state: string; contexts: { nodes: Record<string, string | undefined>[] } } | null } }[] };
  reviewRequests: { nodes: { requestedReviewer: { login?: string } | null }[] };
  comments: { nodes: RawComment[] };
  reviews: { nodes: { id: string; body: string; state: string; submittedAt: string | null; author: Author | null; commit: { oid: string } | null }[] };
  reviewThreads: { nodes: { id: string; isResolved: boolean; path: string; line: number | null; diffSide: string; comments: { nodes: RawComment[] } }[] };
}

const ms = (iso: string | null): number => {
  const t = iso === null ? NaN : Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/** A check run's conclusion or a status context's state, as a count bucket; anything else is pending. */
const CHECK_BUCKET: Record<string, "passed" | "failed"> = {
  SUCCESS: "passed",
  NEUTRAL: "passed",
  SKIPPED: "passed",
  FAILURE: "failed",
  ERROR: "failed",
  TIMED_OUT: "failed",
  CANCELLED: "failed",
  ACTION_REQUIRED: "failed",
  STARTUP_FAILURE: "failed",
};
const ROLLUP: Record<string, TicketPrFacts["checks"]["state"]> = { SUCCESS: "pass", FAILURE: "fail", ERROR: "fail", PENDING: "pending", EXPECTED: "pending" };
const DECISIONS: Record<string, TicketPrFacts["decision"]> = { APPROVED: "APPROVED", CHANGES_REQUESTED: "CHANGES_REQUESTED", REVIEW_REQUIRED: "REVIEW_REQUIRED" };

/** A check run by its conclusion, a status context by its state. */
function bucketOf(c: Record<string, string | undefined>): "passed" | "failed" | "pending" {
  const v = (c["conclusion"] ?? c["state"] ?? "").toUpperCase();
  return CHECK_BUCKET[v] ?? "pending";
}

function checksOf(raw: RawFacts): TicketPrFacts["checks"] {
  const rollup = raw.commits.nodes[0]?.commit.statusCheckRollup ?? null;
  const counts = { passed: 0, failed: 0, pending: 0 };
  for (const c of rollup?.contexts.nodes ?? []) counts[bucketOf(c)] += 1;
  return { state: rollup === null ? "none" : (ROLLUP[rollup.state] ?? "pending"), ...counts };
}

const STATES: Record<string, TicketPrFacts["state"]> = { OPEN: "open", CLOSED: "closed", MERGED: "merged" };

export function toFacts(ref: TicketPrRef, raw: RawFacts): TicketPrFacts {
  return {
    repo: ref.repo,
    number: ref.number,
    title: raw.title,
    url: raw.url,
    author: raw.author?.login ?? "ghost",
    state: STATES[raw.state] ?? "open",
    draft: raw.isDraft,
    checks: checksOf(raw),
    decision: raw.reviewDecision === null ? null : (DECISIONS[raw.reviewDecision] ?? null),
    mergeState: raw.mergeStateStatus,
    headSha: raw.headRefOid,
    updatedAt: ms(raw.updatedAt),
  };
}

const reacted = (c: RawComment): boolean => (c.reactionGroups ?? []).some((g) => g.viewerHasReacted);

/** Conversation comments share one root; review bodies are their own; line comments root at their thread. */
function threadComments(raw: RawFacts): PrThreadComment[] {
  const login = (a: Author | null): string => a?.login ?? "ghost";
  const conversation = raw.comments.nodes.map((c) => ({ id: c.id, rootId: "conversation", kind: "conversation" as const, author: login(c.author), body: c.body, at: ms(c.createdAt), viewerReacted: reacted(c) }));
  const reviews = raw.reviews.nodes
    .filter((r) => r.body.trim() !== "")
    .map((r) => ({ id: r.id, rootId: r.id, kind: "review" as const, author: login(r.author), body: r.body, at: ms(r.submittedAt), viewerReacted: false }));
  const lines = raw.reviewThreads.nodes.flatMap((t) =>
    t.comments.nodes.map((c) => ({
      id: c.id,
      rootId: t.id,
      kind: "review-line" as const,
      author: login(c.author),
      body: c.body,
      at: ms(c.createdAt),
      viewerReacted: reacted(c),
      path: t.path,
      ...(t.line === null ? {} : { line: t.line }),
      side: t.diffSide === "LEFT" ? ("LEFT" as const) : ("RIGHT" as const),
      resolved: t.isResolved,
    })),
  );
  return [...conversation, ...reviews, ...lines].sort((a, b) => a.at - b.at);
}

export function toAttentionInput(ref: TicketPrRef, raw: RawFacts, login: string): PrAttentionInput {
  const facts = toFacts(ref, raw);
  return {
    facts,
    comments: threadComments(raw),
    viewerIsAuthor: raw.viewerDidAuthor,
    viewerRequested: raw.reviewRequests.nodes.some((r) => r.requestedReviewer?.login === login),
    viewerReviewedHead: raw.reviews.nodes.some((r) => r.author?.login === login && r.commit?.oid === raw.headRefOid && r.state !== "PENDING"),
    relayAutoMergeDisarmed: false,
  };
}

const abortIf = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw new HostError("Sync stopped");
};

/** Relay-armed auto-merge (reviews/github-writes.ts): a push after Relay armed it turns it off again. */
export interface AutoMergeWatch {
  /** A push turned Relay's auto-merge off on this PR (Needs you: autoMergeOff). */
  disarmed(ref: TicketPrRef): boolean;
  /** The PR's head as just read; another head than the one Relay armed at disarms it. */
  headSeen(ref: TicketPrRef, head: string, open: boolean): Promise<void>;
}

export class GithubSync {
  constructor(
    private readonly graphql: GhGraphql,
    private readonly store: TicketsStore,
    private readonly autoMerge: AutoMergeWatch | null = null,
  ) {}

  /** Probes every linked PR; reads full facts for the ones whose fingerprint changed. */
  async pass(login: string, signal?: AbortSignal): Promise<void> {
    const refs = this.store.linkedPrs();
    const changed: { ref: TicketPrRef; fingerprint: string }[] = [];
    for (let i = 0; i < refs.length; i += PROBES_PER_CALL) {
      abortIf(signal);
      const chunk = refs.slice(i, i + PROBES_PER_CALL);
      const { data } = await this.graphql(batchQuery(chunk, PROBE_FIELDS));
      chunk.forEach((ref, j) => {
        const node = nodeOf(data, j);
        const prev = this.store.pr(ref);
        if (node === null) {
          this.store.setPr({ ref, fingerprint: null, input: null, noAccess: true });
          return;
        }
        const fingerprint = JSON.stringify(node);
        if (prev?.fingerprint !== fingerprint || prev.input === null) changed.push({ ref, fingerprint });
      });
    }
    for (let i = 0; i < changed.length; i += FACTS_PER_CALL) {
      abortIf(signal);
      await this.facts(changed.slice(i, i + FACTS_PER_CALL), login);
    }
  }

  private async facts(batch: readonly { ref: TicketPrRef; fingerprint: string }[], login: string): Promise<void> {
    const { data } = await this.graphql(batchQuery(batch.map((b) => b.ref), FACT_FIELDS));
    for (const [j, { ref, fingerprint }] of batch.entries()) {
      const node = nodeOf(data, j);
      const input = node === null ? null : await this.watched(toAttentionInput(ref, node as unknown as RawFacts, login));
      this.store.setPr({ ref, fingerprint: node === null ? null : fingerprint, input, noAccess: node === null });
    }
  }

  /** The input with Relay's auto-merge disarmed when a push came after Relay armed it. */
  private async watched(input: PrAttentionInput): Promise<PrAttentionInput> {
    if (this.autoMerge === null) return input;
    const ref = { repo: input.facts.repo, number: input.facts.number };
    await this.autoMerge.headSeen(ref, input.facts.headSha, input.facts.state === "open");
    return { ...input, relayAutoMergeDisarmed: this.autoMerge.disarmed(ref) };
  }
}

/** Board order of a ticket's PR facts: the ones read, in link order; no-access PRs are left out. */
export function prInputs(store: TicketsStore, refs: readonly TicketPrRef[]): PrAttentionInput[] {
  return refs.flatMap((ref) => {
    const input = store.pr(ref)?.input ?? null;
    return input === null ? [] : [input];
  });
}
