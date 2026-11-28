// Reviews' Linear rows open the Board's ticket page, against a stand-in Relay Host in remote mode
// (Reviews over `reviews.req`, tickets over `tickets.req`): a Linear row in the For me queue opens
// `ticket:<KEY>`; a reply goes prepare -> exact-text confirm -> one commit; Done in the page's header
// is the row's own `done` op and goes back to Reviews with the row held back. A host without
// `tickets` still shows the page, read through Reviews' `linear` read, and gets no `tickets.*`
// frame. No network: Linear only exists as the fake host's fixtures. Shots go to
// test-results/reviews-linear/.
//
//   pnpm build && pnpm e2e:run e2e/reviews-linear.spec.ts --retries 0 --max-failures 1
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
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
  links: [],
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

let host: FakeRelayHost

const test = base.extend<{ hostTickets: boolean }>({
  hostTickets: [true, { option: true }],
  launchEnv: async ({ configDir, hostTickets }, use) => {
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

  test('the ticket page still reads the ticket through Reviews', async ({ app, shell }) => {
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1440, 900))
    await openFromReviews(shell)
    await expect(ticketPage(shell).locator('h1')).toHaveText('Read through Reviews')
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
    // An old host never hears a `tickets.*` frame.
    expect(host.ticketFrames).toEqual([])
    await shot(shell, 'fallback')
  })
})
