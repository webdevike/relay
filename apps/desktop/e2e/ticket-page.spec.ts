// The ticket page (`ticket:`), against a stand-in Relay host with `tickets` and `tickets.writes`
// (fixtures in e2e/fixtures/tickets) plus ledger work items: a ticket card opens its page, prev and
// next step through the board's order, the sidebar folds to the status strip, Esc goes PR, ticket,
// board with the board's scroll kept; a ledger-only item opens `ticket:item/<id>`; a key the host
// can't read shows "Linear details unavailable" with every link and PR; a run card opens its own
// target; a narrow pane keeps both sidebar states usable. No network: Linear and GitHub only exist
// as the fake host's fixtures. Screenshots go to test-results/ticket-shots/.
//
//   pnpm build && pnpm e2e:run e2e/ticket-page.spec.ts --retries 0 --max-failures 1
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { TICKETS_FEATURE, TICKETS_WRITES_FEATURE } from '@relay/protocol'
import { test as base, expect } from './fixtures'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { makeEvaFixture } from './helpers/eva-fixture'
import { pickScheme } from './helpers/appearance'

const SHOTS = path.join(__dirname, '..', 'test-results', 'ticket-shots')

let host: FakeRelayHost

const ledger = (key: string, title: string, extra = ''): string =>
  `---\nkey: ${key}\ntitle: ${title}\nworkspace: ecardsystems\nstage: 9 PR (draft)\nmove: isaac\nnext: Isaac: review\nupdated: ${new Date().toISOString().slice(0, 10)}\n${extra}---\n\n## Context\n`

const test = base.extend({
  launchEnv: async ({}, use) => {
    const fx = makeEvaFixture()
    const items = path.join(fx.root, 'work/items')
    fs.mkdirSync(items, { recursive: true })
    fs.writeFileSync(
      path.join(items, 'ENG-9001.md'),
      ledger(
        'ENG-9001',
        'Sample synced ticket',
        'linear: https://linear.example.test/issue/ENG-9001\n',
      ),
    )
    // A ticket the host doesn't sync (and Linear is off in tests): its page can't read Linear.
    fs.writeFileSync(
      path.join(items, 'ENG-9100.md'),
      ledger(
        'ENG-9100',
        'Versions for deleted assets',
        'linear: https://linear.app/acme/issue/ENG-9100/versions\npr: https://github.com/acme/app/pull/12\n',
      ),
    )
    fs.writeFileSync(path.join(items, 'relay-demo.md'), ledger('relay-demo', 'Relay demo item'))
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-ticket-page-'))
    const relayDir = path.join(root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    host.features = ['render.report', TICKETS_FEATURE, TICKETS_WRITES_FEATURE]
    await use({ ...fx.env, EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
    fx.cleanup()
  },
})

test.use({ startOnChat: false })

const sel = (id: string): string => `[data-testid="${id}"]`
type Shell = { __evaosShell: { openPlace(page: string): void } }
const page = (shell: Page) => shell.locator(sel('ticket-page'))
const shot = (shell: Page, name: string) =>
  shell.screenshot({ path: path.join(SHOTS, `${name}.png`) })

/** Esc from inside the page (the global dismiss chord), as Isaac presses it. */
async function esc(shell: Page): Promise<void> {
  await shell.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await shell.keyboard.press('Escape')
}

const boardScroll = (shell: Page) =>
  shell.locator(sel('agents-board')).evaluate((el) => el.scrollLeft)

test('a ticket opens as its own page: step, fold, Esc back to the board, items and runs', async ({
  app,
  shell,
}) => {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1440, 900))
  await pickScheme(shell, 'dark')
  fs.mkdirSync(SHOTS, { recursive: true })
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('board'))
  const eng1 = shell.locator(sel('agents-card-ENG-9001'))
  await expect(eng1).toBeVisible({ timeout: 30_000 })
  await expect(shell.locator(sel('agents-card-ENG-9100'))).toBeVisible()

  // Scroll the board sideways, then open the synced ticket.
  await shell.locator(sel('agents-board')).evaluate((el) => {
    el.scrollLeft = 120
  })
  const scrolled = await boardScroll(shell)
  expect(scrolled).toBeGreaterThan(0)
  // A plain click event: Playwright's click would scroll the card into view first.
  await eng1.dispatchEvent('click')
  await expect(page(shell)).toHaveAttribute('data-ticket', 'ENG-9001')
  await expect(shell.locator(sel('page-board'))).toHaveCount(0)
  await expect(page(shell).locator('h1')).toHaveText('Sample synced ticket')
  await expect(shell.locator(sel('ticket-crumbs'))).toContainText('Board')
  await expect(shell.locator(sel('ticket-crumbs'))).toContainText('ENG-9001')
  await expect(shell.locator(sel('ticket-sidebar'))).toContainText('In Progress')
  await expect(shell.locator(sel('ticket-sidebar'))).toContainText('Sample board')
  await expect(shell.locator(sel('ticket-side-pr-sample-42'))).toBeVisible()
  await expect(shell.locator(sel('ticket-resources'))).toContainText('Sample bridge change')
  await expect(shell.locator(sel('ticket-pos'))).toHaveText(/^\d+ \/ \d+$/)
  await shot(shell, 'ticket')

  // Next and back through the board's order.
  const pos = await shell.locator(sel('ticket-pos')).textContent()
  const [i] = pos!.split(' / ').map(Number)
  const step = i === 1 ? 'ticket-next' : 'ticket-prev'
  const back = i === 1 ? 'ticket-prev' : 'ticket-next'
  await shell.locator(sel(step)).click()
  await expect(page(shell)).not.toHaveAttribute('data-ticket', 'ENG-9001')
  await expect(shell.locator(sel('ticket-pos'))).not.toHaveText(pos!)
  await shell.locator(sel(back)).click()
  await expect(page(shell)).toHaveAttribute('data-ticket', 'ENG-9001')
  await expect(shell.locator(sel('ticket-pos'))).toHaveText(pos!)

  // Fold the sidebar: the strip says what it said, and the fold is kept.
  await shell.locator(sel('ticket-sidebar-toggle')).click()
  await expect(shell.locator(sel('ticket-sidebar'))).toHaveCount(0)
  const strip = shell.locator(sel('ticket-strip'))
  await expect(strip.locator(sel('ticket-strip-state'))).toHaveText('In Progress')
  await expect(strip.locator(sel('ticket-strip-pr'))).toHaveText('sample#42')
  await expect(strip.locator(sel('ticket-strip-line'))).toHaveText('Blocked: Waiting on review')
  await expect(strip.locator(sel('ticket-strip-checks'))).toHaveText('3/3 checks passing')
  await shot(shell, 'ticket-collapsed')
  await shell.locator(sel('ticket-sidebar-toggle')).click()
  await expect(shell.locator(sel('ticket-sidebar'))).toBeVisible()

  // A PR's page sits inside the ticket; Esc goes PR, ticket, board.
  await shell.locator(sel('ticket-side-pr-sample-42')).click()
  await expect(page(shell)).toHaveAttribute('data-pr', 'example/sample#42')
  await expect(shell.locator(sel('ticket-crumbs'))).toContainText('PR #42')
  await expect(shell.locator(sel('ticket-strip'))).toBeVisible()
  await shot(shell, 'ticket-pr')
  await esc(shell)
  await expect(page(shell)).not.toHaveAttribute('data-pr')
  await expect(page(shell)).toHaveAttribute('data-ticket', 'ENG-9001')
  await esc(shell)
  await expect(shell.locator(sel('agents-board'))).toBeVisible()
  await expect(page(shell)).toHaveCount(0)
  await expect.poll(() => boardScroll(shell)).toBe(scrolled)

  // A ledger-only work item opens its work-item page: the card's facts and links, no Linear.
  await shell.locator(sel('agents-card-relay-demo')).click()
  await expect(page(shell)).toHaveAttribute('data-ticket', 'relay-demo')
  await expect(shell.locator(sel('ticket-agent'))).toBeVisible()
  await expect(shell.locator(sel('ticket-link-ledger'))).toBeVisible()
  await expect(shell.locator(sel('ticket-unavailable'))).toHaveCount(0)
  await esc(shell)
  await expect(shell.locator(sel('agents-board'))).toBeVisible()

  // A key the host doesn't have and Linear can't read: why, plus every link and PR.
  await shell.locator(sel('agents-card-ENG-9100')).click()
  await expect(page(shell)).toHaveAttribute('data-ticket', 'ENG-9100')
  await expect(shell.locator(sel('ticket-unavailable'))).toContainText(
    'Linear details unavailable:',
  )
  await expect(shell.locator(sel('ticket-link-ledger'))).toBeVisible()
  await expect(shell.locator(sel('ticket-pr-app-12'))).toBeVisible()
  await expect(shell.locator(sel('ticket-agent'))).toContainText('Needs')
  await shot(shell, 'ticket-unavailable')
  await shell.locator(sel('ticket-pr-app-12')).click()
  await expect(page(shell)).toHaveAttribute('data-pr', 'acme/app#12')
  await esc(shell)
  await esc(shell)
  await expect(shell.locator(sel('agents-board'))).toBeVisible()

  // A run of its own (no key) opens its target, not a ticket page.
  host.setActivity([
    {
      id: 'helper:board-proto',
      kind: 'helper',
      owner: 'assistant:nova',
      title: 'BoardProto',
      status: 'working',
      intent: 'Reading the board',
      startedAt: Date.now() - 60_000,
      updatedAt: Date.now(),
      model: 'claude-opus-5-5',
      open: { to: 'chat', thread: 'assistant:nova' },
    },
  ])
  const run = shell.locator('[data-testid^="agents-card-run:"]')
  await expect(run).toHaveCount(1)
  await run.click()
  await expect(shell.locator(sel('page-board'))).toBeHidden()
  await expect(page(shell)).toHaveCount(0)

  // A narrow pane: both sidebar states stay readable.
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(820, 900))
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('ticket:ENG-9001'))
  await expect(page(shell)).toHaveAttribute('data-ticket', 'ENG-9001')
  await expect(shell.locator(sel('ticket-sidebar'))).toBeVisible()
  await expect(page(shell).locator('h1')).toBeVisible()
  await shot(shell, 'narrow-sidebar')
  await shell.locator(sel('ticket-sidebar-toggle')).click()
  await expect(shell.locator(sel('ticket-strip'))).toBeVisible()
  await shot(shell, 'narrow-collapsed')
})
