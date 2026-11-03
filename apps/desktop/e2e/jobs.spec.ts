import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeEvaFixture, EXPECT_P3, type EvaFixture } from './helpers/eva-fixture'
import { proofShot } from './helpers/proofShot'

type Shell = { __evaosShell: { openPlace(p: string, n?: boolean): void } }

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
const NAMES = ['broken', 'manual-check', 'nightly', 'script-job', 'stale-lock', 'weekly-digest']

async function setScheme(shell: Page, mode: 'dark' | 'light'): Promise<void> {
  await shell.locator(sel(`appearance-${mode}`)).click()
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', mode)
}

test.beforeEach(async ({ shell }) => {
  await expect(shell.locator(sel('dash-hero'))).toBeVisible()
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('jobs'))
  await expect(shell.locator(sel('page-jobs'))).toBeVisible()
  await expect(shell.locator(sel('job-row-nightly'))).toBeVisible()
})

test('lists every job with schedule, state and next due', async ({ app, shell }) => {
  const rows = shell.locator('[data-testid^=job-row-]')
  await expect(rows).toHaveCount(EXPECT_P3.jobs)
  const ids = await rows.evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-testid')!.replace('job-row-', '')),
  )
  expect(ids).toEqual(NAMES)
  await expect(shell.locator(sel('jobs-scheduled'))).toHaveText(
    `${EXPECT_P3.scheduledJobs} scheduled`,
  )
  const row = (n: string) => shell.locator(sel(`job-row-${n}`))
  await expect(row('nightly')).toContainText('Every 2h')
  await expect(shell.locator(sel('job-state-nightly'))).toHaveText('ok')
  await expect(shell.locator(sel('job-state-broken'))).toHaveText('failed')
  await expect(row('manual-check')).toContainText('Manual')
  await expect(shell.locator(sel('job-due-manual-check'))).toHaveText('Not scheduled')
  await expect(shell.locator(sel('job-state-script-job'))).toHaveText('never run')
  await expect(shell.locator(sel('job-due-script-job'))).toHaveText('Due now')
  await expect(shell.locator(sel('job-state-stale-lock'))).not.toHaveText('running')

  await setScheme(shell, 'dark')
  await proofShot(app, shell, 'jobs-list-dark', PHASE)
  await setScheme(shell, 'light')
  await proofShot(app, shell, 'jobs-list-light', PHASE)
})

test('toggling the switch changes exactly one line of job.md', async ({ shell, evaFx }) => {
  const file = path.join(evaFx.root, 'jobs/nightly/job.md')
  const original = fs.readFileSync(file, 'utf8')
  const sw = shell.locator(sel('job-enabled-nightly'))
  await sw.click({ force: true })
  await expect.poll(() => fs.readFileSync(file, 'utf8'), { timeout: 2000 }).not.toBe(original)
  const a = original.split('\n')
  const b = fs.readFileSync(file, 'utf8').split('\n')
  expect(b.filter((l) => !a.includes(l))).toEqual(['enabled: false'])
  expect(a.filter((l) => !b.includes(l))).toEqual([])
  await expect(shell.locator(sel('jobs-scheduled'))).toHaveText('3 scheduled')
  await expect(shell.locator(sel('job-due-nightly'))).toHaveText('Not scheduled')

  await sw.click({ force: true })
  await expect
    .poll(() => fs.readFileSync(file, 'utf8'), { timeout: 2000 })
    .toContain('enabled: true')
  await expect(shell.locator(sel('jobs-scheduled'))).toHaveText('4 scheduled')
})

test('a refused write reverts the switch and shows a toast', async ({ shell, evaFx }) => {
  // A read-only folder makes the atomic temp-file write fail, so the row stays and the write is refused.
  const dir = path.join(evaFx.root, 'jobs/manual-check')
  fs.chmodSync(dir, 0o555)
  try {
    const sw = shell.locator(sel('job-enabled-manual-check'))
    await expect(sw).toBeChecked()
    await sw.click({ force: true })
    await expect(shell.locator('.mantine-Notification-root').first()).toBeVisible()
    await expect(sw).toBeChecked()
    expect(fs.readFileSync(path.join(dir, 'job.md'), 'utf8')).not.toContain('enabled: false')
  } finally {
    fs.chmodSync(dir, 0o755)
  }
})
