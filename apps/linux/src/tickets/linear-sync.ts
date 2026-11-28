// Isaac's Linear issues for the Board, read incrementally (PLAN T0.3): issues assigned to him, that
// he follows or whose comments link his profile, changed since the watermark (30 days back on a
// first run, plus his open assigned ones), 25 per page and at most 8 pages a cycle. The watermark
// (newest updatedAt - 60 s) moves only after a full pass; a cut-short pass resumes from its cursor
// with the same filter next cycle. Watched keys (agent cards) are read by key each cycle; the
// notifications (100) are read each cycle for attention and to refresh issues whose comments,
// reactions or edits did not bump them. Every 30 minutes an id-only pass over the same membership
// tombstones what left it; a key Linear no longer answers (access lost) is tombstoned when seen.

import { TERMINAL_TICKET_STATE_TYPES, type Ticket, type TicketComment, type TicketPrRef, type TicketStateType } from "@relay/protocol";
import { z } from "zod";
import type { LinearGql } from "../reviews/linear";
import type { LinearNotice } from "./attention";
import type { IssueEntry, TicketsStore } from "./store";

export const LINEAR_PAGE = 25;
export const LINEAR_MAX_PAGES = 8;
export const LOOKBACK_MS = 30 * 24 * 60 * 60_000;
export const WATERMARK_SLACK_MS = 60_000;
export const RECONCILE_EVERY_MS = 30 * 60_000;
export const TOMBSTONE_KEEP_MS = 24 * 60 * 60_000;
/** Keys one by-key read asks for. */
const KEYS_PER_CALL = 50;
const MAX_KEY_CALLS = 2;
const RECONCILE_PAGE = 250;
const KEPT_COMMENTS = 50;
const MAX_TEAMS = 20;

const ms = (iso: string | null | undefined): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
};

const Person = z.object({ id: z.string(), name: z.string(), avatarUrl: z.string().nullable().optional() });
type Person = z.infer<typeof Person>;
const actor = (p: Person | null | undefined): Ticket["assignee"] => (p ? { id: p.id, name: p.name, avatarUrl: p.avatarUrl ?? null } : null);
const Link = z.object({ id: z.string(), identifier: z.string(), title: z.string() });

const CommentNode = z.object({
  id: z.string(),
  body: z.string(),
  url: z.string(),
  createdAt: z.string(),
  editedAt: z.string().nullable().optional(),
  resolvedAt: z.string().nullable().optional(),
  quotedText: z.string().nullable().optional(),
  documentContentId: z.string().nullable().optional(),
  parent: z.object({ id: z.string() }).nullable().optional(),
  user: Person.nullable().optional(),
  resolvingUser: Person.nullable().optional(),
  /** `[{emoji, reactions: [{userId}]}]` (Linear's JSON); unknown shapes count as none. */
  reactionData: z.unknown().optional(),
});
type CommentNode = z.infer<typeof CommentNode>;

const IssueNode = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  url: z.string(),
  priority: z.number(),
  prioritySortOrder: z.number(),
  dueDate: z.string().nullable(),
  startedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  documentContent: z.object({ id: z.string() }).nullable().optional(),
  state: z.object({ id: z.string(), name: z.string(), type: z.string(), color: z.string() }),
  team: z.object({ id: z.string(), key: z.string() }),
  assignee: Person.nullable(),
  creator: Person.nullable(),
  labels: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string(), color: z.string() })) }),
  project: z.object({ id: z.string(), name: z.string(), targetDate: z.string().nullable() }).nullable(),
  projectMilestone: z.object({ id: z.string(), name: z.string(), targetDate: z.string().nullable(), sortOrder: z.number() }).nullable().optional(),
  parent: Link.nullable(),
  children: z.object({ nodes: z.array(Link.extend({ state: z.object({ type: z.string() }) })) }),
  relations: z.object({ nodes: z.array(z.object({ type: z.string(), relatedIssue: Link })) }),
  inverseRelations: z.object({ nodes: z.array(z.object({ type: z.string(), issue: Link })) }),
  attachments: z.object({ nodes: z.array(z.object({ url: z.string() })) }),
  subscribers: z.object({ nodes: z.array(z.object({ id: z.string() })) }),
  comments: z.object({ nodes: z.array(CommentNode) }),
});
type IssueNode = z.infer<typeof IssueNode>;

const COMMENT_FIELDS = `id body url createdAt editedAt resolvedAt quotedText documentContentId parent { id }
  user { id name avatarUrl } resolvingUser { id name avatarUrl } reactionData`;

/** Everything a board card and its attention need; `comments` sets how many. */
export const issueFields = (comments: string): string => `
  id identifier title description url priority prioritySortOrder dueDate startedAt createdAt updatedAt
  documentContent { id }
  state { id name type color } team { id key }
  assignee { id name avatarUrl } creator { id name avatarUrl }
  labels { nodes { id name color } }
  project { id name targetDate } projectMilestone { id name targetDate sortOrder }
  parent { id identifier title }
  children { nodes { id identifier title state { type } } }
  relations { nodes { type relatedIssue { id identifier title } } }
  inverseRelations { nodes { type issue { id identifier title } } }
  attachments { nodes { url } }
  subscribers { nodes { id } }
  comments(${comments}) { nodes { ${COMMENT_FIELDS} } }`;

const PageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const IssuesPage = z.object({ issues: z.object({ nodes: z.array(IssueNode), pageInfo: PageInfo }) });
const IdsPage = z.object({ issues: z.object({ nodes: z.array(z.object({ identifier: z.string() })), pageInfo: PageInfo }) });
const IssueOne = z.object({ issue: IssueNode.nullable() });

const ISSUES_QUERY = `query($filter: IssueFilter, $after: String, $first: Int!) {
  issues(filter: $filter, after: $after, first: $first, orderBy: updatedAt) {
    nodes { ${issueFields(`last: ${String(KEPT_COMMENTS)}`)} } pageInfo { hasNextPage endCursor } } }`;
const IDS_QUERY = `query($filter: IssueFilter, $after: String, $first: Int!) {
  issues(filter: $filter, after: $after, first: $first) { nodes { identifier } pageInfo { hasNextPage endCursor } } }`;
const DETAIL_QUERY = `query($id: String!) { issue(id: $id) { ${issueFields("first: 250")} } }`;
const NOTICES_QUERY = `{ notifications(first: 100) { nodes {
  type createdAt ... on IssueNotification { issue { identifier } comment { id } } } } }`;

const TEAMS_QUERY = `query($ids: [ID!]) { teams(filter: { id: { in: $ids } }) { nodes {
  id key states { nodes { id name type color position } } } } }`;
const TeamsData = z.object({
  teams: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        key: z.string(),
        states: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string(), type: z.string(), color: z.string(), position: z.number() })) }),
      }),
    ),
  }),
});

const Notices = z.object({
  notifications: z.object({
    nodes: z.array(
      z.object({
        type: z.string(),
        createdAt: z.string(),
        issue: z.object({ identifier: z.string() }).nullable().optional(),
        comment: z.object({ id: z.string() }).nullable().optional(),
      }),
    ),
  }),
});

const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;

/** PRs linked as Linear attachments (`github.com/<o>/<r>/pull/<n>`), deduped. */
export function prRefsOf(urls: readonly string[]): TicketPrRef[] {
  const seen = new Map<string, TicketPrRef>();
  for (const url of urls) {
    const m = PR_URL.exec(url);
    if (m?.[1] !== undefined && m[2] !== undefined) seen.set(`${m[1]}#${m[2]}`, { repo: m[1], number: Number(m[2]) });
  }
  return [...seen.values()].slice(0, 20);
}

/** A Linear workflow type the protocol knows (`triage` ... `canceled`). */
const knownType = (type: string): type is TicketStateType => Object.hasOwn(TERMINAL_TICKET_STATE_TYPES, type);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const day = (d: string | null): string | null => (d !== null && DATE.test(d) ? d : null);

type Relation = Ticket["relations"][number];
const OUT_KIND: Record<string, Relation["kind"]> = { blocks: "blocks", duplicate: "duplicateOf", related: "related", similar: "similar" };
const IN_KIND: Record<string, Relation["kind"]> = { blocks: "blockedBy", duplicate: "duplicate", related: "related", similar: "similar" };

function relationsOf(i: IssueNode): Relation[] {
  const out = i.relations.nodes.flatMap((r) => {
    const kind = OUT_KIND[r.type];
    return kind === undefined ? [] : [{ id: r.relatedIssue.id, key: r.relatedIssue.identifier, title: r.relatedIssue.title, kind }];
  });
  const inbound = i.inverseRelations.nodes.flatMap((r) => {
    const kind = IN_KIND[r.type];
    return kind === undefined ? [] : [{ id: r.issue.id, key: r.issue.identifier, title: r.issue.title, kind }];
  });
  return [...out, ...inbound].slice(0, 200);
}

const ReactionData = z.array(
  z.object({ emoji: z.string().min(1), reactions: z.array(z.object({ userId: z.string().optional(), user: Person.optional() }).passthrough()).optional() }).passthrough(),
);

function reactionsOf(data: unknown): TicketComment["reactions"] {
  const parsed = ReactionData.safeParse(data);
  if (!parsed.success) return [];
  return parsed.data.slice(0, 50).map((r) => ({
    emoji: r.emoji.slice(0, 64),
    users: (r.reactions ?? [])
      .map((x) => (x.user ? actor(x.user) : x.userId ? { id: x.userId, name: x.userId, avatarUrl: null } : null))
      .filter((u): u is NonNullable<typeof u> => u !== null)
      .slice(0, 50),
  }));
}

export function toComment(c: CommentNode): TicketComment {
  return {
    id: c.id,
    parentId: c.parent?.id ?? null,
    documentContentId: c.documentContentId ?? null,
    quotedText: c.quotedText ?? null,
    author: actor(c.user),
    body: c.body.slice(0, 20_000),
    at: ms(c.createdAt) ?? 0,
    editedAt: ms(c.editedAt),
    resolvedAt: ms(c.resolvedAt),
    resolvingUser: actor(c.resolvingUser),
    reactions: reactionsOf(c.reactionData),
    url: c.url,
  };
}

/** A Linear issue as the protocol's Ticket and its comments (oldest first); `viewerId` sets `subscribed`. */
export function toEntry(i: IssueNode, viewerId: string | null): IssueEntry {
  const ms0 = (iso: string): number => ms(iso) ?? 0;
  const type: TicketStateType = knownType(i.state.type) ? i.state.type : "backlog";
  const m = i.projectMilestone ?? null;
  const ticket: Ticket = {
    key: i.identifier,
    id: i.id,
    documentContentId: i.documentContent?.id ?? null,
    title: i.title,
    description: (i.description ?? "").slice(0, 100_000),
    url: i.url,
    state: { ...i.state, type },
    team: i.team,
    priority: Math.min(4, Math.max(0, Math.round(i.priority))),
    prioritySortOrder: i.prioritySortOrder,
    assignee: actor(i.assignee),
    creator: actor(i.creator),
    labels: i.labels.nodes.slice(0, 50),
    project: i.project ? { ...i.project, targetDate: day(i.project.targetDate) } : null,
    milestone: m ? { id: m.id, name: m.name, targetDate: day(m.targetDate), sortOrder: m.sortOrder } : null,
    parent: i.parent ? { id: i.parent.id, key: i.parent.identifier, title: i.parent.title } : null,
    children: i.children.nodes.slice(0, 200).map((c) => ({ id: c.id, key: c.identifier, title: c.title, done: knownType(c.state.type) && TERMINAL_TICKET_STATE_TYPES[c.state.type] })),
    relations: relationsOf(i),
    prs: prRefsOf(i.attachments.nodes.map((a) => a.url)),
    dueDate: day(i.dueDate),
    startedAt: ms(i.startedAt),
    createdAt: ms0(i.createdAt),
    updatedAt: ms0(i.updatedAt),
    subscribed: viewerId !== null && i.subscribers.nodes.some((s) => s.id === viewerId),
  };
  const comments = i.comments.nodes.map(toComment).sort((a, b) => a.at - b.at);
  return { ticket, comments };
}

export interface LinearViewer {
  readonly id: string;
  /** The profile url a comment links to mention him; null: mentions come from notifications only. */
  readonly url: string | null;
}

const iso = (t: number): string => new Date(t).toISOString();

/** Assigned to, followed by, or mentioned in a comment of the viewer. */
function membership(v: LinearViewer): Record<string, unknown> {
  const or: Record<string, unknown>[] = [{ assignee: { id: { eq: v.id } } }, { subscribers: { some: { id: { eq: v.id } } } }];
  if (v.url !== null) or.push({ comments: { some: { body: { contains: v.url } } } });
  return { or };
}

/** Changed since `since`; a first pass (lookback) also takes his open assigned issues of any age. */
export function issueFilter(v: LinearViewer, since: number, first: boolean): Record<string, unknown> {
  const changed = { and: [{ updatedAt: { gt: iso(since) } }, membership(v)] };
  if (!first) return changed;
  return { or: [changed, { assignee: { id: { eq: v.id } }, state: { type: { nin: ["completed", "canceled"] } } }] };
}

/** Issues by key (`ENG-12`): team key + number, Linear's filter has no identifier. */
function keysFilter(keys: readonly string[]): Record<string, unknown> {
  return {
    or: keys.map((k) => {
      const dash = k.lastIndexOf("-");
      return { team: { key: { eq: k.slice(0, dash) } }, number: { eq: Number(k.slice(dash + 1)) } };
    }),
  };
}

const abortIf = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw new Error("Sync stopped");
};

export interface LinearSyncDeps {
  readonly gql: LinearGql;
  readonly store: TicketsStore;
  readonly now: () => number;
}

export class LinearSync {
  constructor(private readonly deps: LinearSyncDeps) {}

  /** One cycle's Linear reads; answers whether the membership pass is due. */
  async pass(viewer: LinearViewer, watched: readonly string[], signal?: AbortSignal): Promise<{ reconcileDue: boolean }> {
    await this.changed(viewer, signal);
    abortIf(signal);
    await this.byKeys(viewer, watched);
    abortIf(signal);
    await this.notices(viewer);
    abortIf(signal);
    await this.teams();
    const { reconciledAt } = this.deps.store.sync;
    return { reconcileDue: reconciledAt === null || this.deps.now() - reconciledAt >= RECONCILE_EVERY_MS };
  }

  /** Changed issues, at most LINEAR_MAX_PAGES pages; the watermark moves only after the last page. */
  private async changed(viewer: LinearViewer, signal: AbortSignal | undefined): Promise<void> {
    const store = this.deps.store;
    const { watermark } = store.sync;
    const cursor = store.sync.cursor ?? { since: watermark ?? this.deps.now() - LOOKBACK_MS, first: watermark === null, after: null, maxSeen: watermark ?? 0 };
    const filter = issueFilter(viewer, cursor.since, cursor.first);
    let { after, maxSeen } = cursor;
    for (let page = 0; page < LINEAR_MAX_PAGES; page++) {
      abortIf(signal);
      const { issues } = IssuesPage.parse(await this.deps.gql(ISSUES_QUERY, { filter, after, first: LINEAR_PAGE }));
      for (const node of issues.nodes) {
        const entry = toEntry(node, viewer.id);
        store.upsert(entry);
        maxSeen = Math.max(maxSeen, entry.ticket.updatedAt);
      }
      if (!issues.pageInfo.hasNextPage) {
        store.setSync({ cursor: null, watermark: Math.max(cursor.since, maxSeen - WATERMARK_SLACK_MS) });
        return;
      }
      after = issues.pageInfo.endCursor;
      store.setSync({ cursor: { ...cursor, after, maxSeen } });
    }
  }

  /**
   * Watched keys (and keys a notification touched), read by key; a stored key Linear no longer
   * answers is tombstoned as access lost and not asked for again for 24 h.
   */
  private async byKeys(viewer: LinearViewer, keys: readonly string[]): Promise<void> {
    const store = this.deps.store;
    const wanted = [...new Set(keys)].filter((k) => !store.accessLost(k)).slice(0, KEYS_PER_CALL * MAX_KEY_CALLS);
    for (let i = 0; i < wanted.length; i += KEYS_PER_CALL) {
      const chunk = wanted.slice(i, i + KEYS_PER_CALL);
      const { issues } = IssuesPage.parse(await this.deps.gql(ISSUES_QUERY, { filter: keysFilter(chunk), after: null, first: chunk.length }));
      const got = new Set<string>();
      for (const node of issues.nodes) {
        got.add(node.identifier);
        store.upsert(toEntry(node, viewer.id));
      }
      for (const k of chunk) if (!got.has(k) && store.issue(k) !== undefined) store.tombstone(k, true);
    }
  }

  /** The newest 100 notifications; issues they touched since the last read are read again. */
  private async notices(viewer: LinearViewer): Promise<void> {
    const store = this.deps.store;
    const data = Notices.parse(await this.deps.gql(NOTICES_QUERY));
    const notices: LinearNotice[] = data.notifications.nodes.flatMap((n) =>
      n.issue ? [{ type: n.type, issueKey: n.issue.identifier, commentId: n.comment?.id ?? null, at: ms(n.createdAt) ?? 0 }] : [],
    );
    const since = store.sync.noticesAt;
    const touched = notices.filter((n) => since !== null && n.at > since && store.issue(n.issueKey) !== undefined).map((n) => n.issueKey);
    store.setSync({ notices, noticesAt: Math.max(since ?? 0, ...notices.map((n) => n.at)) });
    if (touched.length > 0) await this.byKeys(viewer, touched);
  }

  /** Workflow states of the synced issues' teams (drag-to-move), read again every 30 min or for a new team. */
  private async teams(): Promise<void> {
    const store = this.deps.store;
    const ids = [...new Set(store.entries().map((e) => e.ticket.team.id))].slice(0, MAX_TEAMS);
    const known = new Set(store.sync.teams.map((t) => t.id));
    const fresh = store.sync.teamsAt !== null && this.deps.now() - store.sync.teamsAt < RECONCILE_EVERY_MS;
    if (ids.length === 0 || (fresh && ids.every((id) => known.has(id)))) return;
    const { teams } = TeamsData.parse(await this.deps.gql(TEAMS_QUERY, { ids }));
    const parsed = teams.nodes.map((t) => ({
      id: t.id,
      key: t.key,
      states: t.states.nodes
        .filter((s) => knownType(s.type))
        .sort((a, b) => a.position - b.position)
        .slice(0, 60)
        .map((s) => ({ ...s, type: s.type as TicketStateType })),
    }));
    store.setSync({ teams: parsed, teamsAt: this.deps.now() });
  }

  /**
   * Id-only membership (the first-pass filter from now): stored issues outside it and not watched
   * are tombstoned. A pass that did not finish within the page limit tombstones nothing.
   */
  async reconcile(viewer: LinearViewer, watched: readonly string[], signal?: AbortSignal): Promise<void> {
    const store = this.deps.store;
    const filter = issueFilter(viewer, this.deps.now() - LOOKBACK_MS, true);
    const members = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < LINEAR_MAX_PAGES; page++) {
      abortIf(signal);
      const { issues } = IdsPage.parse(await this.deps.gql(IDS_QUERY, { filter, after, first: RECONCILE_PAGE }));
      for (const n of issues.nodes) members.add(n.identifier);
      if (!issues.pageInfo.hasNextPage) {
        const keep = new Set(watched);
        for (const key of store.keys()) if (!members.has(key) && !keep.has(key)) store.tombstone(key);
        store.setSync({ reconciledAt: this.deps.now() });
        store.purgeTombstones(TOMBSTONE_KEEP_MS);
        return;
      }
      after = issues.pageInfo.endCursor;
    }
  }

  /** One issue with every comment (the ticket page); null when Linear no longer answers it. */
  async detail(key: string, viewerId: string | null): Promise<IssueEntry | null> {
    const { issue } = IssueOne.parse(await this.deps.gql(DETAIL_QUERY, { id: key }));
    if (issue === null) return null;
    const entry = toEntry(issue, viewerId);
    this.deps.store.upsert({ ticket: entry.ticket, comments: entry.comments.slice(-KEPT_COMMENTS) });
    return entry;
  }
}
