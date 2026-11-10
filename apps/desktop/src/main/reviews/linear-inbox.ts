// Linear in the Reviews page: tickets that want Isaac (his notifications: mentions, assignments,
// comments and replies, from other people, on tickets still open) and one ticket's details and
// comment threads, read from Linear's GraphQL API with his key (LINEAR_API_KEY or
// secrets/linear.env, like the ticket badge card). Images uploaded to Linear need that key, so main
// downloads them (review-media.ts) and the markdown points at the served `/reviews/media/<file>`.
// Posting a comment is the only write, after Isaac confirms the text; test instances (EVAOS_E2E=1)
// never post.
import * as path from 'node:path'
import { z } from 'zod'
import type { LinearRow, LinearTicket } from '@evaos/contract'
import type { MainContext } from '../context'
import { handle } from '../ipc/handle'
import { apiKey } from '../linear/linear-ipc'
import { REVIEWS_MEDIA_DIR, isLinearUpload, localizeImages } from './review-media'

const QUEUE_TTL_MS = 60_000

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code })

const ms = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? 0 : t
}

const User = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  /** The profile page; a link to it in a comment is a mention. */
  url: z.string().optional(),
})

const QueueData = z.object({
  viewer: User,
  notifications: z.object({
    nodes: z.array(
      z.object({
        type: z.string(),
        createdAt: z.string(),
        readAt: z.string().nullable(),
        archivedAt: z.string().nullable(),
        actor: User.nullable().optional(),
        issue: z
          .object({
            identifier: z.string(),
            title: z.string(),
            url: z.string(),
            state: z.object({ type: z.string() }),
            comments: z
              .object({
                nodes: z.array(
                  z.object({
                    createdAt: z.string(),
                    user: z.object({ id: z.string() }).nullable(),
                  }),
                ),
              })
              .optional(),
          })
          .nullable()
          .optional(),
      }),
    ),
  }),
})

const QUEUE_QUERY = `{
  viewer { id name displayName }
  notifications(first: 100) { nodes {
    type createdAt readAt archivedAt actor { id name displayName }
    ... on IssueNotification { issue {
      identifier title url state { type }
      comments(last: 20) { nodes { createdAt user { id } } }
    } }
  } }
}`

/**
 * Notification types that want an answer from Isaac, and how a row says so: an @mention, or a
 * comment or reply on a ticket or thread he follows. Assignments and status changes are not asks.
 */
export function reasonOf(type: string): string | null {
  if (type === 'issueCommentMention' || type === 'issueMention') return 'mentioned you'
  if (type === 'issueNewComment') return 'commented'
  if (/Reply|Thread/.test(type)) return 'replied'
  return null
}

/**
 * One row per ticket that still wants Isaac: the newest ask from someone else, newest first. A
 * ticket leaves once he has commented since that ask (a reply anywhere on it), and comes back with
 * the next ask.
 */
export function toRows(data: z.infer<typeof QueueData>): LinearRow[] {
  const rows = new Map<string, LinearRow>()
  for (const n of data.notifications.nodes) {
    const reason = reasonOf(n.type)
    const issue = n.issue
    if (!reason || !issue || n.archivedAt) continue
    // His own agents post as him; those are not asks. Nor is a finished ticket.
    if (n.actor?.id === data.viewer.id) continue
    if (issue.state.type === 'completed' || issue.state.type === 'canceled') continue
    const at = ms(n.createdAt)
    const prev = rows.get(issue.identifier)
    if (prev && prev.updatedAt >= at) {
      prev.unread ||= n.readAt === null
      continue
    }
    const lastMine = Math.max(
      0,
      ...(issue.comments?.nodes ?? [])
        .filter((c) => c.user?.id === data.viewer.id)
        .map((c) => ms(c.createdAt)),
    )
    // He has commented since this ask (and so since every older one): it is answered.
    if (lastMine >= at) continue
    rows.set(issue.identifier, {
      key: issue.identifier,
      title: issue.title,
      url: issue.url,
      reason,
      actor: n.actor?.name ?? 'Linear',
      updatedAt: at,
      unread: n.readAt === null || (prev?.unread ?? false),
    })
  }
  return [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

const Ticket = z.object({
  viewer: User,
  issue: z.object({
    id: z.string(),
    identifier: z.string(),
    title: z.string(),
    url: z.string(),
    description: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    priorityLabel: z.string(),
    creator: User.nullable(),
    state: z.object({ name: z.string(), type: z.string(), color: z.string() }),
    assignee: User.nullable(),
    team: z.object({ name: z.string() }),
    labels: z.object({ nodes: z.array(z.object({ name: z.string(), color: z.string() })) }),
    project: z.object({ name: z.string() }).nullable(),
    parent: z.object({ identifier: z.string(), title: z.string(), url: z.string() }).nullable(),
    children: z.object({
      nodes: z.array(
        z.object({
          identifier: z.string(),
          title: z.string(),
          url: z.string(),
          state: z.object({ name: z.string() }),
        }),
      ),
    }),
    attachments: z.object({
      nodes: z.array(
        z.object({ title: z.string(), url: z.string(), sourceType: z.string().nullable() }),
      ),
    }),
    comments: z.object({
      nodes: z.array(
        z.object({
          id: z.string(),
          body: z.string(),
          createdAt: z.string(),
          url: z.string(),
          user: User.nullable(),
          parent: z.object({ id: z.string() }).nullable(),
        }),
      ),
    }),
  }),
})

const TICKET_QUERY = `query($id: String!) {
  viewer { id name displayName url }
  issue(id: $id) {
    id identifier title url description createdAt updatedAt priorityLabel
    creator { id name displayName url }
    state { name type color } assignee { id name displayName url } team { name }
    labels { nodes { name color } } project { name }
    parent { identifier title url }
    children { nodes { identifier title url state { name } } }
    attachments { nodes { title url sourceType } }
    comments(first: 250) { nodes { id body createdAt url user { id name displayName url } parent { id } } }
  }
}`

const CommentMade = z.object({
  commentCreate: z.object({
    success: z.boolean(),
    comment: z.object({ url: z.string() }).nullable(),
  }),
})

const StatesData = z.object({
  issue: z.object({
    team: z.object({
      states: z.object({
        nodes: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            type: z.string(),
            color: z.string(),
            position: z.number(),
          }),
        ),
      }),
    }),
  }),
})

const StateSet = z.object({
  issueUpdate: z.object({
    success: z.boolean(),
    issue: z.object({ state: z.object({ name: z.string(), type: z.string(), color: z.string() }) }),
  }),
})

export function registerLinearInbox(
  ctx: MainContext,
  opts: { reads: boolean; writes: boolean },
): void {
  const mediaDir = path.join(ctx.config.dir, REVIEWS_MEDIA_DIR)

  const gql = async (query: string, variables: Record<string, unknown> = {}): Promise<unknown> => {
    if (!opts.reads)
      throw fail('linear-off', 'Linear is off in this instance (EVAOS_REVIEWS_GH=1 turns it on)')
    const token = await apiKey(ctx.env.evaRoot, ctx.env.configDir)
    if (!token)
      throw fail('no-linear-key', 'No Linear API key (connect Linear in Settings > Connections)')
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: token },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw fail('linear-failed', `Linear answered ${res.status}`)
    const body = z
      .object({
        data: z.unknown().optional(),
        errors: z.array(z.object({ message: z.string() })).optional(),
      })
      .parse(await res.json())
    if (body.errors?.length) throw fail('linear-failed', body.errors[0]!.message)
    return body.data
  }

  const withLocalImages = (md: string): Promise<string> =>
    localizeImages(md, mediaDir, [
      {
        match: isLinearUpload,
        headers: async (): Promise<Record<string, string>> => {
          const token = await apiKey(ctx.env.evaRoot, ctx.env.configDir)
          return token ? { authorization: token } : {}
        },
      },
    ])

  let cached: { at: number; rows: Promise<LinearRow[]> } | null = null
  handle(ctx, 'reviews.linearQueue', async ({ refresh }) => {
    if (refresh || !cached || Date.now() - cached.at > QUEUE_TTL_MS) {
      const rows = gql(QUEUE_QUERY).then((d) => toRows(QueueData.parse(d)))
      cached = { at: Date.now(), rows }
      rows.catch(() => {
        cached = null
      })
    }
    return cached.rows
  })

  handle(ctx, 'reviews.linearTicket', async ({ key }): Promise<LinearTicket> => {
    const { viewer, issue: i } = Ticket.parse(await gql(TICKET_QUERY, { id: key }))
    // A mention Linear understands is a link to the person's profile; `@handle` text is not one.
    const workspace = /^https:\/\/linear\.app\/[^/]+/.exec(i.url)?.[0] ?? 'https://linear.app'
    const person = (u: z.infer<typeof User>) => ({
      name: u.name,
      handle: u.displayName,
      url: u.url ?? `${workspace}/profiles/${u.displayName}`,
    })
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const mine = new RegExp(
      `(^|[^\\w])@${esc(viewer.displayName)}\\b|${esc(person(viewer).url)}(?![\\w-])`,
      'i',
    )
    const comments = await Promise.all(
      [...i.comments.nodes]
        .sort((a, b) => ms(a.createdAt) - ms(b.createdAt))
        .map(async (c) => ({
          id: c.id,
          parentId: c.parent?.id ?? null,
          author: c.user ? person(c.user) : { name: 'Linear', handle: 'linear', url: '' },
          body: await withLocalImages(c.body),
          at: ms(c.createdAt),
          url: c.url,
          mentionsMe: mine.test(c.body),
        })),
    )
    const people = new Map<string, LinearTicket['me']>()
    for (const u of [i.creator, i.assignee, ...i.comments.nodes.map((c) => c.user)]) {
      if (u && u.id !== viewer.id) people.set(u.id, person(u))
    }
    return {
      id: i.id,
      key: i.identifier,
      title: i.title,
      url: i.url,
      description: await withLocalImages(i.description ?? ''),
      creator: i.creator?.name ?? 'Linear',
      createdAt: ms(i.createdAt),
      updatedAt: ms(i.updatedAt),
      state: i.state,
      assignee: i.assignee?.name ?? null,
      priority: i.priorityLabel,
      labels: i.labels.nodes,
      project: i.project?.name ?? null,
      team: i.team.name,
      parent: i.parent
        ? { key: i.parent.identifier, title: i.parent.title, url: i.parent.url }
        : null,
      children: i.children.nodes.map((c) => ({
        key: c.identifier,
        title: c.title,
        url: c.url,
        state: c.state.name,
      })),
      links: i.attachments.nodes.map((a) => ({
        title: a.title,
        url: a.url,
        kind: a.sourceType ?? 'link',
      })),
      comments,
      people: [...people.values()],
      me: person(viewer),
    }
  })

  handle(ctx, 'reviews.linearComment', async ({ issueId, parentId, body }) => {
    if (!opts.writes) throw fail('dry-run', 'Test instance: the comment was not posted to Linear')
    const data = CommentMade.parse(
      await gql(
        `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { url } } }`,
        { input: { issueId, body, ...(parentId ? { parentId } : {}) } },
      ),
    )
    if (!data.commentCreate.success || !data.commentCreate.comment) {
      throw fail('linear-failed', 'Linear did not take the comment')
    }
    return { url: data.commentCreate.comment.url }
  })

  // The status picker: the workflow states of the ticket's team, in Linear's own board order.
  handle(ctx, 'reviews.linearStates', async ({ issueId }) => {
    const data = StatesData.parse(
      await gql(
        `query($id: String!) { issue(id: $id) { team { states { nodes { id name type color position } } } } }`,
        { id: issueId },
      ),
    )
    return [...data.issue.team.states.nodes].sort((a, b) => a.position - b.position)
  })

  handle(ctx, 'reviews.linearSetState', async ({ issueId, stateId }) => {
    if (!opts.writes) throw fail('dry-run', 'Test instance: the status was not changed in Linear')
    const data = StateSet.parse(
      await gql(
        `mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { state { name type color } } } }`,
        { id: issueId, stateId },
      ),
    )
    if (!data.issueUpdate.success) throw fail('linear-failed', 'Linear did not take the status')
    return data.issueUpdate.issue.state
  })
}
