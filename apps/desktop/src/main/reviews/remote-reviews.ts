// Reviews on a thin client (remote mode): this Mac has no gh login, no Linear key, no Slack session
// and no Astra; the Mini has all of them. Every `reviews.*` call is answered by the Mini's Relay
// Host (`reviews.req`, relay/host-reviews.ts), the same service Relay mobile uses, and mapped onto
// the page's contract here. Done marks, Astra's item sessions, the Guide and Slack reads are the
// Mini's, so both Macs and the phone show the same Reviews. Images the host serves
// (`/reviews/media/<file>/<token>`) are fetched once into this Mac's reviews-media dir and served as
// `/reviews/media/<file>` like local ones. The PR facts and Linear issues the context popover,
// ticket badge cards and thread statuses read come from the host too (`hostPrFacts`, `hostLinearIssue`).
import * as path from 'node:path'
import { z } from 'zod'
import {
  AstraItemSchema,
  LinearTicketSchema,
  ReviewApproveSchema,
  ReviewGuideSchema,
  ReviewWorkSchema,
  type AstraItem,
  type LinearIssue,
  type LinearRow,
  type ReviewPr,
  type ReviewQueue,
  type ReviewRow,
  type SlackQueue,
  type SlackRow,
  type SlackThread,
} from '@evaos/contract'
import type { MainContext } from '../context'
import { parsePr, type PrFacts } from '../context-popover/gh'
import { emit, handle } from '../ipc/handle'
import { cmdFrame } from '../relay/commands'
import type { RelayFrames } from '../relay/client'
import { OLD_HOST, type HostReviews } from '../relay/host-reviews'
import { REVIEWS_MEDIA_DIR, localizeImages } from './review-media'
import { rowStatusOf } from './row-status'

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code })

/** A queue answer this young is reused by the page's parallel queue, Linear and Slack reads. */
const QUEUE_REUSE_MS = 5_000
/** Completed and Created are read again after this long, like the local queue. */
const LISTS_TTL_MS = 60_000
/** How long a Slack refresh waits for the host's background read to finish. */
const SLACK_REFRESH_MS = 300_000
/** Item url -> its Astra session file in the mirror, kept so "Open in chat" works after the session ended. */
const ASTRA_FILES = 'reviews-astra-remote.json'

// ---------------------------------------------------------------------------------------------
// The host's shapes (relay packages/protocol/src/reviews.ts), read leniently.
// ---------------------------------------------------------------------------------------------

const Ref = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('github'), repo: z.string(), number: z.number() }),
  z.object({ kind: z.literal('linear'), key: z.string() }),
  z.object({ kind: z.literal('slack'), channel: z.string(), threadTs: z.string().nullable() }),
])
type Ref = z.infer<typeof Ref>

const Item = z.object({
  url: z.string(),
  ref: Ref,
  title: z.string(),
  actor: z.string(),
  reason: z.string(),
  label: z.string(),
  updatedAt: z.number(),
  unread: z.boolean(),
  draft: z.boolean().optional(),
  group: z.enum(['needs', 'reviewing']).optional(),
  slackKind: z.enum(['mention', 'dm', 'reply']).optional(),
})
type Item = z.infer<typeof Item>

const SourceState = z.object({
  loading: z.boolean(),
  error: z.string().nullable(),
  fetchedAt: z.number().nullable(),
})

export const HostQueue = z.object({
  items: z.array(Item),
  done: z.record(z.string(), z.number()),
  sources: z.object({ github: SourceState, linear: SourceState, slack: SourceState }),
})
export type HostQueue = z.infer<typeof HostQueue>

const HostPrs = z.object({ items: z.array(Item), total: z.number() })

const HostPr = z.object({
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  draft: z.boolean(),
  author: z.object({ login: z.string() }),
  createdAt: z.number(),
  updatedAt: z.number(),
  body: z.string(),
  base: z.string(),
  head: z.string(),
  additions: z.number(),
  deletions: z.number(),
  reviewers: z.array(z.object({ login: z.string(), state: z.string() })),
  assignees: z.array(z.string()),
  labels: z.array(z.object({ name: z.string(), color: z.string() })),
  milestone: z.string().nullable().optional(),
  projects: z.array(z.string()).optional(),
  timeline: z.array(
    z.object({
      kind: z.enum(['comment', 'review', 'commit']),
      author: z.string(),
      body: z.string(),
      state: z.string().nullable(),
      at: z.number(),
    }),
  ),
  checks: z.array(z.object({ name: z.string(), state: z.string(), url: z.string().nullable() })),
  files: z.array(
    z.object({
      path: z.string(),
      additions: z.number(),
      deletions: z.number(),
      change: z.string(),
    }),
  ),
  diff: z.string(),
})

const HostSlackThread = z.object({
  channel: z.string(),
  channelName: z.string(),
  threadTs: z.string().nullable(),
  messages: z.array(
    z.object({
      ts: z.string(),
      author: z.string(),
      mine: z.boolean(),
      text: z.string(),
      mentionsMe: z.boolean(),
      reactions: z.array(z.object({ emoji: z.string(), count: z.number() })),
      files: z.array(z.string()),
      attachments: z
        .array(z.object({ name: z.string(), id: z.string(), src: z.string().nullable() }))
        .default([]),
      at: z.number(),
    }),
  ),
  fetchedAt: z.number(),
})

const HostAstra = AstraItemSchema.omit({ file: true }).extend({ sessionId: z.string().nullable() })
type HostAstra = z.infer<typeof HostAstra>

const HostTicket = z.object({
  key: z.string(),
  title: z.string(),
  url: z.string(),
  updatedAt: z.number(),
  state: z.object({ name: z.string(), type: z.string() }),
  assignee: z.string().nullable(),
  priority: z.string(),
  project: z.string().nullable(),
})

// ---------------------------------------------------------------------------------------------
// Pure mappings (tested in remote-reviews.test.ts)
// ---------------------------------------------------------------------------------------------

/** A GitHub queue row as the page's row. */
export function toRow(item: Item): ReviewRow | null {
  if (item.ref.kind !== 'github') return null
  return {
    repo: item.ref.repo,
    number: item.ref.number,
    title: item.title,
    url: item.url,
    author: item.actor,
    draft: item.draft ?? false,
    updatedAt: item.updatedAt,
  }
}

const rows = (items: readonly Item[]): ReviewRow[] =>
  items.flatMap((i) => {
    const r = toRow(i)
    return r ? [r] : []
  })

/** The host's queue and Completed/Created lists as the page's queue (GitHub rows; Linear and Slack have their own calls). */
export function toQueue(
  q: HostQueue,
  lists: { completed: Item[]; completedTotal: number; created: Item[] },
  now: number,
): ReviewQueue {
  const gh = q.items.filter((i) => i.ref.kind === 'github')
  return {
    needs: rows(gh.filter((i) => i.group === 'needs')),
    reviewing: rows(gh.filter((i) => i.group === 'reviewing')),
    completed: rows(lists.completed),
    completedTotal: lists.completedTotal,
    created: rows(lists.created),
    done: q.done,
    fetchedAt: q.sources.github.fetchedAt ?? now,
  }
}

export function toLinearRows(q: HostQueue): LinearRow[] {
  return q.items.flatMap((i) =>
    i.ref.kind === 'linear'
      ? [
          {
            key: i.ref.key,
            title: i.title,
            url: i.url,
            reason: i.reason,
            actor: i.actor,
            updatedAt: i.updatedAt,
            unread: i.unread,
          },
        ]
      : [],
  )
}

/** A Slack message ts from its permalink (`/p1700000000123456`), else from the row's time. */
export function slackTs(url: string, updatedAt: number): string {
  const m = /\/p(\d{10})(\d{6})(?:[?#]|$)/.exec(url)
  return m ? `${m[1]}.${m[2]}` : (updatedAt / 1000).toFixed(6)
}

/** The host's Slack rows; null before its first read (the page then shows it is reading). */
export function toSlackQueue(q: HostQueue): SlackQueue | null {
  const slack = q.sources.slack
  const out: SlackRow[] = q.items.flatMap((i) =>
    i.ref.kind === 'slack'
      ? [
          {
            kind: i.slackKind ?? 'reply',
            channel: i.ref.channel,
            channelName: i.label,
            threadTs: i.ref.threadTs,
            ts: slackTs(i.url, i.updatedAt),
            author: i.actor,
            text: i.title,
            url: i.url,
            updatedAt: i.updatedAt,
          },
        ]
      : [],
  )
  if (slack.fetchedAt === null && out.length === 0) return null
  return { rows: out, fetchedAt: slack.fetchedAt ?? 0 }
}

/** The item a page url names, for `astraAsk`: the queue's own ref when it has the item, else read from the url. */
export function refOf(url: string, items: readonly Item[]): Ref | null {
  const known = items.find((i) => i.url === url)
  if (known) return known.ref
  const pr = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url)
  if (pr) return { kind: 'github', repo: pr[1]!, number: Number(pr[2]) }
  const ticket = /^https:\/\/linear\.app\/(?:[^/?#]+\/)?issue\/([A-Z][A-Z0-9]*-\d+)/.exec(url)
  if (ticket) return { kind: 'linear', key: ticket[1]! }
  const slack = /^https:\/\/[\w-]+\.slack\.com\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(
    url,
  )
  if (slack) {
    const thread = /[?&]thread_ts=(\d+\.\d+)/.exec(url)?.[1]
    const ts = `${slack[2]}.${slack[3]}`
    return {
      kind: 'slack',
      channel: slack[1]!,
      threadTs: thread ?? (slack[1]!.startsWith('D') ? null : ts),
    }
  }
  return null
}

/** Host-relative `/reviews/media/...` image links made absolute on the host's origin. */
export function absoluteMedia(md: string, origin: string): string {
  return md.replace(/(!\[[^\]\n]*\]\(\s*<?)(\/reviews\/media\/)/g, `$1${origin}$2`)
}

/** The host's PR as the page's PR: commits move out of the timeline, which keeps comments and reviews. */
export function toPr(pr: z.infer<typeof HostPr>): ReviewPr {
  const timeline = pr.timeline.flatMap((t) =>
    t.kind === 'commit'
      ? []
      : [{ kind: t.kind, author: t.author, body: t.body, state: t.state, at: t.at }],
  )
  const commits = pr.timeline.flatMap((t) =>
    t.kind === 'commit'
      ? [{ oid: t.state ?? '', headline: t.body, author: t.author, at: t.at }]
      : [],
  )
  return {
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    draft: pr.draft,
    author: { login: pr.author.login, avatarUrl: null },
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    body: pr.body,
    base: pr.base,
    head: pr.head,
    additions: pr.additions,
    deletions: pr.deletions,
    reviewers: pr.reviewers,
    assignees: pr.assignees,
    labels: pr.labels,
    milestone: pr.milestone ?? null,
    projects: pr.projects ?? [],
    participants: [
      ...new Set([pr.author.login, ...pr.timeline.map((t) => t.author).filter(Boolean)]),
    ],
    commits,
    timeline,
    checks: pr.checks,
    files: pr.files,
    diff: pr.diff,
  }
}

/** The host's Linear ticket as the badge card's issue. */
export function toIssue(t: z.infer<typeof HostTicket>): LinearIssue {
  return {
    identifier: t.key,
    title: t.title,
    url: t.url,
    state: t.state.name,
    stateType: t.state.type,
    priority: t.priority,
    assignee: t.assignee,
    project: t.project,
    updatedAt: t.updatedAt,
  }
}

// ---------------------------------------------------------------------------------------------
// Readers for the context popover, ticket badge cards and thread statuses
// ---------------------------------------------------------------------------------------------

/** A PR's facts from the Mini (`prView`); null when the host can't read it, as local gh would. */
export function hostPrFacts(host: HostReviews) {
  return async (repo: string, number: number): Promise<PrFacts | null> => {
    try {
      const a = await host.req({ kind: 'prView', repo, number })
      return a.view ? parsePr(repo, JSON.stringify(a.view)) : null
    } catch {
      return null
    }
  }
}

/** A Linear issue from the Mini (its `linear` op, with the Mini's key); null when Linear has none. */
export function hostLinearIssue(host: HostReviews) {
  return async (key: string): Promise<LinearIssue | null> => {
    try {
      return toIssue(HostTicket.parse((await host.req({ kind: 'linear', key })).ticket))
    } catch (e) {
      if (e instanceof Error && /not found/i.test(e.message)) return null
      throw e
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The page's handlers
// ---------------------------------------------------------------------------------------------

export interface RemoteReviewsDeps {
  host: HostReviews
  /** The connection's frames: Stop sends `agent.abort` for an item's live session. */
  frames: RelayFrames
  /** The host's http origin, for its served images; null while not connected. */
  origin(): string | null
  /** The mirror's file of omp session `id`, for "Open in chat". */
  sessionFile(id: string): string | null
  /** false in test instances: nothing is posted or handed to Astra. */
  writes: boolean
}

export function registerRemoteReviews(ctx: MainContext, d: RemoteReviewsDeps): void {
  const { host } = d
  const mediaDir = path.join(ctx.config.dir, REVIEWS_MEDIA_DIR)

  const local = async (md: string): Promise<string> => {
    const origin = d.origin()
    if (origin === null || !md.includes('/reviews/media/')) return md
    const prefix = `${origin}/reviews/media/`
    return localizeImages(absoluteMedia(md, origin), mediaDir, [
      { match: (u) => u.startsWith(prefix), headers: () => Promise.resolve({}) },
    ])
  }
  /** One host image path as a local `/reviews/media/<file>`; null when it can't be fetched. */
  const localSrc = async (src: string): Promise<string | null> => {
    const out = /^!\[\]\((.*)\)$/.exec(await local(`![](${src})`))?.[1] ?? null
    // A local copy is `/reviews/media/<file>`; the host's own `<file>/<token>` path means it was not fetched.
    return out?.startsWith('/reviews/media/') && !out.includes('/', '/reviews/media/'.length)
      ? out
      : null
  }

  // The latest queue heard (answer or push): refs for Astra asks, Slack's state for a refresh.
  let latest: { at: number; queue: HostQueue } | null = null
  let inflight: Promise<HostQueue> | null = null
  const slackWaiters = new Set<(q: HostQueue) => void>()
  const heard = (queue: HostQueue): void => {
    latest = { at: Date.now(), queue }
    for (const w of [...slackWaiters]) w(queue)
  }
  const hostQueue = (refresh: boolean): Promise<HostQueue> => {
    if (!refresh && latest && Date.now() - latest.at < QUEUE_REUSE_MS) {
      return Promise.resolve(latest.queue)
    }
    if (!refresh && inflight) return inflight
    const p = host.req({ kind: 'queue', refresh }).then((a) => {
      const q = HostQueue.parse(a.queue)
      heard(q)
      return q
    })
    inflight = p
    void p
      .finally(() => {
        if (inflight === p) inflight = null
      })
      .catch(() => undefined)
    return p
  }

  // Astra: item url -> session file, kept across restarts; live session ids for Stop.
  const files = (): Record<string, string> =>
    ctx.config.readJson<Record<string, string>>(ASTRA_FILES, {})
  const liveIds = new Map<string, string>()
  const toAstra = (a: HostAstra): AstraItem => {
    if (a.sessionId !== null) liveIds.set(a.url, a.sessionId)
    else liveIds.delete(a.url)
    const found = a.sessionId !== null ? d.sessionFile(a.sessionId) : null
    const known = files()
    if (found !== null && known[a.url] !== found) {
      ctx.config.writeJson(ASTRA_FILES, { ...known, [a.url]: found })
    }
    const { sessionId: _id, ...rest } = a
    return { ...rest, file: found ?? known[a.url] ?? null }
  }

  host.onPush((f) => {
    if (f.t === 'reviews.queue') {
      const q = HostQueue.safeParse(f.queue)
      if (q.success) heard(q.data)
    } else if (f.t === 'reviews.astra') {
      const a = HostAstra.safeParse(f.item)
      if (a.success) emit(ctx, 'reviews.astraUpdate', toAstra(a.data))
    }
  })

  // Completed and Created: asked separately; an old host that does not know `prList` is asked once.
  let lists: {
    at: number
    value: Promise<{ completed: Item[]; completedTotal: number; created: Item[] }>
  } | null = null
  let listsOff = false
  const prList = async (list: 'completed' | 'created'): Promise<z.infer<typeof HostPrs>> =>
    HostPrs.parse((await host.req({ kind: 'prList', list })).prs)
  const loadLists = (refresh: boolean) => {
    if (listsOff) return Promise.resolve({ completed: [], completedTotal: 0, created: [] })
    if (refresh || !lists || Date.now() - lists.at > LISTS_TTL_MS) {
      const value = Promise.all([prList('completed'), prList('created')]).then(
        ([completed, created]) => ({
          completed: completed.items,
          completedTotal: completed.total,
          created: created.items,
        }),
      )
      lists = { at: Date.now(), value }
      value.catch((e: unknown) => {
        lists = null
        if (e instanceof Error && e.message === OLD_HOST) listsOff = true
      })
    }
    return lists.value.catch(() => ({ completed: [], completedTotal: 0, created: [] }))
  }

  const sourceFailed = (q: HostQueue, source: 'github' | 'linear', code: string): void => {
    const s = q.sources[source]
    if (s.error !== null && s.fetchedAt === null) throw fail(code, s.error)
  }

  handle(ctx, 'reviews.queue', async ({ refresh }) => {
    const [q, l] = await Promise.all([hostQueue(refresh), loadLists(refresh)])
    sourceFailed(q, 'github', 'gh-failed')
    return toQueue(q, l, Date.now())
  })

  handle(ctx, 'reviews.pr', async ({ repo, number }) => {
    const pr = toPr(HostPr.parse((await host.req({ kind: 'pr', repo, number })).pr))
    const [body, timeline] = await Promise.all([
      local(pr.body),
      Promise.all(pr.timeline.map(async (t) => ({ ...t, body: await local(t.body) }))),
    ])
    return { ...pr, body, timeline }
  })

  handle(ctx, 'reviews.guide', async ({ repo, number }) =>
    ReviewGuideSchema.parse((await host.req({ kind: 'guide', repo, number })).guide),
  )

  handle(ctx, 'reviews.comment', async ({ repo, number, body }) => {
    if (!d.writes) throw fail('dry-run', 'Test instance: the comment was not posted')
    const a = await host.req({ kind: 'comment', repo, number, body })
    return { url: typeof a.url === 'string' ? a.url : '' }
  })

  handle(ctx, 'reviews.review', async ({ repo, number, event, body }) => {
    if (!d.writes) throw fail('dry-run', 'Test instance: the review was not submitted')
    await host.req({ kind: 'review', repo, number, event, body })
    return { ok: true as const }
  })

  handle(ctx, 'reviews.rowStatus', async ({ repo, number }) => {
    const a = await host.req({ kind: 'prView', repo, number })
    const status = rowStatusOf(a.view)
    if (!status) throw fail('gh-failed', `gh pr view ${repo}#${number} answered something else`)
    return status
  })

  handle(ctx, 'reviews.done', async ({ url, updatedAt, done }) => {
    const a = await host.req({ kind: 'done', url, updatedAt, done })
    return z.record(z.string(), z.number()).parse(a.done)
  })

  handle(ctx, 'reviews.linearQueue', async ({ refresh }) => {
    const q = await hostQueue(refresh)
    sourceFailed(q, 'linear', 'linear-failed')
    return toLinearRows(q)
  })

  handle(ctx, 'reviews.linearTicket', async ({ key }) => {
    const t = LinearTicketSchema.parse((await host.req({ kind: 'linear', key })).ticket)
    const [description, comments] = await Promise.all([
      local(t.description),
      Promise.all(t.comments.map(async (c) => ({ ...c, body: await local(c.body) }))),
    ])
    return { ...t, description, comments }
  })

  handle(ctx, 'reviews.linearComment', async ({ issueId, parentId, body }) => {
    if (!d.writes) throw fail('dry-run', 'Test instance: the comment was not posted to Linear')
    const a = await host.req({ kind: 'linearComment', issueId, parentId, body })
    return { url: typeof a.url === 'string' ? a.url : '' }
  })

  handle(ctx, 'reviews.slackQueue', async ({ refresh }) => {
    let q = await hostQueue(refresh)
    // The host reads Slack in the background and pushes the queue when done; a refresh waits for it.
    if (refresh && q.sources.slack.loading) {
      const read = Promise.withResolvers<HostQueue>()
      const done = (next: HostQueue): void => {
        if (next.sources.slack.loading) return
        clearTimeout(timer)
        slackWaiters.delete(done)
        read.resolve(next)
      }
      const timer = setTimeout(() => {
        slackWaiters.delete(done)
        read.resolve(latest?.queue ?? q)
      }, SLACK_REFRESH_MS)
      slackWaiters.add(done)
      q = await read.promise
    }
    const s = q.sources.slack
    if (s.error !== null && s.fetchedAt === null) throw fail('slack-failed', s.error)
    return toSlackQueue(q)
  })

  handle(
    ctx,
    'reviews.slackThread',
    async ({ channel, threadTs, refresh }): Promise<SlackThread | null> => {
      const a = await host.req({ kind: 'slack', channel, threadTs, refresh })
      if (a.thread === null || a.thread === undefined) return null
      const t = HostSlackThread.parse(a.thread)
      const messages = await Promise.all(
        t.messages.map(async (m) => ({
          ts: m.ts,
          author: m.author,
          mine: m.mine,
          text: await local(m.text),
          mentionsMe: m.mentionsMe,
          reactions: m.reactions,
          files: await Promise.all(
            (m.attachments.length > 0
              ? m.attachments
              : m.files.map((name) => ({ name, id: '', src: null }))
            ).map(async (f) => ({
              name: f.name,
              id: f.id,
              image: f.src === null ? null : await localSrc(f.src),
            })),
          ),
          at: m.at,
        })),
      )
      return {
        channel: t.channel,
        channelName: t.channelName,
        threadTs: t.threadTs,
        messages,
        fetchedAt: t.fetchedAt,
      }
    },
  )

  handle(ctx, 'reviews.slackSend', async ({ channel, threadTs, text }) => {
    const command = `reviews.req slackSend ${channel}${threadTs ? ` ${threadTs}` : ''}`
    if (!d.writes) return { status: 'dry-run' as const, command }
    await host.req({ kind: 'slackSend', channel, threadTs, text })
    return { status: 'sent' as const, command }
  })

  handle(ctx, 'reviews.astraAsk', async ({ url, text }) => {
    const ref = refOf(url, latest?.queue.items ?? [])
    if (ref === null)
      throw fail('not-an-item', 'Astra can only be asked about a PR, a ticket or a Slack thread')
    const a = await host.req({ kind: 'astraAsk', url, ref, text })
    return toAstra(HostAstra.parse(a.astra))
  })

  handle(ctx, 'reviews.astraThread', async ({ url }) => {
    const a = await host.req({ kind: 'astra', url })
    return a.astra === null || a.astra === undefined ? null : toAstra(HostAstra.parse(a.astra))
  })

  // The item's session runs on the Mini, which the chat view drives through Relay as well: there is
  // no process on this Mac to let go of.
  handle(ctx, 'reviews.astraRelease', () => ({ released: true }))

  handle(ctx, 'reviews.astraStop', async ({ url }) => {
    let id = liveIds.get(url)
    if (id === undefined) {
      const a = await host.req({ kind: 'astra', url })
      const item = HostAstra.safeParse(a.astra)
      id = item.success ? (item.data.sessionId ?? undefined) : undefined
    }
    if (id === undefined) return { stopped: false }
    const stopped = d.frames.sendFrame(
      cmdFrame(`relay-desktop-astra-stop-${Date.now().toString(36)}`, {
        kind: 'agent.abort',
        sessionId: id,
      }),
    )
    return { stopped }
  })

  // Approve: the auto-work ledgers and Astra's thread are the Mini's.
  handle(
    ctx,
    'reviews.approvable',
    async ({ repo, number }) =>
      ReviewApproveSchema.safeParse((await host.req({ kind: 'approvable', repo, number })).approve)
        .data ?? null,
  )

  // An old Mini host does not know the `work` op and never answers it: ask once, then stop.
  let workOff = false
  handle(ctx, 'reviews.work', async ({ repo, number }) => {
    if (workOff) return null
    try {
      return (
        ReviewWorkSchema.safeParse((await host.req({ kind: 'work', repo, number })).work).data ??
        null
      )
    } catch (e) {
      if (e instanceof Error && e.message === OLD_HOST) workOff = true
      return null
    }
  })

  handle(ctx, 'reviews.approve', async ({ repo, number }) => {
    const command = `reviews.req approve ${repo}#${number}`
    if (!d.writes) return { status: 'dry-run' as const, command }
    try {
      await host.req({ kind: 'approve', repo, number })
    } catch (e) {
      throw fail('astra-failed', e instanceof Error ? e.message : String(e))
    }
    return { status: 'sent' as const, command }
  })

  // The host's reviews service has no PR search, workflow states or ticket hand-off yet: a thin
  // client links PRs from Linear's attachments and shows the status without the picker.
  handle(ctx, 'reviews.prSearch', () => [])
  const notHere = (): never => {
    throw fail('thin-client', 'Not available on a thin client yet; use the Mini')
  }
  handle(ctx, 'reviews.linearStates', notHere)
  handle(ctx, 'reviews.linearSetState', notHere)
  handle(ctx, 'reviews.sendTicket', notHere)
}
