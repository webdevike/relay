import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { proofShot } from './helpers/proofShot'

// One session over the Phase 4 slices: question status, answering, an image, settings applying
// live, and a new chat. Fixture sessions and the fake omp only.
const LOG = path.join(os.tmpdir(), `evaos-fake-omp-p4tour-${process.pid}.log`)
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PHASE = { phase: 'phase-4' }

type Ev = { event: string; detail: Record<string, unknown> | null }
const readLog = (): Ev[] =>
  fs.existsSync(LOG)
    ? fs
        .readFileSync(LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Ev)
    : []

let fx: ChatFixture
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    fs.rmSync(LOG, { force: true })
    await use({ ...fx.launchEnv, FAKE_OMP_DELAY_MS: '10', FAKE_OMP_LOG: LOG })
    fx.cleanup()
    fs.rmSync(LOG, { force: true })
  },
})
test.use({ startOnChat: false })

const sel = (id: string): string => `[data-testid="${id}"]`
const jsonl = (): string[] => fs.readdirSync(fx.sessionsDir).filter((n) => n.endsWith('.jsonl'))

async function openRow(shell: Page, id: string): Promise<void> {
  const row = shell.locator(sel(`chat-row-${id}`))
  if (!(await row.isVisible())) {
    for (const more of await shell.locator('[data-testid^="chat-show-more-"]').all()) {
      if (await more.isVisible()) await more.click()
    }
  }
  // A done chat whose tab closed (left for another workspace) sits in the Settled fold.
  if (!(await row.isVisible())) {
    const settled = shell.locator(sel('chat-settled-toggle'))
    if (await settled.isVisible()) await settled.click()
  }
  await row.click()
}
async function send(shell: Page, text: string): Promise<void> {
  const box = shell.locator(sel('composer-input'))
  await box.fill(text)
  await box.press('Enter')
}

test('one session: question, image, live settings and a new chat', async ({ app, shell }) => {
  const errors: string[] = []
  shell.on('pageerror', (e) => errors.push(e.message))

  await shell.locator(sel('nav-chat')).click()
  await shell.waitForSelector('[data-testid=chat-tree]')
  await openRow(shell, 'p4-ecard')
  await expect(shell.locator(sel('chat-log'))).toContainText('Hello from p4-ecard')

  // A pending question shows in the list, then answering clears it.
  const ecard = shell.locator(sel('chat-row-p4-ecard'))
  await send(shell, '[ask] tour')
  const asked = ecard.locator('.eva-cl-pill[data-status="asked"]')
  await expect(asked).toHaveCount(1, { timeout: 500 })
  await expect(asked).toContainText('Input')
  await expect(shell.locator(sel('pending-dialog'))).toBeVisible()
  await shell.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await proofShot(app, shell, 'tour-chat-question', PHASE)
  await shell.keyboard.press('1')
  await expect(shell.locator(sel('chat-log'))).toContainText('Answer received')
  await expect(shell.locator(sel('pending-dialog'))).toHaveCount(0)
  await expect(asked).toHaveCount(0)
  // Idle and shown, so read: no status pill, just its age.
  await expect(ecard.locator('.eva-cl-pill')).toHaveCount(0, { timeout: 15_000 })
  await expect(ecard.locator('.eva-cl-age')).toHaveCount(1)

  // An image goes out and comes back as a thumbnail with the viewer.
  await shell.evaluate((b64) => {
    const dt = new DataTransfer()
    dt.items.add(
      new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'a.png', {
        type: 'image/png',
      }),
    )
    document
      .querySelector('[data-testid=composer-input]')!
      .dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      )
  }, PNG_B64)
  await expect(shell.locator('[data-testid=composer-chip]')).toHaveCount(1)
  await send(shell, 'tour image')
  const log = shell.locator(sel('chat-log'))
  const thumb = log.locator('img[alt="Image 1 of 1"]')
  await expect(thumb).toBeVisible()
  await expect
    .poll(() => readLog().find((e) => e.event === 'prompt-images')?.detail ?? null)
    .toEqual({ count: 1, mimeTypes: ['image/png'] })
  await proofShot(app, shell, 'tour-chat-image', PHASE)
  await thumb.evaluate((el) => (el.closest('button') as HTMLButtonElement).focus())
  await shell.keyboard.press('Enter')
  const dialog = shell.getByRole('dialog')
  await expect(dialog.locator('img[alt="Image 1 of 1"]')).toBeVisible()
  await shell.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // Settings > Chat applies live: tool runs start folded; tool details on shows each call.
  await openRow(shell, 'p4-jobs')
  await expect(log.locator('[data-testid=tool-group]').first()).toContainText('bash · sleep 5')
  await expect(log.locator('[data-testid$="-tool0"]')).toHaveCount(0)
  type Hooks = {
    openPlace(p: string, n?: boolean, e?: { settingsSection: string }): void
  }
  await shell.evaluate(() =>
    (window as unknown as { __evaosShell: Hooks }).__evaosShell.openPlace('settings', true, {
      settingsSection: 'Chat',
    }),
  )
  await shell.waitForSelector(sel('settings-chat'))
  await shell.getByText('Show tool details', { exact: true }).click()
  await expect(shell.locator(sel('settings-show-tools'))).toBeChecked()
  // Settings is its own workspace; leaving the chat closed its tab. Back on the chat.
  const out = shell.locator(sel('sidebar-back'))
  if (await out.isVisible()) await out.click()
  if (!(await shell.locator(sel('chat-tree')).isVisible()))
    await shell.locator(sel('nav-chat')).click()
  await openRow(shell, 'p4-jobs')
  await expect(log.locator('[data-testid$="-tool0"]').first()).toBeVisible()
  await expect(log.locator('[data-testid=tool-group]')).toHaveCount(0)

  // A new chat appears in the list.
  await shell.locator(sel('chat-new')).click()
  await expect(shell.locator(sel('chat-header'))).toContainText('New chat')
  const before = jsonl()
  await send(shell, 'tour new')
  await expect.poll(() => jsonl().filter((n) => !before.includes(n)).length).toBe(1)
  const created = jsonl().find((n) => !before.includes(n))!
  const id = /_(.+)\.jsonl$/.exec(created)![1]!
  await expect(shell.locator(sel(`chat-row-${id}`))).toBeVisible({ timeout: 2000 })
  await expect(log).toContainText('Foxes are primarily nocturnal hunters')
  await proofShot(app, shell, 'tour-chat-new', PHASE)

  await app.evaluate(() =>
    (
      globalThis as unknown as {
        __evaosTest: { win: { setContentSize(w: number, h: number): void } }
      }
    ).__evaosTest.win.setContentSize(800, 720),
  )
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(800)
  await expect(log).toBeVisible()
  await proofShot(app, shell, 'tour-chat-compact', PHASE)
  expect(errors).toEqual([])
})
