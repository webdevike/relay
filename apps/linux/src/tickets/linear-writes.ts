// Linear writes as Isaac for the tickets MutationGate (PLAN §5): one check/run/reconcile per
// TicketMutation kind over Linear's GraphQL API. check() resolves and binds the live target the write
// depends on (from-state, comment owner, thread root and whether it sits on the issue or on its
// description's document content, the issue's own document content, team states, reply count, the
// new issue's source comment, template and project, a plan row's live key) and refuses inconsistent
// references; its confirm names the live keys and titles and carries the exact text and every plan
// row. Creates pass `id: opId`, so a lost response is reconciled by reading that id. Reactions,
// subscriptions and resolve are desired state: run() reads first and no-ops when already so.
// applyPlan writes one issueUpdate per row; a row whose issue changed since the plan was drafted is
// refused on its own, and a row already at its values (an earlier try) is done without a write.

import { createHash } from "node:crypto";
import { TicketStateType, type TicketMutation, type TicketPlanRow } from "@relay/protocol";
import { z } from "zod";
import { HostError, ProviderRejected, publicError } from "./errors";
import type { CheckResult, MutationExecutor } from "./gate";
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
const ISSUE_REF = `query TicketIssueRef($id: String!) { issue(id: $id) { id identifier title description documentContent { id } } }`;
const ISSUE_SUBSCRIBERS = `query TicketIssueSubscribers($id: String!) { issue(id: $id) { id identifier subscribers(first: 250) { nodes { id } } } }`;
const ISSUE_EXISTS = `query TicketIssueExists($id: ID!) { issues(filter: { id: { eq: $id } }) { nodes { id identifier url } } }`;
const PLAN_ISSUES = `query TicketPlanIssues($ids: [ID!]!) { issues(filter: { id: { in: $ids } }, first: 250) { nodes { id identifier title updatedAt dueDate priority prioritySortOrder } } }`;
const TEAM_STATES = `query TicketTeamStates($id: String!) { team(id: $id) { id key states(first: 250) { nodes { id name } } } }`;
const TEMPLATE = `query TicketTemplate($id: String!) { template(id: $id) { id name type updatedAt templateData team { id } } }`;
const PROJECT = `query TicketProject($id: String!) { project(id: $id) { id name teams(first: 50) { nodes { id } } } }`;
const COMMENT_REF = `query TicketCommentRef($id: String!) { comment(id: $id) { id body updatedAt resolvedAt user { id } parent { id } issue { id identifier } documentContent { id } } }`;
const COMMENT_REPLIES = `query TicketCommentReplies($id: String!) { comment(id: $id) { id body updatedAt user { id } issue { identifier } documentContent { id } children(first: 250) { nodes { id } pageInfo { hasNextPage } } } }`;
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
const IssueRef = z.object({
  issue: z.object({ id: z.string(), identifier: z.string(), title: z.string(), description: z.string().nullable().optional(), documentContent: Ref.nullable().optional() }).nullable(),
});
const IssueSubscribers = z.object({ issue: z.object({ identifier: z.string(), subscribers: Nodes(Ref) }).nullable() });
const IssueNode = z.object({ id: z.string(), identifier: z.string(), url: z.string() });
const IssueExists = z.object({ issues: Nodes(IssueNode) });
const PlanIssue = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  updatedAt: z.string(),
  dueDate: z.string().nullable(),
  priority: z.number(),
  prioritySortOrder: z.number(),
});
type PlanIssue = z.infer<typeof PlanIssue>;
const PlanIssues = z.object({ issues: Nodes(PlanIssue) });
const TeamStates = z.object({ team: z.object({ id: z.string(), key: z.string(), states: Nodes(z.object({ id: z.string(), name: z.string() })) }).nullable() });
const Template = z.object({
  template: z.object({ id: z.string(), name: z.string(), type: z.string(), updatedAt: z.string(), templateData: z.unknown(), team: Ref.nullable().optional() }).nullable(),
});
/** Sub-issues a template defines, where Linear's templateData lists them. */
const TemplateSubIssues = z.object({ subIssues: z.array(z.object({ title: z.string().optional() }).passthrough()) }).passthrough();
const Project = z.object({ project: z.object({ id: z.string(), name: z.string(), teams: Nodes(Ref) }).nullable() });
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
      /** Set for a comment on a document's content (an inline comment on the issue's description). */
      documentContent: Ref.nullable().optional(),
    })
    .nullable(),
});
const CommentReplies = z.object({
  comment: z
    .object({
      body: z.string(),
      updatedAt: z.string(),
      user: Ref.nullable(),
      issue: z.object({ identifier: z.string() }).nullable().optional(),
      documentContent: Ref.nullable().optional(),
      children: z.object({ nodes: z.array(Ref), pageInfo: z.object({ hasNextPage: z.boolean() }) }),
    })
    .nullable(),
});
const CommentReactions = z.object({
  comment: z.object({ reactions: z.array(z.object({ id: z.string(), emoji: z.string(), user: Ref.nullable() })) }).nullable(),
});
const CommentExists = z.object({ comments: Nodes(z.object({ id: z.string(), url: z.string() })) });
const IssuePayload = z.object({ issue: IssueNode.nullable().optional() });
const CommentPayload = z.object({ comment: z.object({ id: z.string(), url: z.string() }).nullable().optional() });

const PRIORITY = ["None", "Urgent", "High", "Medium", "Low"];
/** A revision string for live content (a description, a template's data). */
const digest = (...parts: readonly unknown[]): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const excerpt = (s: string): string => {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};
const invalid = (message: string): CheckResult => ({ ok: false, code: "invalid", message });
const GONE = "It's gone from Linear or you can't see it";

async function ask<T extends z.ZodTypeAny>(gql: LinearGql, query: string, variables: Record<string, unknown>, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await gql(query, variables));
  if (!parsed.success) throw new HostError("Linear answered in an unexpected shape");
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

/** What a plan row sets, for the confirm. */
function rowChange(row: TicketPlanRow): string {
  const parts: string[] = [];
  if (row.dueDate !== undefined) parts.push(`due ${row.dueDate ?? "none"}`);
  if (row.priority !== undefined) parts.push(`priority ${PRIORITY[row.priority] ?? String(row.priority)}`);
  if (row.prioritySortOrder !== undefined) parts.push(`order ${String(row.prioritySortOrder)}`);
  return parts.join(", ") || "no change";
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
    return { ...base, state: e instanceof ProviderRejected ? "failed" : "unknown", error: publicError(e, "Linear") };
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

/** Why a comment's target doesn't add up: an inline one must quote this issue's own description. */
function targetProblem(m: Of<"comment">, key: string, doc: string | null): string | null {
  if (m.documentContentId === undefined) return m.quotedText === undefined ? null : "A quote needs the description it is from";
  if (doc === null || m.documentContentId !== doc) return `That quote isn't on ${key}'s description`;
  if (m.parentId === undefined && (m.quotedText ?? "") === "") return "An inline comment needs the text it quotes";
  return null;
}

/**
 * A reply's root, as Linear has it: a thread's first comment, either on the issue (then the reply
 * goes to the issue) or on the issue's description (then the reply goes to that document content).
 */
async function checkReplyRoot(gql: LinearGql, m: Of<"comment">, issueId: string, doc: string | null): Promise<{ problem: string } | { rev: string }> {
  const { comment } = await ask(gql, COMMENT_REF, { id: m.parentId }, CommentRef);
  if (comment === null) return { problem: "The thread is gone from Linear" };
  if (comment.parent !== null) return { problem: "Replies go to the thread's first comment" };
  const rootDoc = comment.documentContent?.id ?? null;
  const placed = rootDoc !== null ? rootDoc === doc && m.documentContentId === rootDoc : comment.issue?.id === issueId && m.documentContentId === undefined;
  if (!placed) return { problem: rootDoc !== null ? "Reply in the thread on the description where it started" : "That thread is on another issue" };
  // The thread as Isaac saw it: an edit or resolve of its root voids the confirm.
  return { rev: digest(comment.id, comment.updatedAt, comment.resolvedAt) };
}

/**
 * The comment's target and the live revision it binds: the issue, its description's content (for an
 * inline comment, whose quote must still be in it) and the thread root it replies to.
 */
async function commentTarget(gql: LinearGql, m: Of<"comment">, issue: NonNullable<z.infer<typeof IssueRef>["issue"]>): Promise<{ problem: string } | { rev: string }> {
  const doc = issue.documentContent?.id ?? null;
  const problem = targetProblem(m, issue.identifier, doc);
  if (problem !== null) return { problem };
  const description = issue.description ?? "";
  if (m.parentId === undefined && m.quotedText !== undefined && !description.includes(m.quotedText)) return { problem: `That text isn't in ${issue.identifier}'s description any more` };
  const root = m.parentId === undefined ? { rev: "" } : await checkReplyRoot(gql, m, issue.id, doc);
  if ("problem" in root) return root;
  return { rev: digest(issue.id, doc, m.documentContentId === undefined ? "" : description, root.rev) };
}

function commentOps(gql: LinearGql): KindOps<Of<"comment">> {
  return {
    async check(m) {
      const { issue } = await ask(gql, ISSUE_REF, { id: m.issueId }, IssueRef);
      if (issue === null) return invalid(GONE);
      const target = await commentTarget(gql, m, issue);
      if ("problem" in target) return invalid(target.problem);
      const what = m.parentId === undefined ? "Comment on" : "Reply on";
      const where = m.documentContentId === undefined ? issue.identifier : `${issue.identifier}'s description`;
      const quote = m.quotedText === undefined ? {} : { quote: m.quotedText };
      return { ok: true, revision: target.rev, summary: `${what} ${where} (${issue.title}) as you`, text: m.body, ...quote };
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

const onIssue = (c: { issue?: { identifier: string } | null | undefined }): string => (c.issue ? ` on ${c.issue.identifier}` : "");

function editOps(gql: LinearGql, viewerId: () => string | null): KindOps<Of<"editComment">> {
  return {
    async check(m) {
      const { comment } = await ask(gql, COMMENT_REF, { id: m.commentId }, CommentRef);
      if (comment === null) return invalid(GONE);
      if (comment.user === null || comment.user.id !== viewerId()) return invalid("You can only edit your own comments");
      return { ok: true, revision: comment.updatedAt, summary: `Edit your comment${onIssue(comment)}`, text: m.body };
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
      if (comment.children.pageInfo.hasNextPage) return invalid("It has more replies than Relay can count; delete it in Linear");
      const replies = comment.children.nodes.length;
      if (replies !== m.replyCount) return { ok: false, code: "conflict", message: `It has ${String(replies)} replies now; deleting it deletes them too` };
      const which = comment.documentContent ? "inline comment on the description" : "comment";
      const summary = `Delete your ${which}${onIssue(comment)} "${excerpt(comment.body)}"${replies > 0 ? ` and its ${String(replies)} replies` : ""}`;
      return { ok: true, revision: digest(comment.updatedAt, replies), summary };
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
      return { ok: true, revision: comment.resolvedAt === null ? "open" : "resolved", summary: `${m.on ? "Resolve" : "Reopen"} the thread${onIssue(comment)}` };
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

type Team = { readonly id: string; readonly key: string };
type Named = { problem: string } | { name: string | null; rev: string };

/** Template-defined sub-issues Linear also creates, as the confirm names them. */
function subIssues(data: unknown): string {
  const parsed = TemplateSubIssues.safeParse(data);
  if (!parsed.success) return "";
  const titles = parsed.data.subIssues.map((s) => s.title ?? "untitled");
  return titles.length === 0 ? "" : ` with ${String(titles.length)} sub-issues: ${titles.join(", ")}`;
}

/** The template, when given: an issue template of this team (or of none), bound to its live content. */
async function templateOf(gql: LinearGql, id: string | null, team: Team): Promise<Named> {
  if (id === null) return { name: null, rev: "" };
  const { template } = await ask(gql, TEMPLATE, { id }, Template);
  const teamOk = (template?.team ?? null) === null || template?.team?.id === team.id;
  if (template === null || template.type !== "issue" || !teamOk) return { problem: `That template isn't an issue template of team ${team.key}` };
  return { name: `template ${template.name}${subIssues(template.templateData)}`, rev: digest(template.updatedAt, template.templateData) };
}

/** The project, when given: one this team is in. */
async function projectOf(gql: LinearGql, id: string | null, team: Team): Promise<Named> {
  if (id === null) return { name: null, rev: "" };
  const { project } = await ask(gql, PROJECT, { id }, Project);
  return project !== null && project.teams.nodes.some((t) => t.id === team.id) ? { name: `project ${project.name}`, rev: project.id } : { problem: `That project isn't in team ${team.key}` };
}

/** A new issue's source and reference comments, template and project, each checked against the team. */
async function createRefs(gql: LinearGql, m: Of<"createIssue">, team: Team): Promise<{ problem: string } | { from: string; names: string[]; rev: string }> {
  const source = (await ask(gql, COMMENT_REF, { id: m.sourceCommentId }, CommentRef)).comment;
  if (source === null) return { problem: "The comment it starts from is gone from Linear" };
  const reference = m.referenceCommentId === m.sourceCommentId ? source : (await ask(gql, COMMENT_REF, { id: m.referenceCommentId }, CommentRef)).comment;
  if (reference === null) return { problem: "The comment it links back to is gone from Linear" };
  const named = [await templateOf(gql, m.templateId, team), await projectOf(gql, m.projectId, team)];
  const names: string[] = [];
  const revs: string[] = [];
  for (const n of named) {
    if ("problem" in n) return n;
    if (n.name !== null) names.push(n.name);
    revs.push(n.rev);
  }
  return { from: source.issue ? `a comment on ${source.issue.identifier}` : "a comment", names, rev: digest(revs) };
}

function createOps(gql: LinearGql): KindOps<Of<"createIssue">> {
  return {
    async check(m) {
      const { team } = await ask(gql, TEAM_STATES, { id: m.teamId }, TeamStates);
      if (team === null) return invalid("That team is gone from Linear or you can't see it");
      const state = team.states.nodes.find((s) => s.id === m.stateId);
      if (state === undefined) return invalid(`That status isn't in team ${team.key}`);
      const refs = await createRefs(gql, m, team);
      if ("problem" in refs) return invalid(refs.problem);
      const where = [state.name, ...refs.names].join(", ");
      return {
        ok: true,
        revision: digest(team.id, m.stateId, m.sourceCommentId, m.referenceCommentId, m.templateId, m.projectId, refs.rev),
        summary: `New issue in ${team.key} (${where}) from ${refs.from}: ${m.title}`,
        text: m.description,
      };
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

/** A plan row whose id isn't the issue its key names (or is gone): drafted from something else. */
function planProblem(rows: readonly TicketPlanRow[], live: ReadonlyMap<string, PlanIssue>): string | null {
  for (const row of rows) {
    const issue = live.get(row.issueId);
    if (issue === undefined) return `${row.key}: ${GONE}`;
    if (issue.identifier !== row.key) return `${row.key} isn't that issue in Linear (it is ${issue.identifier}). Make the plan again.`;
  }
  return null;
}

function planOps(gql: LinearGql): KindOps<Of<"applyPlan">> {
  return {
    async check(m) {
      const live = await planIssues(gql, m.rows);
      const problem = planProblem(m.rows, live);
      if (problem !== null) return invalid(problem);
      const issues = m.rows.map((r) => live.get(r.issueId)).filter((i): i is PlanIssue => i !== undefined);
      const revision = createHash("sha256").update(issues.map((i) => `${i.id}@${i.updatedAt}`).join(",")).digest("hex");
      const rows = m.rows.map((r, i) => ({ key: issues[i]?.identifier ?? r.key, title: issues[i]?.title ?? "", change: rowChange(r) }));
      return { ok: true, revision, summary: `Apply the plan to ${String(rows.length)} issues in Linear`, rows };
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

/**
 * The Linear family's executor; `viewerId` is the Linear account the host acts as. `guard` runs
 * immediately before every mutation request (each plan row, after every awaited read) and throws
 * StaleCredential when the pinned key or account is no longer the host's, so nothing goes out.
 */
export function linearExecutor(raw: LinearGql, viewerId: () => string | null, guard: () => void = () => undefined): MutationExecutor<TicketMutation> {
  const gql: LinearGql = (query, variables) => {
    if (query.startsWith("mutation")) guard();
    return raw(query, variables);
  };
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
