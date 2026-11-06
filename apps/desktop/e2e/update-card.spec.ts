import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { pickScheme } from './helpers/appearance'

// A pending update turns the footer's refresh icon into a download icon: hover shows the details,
// one click restarts; it survives Later on the toast, and a hidden sidebar falls back to the footer chip.
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
  'update icon sits in the Settings row, opens details on hover, survives Later; chip covers a hidden sidebar',
  { tag: '@smoke' },
  async ({ app, shell }) => {
    const badge = shell.locator('[data-testid=update-button]')
    await expect(badge).toHaveAttribute('aria-label', 'Check for updates')
    await offer(app)
    await expect(shell.locator('[data-testid=update-toast]')).toBeVisible()
    await expect(badge).toBeVisible()
    await expect(badge).toHaveAttribute('aria-label', 'Update and restart')

    // A small icon in the same row as Settings, to its right.
    const b = (await badge.boundingBox())!
    const s = (await shell.locator('[data-testid=nav-setting]').boundingBox())!
    expect(b.height).toBeLessThanOrEqual(28)
    expect(Math.abs(b.y - s.y)).toBeLessThan(2)
    expect(b.x).toBeGreaterThan(s.x + s.width)

    // Hover opens the details: build and summary (no history here, so the summary line).
    await badge.hover()
    const pop = shell.locator('[data-testid=update-popover]')
    await expect(pop).toBeVisible()
    await expect(pop.locator('[data-testid=update-popover-build]')).toHaveText('Build e2e1234')
    await expect(pop.locator('[data-testid=update-popover-summary]')).toHaveText(
      'Faster chat list and a calmer sidebar',
    )

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
