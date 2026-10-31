import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

// Opt-in live spec: @Astra on PR eCardSystems/node-client-api-service#170 starts a real Astra
// session (real omp, her prime and thread memory from ~/Eva, her profile and model), the answer
// streams inline, a follow-up continues the same session, Use as reply fills the comment box (the
// GitHub post still asks first and is a dry run here), and Open session shows it in the chat view.
// The test asks only read-only questions. EVAOS_REVIEWS_SHOTS=<dir> keeps the screenshots there.
test.skip(process.env.EVAOS_LIVE !== '1', 'a real Astra session is opt-in (EVAOS_LIVE=1)')

const EVA = path.join(os.homedir(), 'Eva')
test.use({
  launchEnv: {
    EVAOS_LIVE: '1',
    EVAOS_EVA_ROOT: EVA,
    EVAOS_OMP_BIN: process.env.EVAOS_OMP_BIN ?? path.join(os.homedir(), '.local/bin/omp'),
    EVAOS_REVIEWS_GH: '1',
  },
})
test.setTimeout(900_000)

const URL = 'https://github.com/eCardSystems/node-client-api-service/pull/170'
const sel = (id: string): string => `[data-testid="${id}"]`
const SHOTS = process.env.EVAOS_REVIEWS_SHOTS ?? path.join(__dirname, '../test-results/reviews')

async function shot(shell: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await shell.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

type Shell = { __evaosShell: { openPlace(page: string): void } }
type Eva = {
  eva: {
    invoke(c: string, i: unknown): Promise<{ ok: boolean; value: { file: string | null } | null }>
  }
}

const sessionFile = (shell: Page): Promise<string | null> =>
  shell.evaluate(
    async (url) =>
      (await (window as unknown as Eva).eva.invoke('reviews.astraThread', { url })).value?.file ??
      null,
    URL,
  )

test('@Astra on a PR runs its own Astra session and answers inline', async ({ app, shell }) => {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1800, 1000))
  await shell.waitForFunction(() => !!(window as unknown as Partial<Shell>).__evaosShell)
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('settings'))
  const dark = shell.locator(sel('appearance-dark'))
  if (await dark.isVisible().catch(() => false)) await dark.click()
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('reviews'))
  await expect(shell.locator(sel('review-queue'))).not.toContainText('Loading', { timeout: 60_000 })
  await shell.keyboard.press('Meta+Shift+B')
  await shell.locator(sel('review-queue')).getByText('Created', { exact: true }).click()
  await shell.locator(sel('review-row-170')).click()
  await expect(shell.locator(sel('review-conversation'))).toBeVisible({ timeout: 60_000 })

  // First ask: a new session seeded with the PR.
  const box = shell.locator(sel('review-composer'))
  await box.fill(
    '@Astra In two or three sentences: what does this PR change, and what is the riskiest part? Read only; do not post or send anything.',
  )
  await box.press('Meta+Enter')
  const inline = shell.locator(sel('review-astra'))
  await expect(inline).toBeVisible({ timeout: 60_000 })
  await expect(inline).toContainText('Astra · node-client-api-service#170')
  await expect(inline.locator(sel('review-astra-question')).first()).toContainText('riskiest part')
  await expect(inline.locator(sel('review-astra-question')).first()).not.toContainText(
    'You are Astra',
  )
  await expect(shell.getByText('Post this comment on GitHub?')).toHaveCount(0)
  await shot(shell, 'astra-inline-1-asked')
  await expect(inline.locator(sel('review-astra-use')).first()).toBeVisible({ timeout: 600_000 })
  await expect(inline.locator(sel('review-astra-working'))).toHaveCount(0, { timeout: 120_000 })
  await shot(shell, 'astra-inline-2-answer')
  const first = await sessionFile(shell)
  expect(first).toMatch(/\.jsonl$/)

  // Follow-up: the same session.
  await box.fill('@Astra Which one file should I read first? One line.')
  await box.press('Meta+Enter')
  await expect(inline.locator(sel('review-astra-question'))).toHaveCount(2)
  await expect(inline.locator(sel('review-astra-use'))).toHaveCount(2, { timeout: 600_000 })
  await expect(inline.locator(sel('review-astra-working'))).toHaveCount(0, { timeout: 120_000 })
  expect(await sessionFile(shell)).toBe(first)
  await shot(shell, 'astra-inline-3-followup')

  // Use as reply fills the box; posting it still asks first (and is a dry run in tests).
  const answer = (await inline.locator(sel('review-astra-answer')).last().innerText()).trim()
  await inline.locator(sel('review-astra-use')).last().click()
  await expect(box).not.toHaveValue('')
  await box.press('Meta+Enter')
  await expect(shell.getByText('Post this comment on GitHub?')).toBeVisible()
  await shell.waitForTimeout(400)
  await shot(shell, 'astra-inline-4-use-as-reply')
  expect(answer.length).toBeGreaterThan(0)
  await shell.getByRole('button', { name: 'Cancel' }).last().click()
  await box.fill('')

  // Open session: the normal chat view on the same file.
  await inline.locator(sel('review-astra-open')).click()
  await expect(shell.locator(sel('page-chat-wrap'))).toBeVisible()
  await shell.waitForTimeout(2000)
  await shot(shell, 'astra-inline-5-session')
})
