import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { FakeRelayHost } from './helpers/fake-relay-host'

// The PR Diff tab against a fake Relay Host (`reviews.req` from fixtures/reviews-diff, with
// `reviews.actions`): the file tree (compacted folders, click and keyboard jump, resize saved,
// whole-rail hide), long lines wrapping with no sideways scroll in split, unified and a narrow
// window, and a review thread on its line whose reply goes through one confirmed `prCommit`.
// No GitHub, Linear or Claude.

const FIXTURES = path.join(__dirname, 'fixtures/reviews-diff')
const NOW = '2026-11-27T18:00:00Z'
const PLACE = 'review:pr:acme/notes-api#77'
const LONG = 'src/very/deep/nested/longline.ts'
const ITEMS = 'src/api/routes/items.ts'

let host: FakeRelayHost
let root: string

const test = base.extend({
  launchEnv: async ({ configDir }, use) => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-pr-diff-')))
    const relayDir = path.join(root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    host.features.push('reviews.actions')
    host.serveReviews(FIXTURES)
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

const uiPrefs = (dir: string): Record<string, unknown> => {
  try {
    const layout = JSON.parse(fs.readFileSync(path.join(dir, 'layout.json'), 'utf8')) as {
      ui?: Record<string, unknown>
    }
    return layout.ui ?? {}
  } catch {
    return {}
  }
}

async function openDiff(shell: Page): Promise<Locator> {
  await shell.evaluate((p) => (window as unknown as Shell).__evaosShell.openPlace(p), PLACE)
  const tab = shell.locator(`${sel('review-tab-diff')}, ${sel('review-tab-files')}`).first()
  await expect(tab).toBeVisible({ timeout: 30_000 })
  await tab.click()
  const files = shell.locator(sel('review-files'))
  await expect(files.locator(`[data-file="${ITEMS}"]`)).toBeVisible({ timeout: 30_000 })
  return files
}

const row = (files: Locator, p: string): Locator => files.locator(`[data-path="${p}"]`)

/** The card's top against the diff list's top (0: scrolled to it). */
const offsetOf = (files: Locator, p: string): Promise<number> =>
  files.locator('.eva-rv-filediffs').evaluate((list, file) => {
    const card = list.querySelector(`[data-file="${CSS.escape(file)}"]`)!
    return card.getBoundingClientRect().top - list.getBoundingClientRect().top
  }, p)

/** Every line row of the long-line file, and the list itself, as [scrollWidth, clientWidth]. */
const widths = (files: Locator): Promise<Array<[number, number]>> =>
  files.locator('.eva-rv-filediffs').evaluate((list, file) => {
    const card = list.querySelector(`[data-file="${CSS.escape(file)}"]`)!
    const els = [
      list,
      ...card.querySelectorAll('[data-testid="review-diff-line"]'),
      ...card.querySelectorAll('.eva-rv-code'),
    ]
    return els.map((e) => [e.scrollWidth, e.clientWidth] as [number, number])
  }, LONG)

async function expectNoSideScroll(files: Locator, mode: 'split' | 'unified'): Promise<void> {
  await files
    .locator(sel('review-diff-mode'))
    .getByText(mode === 'split' ? 'Split' : 'Unified')
    .click()
  const card = files.locator(`[data-file="${LONG}"]`)
  await expect(card.locator(`table[data-mode="${mode}"]`)).toBeVisible()
  const all = await widths(files)
  expect(all.length).toBeGreaterThan(4)
  for (const [scroll, client] of all) expect(scroll).toBeLessThanOrEqual(client)
  // The long line wraps: its row is several lines tall.
  const tall = await card
    .locator(sel('review-diff-line'))
    .nth(1)
    .evaluate((r) => r.getBoundingClientRect().height)
  expect(tall).toBeGreaterThan(40)
}

test('PR Diff: file tree, resize, rail hide, wrapped lines and an inline review reply', async ({
  app,
  shell,
  configDir,
}) => {
  test.setTimeout(150_000)
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1440, 900))
  await shell.clock.setFixedTime(new Date(NOW))
  let files = await openDiff(shell)

  // Tree: single-child folders compacted, folders first, +/- per row.
  const tree = files.locator(sel('review-file-tree'))
  await expect(tree).toBeVisible()
  await expect(row(files, 'src/very/deep/nested')).toContainText('very/deep/nested')
  await expect(row(files, 'src/api/routes')).toContainText('api/routes')
  await expect(row(files, ITEMS)).toContainText('+4')

  // Click jumps the diff list to the file.
  await row(files, 'src/gen/part06.ts').click()
  await expect.poll(() => offsetOf(files, 'src/gen/part06.ts')).toBeLessThan(8)
  await expect(row(files, 'src/gen/part06.ts')).toHaveAttribute('data-active', 'true')

  // Keyboard: arrows move between rows, Enter opens the focused file.
  await row(files, 'src/gen/part01.ts').click()
  await expect.poll(() => offsetOf(files, 'src/gen/part01.ts')).toBeLessThan(8)
  await shell.keyboard.press('ArrowDown')
  await expect(files.locator('[role=treeitem][data-value="src/gen/part02.ts"]')).toBeFocused()
  await shell.keyboard.press('Enter')
  await expect.poll(() => offsetOf(files, 'src/gen/part02.ts')).toBeLessThan(8)
  // Left on a file goes to its folder; Left again folds it.
  await shell.keyboard.press('ArrowLeft')
  await expect(files.locator('[role=treeitem][data-value="src/gen"]')).toBeFocused()
  await shell.keyboard.press('ArrowLeft')
  await expect(row(files, 'src/gen/part02.ts')).toBeHidden()
  await shell.keyboard.press('ArrowRight')
  await expect(row(files, 'src/gen/part02.ts')).toBeVisible()

  // Resize: keys step 16 px, a drag follows the pointer, bounded 200-480, saved.
  const rail = files.locator(sel('review-file-tree'))
  const edge = files.locator(sel('review-rail-resize'))
  const width = () => rail.evaluate((e) => e.getBoundingClientRect().width)
  expect(await width()).toBeCloseTo(260, 0)
  await edge.focus()
  await shell.keyboard.press('ArrowRight')
  await shell.keyboard.press('ArrowRight')
  expect(await width()).toBeCloseTo(292, 0)
  const b = (await edge.boundingBox())!
  await shell.mouse.move(b.x + b.width / 2, b.y + 200)
  await shell.mouse.down()
  await shell.mouse.move(b.x + b.width / 2 + 60, b.y + 200, { steps: 5 })
  await shell.mouse.up()
  expect(await width()).toBeCloseTo(352, 0)
  await shell.mouse.move(b.x + 400, b.y + 200)
  await edge.focus()
  await shell.keyboard.press('End')
  expect(await width()).toBeCloseTo(480, 0)
  await shell.keyboard.press('Home')
  expect(await width()).toBeCloseTo(200, 0)
  for (let i = 0; i < 6; i++) await shell.keyboard.press('ArrowRight')
  expect(await width()).toBeCloseTo(296, 0)
  await expect.poll(() => uiPrefs(configDir)['reviews.fileRail.width']).toBe(296)

  // Hide the whole rail and bring it back; the choice is saved.
  await files.locator(sel('review-rail-toggle')).click()
  await expect(tree).toBeHidden()
  await expect.poll(() => uiPrefs(configDir)['reviews.fileRail.open']).toBe(false)
  await files.locator(sel('review-rail-toggle')).click()
  await expect(tree).toBeVisible()
  await expect.poll(() => uiPrefs(configDir)['reviews.fileRail.open']).toBe(true)

  // After a reload the saved width holds.
  await shell.reload()
  files = await openDiff(shell)
  await expect
    .poll(() =>
      files.locator(sel('review-file-tree')).evaluate((e) => e.getBoundingClientRect().width),
    )
    .toBeCloseTo(296, 0)

  // Long lines wrap: no row, cell or the list scrolls sideways in split, unified or narrow.
  await expectNoSideScroll(files, 'split')
  await files.locator(`[data-file="${LONG}"]`).scrollIntoViewIfNeeded()
  await shell.screenshot({ path: test.info().outputPath('long-line-split.png') })
  await expectNoSideScroll(files, 'unified')
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(760, 900))
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(760)
  await expectNoSideScroll(files, 'split')
  await expectNoSideScroll(files, 'unified')
  await files.locator(`[data-file="${LONG}"]`).scrollIntoViewIfNeeded()
  await shell.screenshot({ path: test.info().outputPath('long-line-narrow.png') })
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1440, 900))
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(1440)

  // The review thread sits under the line it is on, with its image; the outdated one is marked.
  const card = files.locator(`[data-file="${ITEMS}"]`)
  await card.scrollIntoViewIfNeeded()
  const thread = card.locator('[data-testid="review-inline-thread"][data-thread="501"]')
  await expect(thread).toBeVisible()
  await expect(thread).toContainText('Why 423 and not 409 here?')
  await expect(thread).toContainText('423 Locked says what happened.')
  const lineAbove = await thread.evaluate(
    (t) => t.closest('tr')?.previousElementSibling?.getAttribute('data-new') ?? null,
  )
  expect(lineAbove).toBe('3')
  await expect
    .poll(() =>
      thread
        .locator('img')
        .evaluate((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0)
  const outdated = card.locator('[data-testid="review-inline-thread"][data-thread="503"]')
  await expect(outdated.locator(sel('review-inline-outdated'))).toHaveText('Outdated')
  await thread.scrollIntoViewIfNeeded()
  await shell.screenshot({ path: test.info().outputPath('inline-thread.png') })

  // Reply: the confirm shows the exact text; one prPrepare and one prCommit reach the host.
  const text = 'Agreed, 423 it is.'
  await thread.locator(sel('review-inline-reply')).click()
  await thread.locator(sel('review-inline-composer')).fill(text)
  await thread.locator(sel('review-inline-composer-send')).click()
  await expect(shell.locator(sel('review-confirm-text'))).toHaveText(text)
  await shell.locator(sel('review-confirm-post')).click()
  await expect(thread).toContainText(text)
  const writes = host.prMutations.map((m) => m.cmd)
  expect(writes.map((w) => w.kind)).toEqual(['prPrepare', 'prCommit'])
  const commits = writes.filter((w) => w.kind === 'prCommit')
  expect(commits).toHaveLength(1)
  expect(commits[0]!.mutation).toEqual({
    kind: 'reviewReply',
    repo: 'acme/notes-api',
    number: 77,
    commentId: 501,
    body: text,
  })
  expect(commits[0]!.approvalId).toBe('pr-approval-1')
})
