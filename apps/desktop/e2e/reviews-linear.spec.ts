// Reviews' Linear rows open the Board's ticket page, against a stand-in Relay Host in remote mode
// (Reviews over `reviews.req`, tickets over `tickets.req`): a Linear row in the For me queue opens
// `ticket:<KEY>`; a reply goes prepare -> exact-text confirm -> one commit; Done in the page's header
// is the row's own `done` op and goes back to Reviews with the row held back. A host without
// `tickets` still shows the page, read through Reviews' `linear` read, with today's actions
// (status, links, commits, Refresh, mentions as profile links, reply, Done) and gets no
// `tickets.*` frame. In local mode (no host at all) the same page writes through Reviews' own
// Linear IPC, stubbed in main here. No network: Linear only exists as fixtures. Shots go to
// test-results/reviews-linear/.
//
//   pnpm build && pnpm e2e:run e2e/reviews-linear.spec.ts --retries 0 --max-failures 1
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { TICKETS_FEATURE, TICKETS_WRITES_FEATURE } from '@relay/protocol'
import { test as base, expect } from './fixtures'
import { FakeRelayHost } from './helpers/fake-relay-host'

const KEY = 'ENG-9101'
const URL = 'https://linear.example.test/issue/ENG-9101'
const SHOTS = path.join(__dirname, '..', 'test-results', 'reviews-linear')
/** A 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

/** The Reviews queue the host answers: one Linear ticket waiting on Isaac. */
const QUEUE = {
  items: [
    {
      url: URL,
      ref: { kind: 'linear', key: KEY },
      title: 'Ticket activity sample',
      actor: 'Sample Teammate',
      reason: 'mentioned you',
      label: 'Mentioned',
      updatedAt: 1764100000000,
      unread: true,
    },
  ],
  done: {},
  sources: Object.fromEntries(
    ['github', 'linear', 'slack'].map((s) => [s, { loading: false, error: null, fetchedAt: 1 }]),
  ),
}

/** Reviews' own Linear read of the ticket (`reviews.linearTicket`), what the fallback shows. */
const LINEAR_TICKET = {
  id: 'issue-9101',
  key: KEY,
  title: 'Read through Reviews',
  url: URL,
  description: 'Fallback description from the Reviews read.',
  creator: 'Sample Teammate',
  createdAt: 1764000000000,
  updatedAt: 1764100000000,
  state: { name: 'In Progress', type: 'started', color: '#f2c94c' },
  assignee: 'Test Owner',
  priority: 'High',
  labels: [],
  project: null,
  team: 'Engineering',
  parent: null,
  children: [],
  links: [
    { title: 'Design doc', url: 'https://docs.example.test/design', kind: 'link' },
    { title: 'abc123', url: 'https://github.com/example/sample/commit/abc123', kind: 'github' },
  ],
  comments: [
    {
      id: 'c-fallback',
      parentId: null,
      author: {
        name: 'Sample Teammate',
        handle: 'sample',
        url: 'https://linear.app/x/profiles/sample',
      },
      body: 'A comment read through Reviews.',
      at: 1764050000000,
      url: `${URL}#comment-c-fallback`,
      mentionsMe: true,
    },
  ],
  people: [
    { name: 'Sample Teammate', handle: 'sample', url: 'https://linear.app/x/profiles/sample' },
  ],
  me: { name: 'Test Owner', handle: 'owner', url: 'https://linear.app/x/profiles/owner' },
}

/** The Linear row Reviews lists in local mode (`reviews.linearQueue`). */
const ROW = {
  key: KEY,
  title: 'Ticket activity sample',
  url: URL,
  reason: 'mentioned you',
  actor: 'Sample Teammate',
  updatedAt: 1764100000000,
  unread: true,
}

/** The team's workflow states (`reviews.linearStates`), in Linear's order. */
const STATES = [
  { id: 's-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2', position: 0 },
  { id: 's-prog', name: 'In Progress', type: 'started', color: '#f2c94c', position: 1 },
  { id: 's-review', name: 'In Review', type: 'started', color: '#5e6ad2', position: 2 },
  { id: 's-done', name: 'Done', type: 'completed', color: '#4cb782', position: 3 },
]

/** The comment body Linear gets for `@Sample Teammate ...`: the profile link it notifies. */
const MENTION = 'https://linear.app/x/profiles/sample can you retest?'

let host: FakeRelayHost

const test = base.extend<{ hostTickets: boolean; local: boolean }>({
  hostTickets: [true, { option: true }],
  local: [false, { option: true }],
  launchEnv: async ({ configDir, hostTickets, local }, use) => {
    // Local mode: no Relay host at all (no relay dir, no relay-remote.json).
    if (local) return use({})
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-reviews-linear-')))
    const relayDir = path.join(root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    host.features = hostTickets
      ? ['render.report', TICKETS_FEATURE, TICKETS_WRITES_FEATURE]
      : ['render.report']
    host.reviews.set('queue', { queue: QUEUE })
    host.reviews.set('prList', { prs: { items: [], total: 0 } })
    host.reviews.set('linear', { ticket: LINEAR_TICKET })
    host.reviews.set('done', { done: { [URL]: Date.now() } })
    host.reviews.set('astra', { astra: null })
    // The host ticket's images (e2e/fixtures/tickets/ENG-9101.json), as the host serves drops.
    for (const drop of ['/drops/ticket-desc/tok', '/drops/ticket-comment/tok'])
      host.serveFile(drop, PNG, 'image/png')
    // Remote mode, already paired: this app's config names the host, the host knows its secret.
    const authority = new globalThis.URL(host.origin).host
    const secretHex = randomBytes(32).toString('hex')
    fs.writeFileSync(
      path.join(configDir, 'relay-remote.json'),
      JSON.stringify({ host: authority, paired: { id: authority, secretHex } }),
      { mode: 0o600 },
    )
    fs.writeFileSync(
      path.join(relayDir, 'devices.json'),
      JSON.stringify({
        [`relay-desktop-${os.hostname()}`]: { secretHex, name: 'Relay Desktop', pairedAt: 1 },
      }),
      { mode: 0o600 },
    )
    // The relay dir too, so the host's drops (the ticket's images) load from this fake host.
    await use({ EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
  },
})

test.use({ startOnChat: false, toolPanes: false })

const sel = (id: string): string => `[data-testid="${id}"]`
type Shell = { __evaosShell: { openPlace(page: string): void } }
type Op = { kind: string; mutation?: Record<string, unknown> }
const commits = (): Op[] =>
  host.mutations.map((m) => m.cmd as Op).filter((w) => w.kind === 'commit')
const reviewOps = (kind: string): Record<string, unknown>[] =>
  host.reviewOps.filter((o) => o.kind === kind)
const ticketPage = (shell: Page) => shell.locator(sel('ticket-page'))

async function shot(shell: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await shell.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

/** Reviews, For me, then the Linear row: the ticket page it opens. */
async function openFromReviews(shell: Page): Promise<void> {
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('reviews'))
  const reviews = shell.locator(sel('reviews-page'))
  await expect(reviews).toBeVisible({ timeout: 30_000 })
  await reviews.getByText('For me', { exact: true }).click()
  const row = reviews.locator(sel(`review-ticket-${KEY}`))
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(ticketPage(shell)).toHaveAttribute('data-ticket', KEY, { timeout: 30_000 })
  await expect(shell.locator(sel('reviews-page'))).toHaveCount(0)
}

/** The legacy page's composer: `text`, Send, the exact-text confirm (checked), then Post. */
async function postComment(shell: Page, text: string, confirmText: string): Promise<void> {
  await shell.locator(sel('ticket-composer')).fill(text)
  await shell.locator(sel('ticket-composer-send')).click()
  await expect(shell.locator(sel('review-confirm-text'))).toHaveText(confirmText)
  await shell.locator(sel('review-confirm-post')).click()
}

/** A reply under the fallback's comment through the legacy page's reply box. */
async function postReply(shell: Page, text: string): Promise<void> {
  const root = shell.locator('[data-comment-id="c-fallback"]')
  await root.hover()
  await root.getByRole('button', { name: 'Reply' }).click()
  await shell.locator(sel('ticket-reply-box')).fill(text)
  await shell.locator(sel('ticket-reply-box-send')).click()
  await expect(shell.locator(sel('review-confirm-text'))).toHaveText(text)
  await shell.locator(sel('review-confirm-post')).click()
}

/** Picks `name` in the sidebar's status menu. */
async function pickStatus(shell: Page, name: string): Promise<void> {
  await shell.locator(sel('ticket-status')).click()
  await shell.locator(sel(`ticket-state-${name}`)).click()
}

/** What the legacy page shows from Reviews' read besides the shell: links and commits. */
async function expectLegacyRail(shell: Page): Promise<void> {
  await expect(ticketPage(shell).locator('h1')).toHaveText('Read through Reviews')
  await expect(shell.locator(sel('ticket-link'))).toHaveText('Design doc')
  await expect(shell.locator(sel('ticket-commits'))).toHaveText('1 linked commit')
  await expect(shell.locator(sel('ticket-status'))).toHaveAttribute('data-write', 'legacy')
}

/** Done in the page's header: back to Reviews with the row held back. */
async function doneBackToReviews(shell: Page): Promise<void> {
  await shell.locator(sel('review-done')).click()
  await expect(shell.locator(sel('reviews-page'))).toBeVisible()
  await expect(ticketPage(shell)).toHaveCount(0)
  await expect(shell.locator(sel(`review-ticket-${KEY}`))).toHaveCount(0)
}

test('a Linear row opens the ticket page: read, gated reply, Done back to Reviews', async ({
  app,
  shell,
}) => {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1440, 900))
  await openFromReviews(shell)

  // The Board's ticket page, read from the host, with Reviews' Done in its header.
  await expect(ticketPage(shell).locator('h1')).toHaveText('Ticket activity sample')
  const activity = shell.locator(sel('ticket-activity'))
  await expect(activity.locator('[data-comment-id="c-mine"]')).toContainText('Looks right')
  await expect(shell.locator(sel('review-done'))).toBeVisible()
  await shot(shell, 'ticket')

  // A reply in the thread: prepare, the exact text to confirm, one commit, shown once.
  const root = activity.locator('[data-comment-id="c-pal"]')
  await root.hover()
  await root.getByRole('button', { name: 'Reply' }).click()
  const reply = shell.locator(sel('ticket-reply-box'))
  await reply.fill('Retested, looks right')
  await shell.locator(sel('ticket-reply-box-send')).click()
  await expect(shell.locator(sel('review-confirm-text'))).toHaveText('Retested, looks right')
  expect(commits()).toHaveLength(0)
  await shot(shell, 'reply-confirm')
  await shell.locator(sel('review-confirm-post')).click()
  const bodies = activity.locator(sel('ticket-comment-body'))
  await expect(bodies.filter({ hasText: 'Retested, looks right' })).toHaveCount(1)
  expect(commits()).toHaveLength(1)
  expect(commits()[0]!.mutation).toMatchObject({
    kind: 'comment',
    issueId: 'issue-9101',
    parentId: 'c-pal',
    body: 'Retested, looks right',
  })
  // Nothing went the old Reviews way.
  expect(reviewOps('linearComment')).toHaveLength(0)

  // Done: the row's own `done` op, then back to Reviews with the row held back.
  await shell.locator(sel('review-done')).click()
  await expect(shell.locator(sel('reviews-page'))).toBeVisible()
  await expect(ticketPage(shell)).toHaveCount(0)
  await expect(shell.locator(sel(`review-ticket-${KEY}`))).toHaveCount(0)
  expect(reviewOps('done')).toEqual([
    expect.objectContaining({ kind: 'done', url: URL, done: true }),
  ])
  expect(commits()).toHaveLength(1)
  await shot(shell, 'after-done')
})

test.describe('a host without tickets', () => {
  test.use({ hostTickets: false })

  test("the ticket page reads through Reviews and keeps today's actions", async ({
    app,
    shell,
  }) => {
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1440, 900))
    await openFromReviews(shell)
    await expectLegacyRail(shell)
    await expect(shell.locator(sel('ticket-description'))).toContainText(
      'Fallback description from the Reviews read.',
    )
    await expect(shell.locator(sel('ticket-activity'))).toContainText(
      'A comment read through Reviews.',
    )
    // Today's composer path stays (writes through Reviews), and Done is there.
    await expect(shell.locator(sel('ticket-composer'))).toBeVisible()
    await expect(shell.locator(sel('review-done'))).toBeVisible()
    expect(reviewOps('linear')).toEqual([expect.objectContaining({ kind: 'linear', key: KEY })])
    await shot(shell, 'fallback')

    // Refresh reads it again through Reviews.
    await shell.locator(sel('ticket-refresh')).click()
    await expect.poll(() => reviewOps('linear').length).toBe(2)

    // The status picker is today's: a thin client can't read the team's states, says so and
    // keeps a label (as Reviews' panel did); nothing is written.
    await shell.locator(sel('ticket-status')).click()
    await expect(shell.getByText("Couldn't read the statuses")).toBeVisible()
    await expect(shell.locator(sel('ticket-status'))).not.toHaveAttribute('data-write', 'legacy')

    // A comment naming a person: the confirm shows the profile link Linear notifies with; the
    // reply the same way. A test instance never posts (Reviews' own dry run, as on main).
    await postComment(shell, '@Sample Teammate can you retest?', MENTION)
    await expect(shell.getByText('Not posted').first()).toBeVisible()
    await postReply(shell, 'Retested here')
    expect(reviewOps('linearComment')).toEqual([])

    await doneBackToReviews(shell)
    expect(reviewOps('done')).toEqual([
      expect.objectContaining({ kind: 'done', url: URL, done: true }),
    ])
    // An old host never hears a `tickets.*` frame, and no gate write happened.
    expect(host.ticketFrames).toEqual([])
    expect(host.mutations).toEqual([])
  })
})

type LinearCall = [channel: string, input: Record<string, unknown>]

/**
 * Reviews' own Linear IPC in main, answering from the fixtures and recording each call (local
 * mode reads Linear itself; tests never reach it), and an empty GitHub queue (GitHub is off in
 * tests, which would hide the page). A status change sticks for the next read.
 */
async function stubLocalLinear(app: ElectronApplication): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, fx) => {
      const g = globalThis as unknown as { linearCalls: LinearCall[] }
      g.linearCalls = []
      let ticket = fx.ticket
      const answers: Record<string, (input: Record<string, unknown>) => unknown> = {
        'reviews.queue': () => ({
          needs: [],
          reviewing: [],
          completed: [],
          completedTotal: 0,
          created: [],
          done: {},
          fetchedAt: 1,
        }),
        'reviews.linearQueue': () => [fx.row],
        'reviews.linearTicket': () => ticket,
        'reviews.linearStates': () => fx.states,
        'reviews.linearSetState': (input) => {
          const s = fx.states.find((x) => x.id === input.stateId)!
          ticket = { ...ticket, state: { name: s.name, type: s.type, color: s.color } }
          return ticket.state
        },
        'reviews.linearComment': () => ({ url: `${fx.ticket.url}#comment-new` }),
      }
      for (const [channel, answer] of Object.entries(answers)) {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, (_e, input: Record<string, unknown>) => {
          g.linearCalls.push([channel, input])
          return { ok: true, value: answer(input) }
        })
      }
    },
    { ticket: LINEAR_TICKET, row: ROW, states: STATES },
  )
}

const localCalls = (app: ElectronApplication, channel: string): Promise<unknown[]> =>
  app.evaluate(
    (_, ch) =>
      (globalThis as unknown as { linearCalls: LinearCall[] }).linearCalls
        .filter(([c]) => c === ch)
        .map(([, input]) => input),
    channel,
  )

test.describe('local mode, no host', () => {
  test.use({ local: true })

  test("the ticket page writes through Reviews' own Linear path", async ({ app, shell }) => {
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1440, 900))
    await stubLocalLinear(app)
    await openFromReviews(shell)
    await expectLegacyRail(shell)

    // A status change goes straight through; Done asks first and writes only after Move.
    await pickStatus(shell, 'In Review')
    await expect(shell.locator(sel('ticket-status'))).toContainText('In Review')
    await pickStatus(shell, 'Done')
    await expect(shell.getByRole('dialog')).toContainText('Move ENG-9101 to Done?')
    expect(await localCalls(app, 'reviews.linearSetState')).toHaveLength(1)
    await shot(shell, 'local-status-confirm')
    await shell.locator(sel('ticket-status-confirm-ok')).click()
    await expect(shell.locator(sel('ticket-status'))).toContainText('Done')
    expect(await localCalls(app, 'reviews.linearSetState')).toEqual([
      { issueId: 'issue-9101', stateId: 's-review' },
      { issueId: 'issue-9101', stateId: 's-done' },
    ])

    // A mention goes as the person's profile link; a reply under its comment.
    await postComment(shell, '@Sample Teammate can you retest?', MENTION)
    await expect.poll(async () => (await localCalls(app, 'reviews.linearComment')).length).toBe(1)
    await postReply(shell, 'Retested here')
    await expect.poll(async () => (await localCalls(app, 'reviews.linearComment')).length).toBe(2)
    expect(await localCalls(app, 'reviews.linearComment')).toEqual([
      { issueId: 'issue-9101', parentId: null, body: MENTION },
      { issueId: 'issue-9101', parentId: 'c-fallback', body: 'Retested here' },
    ])

    // Refresh reads it again.
    const reads = (await localCalls(app, 'reviews.linearTicket')).length
    await shell.locator(sel('ticket-refresh')).click()
    await expect
      .poll(async () => (await localCalls(app, 'reviews.linearTicket')).length)
      .toBeGreaterThan(reads)

    await doneBackToReviews(shell)
  })
})
