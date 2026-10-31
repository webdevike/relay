import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

// Opt-in live spec: Slack in Reviews against Isaac's real Slack, read through the claude.ai Slack
// connector (read tools only) with the real claude CLI. Read-only by construction: EVAOS_E2E=1
// turns the hand-off to Astra (the only way a reply reaches Slack) into a dry run, and the spec
// checks that. EVAOS_REVIEWS_SHOTS=<dir> keeps the screenshots there.
test.skip(process.env.EVAOS_LIVE !== '1', 'live Slack reads are opt-in (EVAOS_LIVE=1)')

/** Linear shares the queue; without its key the screenshots show a Linear error. */
function linearKey(): string {
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY
  const file = path.join(os.homedir(), 'Eva/secrets/linear.env')
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  return /LINEAR_API_KEY\s*=\s*["']?([^"'\s]+)/.exec(text)?.[1] ?? ''
}

test.use({
  launchEnv: {
    EVAOS_REVIEWS_GH: '1',
    LINEAR_API_KEY: linearKey(),
    EVAOS_CLAUDE_BIN: process.env.EVAOS_CLAUDE_BIN ?? path.join(os.homedir(), '.local/bin/claude'),
  },
})
test.setTimeout(600_000)

const sel = (id: string): string => `[data-testid="${id}"]`
const SHOTS = process.env.EVAOS_REVIEWS_SHOTS ?? path.join(__dirname, '../test-results/reviews')

async function shot(shell: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await shell.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

type Shell = { __evaosShell: { openPlace(page: string): void } }

test('reads Slack threads waiting on Isaac and hands a reply to Astra without posting', async ({
  app,
  shell,
}) => {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1800, 1000))
  await shell.waitForFunction(() => !!(window as unknown as Partial<Shell>).__evaosShell)
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('settings'))
  const dark = shell.locator(sel('appearance-dark'))
  if (await dark.isVisible().catch(() => false)) await dark.click()
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('reviews'))
  await shell.keyboard.press('Meta+Shift+B')
  const groups = shell.locator(sel('review-slack-groups'))
  await expect(groups).toBeVisible()
  await expect(shell.locator(sel('review-slack-reading'))).toBeVisible()
  await shot(shell, 'slack-queue-reading')
  const rows = shell.locator(sel('review-slack-row'))
  await expect(rows.first()).toBeVisible({ timeout: 300_000 })
  await expect(shell.locator(sel('review-slack-reading'))).toHaveCount(0)
  await shot(shell, 'slack-queue')

  // Prefer a thread (parent, replies divider) over a DM for the thread shots.
  const threadRow = shell.locator(`${sel('review-slack-row')}[data-thread]`).first()
  const target = (await threadRow.count()) > 0 ? threadRow : rows.first()
  await target.click()
  const thread = shell.locator(sel('slack-thread'))
  await expect(thread.locator(sel('slack-message')).first()).toBeVisible({ timeout: 240_000 })
  await expect(shell.locator(sel('slack-reading'))).toHaveCount(0, { timeout: 240_000 })
  await shell.waitForTimeout(500)
  await shot(shell, 'slack-thread')

  // Quote a specific message into the reply.
  const msg = thread.locator(sel('slack-message')).first()
  await msg.hover()
  await msg.getByRole('button', { name: 'Quote' }).click()
  const box = shell.locator(sel('slack-composer'))
  await expect(box).toHaveValue(/^> /)
  await box.click()
  await box.press('End')
  await box.pressSequentially('Thanks, I will read it today.')
  await shot(shell, 'slack-reply-quote')

  // A reply shows the exact text first, then goes to Astra to post (a dry run here).
  const text = (await box.inputValue()).trim()
  await box.press('Meta+Enter')
  await expect(shell.locator(sel('review-confirm-text'))).toHaveText(text)
  await shell.waitForTimeout(400)
  await shot(shell, 'slack-confirm')
  await shell.locator(sel('review-confirm-post')).click()
  await expect(
    shell
      .getByText(
        /Test instance, not sent: bun .*eva-thread\.ts --agent astra "Slack send request: channel=[CDG]\w+ thread_ts=/,
      )
      .last(),
  ).toBeVisible()
  await expect(shell.locator(sel('slack-pending-send')).last()).toBeVisible()
  await shot(shell, 'slack-sent-to-astra')

  // @Astra marks the box private; what an ask does is reviews-astra.live.spec.ts.
  await box.fill('@Astra what does Todd expect from me here?')
  await expect(box).toHaveAttribute('data-private', 'true')
  await shot(shell, 'slack-private-typing')
  await box.fill('')

  // Done hides it locally.
  const before = await rows.count()
  await shell.locator(sel('review-done')).click()
  await expect(rows).toHaveCount(before - 1)
  await shot(shell, 'slack-after-done')
})
