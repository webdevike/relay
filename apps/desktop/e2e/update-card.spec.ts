import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { pickScheme } from './helpers/appearance'

// A pending update shows a card above Settings that survives Later on the toast; a hidden
// sidebar falls back to the footer chip. The update is faked through main's `update` test hook.
type Hooks = { __evaosTest: { hooks: { update: { offer(u: object): void } } } }

const SUMMARY =
  'Faster chat list, a calmer sidebar, and the update card you are looking at right now, with a long tail'

async function offer(app: ElectronApplication): Promise<void> {
  await app.evaluate((_e, summary) => {
    ;(globalThis as unknown as Hooks).__evaosTest.hooks.update.offer({ summary, build: 'e2e-1' })
  }, SUMMARY)
}

const shot = async (shell: Page, name: string): Promise<void> => {
  const dir = process.env.UPDATE_CARD_SHOTS
  if (dir) await shell.locator('[data-testid=sidebar]').screenshot({ path: path.join(dir, name) })
}

test.use({ startOnChat: false, toolPanes: false })

test('update card sits above Settings, survives Later, and the chip covers a hidden sidebar', async ({
  app,
  shell,
}) => {
  await expect(shell.locator('[data-testid=update-card]')).toHaveCount(0)
  await offer(app)
  const card = shell.locator('[data-testid=update-card]')
  await expect(shell.locator('[data-testid=update-toast]')).toBeVisible()
  await expect(card).toBeVisible()
  await expect(card).toContainText('Update ready')
  // Directly above the Settings row.
  const cardBox = (await card.boundingBox())!
  const settingsBox = (await shell.locator('[data-testid=nav-setting]').boundingBox())!
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(settingsBox.y)
  expect(settingsBox.y - (cardBox.y + cardBox.height)).toBeLessThan(16)
  // One line, truncated.
  const summary = shell.locator('[data-testid=update-card-summary]')
  expect(await summary.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  await expect(card).toHaveCSS('border-top-width', '1px')
  await expect(card).toHaveCSS('border-top-left-radius', '8px')
  await expect(card).toHaveCSS('box-shadow', 'none')

  await pickScheme(shell, 'dark')
  await shot(shell, 'expanded-dark.png')
  await pickScheme(shell, 'light')
  await shot(shell, 'expanded-light.png')

  // Later hides the toast only.
  await shell.getByRole('button', { name: 'Later' }).click()
  await expect(shell.locator('[data-testid=update-toast]')).toHaveCount(0)
  await expect(card).toBeVisible()
  await expect(shell.locator('[data-testid=update-chip]')).toHaveCount(0)

  // Hidden sidebar: the footer chip offers the restart.
  await shell.keyboard.press('Meta+b')
  await expect(shell.locator('[data-testid=update-chip]')).toBeVisible()
  await shell.screenshot({ path: path.join(process.env.UPDATE_CARD_SHOTS ?? '/tmp', 'hidden.png') })
})
