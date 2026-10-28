import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { EXPECT_P3, makeEvaFixture, type EvaFixture } from './helpers/eva-fixture'
import { FAKE_GATE, FAKE_JOB_RUN } from './helpers/paths'
import { proofShot } from './helpers/proofShot'

type Shell = { __evaosShell: { openPlace(p: string, n?: boolean): void } }
type Win = { __evaosTest: { win: { setContentSize(w: number, h: number): void } } }

const test = base.extend<{ evaFx: EvaFixture }>({
  evaFx: async ({}, use) => {
    const fx = makeEvaFixture()
    await use(fx)
    fx.cleanup()
  },
  launchEnv: async ({ evaFx }, use) => {
    await use(evaFx.env)
  },
})

test.use({ startOnChat: false, colorScheme: 'dark' })

const PHASE = { phase: 'phase-3' }
const sel = (id: string): string => `[data-testid=${id}]`

async function visitAll(app: ElectronApplication, shell: Page, suffix: string): Promise<void> {
  const shot = async (name: string): Promise<void> => {
    if (suffix) await proofShot(app, shell, `tour-${name}-${suffix}`, PHASE)
  }
  const place = (p: string): Promise<void> =>
    shell.evaluate((x) => (window as unknown as Shell).__evaosShell.openPlace(x), p)

  await place('dashboard')
  await expect(shell.locator(sel('page-dashboard'))).toBeVisible()
  await expect(shell.locator(sel('dash-summary'))).toHaveText(
    `${EXPECT_P3.workspaces} workspaces, ${EXPECT_P3.openTodos} open todos, ${EXPECT_P3.updatesThisWeek} updates this week`,
  )
  await shot('dashboard')

  const card = shell.locator(sel('ws-card-flo'))
  if (await card.count()) await card.click()
  else await shell.locator('.eva-dash-name-link', { hasText: 'Flo' }).first().click()
  await expect(shell.locator(sel('page-workspace'))).toBeVisible()
  await expect(shell.locator(sel('ws-header'))).toContainText('Flo')
  await shot('workspace')

  await place('jobs')
  await expect(shell.locator(sel('page-jobs'))).toBeVisible()
  await expect(shell.locator('[data-testid^=job-row-]')).toHaveCount(EXPECT_P3.jobs)
  await shot('jobs')

  await place('habits')
  await expect(shell.locator(sel('page-habits'))).toBeVisible()
  await expect(shell.locator(sel('habit-row-stretch'))).toBeVisible()
  await shot('habits')

  // The meetings sub-sidebar can still be open from the previous pass.
  if (await shell.locator(sel('nav-meetings')).isVisible()) {
    await shell.locator(sel('nav-meetings')).click()
  }
  // At compact widths the sidebar folds so the tool panes keep their room; hide them to show it.
  if ((await shell.locator(sel('shell')).getAttribute('data-sidebar-state')) === 'folded') {
    await shell.locator(`${sel('panel-toggle')}:visible`).click()
    await expect(shell.locator(sel('shell'))).toHaveAttribute('data-sidebar-state', 'open')
  }
  await expect(shell.locator(sel('meetings-list'))).toBeVisible()
  await shell.locator(sel('meeting-row-standup')).click()
  await expect(shell.locator(sel('page-meeting'))).toContainText('Daily standup')
  await shot('meeting')
}

test('one session visits every Phase 3 page at wide and compact widths', async ({ app, shell }) => {
  await expect(shell.locator(sel('dash-hero'))).toBeVisible()
  await visitAll(app, shell, '')

  await app.evaluate(() => (globalThis as unknown as Win).__evaosTest.win.setContentSize(800, 720))
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(800)
  await visitAll(app, shell, 'compact')

  const log = await app.evaluate(
    () =>
      (
        globalThis as unknown as {
          __evaosTest: { hooks: { spawnLog?: Array<{ file: string; argv: string[] }> } }
        }
      ).__evaosTest.hooks.spawnLog ?? [],
  )
  expect(log.length).toBeGreaterThan(0)
  for (const e of log) {
    expect([e.file, ...e.argv].some((x) => x === FAKE_GATE || x === FAKE_JOB_RUN)).toBe(true)
  }
})
