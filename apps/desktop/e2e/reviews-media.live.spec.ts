import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { pickScheme } from './helpers/appearance'

// Opt-in live spec: images in Reviews from all three sources, against real items. GitHub's
// attachments (`<img>` tags to github.com/user-attachments, need gh auth) on
// eCardSystems/react-client-reports-app#246, Linear's uploads and profile-link mentions on
// ENG-5974, and Slack's files (fetched through the Slack desktop app's debugging port) on a #ui-ux
// thread. Read-only: nothing is posted anywhere. EVAOS_REVIEWS_SHOTS=<dir> keeps the screenshots.
test.skip(process.env.EVAOS_LIVE !== '1', 'live reads are opt-in (EVAOS_LIVE=1)')

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

/** Every image under `root` decoded (not broken), and at least `min` of them. */
async function imagesLoaded(root: Locator, min: number): Promise<void> {
  await expect
    .poll(
      () =>
        root
          .locator('img')
          .evaluateAll((imgs) =>
            imgs.map(
              (i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0,
            ),
          ),
      { timeout: 60_000 },
    )
    .toEqual(expect.arrayContaining(Array(min).fill(true)))
  const broken = await root
    .locator('img')
    .evaluateAll((imgs) =>
      imgs
        .filter((i) => (i as HTMLImageElement).naturalWidth === 0)
        .map((i) => (i as HTMLImageElement).src),
    )
  expect(broken).toEqual([])
}

type Shell = { __evaosShell: { openPlace(page: string): void } }
type Eva = { eva: { invoke(c: string, i: unknown): Promise<{ ok: boolean; value: unknown }> } }

test('Reviews shows GitHub, Linear and Slack images inline and Linear mentions by name', async ({
  app,
  shell,
}) => {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1800, 1000))
  await shell.waitForFunction(() => !!(window as unknown as Partial<Shell>).__evaosShell)
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('settings'))
  await pickScheme(shell, 'dark')
  await shell.locator(sel('nav-reviews')).click()
  await expect(shell.locator(sel('review-queue'))).toBeVisible()
  await shell.keyboard.press('Meta+Shift+B')

  // Linear: ENG-5974's uploads, served from the config dir (whose path has spaces in live use).
  await shell.locator(sel('review-search')).fill('ENG-5974')
  await shell.locator(sel('review-search')).press('Enter')
  const details = shell.locator(sel('linear-details'))
  await expect(details).toBeVisible({ timeout: 60_000 })
  await expect(details).not.toContainText('![')
  await imagesLoaded(details, 1)
  await shell.waitForTimeout(500)
  await shot(shell, 'media-linear-details')
  await shell.locator(sel('linear-tab-comments')).click()
  const comments = shell.locator(sel('linear-comments'))
  await expect(comments).not.toContainText('/profiles/')
  await expect(comments).not.toContainText('![')
  await imagesLoaded(comments, 0)
  await shell.waitForTimeout(500)
  await shot(shell, 'media-linear-comments')

  // GitHub: #246's `<img>` attachments, fetched signed in.
  await shell.locator(sel('review-queue')).getByText('Created', { exact: true }).click()
  await shell.locator(sel('review-row-246')).click()
  const conversation = shell.locator(sel('review-conversation'))
  await expect(conversation).toBeVisible({ timeout: 60_000 })
  await imagesLoaded(conversation, 2)
  await shell.waitForTimeout(500)
  await shot(shell, 'media-github-pr246')

  // Slack: a #ui-ux thread with four PNGs, read through the connector, files through Slack's app.
  const thread = (await shell.evaluate(() =>
    (window as unknown as Eva).eva.invoke('reviews.slackThread', {
      channel: 'C0CB9NMQDHB',
      threadTs: '1793223274.330049',
      refresh: true,
    }),
  )) as {
    ok: boolean
    value: { messages: Array<{ files: Array<{ name: string; image: string | null }> }> }
  }
  expect(thread.ok).toBe(true)
  const files = thread.value.messages.flatMap((m) => m.files)
  const pngs = files.filter((f) => f.name.endsWith('.png'))
  expect(pngs.length).toBeGreaterThan(0)
  expect(pngs.every((f) => f.image?.startsWith('/reviews/media/'))).toBe(true)
  const sizes = await shell.evaluate(
    (srcs) =>
      Promise.all(
        srcs.map(
          (src) =>
            new Promise<number>((resolve) => {
              const img = new Image()
              img.onload = () => resolve(img.naturalWidth)
              img.onerror = () => resolve(0)
              img.src = `relay-media://media/?src=${encodeURIComponent(src)}`
            }),
        ),
      ),
    pngs.map((f) => f.image!),
  )
  expect(sizes.every((w) => w > 0)).toBe(true)
})
