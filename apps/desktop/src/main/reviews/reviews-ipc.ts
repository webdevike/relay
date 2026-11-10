// The Reviews page: Isaac's GitHub review queue for the eCardSystems org and one PR's detail, read
// with `gh`. Writes leave the app only on an explicit action: a GitHub comment or review after
// Isaac confirms the text in the renderer. Test instances (EVAOS_E2E=1) never post. @Astra asks go
// to the item's own Astra session (astra-sessions.ts), never to GitHub. In remote mode (a thin
// client) none of this runs here: the Mini's Relay Host answers every call (remote-reviews.ts).
import * as os from 'node:os'
import * as path from 'node:path'
import { z } from 'zod'
import type { ReviewApprove, ReviewPr, ReviewQueue, ReviewRow } from '@evaos/contract'
import type { MainContext } from '../context'
import type { ToolRun } from '../context-popover/pr-source'
import { handle } from '../ipc/handle'
import { claudeWriter, guideCache } from './guide'
import { registerLinearInbox } from './linear-inbox'
import { registerSlackInbox } from './slack-inbox'
import {
  approvableKey,
  approveLine,
  approveState,
  readLedgers,
  readLoop,
  readTicketWork,
  sendLine,
  workOf,
} from './approve'
import { registerRemoteReviews, type RemoteReviewsDeps } from './remote-reviews'
import { checkState, rowStatusOf, type RawCheck } from './row-status'
import { registerAstraSessions } from './astra-sessions'
import { REVIEWS_MEDIA_DIR, isGithubUpload, isLinearUpload, localizeImages } from './review-media'
import { apiKey } from '../linear/linear-ipc'

/** What the Guide is written from. */
const GuidePr = z.object({
  title: z.string(),
  body: z.string(),
  headRefOid: z.string(),
  files: z.array(z.object({ path: z.string(), additions: z.number(), deletions: z.number() })),
})

export const REVIEWS_ORG = 'eCardSystems'
const DONE_FILE = 'reviews-done.json'
const QUEUE_TTL_MS = 60_000

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code })

const PR_SEARCH_QUERY = `query($q: String!) { search(query: $q, type: ISSUE, first: 30) { nodes {
  ... on PullRequest { number title url state isDraft headRefName repository { nameWithOwner } } } } }`
const PrSearch = z.object({
  data: z.object({
    search: z.object({
      nodes: z.array(
        z.union([
          z.object({
            number: z.number(),
            title: z.string(),
            url: z.string(),
            state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
            isDraft: z.boolean(),
            headRefName: z.string(),
            repository: z.object({ nameWithOwner: z.string() }),
          }),
          z.object({}),
        ]),
      ),
    }),
  }),
})

const ms = (iso: unknown): number => {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? 0 : t
}

interface SearchItem {
  number: number
  title: string
  html_url: string
  repository_url: string
  user: { login: string } | null
  updated_at: string
  draft?: boolean
}

export function toRow(item: SearchItem): ReviewRow {
  return {
    repo: item.repository_url.replace(/^https:\/\/api\.github\.com\/repos\//, ''),
    number: item.number,
    title: item.title,
    url: item.html_url,
    author: item.user?.login ?? 'ghost',
    draft: item.draft === true,
    updatedAt: ms(item.updated_at),
  }
}

interface Raw {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  author: { login: string } | null
  createdAt: string
  updatedAt: string
  body: string
  baseRefName: string
  headRefName: string
  additions: number
  deletions: number
  commits: Array<{
    oid: string
    messageHeadline: string
    authoredDate: string
    authors: Array<{ login?: string; name?: string }>
  }>
  files: Array<{ path: string; additions: number; deletions: number; changeType?: string }>
  reviewRequests: Array<{ login?: string; name?: string; slug?: string }>
  latestReviews: Array<{ author: { login: string } | null; state: string }>
  reviews: Array<{
    author: { login: string } | null
    state: string
    body: string
    submittedAt: string
  }>
  comments: Array<{ author: { login: string } | null; body: string; createdAt: string }>
  assignees: Array<{ login: string }>
  labels: Array<{ name: string; color: string }>
  milestone: { title: string } | null
  projectItems: Array<{ title?: string }>
  statusCheckRollup: RawCheck[]
}

export const PR_JSON_FIELDS =
  'number,title,url,state,isDraft,author,createdAt,updatedAt,body,baseRefName,headRefName,additions,deletions,commits,files,reviewRequests,latestReviews,reviews,comments,assignees,labels,milestone,projectItems,statusCheckRollup'

const CHECK_ORDER = ['fail', 'pending', 'pass', 'skipped']

/** `gh pr view --json PR_JSON_FIELDS` plus `gh pr diff` as the page's PR. */
export function toPr(repo: string, raw: Raw, diff: string): ReviewPr {
  const login = (a: { login: string } | null): string => a?.login ?? 'ghost'
  const requested = raw.reviewRequests.map((r) => r.login ?? r.slug ?? r.name ?? '?')
  const reviewed = raw.latestReviews
    .filter((r) => !requested.includes(login(r.author)))
    .map((r) => ({ login: login(r.author), state: r.state }))
  const timeline: ReviewPr['timeline'] = [
    ...raw.comments.map((c) => ({
      kind: 'comment' as const,
      author: login(c.author),
      body: c.body,
      state: null,
      at: ms(c.createdAt),
    })),
    ...raw.reviews
      .filter((r) => r.body.trim() !== '' || r.state !== 'COMMENTED')
      .map((r) => ({
        kind: 'review' as const,
        author: login(r.author),
        body: r.body,
        state: r.state,
        at: ms(r.submittedAt),
      })),
  ].sort((a, b) => a.at - b.at)
  const participants = [
    ...new Set([
      login(raw.author),
      ...timeline.map((t) => t.author),
      ...raw.commits.flatMap((c) => c.authors.map((a) => a.login ?? '')).filter(Boolean),
    ]),
  ]
  return {
    repo,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: raw.state,
    draft: raw.isDraft,
    author: { login: login(raw.author), avatarUrl: null },
    createdAt: ms(raw.createdAt),
    updatedAt: ms(raw.updatedAt),
    body: raw.body,
    base: raw.baseRefName,
    head: raw.headRefName,
    additions: raw.additions,
    deletions: raw.deletions,
    reviewers: [...requested.map((l) => ({ login: l, state: 'PENDING' })), ...reviewed],
    assignees: raw.assignees.map((a) => a.login),
    labels: raw.labels.map((l) => ({ name: l.name, color: l.color })),
    milestone: raw.milestone?.title ?? null,
    projects: raw.projectItems.map((p) => p.title ?? '').filter(Boolean),
    participants,
    commits: raw.commits.map((c) => ({
      oid: c.oid,
      headline: c.messageHeadline,
      author: c.authors[0]?.name || c.authors[0]?.login || '',
      at: ms(c.authoredDate),
    })),
    timeline,
    checks: raw.statusCheckRollup
      .map((c) => ({
        name: c.name ?? c.context ?? 'check',
        state: checkState(c),
        url: c.detailsUrl ?? c.targetUrl ?? null,
      }))
      .sort((a, b) => CHECK_ORDER.indexOf(a.state) - CHECK_ORDER.indexOf(b.state)),
    files: raw.files.map((f) => ({
      path: f.path,
      additions: f.additions,
      deletions: f.deletions,
      change: f.changeType ?? 'MODIFIED',
    })),
    diff,
  }
}

export function registerReviewsIpc(
  ctx: MainContext,
  run: ToolRun,
  remote: Omit<RemoteReviewsDeps, 'writes'> | null = null,
): void {
  const writes = !ctx.env.e2e
  if (remote) {
    registerRemoteReviews(ctx, { ...remote, writes })
    return
  }
  // gh reads real GitHub: the live app, or a test instance that opts in with EVAOS_REVIEWS_GH=1.
  const readsGitHub = ctx.env.live || process.env.EVAOS_REVIEWS_GH === '1'
  const cwd = os.homedir()

  const gh = async (args: string[]): Promise<string> => {
    if (!readsGitHub)
      throw fail('github-off', 'GitHub is off in this instance (EVAOS_REVIEWS_GH=1 turns it on)')
    const res = await run('gh', args, cwd)
    if (res.code !== 0) throw fail('gh-failed', `gh ${args.slice(0, 2).join(' ')} failed`)
    return res.stdout
  }

  const search = async (
    q: string,
    perPage: number,
  ): Promise<{ total: number; rows: ReviewRow[] }> => {
    const out = await gh([
      'api',
      '-X',
      'GET',
      'search/issues',
      '-f',
      `q=is:pr org:${REVIEWS_ORG} ${q}`,
      '-f',
      `per_page=${perPage}`,
      '-f',
      'sort=updated',
    ])
    const body = JSON.parse(out) as { total_count: number; items: SearchItem[] }
    return { total: body.total_count, rows: body.items.map(toRow) }
  }

  const done = (): Record<string, number> =>
    ctx.config.readJson<Record<string, number>>(DONE_FILE, {})

  let cached: { at: number; queue: Promise<Omit<ReviewQueue, 'done'>> } | null = null
  const loadQueue = async (): Promise<Omit<ReviewQueue, 'done'>> => {
    const [needs, reviewing, completed, created] = await Promise.all([
      search('is:open review-requested:@me', 50),
      search('is:open reviewed-by:@me -author:@me -review-requested:@me', 50),
      search('reviewed-by:@me -author:@me is:closed', 20),
      search('is:open author:@me', 50),
    ])
    return {
      needs: needs.rows,
      reviewing: reviewing.rows,
      completed: completed.rows,
      completedTotal: completed.total,
      created: created.rows,
      fetchedAt: Date.now(),
    }
  }

  handle(ctx, 'reviews.queue', async ({ refresh }) => {
    if (refresh || !cached || Date.now() - cached.at > QUEUE_TTL_MS) {
      const queue = loadQueue()
      cached = { at: Date.now(), queue }
      queue.catch(() => {
        cached = null
      })
    }
    return { ...(await cached.queue), done: done() }
  })

  // `gh auth token` once: GitHub's uploaded images open only signed in.
  let token: Promise<string | null> | null = null
  const githubAuth = async (): Promise<Record<string, string>> => {
    token ??= run('gh', ['auth', 'token'], cwd).then((r) =>
      r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null,
    )
    const t = await token
    if (t === null) token = null
    return t ? { authorization: `token ${t}` } : {}
  }

  handle(ctx, 'reviews.pr', async ({ repo, number }) => {
    const [view, diff] = await Promise.all([
      gh(['pr', 'view', String(number), '-R', repo, '--json', PR_JSON_FIELDS]),
      gh(['pr', 'diff', String(number), '-R', repo, '--color=never']),
    ])
    const pr = toPr(repo, JSON.parse(view) as Raw, diff)
    // GitHub's attachments need his login; `<img>` tags become markdown the page renders.
    const media = path.join(ctx.config.dir, REVIEWS_MEDIA_DIR)
    const sources = [
      { match: isGithubUpload, headers: githubAuth },
      // PR bodies carry Linear proof screenshots too.
      {
        match: isLinearUpload,
        headers: async (): Promise<Record<string, string>> => {
          const key = await apiKey(ctx.env.evaRoot, ctx.env.configDir)
          return key ? { authorization: key } : {}
        },
      },
    ]
    const [body, timeline] = await Promise.all([
      localizeImages(pr.body, media, sources),
      Promise.all(
        pr.timeline.map(async (t) => ({
          ...t,
          body: await localizeImages(t.body, media, sources),
        })),
      ),
    ])
    return { ...pr, body, timeline }
  })

  handle(ctx, 'reviews.comment', async ({ repo, number, body }) => {
    if (!writes) throw fail('dry-run', 'Test instance: the comment was not posted')
    const out = await gh(['pr', 'comment', String(number), '-R', repo, '--body', body])
    return { url: out.trim() }
  })

  handle(ctx, 'reviews.review', async ({ repo, number, event, body }) => {
    if (!writes) throw fail('dry-run', 'Test instance: the review was not submitted')
    const flag = {
      approve: '--approve',
      'request-changes': '--request-changes',
      comment: '--comment',
    }[event]
    await gh([
      'pr',
      'review',
      String(number),
      '-R',
      repo,
      flag,
      ...(body.trim() ? ['--body', body] : []),
    ])
    return { ok: true as const }
  })

  const guide = guideCache(ctx.config, claudeWriter(ctx.env.claudeBin, ctx.env.live))
  handle(ctx, 'reviews.guide', async ({ repo, number }) => {
    const [view, diff] = await Promise.all([
      gh(['pr', 'view', String(number), '-R', repo, '--json', 'title,body,files,headRefOid']),
      gh(['pr', 'diff', String(number), '-R', repo, '--color=never']),
    ])
    const pr = GuidePr.parse(JSON.parse(view))
    return guide(`${repo}#${number}`, pr.headRefOid, { ...pr, diff })
  })

  /** One line to Astra's main thread through eva-thread.ts (Slack send requests); a dry run in test instances. */
  const tellAstra = async (
    line: string,
  ): Promise<{ status: 'sent' | 'dry-run'; command: string }> => {
    const tool = path.join(ctx.env.evaRoot, '.omp/tools/eva-thread.ts')
    const command = `bun ${tool} --agent astra ${JSON.stringify(line)}`
    if (!writes) return { status: 'dry-run', command }
    const res = await run(tool, ['--agent', 'astra', line], ctx.env.evaRoot)
    if (res.code !== 0) throw fail('astra-failed', 'eva-thread.ts could not reach Astra')
    return { status: 'sent', command }
  }

  // Approve on an auto-work draft: the hand-off is the only action; Astra runs ready.ts.
  const APPROVED_FILE = 'reviews-approved.json'
  const approveOf = (repo: string, number: number): ReviewApprove | null => {
    const sent = ctx.config.readJson<Record<string, number>>(APPROVED_FILE, {})
    const key = approvableKey(
      readLedgers(ctx.env.evaRoot),
      `https://github.com/${repo}/pull/${number}`,
    )
    if (key === null) return null
    const state = approveState({
      loop: readLoop(ctx.env.evaRoot, key),
      sentAt: sent[key] ?? null,
    })
    return { key, state }
  }

  handle(ctx, 'reviews.approvable', ({ repo, number }) => approveOf(repo, number))

  handle(ctx, 'reviews.rowStatus', async ({ repo, number }) => {
    const out = await gh([
      'pr',
      'view',
      String(number),
      '-R',
      repo,
      '--json',
      'statusCheckRollup,reviewDecision,isDraft',
    ])
    const status = rowStatusOf(JSON.parse(out))
    if (!status) throw fail('gh-failed', `gh pr view ${repo}#${number} answered something else`)
    return status
  })

  handle(ctx, 'reviews.work', ({ repo, number }) =>
    workOf(
      readLedgers(ctx.env.evaRoot),
      `https://github.com/${repo}/pull/${number}`,
      (key) => readTicketWork(ctx.env.evaRoot, key),
      approveOf(repo, number),
    ),
  )

  handle(ctx, 'reviews.approve', async ({ repo, number }) => {
    const a = approveOf(repo, number)
    if (a === null) throw fail('not-approvable', 'That PR is no longer waiting on your approval')
    if (a.state !== 'ready') throw fail('already-sent', `${a.key} was already handed to Astra`)
    const sent = await tellAstra(approveLine(a.key))
    if (sent.status === 'sent')
      ctx.config.writeJson(APPROVED_FILE, {
        ...ctx.config.readJson<Record<string, number>>(APPROVED_FILE, {}),
        [a.key]: Date.now(),
      })
    return sent
  })

  handle(ctx, 'reviews.sendTicket', ({ key, title, url, note }) =>
    tellAstra(sendLine(key, title, url, note)),
  )

  // PRs that name a ticket: GitHub's search finds the key in a title or body; ticketPrs (renderer)
  // keeps those whose title or branch carries it.
  handle(ctx, 'reviews.prSearch', async ({ key }) => {
    const out = await gh([
      'api',
      'graphql',
      '-f',
      `query=${PR_SEARCH_QUERY}`,
      '-f',
      `q="${key}" org:${REVIEWS_ORG} is:pr`,
    ])
    return PrSearch.parse(JSON.parse(out)).data.search.nodes.flatMap((n) =>
      'number' in n
        ? [
            {
              repo: n.repository.nameWithOwner,
              number: n.number,
              title: n.title,
              url: n.url,
              state: n.state,
              draft: n.isDraft,
              head: n.headRefName,
            },
          ]
        : [],
    )
  })

  handle(ctx, 'reviews.done', ({ url, updatedAt, done: on }) => {
    const next = { ...done() }
    if (on) next[url] = updatedAt
    else delete next[url]
    ctx.config.writeJson(DONE_FILE, next)
    return next
  })

  registerLinearInbox(ctx, { reads: readsGitHub, writes })
  registerSlackInbox(ctx, { reads: readsGitHub, tellAstra })
  registerAstraSessions(ctx)
}
