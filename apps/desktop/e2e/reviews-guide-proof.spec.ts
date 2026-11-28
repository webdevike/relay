import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { pickScheme } from './helpers/appearance'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { REPO_ROOT } from './helpers/paths'

// Reviews in remote mode against a fake Relay Host answering `reviews.req` from fixtures (a
// synthetic PR with a deleted, a renamed and a new file, images in its body and a comment, and a v2
// Guide of four sections with callouts): no GitHub, Linear or Claude. Shots of the Guide, the
// conversation and the Files tab go to proof/guide-v2/<PROOF_PHASE>/ (before|after, default after);
// PROOF_DIR overrides the root. Assertions that only hold for Guide v2 run only in the after phase.

const PHASE = process.env['PROOF_PHASE'] === 'before' ? 'before' : 'after'
const OUT = path.join(process.env['PROOF_DIR'] ?? path.join(REPO_ROOT, 'proof/guide-v2'), PHASE)
const FIXTURES = path.join(__dirname, 'fixtures/reviews')
const NOW = '2026-11-27T18:00:00Z'
const SIZE = { width: 1440, height: 900 }

let host: FakeRelayHost
let root: string

const test = base.extend({
  launchEnv: async ({ configDir }, use) => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-guide-proof-')))
    const relayDir = path.join(root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    host.serveReviews(FIXTURES)
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
    await use({ EVAOS_NOW: NOW })
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
  },
})
test.use({ startOnChat: false, toolPanes: false })

const sel = (id: string): string => `[data-testid="${id}"]`
type Shell = { __evaosShell: { openPlace(page: string): void } }

async function shot(shell: Page, name: string): Promise<void> {
  // Lazy images and the highlighter settle before the shot.
  await shell.waitForTimeout(600)
  fs.mkdirSync(OUT, { recursive: true })
  await shell.screenshot({ path: path.join(OUT, `${name}.png`) })
}

test('the Reviews PR page: Guide, conversation images and Files over reviews.req', async ({
  app,
  shell,
}) => {
  test.setTimeout(120_000)
  await app.evaluate(
    ({ BaseWindow }, size) => BaseWindow.getAllWindows()[0]!.setSize(size.width, size.height),
    SIZE,
  )
  await shell.clock.setFixedTime(new Date(NOW))
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('settings'))
  await pickScheme(shell, 'light')
  await shell.locator(sel('nav-reviews')).click()
  // The queue opens on Created; the fixture PR asks for this reviewer's review.
  const queue = shell.locator(sel('review-queue'))
  await queue.getByText('For me', { exact: true }).click()
  const row = queue.locator(sel('review-row-42'))
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()

  // Conversation: the body's <img width="320">, its markdown image and the comment's image.
  const conv = shell.locator(sel('review-conversation'))
  await expect(conv).toBeVisible({ timeout: 30_000 })
  await expect(conv).toContainText('Looks right')
  const images = conv.locator('img')
  await expect(images.first()).toBeVisible()
  await expect
    .poll(() =>
      images.evaluateAll((all) =>
        all.every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth),
      ),
    )
    .toBe(true)
  // A kept width caps the image at that many px (min(Npx, 100%)), never upscaling it.
  const sized = (alt: string) =>
    conv.locator(`img[alt="${alt}"]`).evaluate((i) => ({
      maxWidth: getComputedStyle(i).maxWidth,
      width: i.getBoundingClientRect().width,
    }))
  if (PHASE === 'after') {
    await expect(images).toHaveCount(3)
    const banner = await sized('Locked banner')
    expect(banner.maxWidth).toContain('320px')
    expect(banner.width).toBeCloseTo(320, 0)
    const comment = await sized('Locked item')
    expect(comment.maxWidth).toContain('480px')
    expect(comment.width).toBeCloseTo(480, 0)
  }
  await shot(shell, 'conversation')
  await conv.locator('img').last().scrollIntoViewIfNeeded()
  await shot(shell, 'conversation-comment')

  // Guide: four sections; v2 shows the overview and the selected hunks with callouts.
  await shell.locator(sel('review-tab-guide')).click()
  const guide = shell.locator(sel('review-guide'))
  await expect(guide).toHaveAttribute('data-source', 'model', { timeout: 30_000 })
  await expect(guide.locator(sel('review-guide-section'))).toHaveCount(4)
  if (PHASE === 'after') {
    await expect(guide).toHaveAttribute('data-version', '2')
    await expect(guide.locator(sel('review-guide-overview'))).toBeVisible()
    await expect(guide.locator(sel('review-diff-annotation')).first()).toBeVisible()
    await expect(guide).toContainText('Minutes, not milliseconds')
  }
  await shot(shell, 'guide')
  // The cleanup section (the deleted file's hunk), then the last one and what follows it.
  const sections = guide.locator(sel('review-guide-section'))
  await sections.nth(2).evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await shot(shell, 'guide-cleanup')
  await sections.nth(3).evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await shot(shell, 'guide-end')

  // Files: every changed file, the deleted one included, as a diff.
  await shell.locator(sel('review-tab-files')).click()
  const files = shell.locator(sel('review-files'))
  await expect(files).toBeVisible()
  await expect(files).toContainText('src/old.ts')
  await expect(shell.locator(sel('review-diff')).first()).toBeVisible()
  await shot(shell, 'diff')

  expect(host.reviewOps.map((o) => o.kind)).toEqual(
    expect.arrayContaining(['queue', 'pr', 'guide']),
  )
})
