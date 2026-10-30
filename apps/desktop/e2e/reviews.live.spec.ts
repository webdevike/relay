import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

// Opt-in live spec: the Reviews page against real GitHub (gh, Isaac's account) on PR
// eCardSystems/node-client-api-service#170. Read-only by construction: EVAOS_E2E=1 turns every
// write (GitHub comment, review, private @Astra ask) into a dry run, and the spec checks that.
// EVAOS_REVIEWS_SHOTS=<dir> keeps the screenshots there.
test.skip(process.env.EVAOS_LIVE !== '1', 'live GitHub reads are opt-in (EVAOS_LIVE=1)')
// The Guide is written by the real claude CLI (a read: the model sees the PR, nothing is posted).
test.use({
  launchEnv: {
    EVAOS_REVIEWS_GH: '1',
    EVAOS_CLAUDE_BIN: process.env.EVAOS_CLAUDE_BIN ?? path.join(os.homedir(), '.local/bin/claude'),
  },
})
test.setTimeout(300_000)

const sel = (id: string): string => `[data-testid="${id}"]`
const SHOTS = process.env.EVAOS_REVIEWS_SHOTS ?? path.join(__dirname, '../test-results/reviews')

async function shot(shell: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await shell.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

type Shell = { __evaosShell: { openPlace(page: string): void } }

test('reviews a real PR end to end without writing anywhere', async ({ app, shell }) => {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1800, 1000))
  await shell.waitForFunction(() => !!(window as unknown as Partial<Shell>).__evaosShell)
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('settings'))
  const dark = shell.locator(sel('appearance-dark'))
  if (await dark.isVisible().catch(() => false)) await dark.click()
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('reviews'))
  await expect(shell.locator(sel('review-queue'))).toBeVisible()
  await expect(shell.locator(sel('review-queue'))).not.toContainText('Loading', { timeout: 30_000 })
  // Only the page: the default layout's Browser pane would take a third of the window.
  await shell.keyboard.press('Meta+Shift+B')
  await shot(shell, '01-queue-for-me')

  await shell.locator(sel('review-queue')).getByText('Created', { exact: true }).click()
  await shell.locator(sel('review-row-170')).click()
  await expect(shell.locator(sel('review-conversation'))).toBeVisible({ timeout: 30_000 })
  await expect(shell.locator(sel('review-rail'))).toContainText('tbarczak')
  await shot(shell, '02-conversation')

  await shell.locator(sel('review-tab-files')).click()
  await expect(shell.locator(sel('review-diff')).first()).toBeVisible()
  await shot(shell, '03-files-split')

  await expect(shell.locator(sel('review-tab-commits'))).toHaveCount(0)
  await shot(shell, '04-tabs')
  await shell.locator(sel('review-tab-checks')).click()
  await expect(shell.locator(sel('review-checks'))).toBeVisible()
  await shot(shell, '05-checks')

  // Guide: an authored walkthrough in one scroll; reviewing a file collapses it and checks it off.
  await shell.locator(sel('review-tab-guide')).click()
  const guide = shell.locator(sel('review-guide'))
  await expect(guide.locator(sel('review-guide-loading'))).toBeVisible()
  await shot(shell, '06a-guide-loading')
  await expect(guide).toHaveAttribute('data-source', 'model', { timeout: 200_000 })
  const titles = await guide.locator('.eva-rv-lsec-title').allTextContents()
  expect(titles.length).toBeGreaterThanOrEqual(3)
  expect(titles.length).toBeLessThanOrEqual(7)
  // Sections are written, not commits: no commit headline anywhere in the Guide.
  await expect(guide).not.toContainText('feat: ref ENG-6312 Filter')
  await expect(guide.locator(sel('review-diff')).first()).toBeVisible()
  await shell.waitForTimeout(500)
  await shot(shell, '06-guide-top')
  const first = guide.locator(sel('review-guide-section')).first()
  for (const box of await first.getByLabel('Reviewed').all()) await box.check()
  await first.scrollIntoViewIfNeeded()
  await shot(shell, '06b-guide-reviewed')
  await guide.locator(sel('review-guide-section')).nth(2).scrollIntoViewIfNeeded()
  await shot(shell, '06c-guide-section3')
  await expect(shell.getByRole('button', { name: 'Hand to Astra' })).toHaveCount(0)

  // @Astra is private: it goes to Astra (dry run here), never to the GitHub confirm.
  await shell.locator(sel('review-tab-conversation')).click()
  const box = shell.locator(sel('review-composer'))
  await box.fill('@Astra can a hot asset page pass 1000 versions here?')
  await shot(shell, '07-private-typing')
  await box.press('Meta+Enter')
  await expect(shell.locator(sel('review-private-ask')).last()).toContainText('1000 versions')
  await expect(shell.getByText('Post this comment on GitHub?')).toHaveCount(0)
  await shot(shell, '08-private-sent')

  // A plain comment asks first and shows the exact text; posting is a dry run in tests.
  await box.fill('Looks good once the versions route pages.')
  await box.press('Meta+Enter')
  await expect(shell.locator(sel('review-confirm-text'))).toHaveText(
    'Looks good once the versions route pages.',
  )
  await shell.waitForTimeout(400)
  await shot(shell, '09-comment-confirm')
  await shell.locator(sel('review-confirm-post')).click()
  await expect(shell.getByText('Test instance: the comment was not posted')).toBeVisible()

  await shell.locator(sel('review-done')).click()
  await expect(shell.locator(sel('review-row-170'))).toHaveCount(0)
  await shot(shell, '12-after-done')
})
