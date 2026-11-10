import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeEvaFixture, type EvaFixture } from './helpers/eva-fixture'

// Opt-in live spec: the Agents board's combined ticket view on ENG-6832 against real Linear
// (LINEAR_API_KEY) and GitHub (gh). Read-only by construction: EVAOS_E2E=1 turns every write
// (status change, PR review, hand-off to Astra) into a dry run, and the spec checks each one.
// EVAOS_TICKET_SHOTS=<dir> keeps the screenshots there.
const KEY = process.env.EVAOS_TICKET_KEY ?? 'ENG-6832'
/** The real ledger, so the card carries its PR, stage and links. */
const LEDGER = path.join(os.homedir(), 'Eva/work/items', `${KEY}.md`)

const test = base.extend<{ evaFx: EvaFixture }>({
  evaFx: async ({}, use) => {
    const fx = makeEvaFixture()
    const items = path.join(fx.root, 'work/items')
    fs.mkdirSync(items, { recursive: true })
    fs.copyFileSync(LEDGER, path.join(items, `${KEY}.md`))
    await use(fx)
    fx.cleanup()
  },
  launchEnv: async ({ evaFx }, use) => {
    await use({ ...evaFx.env, EVAOS_REVIEWS_GH: '1' })
  },
})
test.use({ startOnChat: false })
test.skip(process.env.EVAOS_LIVE !== '1', 'live Linear and GitHub reads are opt-in (EVAOS_LIVE=1)')
test.setTimeout(300_000)

const sel = (id: string): string => `[data-testid="${id}"]`
const SHOTS =
  process.env.EVAOS_TICKET_SHOTS ?? path.join(__dirname, '../test-results/agents-ticket')
type Shell = { __evaosShell: { openPlace(page: string): void } }

async function shot(shell: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await shell.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

async function toast(shell: Page, text: string): Promise<void> {
  await expect(shell.locator('.mantine-Notification-root').filter({ hasText: text })).toBeVisible()
  // Let the toast stack finish moving, so the shot shows this one on top.
  await shell.waitForTimeout(600)
}

test('combined ticket view on a real ticket, every write a dry run', async ({ app, shell }) => {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1800, 1100))
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('agents'))
  await expect(shell.locator(sel('agents-board'))).toBeVisible()
  await shell.locator(sel(`agents-card-${KEY}`)).click()

  const side = shell.locator(sel('agents-side'))
  await expect(side.locator(sel('linear-status'))).toBeVisible({ timeout: 30_000 })
  const reportsTab = side.locator(sel('ticket-pr-tab-react-client-reports-app-254'))
  await expect(reportsTab).toBeVisible({ timeout: 30_000 })
  await expect(side.locator(sel('review-conversation'))).toBeVisible({ timeout: 60_000 })
  await shot(shell, '01-board-with-ticket-view')

  await reportsTab.click()
  await expect(side.locator(sel('review-head-id'))).toHaveText('react-client-reports-app#254', {
    timeout: 60_000,
  })
  await expect(side.locator(sel('review-reviewers'))).toBeVisible()
  await reportsTab.scrollIntoViewIfNeeded()
  await shot(shell, '02-pr-254-conversation')

  await side.locator(sel('review-tab-files')).click()
  await expect(side.locator(sel('review-diff')).first()).toBeVisible()
  await reportsTab.scrollIntoViewIfNeeded()
  await shot(shell, '03-pr-254-files')

  await side.locator(sel('review-tab-checks')).click()
  await expect(side.locator(sel('review-checks'))).toBeVisible()
  await reportsTab.scrollIntoViewIfNeeded()
  await shot(shell, '04-pr-254-checks')

  // Review on GitHub: approve, a dry run in a test instance.
  await side.locator(sel('review-changes')).click()
  await shell.locator('.mantine-SegmentedControl-label', { hasText: /^Approve$/ }).click()
  await shell.getByRole('button', { name: 'Submit review on GitHub' }).click()
  await toast(shell, 'the review was not submitted')
  await shot(shell, '05-review-approve-dry-run')

  // Status: the team's states, a pick is a dry run.
  await side.locator(sel('agents-panel')).evaluate((el) => {
    el.querySelector('.eva-ab-tv-scroll')?.scrollTo({ top: 0 })
  })
  await side.locator(sel('linear-status')).click()
  const menu = shell.locator(sel('linear-status-menu'))
  await expect(menu.getByRole('menuitem').first()).toBeVisible({ timeout: 30_000 })
  await shot(shell, '06-status-menu')
  const current = (await side.locator(sel('linear-status')).innerText()).trim()
  await menu.getByRole('menuitem').filter({ hasNotText: current }).first().click()
  await toast(shell, 'the status was not changed in Linear')
  await shot(shell, '07-status-dry-run')

  // Hand the ticket to Astra: shows the exact command it would run.
  await side.locator(sel('ticket-send')).click()
  await shell.locator(sel('ticket-send-note')).fill('Proof run, nothing is sent.')
  await shell.locator(sel('ticket-send-confirm')).click()
  await toast(shell, 'Test instance, not sent')
  await shot(shell, '08-send-to-astra-dry-run')

  // A window too narrow for both: the open card moves into the drawer.
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(820, 1000))
  await expect(shell.locator(`${sel('agents-drawer')} ${sel('linear-status')}`)).toBeVisible({
    timeout: 30_000,
  })
  await shot(shell, '09-narrow-drawer')
})
