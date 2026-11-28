// Before/after proof of the Linear-style Board (PLAN M8): the same spec runs on the branch (after)
// and in a baseline worktree at 61a5b2e6 (before), headless at 1440x900, light scheme, with the
// same fixtures and clock. Relay Desktop is in remote mode against FakeRelayHost: ledger work items
// in a fixture Eva root, the host's synced tickets (e2e/fixtures/tickets, `tickets` and
// `tickets.writes` in after), Reviews' reads (the e2e/fixtures/reviews-diff PR served as the
// ticket's PR `example/sample#42`, with `reviews.actions` in after) and each ticket's Linear read
// for the baseline's side panel. Shots go to <PROOF_DIR>/<PROOF_PHASE>/ (default
// proof/linear-board/after); assertions that only hold after run only in after. No GitHub,
// Linear, Claude or omp: every write lands on the fake host's gate.
//
//   pnpm build && PROOF_PHASE=after pnpm e2e:run e2e/board-proof.spec.ts --project=parallel --retries 0 --max-failures 1
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { pickScheme } from './helpers/appearance'
import { makeEvaFixture } from './helpers/eva-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { REPO_ROOT } from './helpers/paths'

const PHASE = process.env['PROOF_PHASE'] === 'before' ? 'before' : 'after'
const AFTER = PHASE === 'after'
const OUT = path.join(process.env['PROOF_DIR'] ?? path.join(REPO_ROOT, 'proof/linear-board'), PHASE)
const NOW = '2026-11-27T18:00:00Z'
const NOW_MS = Date.parse(NOW)
const DAY_MS = 86_400_000
const SIZE = { width: 1440, height: 900 }
// Feature names as strings: the baseline's protocol package doesn't export them.
const TICKETS = 'tickets'
const TICKETS_WRITES = 'tickets.writes'
const REVIEWS_ACTIONS = 'reviews.actions'

type Json = Record<string, unknown>
const TICKET_FIXTURES = path.join(__dirname, 'fixtures/tickets')
const PR_FIXTURES = path.join(__dirname, 'fixtures/reviews-diff')
const readJson = (file: string): Json => JSON.parse(fs.readFileSync(file, 'utf8')) as Json
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** The ticket's PR (as the ticket fixtures link it) and the reviews-diff PR served as it. */
const PR_REF = { repo: 'example/sample', number: 42 }
const HEAD = '0123456789abcdef0123456789abcdef01234567'
const PLACE_PR = `review:pr:${PR_REF.repo}#${PR_REF.number}`

function proofPr(): Json {
  const answers = readJson(path.join(PR_FIXTURES, 'answers.json'))
  const pr = clone((answers['pr'] as { pr: Json }).pr)
  const check = (name: string, runId: number): Json => ({
    name,
    state: 'pass',
    url: `https://github.example.test/${PR_REF.repo}/actions/runs/${runId}`,
  })
  const checks = [check('test', 7), check('lint', 8), check('build', 9)]
  return {
    ...pr,
    repo: PR_REF.repo,
    number: PR_REF.number,
    url: `https://github.example.test/${PR_REF.repo}/pull/${PR_REF.number}`,
    title: 'Sample bridge change',
    headSha: HEAD,
    checks,
    actions: {
      ...(pr['actions'] as Json),
      mergeStateStatus: 'BLOCKED',
      checks: checks.map((c, i) => ({
        ...c,
        workflow: c['name'],
        runId: 7 + i,
        runNumber: 3,
        attempt: 1,
        headSha: HEAD,
      })),
    },
  }
}

type Ticket = Json & {
  key: string
  title: string
  state: { id: string; name: string; type: string; color: string }
}

/** The host's board: the fixture's two tickets plus a Done one and one In Review. */
function boardTickets(): Ticket[] {
  const board = readJson(path.join(TICKET_FIXTURES, 'board.json')) as {
    board: { tickets: Ticket[] }
  }
  const [first, second] = board.board.tickets as [Ticket, Ticket]
  const extra = (key: string, title: string, state: Ticket['state']): Ticket => ({
    ...clone(second),
    key,
    id: `issue-${key.slice(4)}`,
    documentContentId: `doc-issue-${key.slice(4)}`,
    url: `https://linear.example.test/issue/${key}`,
    title,
    state,
  })
  const waiting = clone(first)
  const attention = waiting['attention'] as { waiting: Json[] }
  for (const w of attention.waiting) w['at'] = NOW_MS - 3 * 3_600_000
  return [
    waiting,
    second,
    extra('ENG-9003', 'Finished sample ticket', {
      id: 'state-done',
      name: 'Done',
      type: 'completed',
      color: '#5e6ad2',
    }),
    extra('ENG-9004', 'Review sample ticket', {
      id: 'state-in-review',
      name: 'In Review',
      type: 'started',
      color: '#0f783c',
    }),
  ]
}

const PRIORITY = ['No priority', 'Urgent', 'High', 'Medium', 'Low']
const person = (name: string): Json => ({
  name,
  handle: name.toLowerCase().replace(/\s+/g, '-'),
  url: `https://linear.example.test/profiles/${name.toLowerCase().replace(/\s+/g, '-')}`,
})

/** Reviews' Linear read of a board ticket (what the baseline's side panel shows), same facts. */
function linearRead(t: Ticket): Json {
  const detailFile = path.join(TICKET_FIXTURES, `${t.key}.json`)
  const detail = fs.existsSync(detailFile) ? readJson(detailFile) : t
  const named = (v: unknown): string | null => (v ? String((v as Json)['name']) : null)
  const comments = ((detail['comments'] as Json[] | undefined) ?? []).map((c) => ({
    id: c['id'],
    parentId: c['parentId'],
    author: person(String(named(c['author']))),
    body: c['body'],
    at: c['at'],
    url: c['url'],
    mentionsMe: String(c['body']).includes('@Test'),
  }))
  const facts = (t['prFacts'] as Json[] | undefined) ?? []
  return {
    id: t['id'],
    key: t.key,
    title: t.title,
    url: t['url'],
    description: String(detail['description'] ?? ''),
    creator: named(t['creator']) ?? 'Sample Teammate',
    createdAt: t['createdAt'],
    updatedAt: t['updatedAt'],
    state: { name: t.state.name, type: t.state.type, color: t.state.color },
    assignee: named(t['assignee']),
    priority: PRIORITY[Number(t['priority'])] ?? 'No priority',
    labels: ((t['labels'] as Json[]) ?? []).map((l) => ({ name: l['name'], color: l['color'] })),
    project: named(t['project']),
    team: 'Engineering',
    parent: null,
    children: [],
    links: facts.map((p) => ({ title: p['title'], url: p['url'], kind: 'github' })),
    comments,
    people: [person('Sample Teammate')],
    me: person('Test Owner'),
  }
}

/** Ledger work items: one per board ticket (same titles) and a Relay-only item. */
const LEDGER: Array<{ key: string; title: string; stage: string; move: string; extra?: string }> = [
  {
    key: 'ENG-9001',
    title: 'Sample synced ticket',
    stage: '9 PR (draft)',
    move: 'isaac',
    extra: `linear: https://linear.example.test/issue/ENG-9001\npr: https://github.com/${PR_REF.repo}/pull/${PR_REF.number}\n`,
  },
  { key: 'ENG-9002', title: 'Second sample ticket', stage: '3 Plan', move: 'agent' },
  { key: 'ENG-9003', title: 'Finished sample ticket', stage: 'Done', move: 'agent' },
  { key: 'ENG-9004', title: 'Review sample ticket', stage: '8 Review', move: 'noah' },
  { key: 'relay-demo', title: 'Relay demo item', stage: '5 Build', move: 'agent' },
]

function writeLedger(root: string): void {
  const items = path.join(root, 'work/items')
  fs.mkdirSync(items, { recursive: true })
  for (const l of LEDGER) {
    const who = l.move.charAt(0).toUpperCase() + l.move.slice(1)
    fs.writeFileSync(
      path.join(items, `${l.key}.md`),
      `---\nkey: ${l.key}\ntitle: ${l.title}\nworkspace: ecardsystems\nstage: ${l.stage}\nmove: ${l.move}\nnext: ${who}: next step\nupdated: ${NOW.slice(0, 10)}\n${l.extra ?? ''}---\n\n## Context\n`,
    )
  }
}

/** A local calendar day `days` from NOW (`YYYY-MM-DD`). */
function dayFromNow(days: number): string {
  const d = new Date(NOW_MS + days * DAY_MS)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The Timeline's tickets: "+N" in the fixture is N days from NOW. */
function timelineTickets(): Json[] {
  const relative = (v: unknown): unknown =>
    typeof v === 'string' && /^\+\d+$/.test(v) ? dayFromNow(Number(v.slice(1))) : v
  const { tickets } = readJson(path.join(TICKET_FIXTURES, 'timeline-board.json')) as {
    tickets: Json[]
  }
  return tickets.map((t) => ({
    ...t,
    dueDate: relative(t['dueDate']),
    startedAt: t['dueDate'] === null ? null : NOW_MS - 3 * DAY_MS,
    milestone: {
      ...(t['milestone'] as Json),
      targetDate: relative((t['milestone'] as Json)['targetDate']),
    },
  }))
}

/** A 1x1 PNG, for the ticket fixtures' drop images. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

let host: FakeRelayHost

type HostMode = 'tickets' | 'fallback' | 'timeline'

const test = base.extend<{ hostMode: HostMode }>({
  hostMode: ['tickets', { option: true }],
  launchEnv: async ({ configDir, hostMode }, use) => {
    const fx = makeEvaFixture({ now: new Date(NOW) })
    writeLedger(fx.root)
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-board-proof-')))
    const relayDir = path.join(root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    if (AFTER) {
      host.features = ['render.report', REVIEWS_ACTIONS]
      if (hostMode !== 'fallback') host.features.push(TICKETS, TICKETS_WRITES)
    }
    const tickets = boardTickets()
    host.tickets.board.tickets = hostMode === 'timeline' ? timelineTickets() : tickets
    const freshness = host.tickets.status['freshness'] as Json
    freshness['lastSyncAt'] = NOW_MS - 120_000
    host.serveReviews(PR_FIXTURES)
    host.reviews.set('pr', { pr: proofPr() })
    for (const t of tickets) host.reviews.set(`linear:${t.key}`, { ticket: linearRead(t) })
    for (const drop of ['/drops/ticket-desc/tok', '/drops/ticket-comment/tok'])
      host.serveFile(drop, PNG, 'image/png')
    // Remote mode, already paired: this app's config names the host, the host knows its secret.
    const authority = new URL(host.origin).host
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
    await use({ ...fx.env, EVAOS_RELAY_DIR: relayDir, EVAOS_NOW: NOW })
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
    fx.cleanup()
  },
})
test.use({ startOnChat: false, toolPanes: false })

const sel = (id: string): string => `[data-testid="${id}"]`
type Shell = { __evaosShell: { openPlace(page: string): void } }

async function shot(shell: Page, name: string): Promise<void> {
  // The pointer rests on the empty footer, so no hover tooltip covers the page; images,
  // highlighters and transitions settle before the shot.
  await shell.mouse.move(SIZE.width - 40, SIZE.height - 10)
  await shell.waitForTimeout(700)
  fs.mkdirSync(OUT, { recursive: true })
  await shell.screenshot({ path: path.join(OUT, `${name}.png`) })
}

async function setup(app: ElectronApplication, shell: Page): Promise<void> {
  await app.evaluate(
    ({ BaseWindow }, size) => BaseWindow.getAllWindows()[0]!.setSize(size.width, size.height),
    SIZE,
  )
  await shell.clock.setFixedTime(new Date(NOW))
  await pickScheme(shell, 'light')
}

const openPlace = (shell: Page, place: string): Promise<void> =>
  shell.evaluate((p) => (window as unknown as Shell).__evaosShell.openPlace(p), place)

/** Settings > Theme > Other > Behavior > Focus ring, through the page as Isaac sets it. */
async function setFocusRing(shell: Page, value: 'auto' | 'never'): Promise<void> {
  await openPlace(shell, 'settings')
  const editor = shell.locator(sel('theme-editor'))
  await expect(editor).toBeVisible({ timeout: 30_000 })
  await editor.getByRole('tab', { name: 'Other' }).click()
  const ring = editor.getByLabel('Focus ring')
  if (!(await ring.isVisible())) await editor.getByRole('button', { name: 'BEHAVIOR' }).click()
  await ring.click()
  await shell.getByRole('option', { name: value, exact: true }).click()
  await expect(shell.locator('html')).toHaveAttribute('data-focus-ring', value)
}

/** No write left the fake host's gate, and the only writes are the ones this spec confirmed. */
function expectHermetic(): void {
  const kinds = host.mutations.map((m) => (m.cmd as { kind: string }).kind)
  expect(kinds.every((k) => k === 'prepare' || k === 'commit')).toBe(true)
  expect(host.prMutations).toEqual([])
}

test('Board, ticket and PR', async ({ app, shell }) => {
  test.setTimeout(180_000)
  await setup(app, shell)
  await openPlace(shell, 'board')
  const board = shell.locator(sel('agents-board'))
  await expect(board).toBeVisible({ timeout: 30_000 })
  const eng1 = shell.locator(sel('agents-card-ENG-9001'))
  await expect(eng1).toBeVisible({ timeout: 30_000 })
  await expect(shell.locator(sel('agents-card-relay-demo'))).toBeVisible()

  if (!AFTER) {
    // Today's agent board; a card opens its side panel with Reviews' Linear read and the PR.
    await shot(shell, 'board')
    await eng1.click()
    const side = shell.locator(sel('agents-side'))
    await expect(side).toBeVisible()
    await expect(side).toContainText('Sample synced ticket', { timeout: 30_000 })
    await expect(side.locator(sel('review-detail'))).toBeVisible({ timeout: 30_000 })
    await shot(shell, 'ticket')
    await openPlace(shell, PLACE_PR)
    const detail = shell.locator(`${sel('review-detail')}:not(${sel('agents-side')} *)`)
    await expect(detail.first()).toBeVisible({ timeout: 30_000 })
    await expect(detail.first()).toContainText('Sample bridge change')
    await shot(shell, 'pr')
    expectHermetic()
    return
  }

  // Board: synced tickets beside the ledger-only item, Done hidden, chips, Waiting on you.
  await expect(shell.locator(sel('agents-freshness'))).toContainText('Synced')
  await expect(eng1).toContainText('Waiting on you')
  await expect(eng1).toContainText('#42')
  await expect(shell.locator(sel('agents-card-ENG-9004'))).toBeVisible()
  await expect(shell.locator('section.eva-ab-col[data-column="done"]')).toHaveCount(0)
  await expect(shell.locator(sel('agents-hidden-done')).locator('.eva-ab-count')).toHaveText('1')
  await expect(shell.locator(sel('agents-waiting-count'))).toHaveText('1')
  await shot(shell, 'board')

  // Keyboard: Tab from the Waiting chip lands on Mark as handled. Relay starts with the focus ring
  // off (Settings > Theme > Other > Focus ring); it is turned on there for this shot, then back off.
  await setFocusRing(shell, 'auto')
  await openPlace(shell, 'board')
  await eng1.locator(sel('agents-wait-open')).focus()
  await shell.keyboard.press('Tab')
  const handled = eng1.locator(sel('agents-wait-handled'))
  await expect(handled).toBeFocused()
  expect(await handled.evaluate((e) => e.matches(':focus-visible'))).toBe(true)
  expect(await handled.evaluate((e) => getComputedStyle(e).outlineStyle)).toBe('solid')
  await shot(shell, 'waiting-handled-focus')
  await handled.evaluate((e) => (e as HTMLElement).blur())
  await setFocusRing(shell, 'never')
  await openPlace(shell, 'board')

  // The ticket page: summary card, activity and the sidebar.
  await eng1.dispatchEvent('click')
  const page = shell.locator(sel('ticket-page'))
  await expect(page).toHaveAttribute('data-ticket', 'ENG-9001', { timeout: 30_000 })
  await expect(page.locator('h1')).toHaveText('Sample synced ticket')
  await expect(shell.locator(sel('ticket-summary'))).toBeVisible()
  await expect(shell.locator(sel('ticket-sidebar'))).toContainText('In Progress')
  await expect(shell.locator(sel('ticket-side-pr-sample-42'))).toBeVisible()
  await shot(shell, 'ticket')
  await shell.locator(sel('ticket-sidebar-toggle')).click()
  await expect(shell.locator(sel('ticket-strip'))).toBeVisible()
  await shot(shell, 'ticket-sidebar-collapsed')
  await shell.locator(sel('ticket-sidebar-toggle')).click()
  await expect(shell.locator(sel('ticket-sidebar'))).toBeVisible()

  // The PR page from the ticket: Guide | Diff | Comments and the sidebar merge box.
  await shell.locator(sel('ticket-side-pr-sample-42')).click()
  await expect(page).toHaveAttribute('data-pr', `${PR_REF.repo}#${PR_REF.number}`)
  const prPage = shell.locator(sel('ticket-pr-page'))
  await expect(prPage.locator(sel('review-detail'))).toBeVisible({ timeout: 30_000 })
  for (const t of ['guide', 'diff', 'comments'])
    await expect(shell.locator(sel(`review-tab-${t}`))).toBeVisible()
  const rail = shell.locator(sel('review-rail'))
  await expect(rail.locator(sel('pr-status-line'))).toContainText('Blocked')
  await expect(rail.locator(sel('pr-merge-start'))).toBeVisible()
  await shot(shell, 'pr')

  // Merge confirm: names the head and the outcome; Cancel writes nothing.
  await rail.locator(sel('pr-merge-start')).click()
  await expect(shell.locator(sel('pr-merge-Head'))).toHaveText(HEAD.slice(0, 7))
  await expect(shell.locator(sel('pr-merge-confirm'))).toBeVisible()
  await shot(shell, 'merge-confirm')
  await shell.getByRole('button', { name: 'Cancel' }).click()
  await expect(shell.locator(sel('pr-merge-confirm'))).toHaveCount(0)

  // Diff: the file tree and the review thread on its line (the first file), then the long line
  // wrapped (the list jumps to its file from the tree; too far down to share one window).
  await shell.locator(sel('review-tab-diff')).click()
  const files = shell.locator(sel('review-files'))
  await expect(files.locator(sel('review-file-tree'))).toBeVisible({ timeout: 30_000 })
  const thread = files.locator('[data-testid="review-inline-thread"][data-thread="501"]')
  await expect(thread).toContainText('Why 423 and not 409 here?')
  await expect(thread).toBeInViewport()
  await shot(shell, 'pr-diff-tree')
  const long = 'src/very/deep/nested/longline.ts'
  await files.locator(`[data-path="${long}"]`).click()
  const longCard = files.locator(`[data-file="${long}"]`)
  await expect(longCard).toBeInViewport()
  const tall = await longCard
    .locator(sel('review-diff-line'))
    .nth(1)
    .evaluate((r) => r.getBoundingClientRect().height)
  expect(tall).toBeGreaterThan(40)
  // The list scrolled, not the page: the tabs and the file tree stay in view.
  await expect(shell.locator(sel('review-tab-diff'))).toBeInViewport()
  await expect(files.locator(`[data-path="${long}"]`)).toBeInViewport()
  await shot(shell, 'pr-diff-longline')

  // The folded PR sidebar: inside a ticket, the ticket's status strip tells the PR's status.
  await shell.locator(sel('review-tab-comments')).click()
  await shell.locator(sel('pr-sidebar-toggle')).click()
  await expect(shell.locator(sel('review-rail'))).toHaveCount(0)
  await expect(shell.locator(sel('ticket-strip'))).toContainText('Blocked')
  await shot(shell, 'pr-sidebar-collapsed')
  await shell.locator(sel('pr-sidebar-toggle')).click()

  // An inline thread on a ticket's description: select, comment, confirm, then the highlight's popover.
  await openPlace(shell, 'ticket:ENG-9101')
  const description = shell.locator(sel('ticket-description'))
  await expect(description).toContainText('The flow, as drawn', { timeout: 30_000 })
  await shell.evaluate(() => {
    const body = document.querySelector('[data-testid="ticket-description"] [data-inline-body]')!
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = (n as Text).data.indexOf('flow, as drawn')
      if (at < 0) continue
      const r = document.createRange()
      r.setStart(n, at)
      r.setEnd(n, at + 'flow, as drawn'.length)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(r)
      return
    }
    throw new Error('no description text')
  })
  await shell.locator(sel('selection-comment')).click()
  await shell.locator(sel('inline-composer')).fill('Which flow is this?')
  await shell.locator(sel('inline-composer-send')).click()
  await expect(shell.locator(sel('review-confirm-text'))).toHaveText('Which flow is this?')
  await shell.locator(sel('review-confirm-post')).click()
  const highlight = shell.locator(sel('inline-highlight')).first()
  await expect(highlight).toBeVisible({ timeout: 30_000 })
  await highlight.focus()
  await shell.keyboard.press('Enter')
  const pop = shell.locator(sel('inline-thread-popover'))
  await expect(pop.locator(sel('ticket-comment-body'))).toContainText('Which flow is this?')
  await shot(shell, 'inline-thread')

  expectHermetic()
  expect(host.mutations.map((m) => (m.cmd as { kind: string }).kind)).toEqual(['prepare', 'commit'])
})

test.describe('a host without tickets', () => {
  test.use({ hostMode: 'fallback' })

  test('the Board falls back and says why', async ({ app, shell }) => {
    test.skip(!AFTER, 'after only')
    await setup(app, shell)
    await openPlace(shell, 'board')
    await expect(shell.locator(sel('agents-card-ENG-9001'))).toBeVisible({ timeout: 30_000 })
    const fresh = shell.locator(sel('agents-freshness'))
    await expect(fresh).not.toContainText('Synced')
    await expect(fresh).not.toBeEmpty()
    await expect(
      shell.locator(sel('agents-card-ENG-9001')).locator(sel('agents-wait')),
    ).toHaveCount(0)
    await shot(shell, 'fallback')
    expect(host.ticketFrames).toEqual([])
    expectHermetic()
  })
})

test.describe('the Timeline', () => {
  test.use({ hostMode: 'timeline' })

  test('bars by due date, and Ask Astra to re-plan', async ({ app, shell }) => {
    test.skip(!AFTER, 'after only')
    test.setTimeout(120_000)
    await setup(app, shell)
    await openPlace(shell, 'board')
    await expect(shell.locator(sel('agents-board'))).toBeVisible({ timeout: 30_000 })
    await shell.locator(sel('agents-view-timeline')).click()
    const timeline = shell.locator(sel('timeline'))
    await expect(timeline).toBeVisible()
    await expect(shell.locator('.wx-bar[data-id=":ENG-9001"]')).toBeVisible({ timeout: 30_000 })
    await expect(shell.locator(sel('timeline-nodate'))).toContainText('ENG-9004')
    // Today's label sits on the time scale, never over a bar's text.
    await expect(shell.locator('.wx-scale [data-line-label="today"]')).toHaveText('Today')
    await shot(shell, 'timeline')

    await timeline
      .getByText(/^Beta \(/)
      .first()
      .click()
    await shell.getByRole('button', { name: 'Ask Astra to re-plan' }).click()
    const panel = shell.locator(sel('plan-panel'))
    await expect(panel).toHaveAttribute('data-plan', 'reviewingProposal', { timeout: 30_000 })
    await expect(panel).toContainText('Land Beta by its target date')
    await expect(panel.locator('[data-plan-row="ENG-9001"]')).toContainText('2027-01-08')
    await shot(shell, 'timeline-proposal')
    expect(host.mutations).toEqual([])
    expectHermetic()
  })
})
