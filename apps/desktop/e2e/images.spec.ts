import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { proofShot } from './helpers/proofShot'

// One tmp copy of the agent-p4 fixture per test; p4-images holds an inline PNG and a blob ref.
let fx: ChatFixture
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    await use(fx.launchEnv)
    fx.cleanup()
  },
})

const sel = (id: string): string => `[data-testid="${id}"]`

test('prompt images render as thumbnails and open in a viewer', async ({ app, shell }) => {
  await shell.locator(sel('nav-chat')).click()
  await shell.waitForSelector('[data-testid=chat-tree]')
  const row = shell.locator(sel('chat-row-p4-images'))
  if (!(await row.isVisible())) {
    for (const more of await shell.locator('[data-testid^="chat-show-more-"]').all()) {
      if (await more.isVisible()) await more.click()
    }
  }
  await row.click()

  const log = shell.locator(sel('chat-log'))
  await expect(log).toContainText('Look at these two images')
  const first = log.locator('img[alt="Image 1 of 2"]')
  const second = log.locator('img[alt="Image 2 of 2"]')
  await expect(first).toBeVisible()
  await expect(second).toBeVisible()
  for (const img of [first, second]) {
    await expect
      .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0)
    const box = await img.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeLessThanOrEqual(240)
    expect(box!.height).toBeLessThanOrEqual(240)
  }
  await proofShot(app, shell, 'images-inline', { phase: 'phase-4' })

  // Focus inside the page only (no window focus), then open with Enter.
  await first.evaluate((el) => (el.closest('button') as HTMLButtonElement).focus())
  await shell.keyboard.press('Enter')
  const dialog = shell.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('img[alt="Image 1 of 2"]')).toBeVisible()
  await shell.keyboard.press('ArrowRight')
  await expect(dialog.locator('img[alt="Image 2 of 2"]')).toBeVisible()
  await proofShot(app, shell, 'images-viewer', { phase: 'phase-4' })
  await shell.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(first).toBeVisible()
})
