// Linear writes as Isaac for the tickets MutationGate (PLAN §5): one check/run/reconcile per
// TicketMutation kind over Linear's GraphQL API. check() reads the live state the write depends on
// (from-state, comment owner, thread root, team states, reply count) and refuses when it no longer
// applies. Creates pass `id: opId`, so a lost response is reconciled by reading that id. Reactions,
// subscriptions and resolve are desired state: run() reads first and no-ops when already so.
// applyPlan writes one issueUpdate per row; a row whose issue changed since the plan was drafted is
// refused on its own, and a row already at its values (an earlier try) is done without a write.

import { TicketStateType, type TicketMutation, type TicketPlanRow } from "@relay/protocol";
import { z } from "zod";
import { ProviderRejected, type CheckResult, type MutationExecutor } from "./gate";
import type { OpResult } from "./ops-store";

export type LinearGql = (query: string, variables: Record<string, unknown>) => Promise<unknown>;
type Of<K extends TicketMutation["kind"]> = Extract<TicketMutation, { kind: K }>;
type RowOutcome = NonNullable<OpResult["rows"]>[number];

interface KindOps<M> {
  check(m: M): Promise<CheckResult>;
  run(m: M, opId: string): Promise<OpResult>;
  reconcile(m: M, opId: string): Promise<"done" | "notDone">;
}
type KindTable = { [K in TicketMutation["kind"]]: KindOps<Of<K>> };

const ISSUE_STATES = `query TicketIssueStates($id: String!) { issue(id: $id) { id identifier state { id name type } team { id states(first: 250) { nodes { id name type } } } } }`;
const ISSUE_STATE = `query TicketIssueState($id: String!) { issue(id: $id) { id state { id } } }`;
const ISSUE_REF = `query TicketIssueRef($id: String!) { issue(id: $id) { id identifier } }`;
const ISSUE_SUBSCRIBERS = `query TicketIssueSubscribers($id: String!) { issue(id: $id) { id identifier subscribers(first: 250) { nodes { id } } } }`;
const ISSUE_EXISTS = `query TicketIssueExists($id: ID!) { issues(filter: { id: { eq: $id } }) { nodes { id identifier url } } }`;
const PLAN_ISSUES = `query TicketPlanIssues($ids: [ID!]!) { issues(filter: { id: { in: $ids } }, first: 250) { nodes { id identifier updatedAt dueDate priority prioritySortOrder } } }`;
const TEAM_STATES = `query TicketTeamStates($id: String!) { team(id: $id) { id key states(first: 250) { nodes { id } } } }`;
const COMMENT_REF = `query TicketCommentRef($id: String!) { comment(id: $id) { id body updatedAt resolvedAt user { id } parent { id } issue { id identifier } } }`;
const COMMENT_REPLIES = `query TicketCommentReplies($id: String!) { comment(id: $id) { id user { id } children(first: 250) { nodes { id } } } }`;
const COMMENT_REACTIONS = `query TicketCommentReactions($id: String!) { comment(id: $id) { id reactions { id emoji user { id } } } }`;
const COMMENT_EXISTS = `query TicketCommentExists($id: ID!) { comments(filter: { id: { eq: $id } }) { nodes { id url } } }`;
const ISSUE_UPDATE = `mutation TicketIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier url } } }`;
const ISSUE_CREATE = `mutation TicketIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }`;
const ISSUE_SUBSCRIBE = `mutation TicketIssueSubscribe($id: String!) { issueSubscribe(id: $id) { success } }`;
const ISSUE_UNSUBSCRIBE = `mutation TicketIssueUnsubscribe($id: String!) { issueUnsubscribe(id: $id) { success } }`;
const COMMENT_CREATE = `mutation TicketCommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }`;
const COMMENT_UPDATE = `mutation TicketCommentUpdate($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success } }`;
const COMMENT_DELETE = `mutation TicketCommentDelete($id: String!) { commentDelete(id: $id) { success } }`;
const COMMENT_RESOLVE = `mutation TicketCommentResolve($id: String!) { commentResolve(id: $id) { success } }`;
const COMMENT_UNRESOLVE = `mutation TicketCommentUnresolve($id: String!) { commentUnresolve(id: $id) { success } }`;
const REACTION_CREATE = `mutation TicketReactionCreate($input: ReactionCreateInput!) { reactionCreate(input: $input) { success reaction { id } } }`;
const REACTION_DELETE = `mutation TicketReactionDelete($id: String!) { reactionDelete(id: $id) { success } }`;

const Ref = z.object({ id: z.string() });
const Nodes = <T extends z.ZodTypeAny>(node: T) => z.object({ nodes: z.array(node) });
const State = z.object({ id: z.string(), name: z.string(), type: z.string() });
const IssueStates = z.object({
  issue: z.object({ id: z.string(), identifier: z.string(), state: State, team: z.object({ id: z.string(), states: Nodes(State) }) }).nullable(),
});
const IssueState = z.object({ issue: z.object({ state: Ref }).nullable() });
const IssueRef = z.object({ issue: z.object({ id: z.string(), identifier: z.string() }).nullable() });
const IssueSubscribers = z.object({ issue: z.object({ identifier: z.string(), subscribers: Nodes(Ref) }).nullable() });
const IssueNode = z.object({ id: z.string(), identifier: z.string(), url: z.string() });
const IssueExists = z.object({ issues: Nodes(IssueNode) });
const PlanIssue = z.object({
  id: z.string(),
  identifier: z.string(),
  updatedAt: z.string(),
  dueDate: z.string().nullable(),
  priority: z.number(),
  prioritySortOrder: z.number(),
});
type PlanIssue = z.infer<typeof PlanIssue>;
const PlanIssues = z.object({ issues: Nodes(PlanIssue) });
const TeamStates = z.object({ team: z.object({ id: z.string(), key: z.string(), states: Nodes(Ref) }).nullable() });
const CommentRef = z.object({
  comment: z
    .object({
      id: z.string(),
      body: z.string(),
      updatedAt: z.string(),
      resolvedAt: z.string().nullable(),
      user: Ref.nullable(),
      parent: Ref.nullable(),
      issue: z.object({ id: z.string(), identifier: z.string() }).nullable(),
    })
    .nullable(),
});
const CommentReplies = z.object({ comment: z.object({ user: Ref.nullable(), children: Nodes(Ref) }).nullable() });
const CommentReactions = z.object({
  comment: z.object({ reactions: z.array(z.object({ id: z.string(), emoji: z.string(), user: Ref.nullable() })) }).nullable(),
});
const CommentExists = z.object({ comments: Nodes(z.object({ id: z.string(), url: z.string() })) });
const IssuePayload = z.object({ issue: IssueNode.nullable().optional() });
const CommentPayload = z.object({ comment: z.object({ id: z.string(), url: z.string() }).nullable().optional() });

const PRIORITY = ["None", "Urgent", "High", "Medium", "Low"];
const invalid = (message: string): CheckResult => ({ ok: false, code: "invalid", message });
const GONE = "It's gone from Linear or you can't see it";

async function ask<T extends z.ZodTypeAny>(gql: LinearGql, query: string, variables: Record<string, unknown>, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await gql(query, variables));
  if (!parsed.success) throw new Error("Linear answered in an unexpected shape");
  return parsed.data as z.infer<T>;
}

/** Runs a mutation and answers its payload; `success: false` is a definite refusal. */
async function mutate(gql: LinearGql, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const field = /\{\s*(\w+)\(/.exec(query)?.[1] ?? "";
  const data = (await gql(query, variables)) as Record<string, { success?: unknown } | null | undefined> | null;
  const payload = data?.[field];
  if (payload?.success !== true) throw new ProviderRejected(`Linear refused ${field}`);
  return payload;
}

function issueResult(payload: unknown): OpResult {
  const issue = IssuePayload.safeParse(payload).data?.issue;
  return issue ? { id: issue.id, key: issue.identifier, url: issue.url } : {};
}

/** The fields of a plan row that differ from Linear now (empty: already applied). */
function rowChanges(row: TicketPlanRow, live: PlanIssue): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (row.dueDate !== undefined && row.dueDate !== live.dueDate) input["dueDate"] = row.dueDate;
  if (row.priority !== undefined && row.priority !== live.priority) input["priority"] = row.priority;
  if (row.prioritySortOrder !== undefined && row.prioritySortOrder !== live.prioritySortOrder) input["prioritySortOrder"] = row.prioritySortOrder;
  return input;
}

function rowSummary(row: TicketPlanRow): string {
  const parts: string[] = [];
  if (row.dueDate !== undefined) parts.push(`due ${row.dueDate ?? "none"}`);
  if (row.priority !== undefined) parts.push(`priority ${PRIORITY[row.priority] ?? String(row.priority)}`);
  if (row.prioritySortOrder !== undefined) parts.push(`order ${String(row.prioritySortOrder)}`);
  return `${row.key}: ${parts.join(", ") || "no change"}`;
}

async function applyRow(gql: LinearGql, row: TicketPlanRow, live: PlanIssue | undefined): Promise<RowOutcome> {
  const base = { key: row.key, opId: row.opId };
  if (live === undefined) return { ...base, state: "failed", error: GONE };
  const input = rowChanges(row, live);
  if (Object.keys(input).length === 0) return { ...base, state: "done" };
  if (Date.parse(live.updatedAt) !== row.baseUpdatedAt) return { ...base, state: "failed", error: "Changed in Linear since the plan was made" };
  try {
    await mutate(gql, ISSUE_UPDATE, { id: row.issueId, input });
    return { ...base, state: "done" };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { ...base, state: e instanceof ProviderRejected ? "failed" : "unknown", error };
  }
}

async function planIssues(gql: LinearGql, rows: readonly TicketPlanRow[]): Promise<Map<string, PlanIssue>> {
  const data = await ask(gql, PLAN_ISSUES, { ids: rows.map((r) => r.issueId) }, PlanIssues);
  return new Map(data.issues.nodes.map((n) => [n.id, n]));
}

function stateOps(gql: LinearGql): KindOps<Of<"setState">> {
  return {
    async check(m) {
      const { issue } = await ask(gql, ISSUE_STATES, { id: m.issueId }, IssueStates);
      if (issue === null) return invalid(GONE);
      if (issue.state.id !== m.fromStateId) return { ok: false, code: "conflict", message: `Changed in Linear since you looked: ${issue.identifier} is in ${issue.state.name} now` };
      const target = issue.team.states.nodes.find((s) => s.id === m.toStateId);
      if (target === undefined) return invalid(`That status isn't in ${issue.identifier}'s team`);
      return { ok: true, revision: issue.state.id, summary: `Move ${issue.identifier} to ${target.name}`, toStateType: TicketStateType.parse(target.type) };
    },
    async run(m) {
      return issueResult(await mutate(gql, ISSUE_UPDATE, { id: m.issueId, input: { stateId: m.toStateId } }));
    },
    async reconcile(m) {
      const { issue } = await ask(gql, ISSUE_STATE, { id: m.issueId }, IssueState);
      return issue?.state.id === m.toStateId ? "done" : "notDone";
    },
  };
}

async function checkReplyRoot(gql: LinearGql, parentId: string, issueId: string): Promise<string | null> {
  const { comment } = await ask(gql, COMMENT_REF, { id: parentId }, CommentRef);
  if (comment === null) return "The thread is gone from Linear";
  if (comment.parent !== null) return "Replies go to the thread's first comment";
  return comment.issue?.id === issueId ? null : "That thread is on another issue";
}

function commentOps(gql: LinearGql): KindOps<Of<"comment">> {
  return {
    async check(m) {
      const { issue } = await ask(gql, ISSUE_REF, { id: m.issueId }, IssueRef);
      if (issue === null) return invalid(GONE);
      const wrongRoot = m.parentId === undefined ? null : await checkReplyRoot(gql, m.parentId, issue.id);
      if (wrongRoot !== null) return invalid(wrongRoot);
      const what = m.parentId === undefined ? "Comment on" : "Reply on";
      return { ok: true, revision: issue.id, summary: `${what} ${issue.identifier} as you:\n\n${m.body}` };
    },
    async run(m, opId) {
      const target = m.documentContentId === undefined ? { issueId: m.issueId } : { documentContentId: m.documentContentId };
      const input = { id: opId, ...target, parentId: m.parentId, quotedText: m.quotedText, body: m.body };
      const comment = CommentPayload.safeParse(await mutate(gql, COMMENT_CREATE, { input })).data?.comment;
      return comment ? { id: comment.id, url: comment.url } : { id: opId };
    },
    async reconcile(_m, opId) {
      const { comments } = await ask(gql, COMMENT_EXISTS, { id: opId }, CommentExists);
      return comments.nodes.length > 0 ? "done" : "notDone";
    },
  };
}

function editOps(gql: LinearGql, viewerId: () => string | null): KindOps<Of<"editComment">> {
  return {
    async check(m) {
      const { comment } = await ask(gql, COMMENT_REF, { id: m.commentId }, CommentRef);
      if (comment === null) return invalid(GONE);
      if (comment.user === null || comment.user.id !== viewerId()) return invalid("You can only edit your own comments");
      return { ok: true, revision: comment.updatedAt, summary: `Edit your comment:\n\n${m.body}` };
    },
    async run(m) {
      await mutate(gql, COMMENT_UPDATE, { id: m.commentId, input: { body: m.body } });
      return { id: m.commentId };
    },
    async reconcile(m) {
      const { comment } = await ask(gql, COMMENT_REF, { id: m.commentId }, CommentRef);
      return comment?.body === m.body ? "done" : "notDone";
    },
  };
}

function deleteOps(gql: LinearGql, viewerId: () => string | null): KindOps<Of<"deleteComment">> {
  return {
    async check(m) {
      const { comment } = await ask(gql, COMMENT_REPLIES, { id: m.commentId }, CommentReplies);
      if (comment === null) return invalid(GONE);
      if (comment.user === null || comment.user.id !== viewerId()) return invalid("You can only delete your own comments");
      const replies = comment.children.nodes.length;
      if (replies !== m.replyCount) return { ok: false, code: "conflict", message: `It has ${String(replies)} replies now; deleting it deletes them too` };
      const summary = replies > 0 ? `Delete your comment and its ${String(replies)} replies` : "Delete your comment";
      return { ok: true, revision: `replies:${String(replies)}`, summary };
    },
    async run(m) {
      await mutate(gql, COMMENT_DELETE, { id: m.commentId });
      return { id: m.commentId };
    },
    async reconcile(m) {
      const { comments } = await ask(gql, COMMENT_EXISTS, { id: m.commentId }, CommentExists);
      return comments.nodes.length === 0 ? "done" : "notDone";
    },
  };
}

function resolveOps(gql: LinearGql): KindOps<Of<"resolve">> {
  const resolved = async (rootId: string): Promise<boolean | null> => {
    const { comment } = await ask(gql, COMMENT_REF, { id: rootId }, CommentRef);
    return comment === null ? null : comment.resolvedAt !== null;
  };
  return {
    async check(m) {
      const { comment } = await ask(gql, COMMENT_REF, { id: m.rootId }, CommentRef);
      if (comment === null) return invalid(GONE);
      if (comment.parent !== null) return invalid("Only a thread's first comment resolves it");
      return { ok: true, revision: comment.resolvedAt === null ? "open" : "resolved", summary: m.on ? "Resolve the thread" : "Reopen the thread" };
    },
    async run(m) {
      if ((await resolved(m.rootId)) !== m.on) await mutate(gql, m.on ? COMMENT_RESOLVE : COMMENT_UNRESOLVE, { id: m.rootId });
      return { id: m.rootId };
    },
    async reconcile(m) {
      return (await resolved(m.rootId)) === m.on ? "done" : "notDone";
    },
  };
}

function reactOps(gql: LinearGql, viewerId: () => string | null): KindOps<Of<"react">> {
  const mine = async (m: Of<"react">): Promise<{ id: string } | null | undefined> => {
    const { comment } = await ask(gql, COMMENT_REACTIONS, { id: m.commentId }, CommentReactions);
    return comment === null ? null : comment.reactions.find((r) => r.emoji === m.emoji && r.user !== null && r.user.id === viewerId());
  };
  return {
    async check(m) {
      if (viewerId() === null) return invalid("No Linear account resolved");
      if ((await mine(m)) === null) return invalid(GONE);
      return { ok: true, revision: "comment", summary: `${m.on ? "React" : "Remove reaction"} ${m.emoji}` };
    },
    async run(m, opId) {
      const current = await mine(m);
      if (m.on && current === undefined) await mutate(gql, REACTION_CREATE, { input: { id: opId, commentId: m.commentId, emoji: m.emoji } });
      if (!m.on && current) await mutate(gql, REACTION_DELETE, { id: current.id });
      return { id: m.commentId };
    },
    async reconcile(m) {
      return Boolean(await mine(m)) === m.on ? "done" : "notDone";
    },
  };
}

function subscribeOps(gql: LinearGql, viewerId: () => string | null): KindOps<Of<"subscribe">> {
  const subscribed = async (issueId: string): Promise<{ key: string; on: boolean } | null> => {
    const { issue } = await ask(gql, ISSUE_SUBSCRIBERS, { id: issueId }, IssueSubscribers);
    const me = viewerId();
    return issue === null ? null : { key: issue.identifier, on: issue.subscribers.nodes.some((s) => s.id === me) };
  };
  return {
    async check(m) {
      if (viewerId() === null) return invalid("No Linear account resolved");
      const now = await subscribed(m.issueId);
      if (now === null) return invalid(GONE);
      return { ok: true, revision: now.on ? "on" : "off", summary: `${m.on ? "Subscribe to" : "Unsubscribe from"} ${now.key}` };
    },
    async run(m) {
      if ((await subscribed(m.issueId))?.on !== m.on) await mutate(gql, m.on ? ISSUE_SUBSCRIBE : ISSUE_UNSUBSCRIBE, { id: m.issueId });
      return { id: m.issueId };
    },
    async reconcile(m) {
      return (await subscribed(m.issueId))?.on === m.on ? "done" : "notDone";
    },
  };
}

function createOps(gql: LinearGql): KindOps<Of<"createIssue">> {
  return {
    async check(m) {
      const { team } = await ask(gql, TEAM_STATES, { id: m.teamId }, TeamStates);
      if (team === null) return invalid("That team is gone from Linear or you can't see it");
      if (!team.states.nodes.some((s) => s.id === m.stateId)) return invalid(`That status isn't in team ${team.key}`);
      return { ok: true, revision: team.id, summary: `New issue in ${team.key}: ${m.title}\n\n${m.description}` };
    },
    async run(m, opId) {
      const { kind: _kind, templateId, projectId, ...fields } = m;
      const input = { id: opId, ...fields, ...(templateId === null ? {} : { templateId }), ...(projectId === null ? {} : { projectId }) };
      return issueResult(await mutate(gql, ISSUE_CREATE, { input }));
    },
    async reconcile(_m, opId) {
      const { issues } = await ask(gql, ISSUE_EXISTS, { id: opId }, IssueExists);
      return issues.nodes.length > 0 ? "done" : "notDone";
    },
  };
}

function planOps(gql: LinearGql): KindOps<Of<"applyPlan">> {
  return {
    async check(m) {
      const live = await planIssues(gql, m.rows);
      const gone = m.rows.find((r) => !live.has(r.issueId));
      if (gone !== undefined) return invalid(`${gone.key}: ${GONE}`);
      return { ok: true, revision: "plan", summary: `Apply plan to Linear:\n${m.rows.map(rowSummary).join("\n")}` };
    },
    async run(m) {
      const live = await planIssues(gql, m.rows);
      const rows: RowOutcome[] = [];
      for (const row of m.rows) rows.push(await applyRow(gql, row, live.get(row.issueId)));
      return { rows };
    },
    async reconcile(m) {
      const live = await planIssues(gql, m.rows);
      const pending = m.rows.some((r) => {
        const issue = live.get(r.issueId);
        return issue === undefined || Object.keys(rowChanges(r, issue)).length > 0;
      });
      return pending ? "notDone" : "done";
    },
  };
}

/** The Linear family's executor; `viewerId` is the Linear account the host acts as. */
export function linearExecutor(gql: LinearGql, viewerId: () => string | null): MutationExecutor<TicketMutation> {
  const table: KindTable = {
    setState: stateOps(gql),
    comment: commentOps(gql),
    editComment: editOps(gql, viewerId),
    deleteComment: deleteOps(gql, viewerId),
    resolve: resolveOps(gql),
    react: reactOps(gql, viewerId),
    subscribe: subscribeOps(gql, viewerId),
    createIssue: createOps(gql),
    applyPlan: planOps(gql),
  };
  const ops = (m: TicketMutation): KindOps<TicketMutation> => table[m.kind] as unknown as KindOps<TicketMutation>;
  return {
    check: (m) => ops(m).check(m),
    run: (m, opId) => ops(m).run(m, opId),
    reconcile: (m, opId) => ops(m).reconcile(m, opId),
  };
}
