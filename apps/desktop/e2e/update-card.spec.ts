import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { pickScheme } from './helpers/appearance'

// A pending update shows a small badge above Settings whose hover card carries the details and
// Restart; it survives Later on the toast, and a hidden sidebar falls back to the footer chip.
// The update is faked through main's `update` test hook.
type Hooks = { __evaosTest: { hooks: { update: { offer(u: object): void } } } }

async function offer(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    ;(globalThis as unknown as Hooks).__evaosTest.hooks.update.offer({
      summary: 'Faster chat list and a calmer sidebar',
      build: 'e2e1234abcd',
    })
  })
}

const shotDir = process.env.UPDATE_CARD_SHOTS
const shot = async (shell: Page, name: string): Promise<void> => {
  if (!shotDir) return
  await shell.waitForTimeout(400) // the dropdown fades in
  await shell.screenshot({
    path: path.join(shotDir, name),
    clip: { x: 0, y: 480, width: 340, height: 320 },
  })
}

test.use({ startOnChat: false, toolPanes: false })

test(
  'update badge sits above Settings, opens details on hover, survives Later; chip covers a hidden sidebar',
  { tag: '@smoke' },
  async ({ app, shell }) => {
    await expect(shell.locator('[data-testid=update-badge]')).toHaveCount(0)
    await offer(app)
    const badge = shell.locator('[data-testid=update-badge]')
    await expect(shell.locator('[data-testid=update-toast]')).toBeVisible()
    await expect(badge).toBeVisible()
    await expect(badge).toContainText('Update')

    // Small, and directly above the Settings row.
    const b = (await badge.boundingBox())!
    const s = (await shell.locator('[data-testid=nav-setting]').boundingBox())!
    expect(b.height).toBeLessThan(28)
    expect(b.y + b.height).toBeLessThanOrEqual(s.y)
    expect(s.y - (b.y + b.height)).toBeLessThan(16)

    // Hover opens the details: build and Restart (no history here, so the summary line).
    await badge.hover()
    const pop = shell.locator('[data-testid=update-popover]')
    await expect(pop).toBeVisible()
    await expect(pop.locator('[data-testid=update-popover-build]')).toHaveText('Build e2e1234')
    await expect(pop.locator('[data-testid=update-popover-summary]')).toHaveText(
      'Faster chat list and a calmer sidebar',
    )
    await expect(pop.locator('[data-testid=update-popover-restart]')).toBeVisible()

    // Dark and light, badge alone and with the popover open.
    for (const scheme of ['dark', 'light'] as const) {
      await pickScheme(shell, scheme)
      await shell.locator('[data-testid=update-popover]').waitFor()
      await shot(shell, `popover-${scheme}.png`)
    }
    await shell.mouse.move(600, 300)
    await expect(pop).toHaveCount(0)
    for (const scheme of ['dark', 'light'] as const) {
      await pickScheme(shell, scheme)
      await shot(shell, `badge-${scheme}.png`)
    }

    // Later hides the toast only.
    await shell.getByRole('button', { name: 'Later' }).click()
    await expect(shell.locator('[data-testid=update-toast]')).toHaveCount(0)
    await expect(badge).toBeVisible()
    await expect(shell.locator('[data-testid=update-chip]')).toHaveCount(0)

    // Hidden sidebar: the footer chip offers the restart.
    await shell.keyboard.press('Meta+b')
    await expect(shell.locator('[data-testid=update-chip]')).toBeVisible()
  },
)
