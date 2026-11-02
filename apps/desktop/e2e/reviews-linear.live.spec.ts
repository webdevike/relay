import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

// Opt-in live spec: Linear tickets in Reviews against Isaac's real Linear (his key from
// LINEAR_API_KEY or ~/Eva/secrets/linear.env) on ENG-6406. Read-only by construction: EVAOS_E2E=1
// turns posting to Linear into a dry run, and the spec checks that.
// EVAOS_REVIEWS_SHOTS=<dir> keeps the screenshots there.
test.skip(process.env.EVAOS_LIVE !== '1', 'live Linear reads are opt-in (EVAOS_LIVE=1)')

function linearKey(): string {
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY
  const text = fs.readFileSync(path.join(os.homedir(), 'Eva/secrets/linear.env'), 'utf8')
  return /LINEAR_API_KEY\s*=\s*["']?([^"'\s]+)/.exec(text)?.[1] ?? ''
}

test.use({ launchEnv: { EVAOS_REVIEWS_GH: '1', LINEAR_API_KEY: linearKey() } })
test.setTimeout(180_000)

const TICKET = process.env.EVAOS_REVIEWS_TICKET ?? 'ENG-6406'
const sel = (id: string): string => `[data-testid="${id}"]`
const SHOTS = process.env.EVAOS_REVIEWS_SHOTS ?? path.join(__dirname, '../test-results/reviews')

async function shot(shell: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await shell.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

type Shell = { __evaosShell: { openPlace(page: string): void } }

test('reads, replies to and finishes a real Linear ticket without writing anywhere', async ({
  app,
  shell,
}) => {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1800, 1000))
  await shell.waitForFunction(() => !!(window as unknown as Partial<Shell>).__evaosShell)
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('settings'))
  const dark = shell.locator(sel('appearance-dark'))
  if (await dark.isVisible().catch(() => false)) await dark.click()
  await shell.locator(sel('nav-reviews')).click()
  const group = shell.locator(sel('review-linear-group'))
  await expect(group).toBeVisible()
  await expect(group).not.toContainText('Loading', { timeout: 30_000 })
  await expect(group).not.toContainText("Couldn't read Linear")
  await shell.keyboard.press('Meta+Shift+B')
  await shot(shell, 'linear-queue')

  // Details: description with images inline, properties in the rail.
  await shell.locator(sel('review-search')).fill(TICKET)
  await shell.locator(sel('review-search')).press('Enter')
  await expect(shell.locator(sel('linear-details'))).toBeVisible({ timeout: 30_000 })
  await expect(shell.locator(sel('linear-rail'))).toContainText('Status')
  await expect(shell.locator(sel('linear-rail'))).toContainText('Linked PRs')
  await shell.waitForTimeout(800)
  await shot(shell, 'linear-details')

  // Comments: threads with replies.
  await shell.locator(sel('linear-tab-comments')).click()
  const threads = shell.locator(sel('linear-thread'))
  await expect(threads.first()).toBeVisible()
  await shell.waitForTimeout(500)
  await shot(shell, 'linear-comments')

  // Reply under a specific comment, quoting a selection from it.
  const thread = threads.first()
  const firstComment = thread.locator(sel('linear-comment')).first()
  await firstComment.hover()
  await firstComment.getByRole('button', { name: 'Reply' }).click()
  const replyBox = shell.locator(sel('linear-reply-box'))
  await expect(replyBox).toBeVisible()
  await firstComment.locator('.eva-rv-lcomment-body').evaluate((el) => {
    const text = el.querySelector('p') ?? el
    const range = document.createRange()
    range.selectNodeContents(text)
    const s = window.getSelection()!
    s.removeAllRanges()
    s.addRange(range)
  })
  await firstComment.hover()
  await firstComment.getByRole('button', { name: 'Quote' }).click()
  await expect(replyBox).toHaveValue(/^> /)
  await replyBox.click()
  await replyBox.press('End')
  await replyBox.pressSequentially('Retested on stage, looks right now.')
  await replyBox.scrollIntoViewIfNeeded()
  await shot(shell, 'linear-reply-quote')

  // Anything for Linear shows the exact text first; posting is a dry run in tests.
  const replyText = await replyBox.inputValue()
  await replyBox.press('Meta+Enter')
  await expect(shell.locator(sel('review-confirm-text'))).toHaveText(replyText.trim())
  await expect(shell.getByText('Post this reply on Linear?')).toBeVisible()
  await shell.waitForTimeout(400)
  await shot(shell, 'linear-confirm')
  await shell.locator(sel('review-confirm-post')).click()
  await expect(shell.getByText('Test instance: the comment was not posted to Linear')).toBeVisible()

  // @ lists Astra and the people on the ticket; @Astra goes privately to Astra, never to Linear.
  const box = shell.locator(sel('linear-composer'))
  await box.click()
  // Picking a person shows @Name; Linear gets their profile link, the mention it understands.
  await box.pressSequentially('@ste')
  await box.press('Enter')
  await expect(box).toHaveValue('@Steve Arms ')
  await box.pressSequentially('can you retest?')
  await box.press('Meta+Enter')
  await expect(shell.locator(sel('review-confirm-text'))).toHaveText(
    /^https:\/\/linear\.app\/[^/]+\/profiles\/[\w.-]+ can you retest\?$/,
  )
  await shell.waitForTimeout(400)
  await shot(shell, 'linear-mention-confirm')
  await shell.getByRole('button', { name: 'Cancel' }).last().click()
  await box.fill('')
  await box.click()
  await box.pressSequentially('@')
  await expect(shell.locator(sel('review-mention-list'))).toBeVisible()
  await shot(shell, 'linear-mention')
  await box.press('Enter')
  // Astra is first in the list; what an @Astra ask does is reviews-astra.live.spec.ts.
  await expect(box).toHaveValue('@Astra ')
  await expect(shell.locator(sel('linear-composer'))).toHaveAttribute('data-private', 'true')
  await shot(shell, 'linear-private-typing')
  await box.fill('')

  // Done hides it locally.
  await shell.locator(sel('review-done')).click()
  await expect(shell.locator(sel('linear-detail'))).toHaveCount(0)
  await expect(shell.locator(sel(`review-ticket-${TICKET}`))).toHaveCount(0)
  await shot(shell, 'linear-after-done')
})
