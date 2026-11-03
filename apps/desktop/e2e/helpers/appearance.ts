import type { Page } from '@playwright/test'

/** Picks Light or Dark in the sidebar's Settings popover, then closes the popover. */
export async function pickScheme(shell: Page, scheme: 'light' | 'dark'): Promise<void> {
  const row = shell.locator('[data-testid="nav-setting"]')
  const menu = shell.locator('[data-testid="settings-menu"]')
  await row.click()
  await menu.waitFor({ state: 'visible' })
  await shell.locator(`[data-testid="appearance-${scheme}"]`).click()
  await row.click()
  await menu.waitFor({ state: 'hidden' })
}
