import * as fs from 'node:fs'
import * as path from 'node:path'
import { test, expect, launchApp } from './fixtures'
import type { Page } from '@playwright/test'

test.use({ startOnChat: false, colorScheme: 'dark' })
async function openTheme(page: Page) {
  await page.waitForFunction(() => Boolean((window as unknown as { __evaosShell?: unknown }).__evaosShell))
  await page.evaluate(() => (window as unknown as { __evaosShell: { openPlace(p: string, n: boolean, e: {settingsSection: string}): void } }).__evaosShell.openPlace('settings', false, { settingsSection: 'Theme' }))
}
const background = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--eva-c-background').trim())

test('theme family applies without remount, preserves edits and survives relaunch', async ({ app, shell, configDir }) => {
  await openTheme(shell)
  const before = await background(shell)
  await shell.evaluate(() => { (window as unknown as { __themeMarker: Element | null }).__themeMarker = document.querySelector('[data-testid=settings-theme]') })
  const picker = shell.getByRole('button', { name: 'Theme family' })
  await picker.click()
  await expect(shell.getByRole('menuitem', { name: 'Flexoki', exact: true })).toBeVisible()
  await expect(shell.getByRole('menu')).toHaveCSS('opacity', '1')
  await shell.screenshot({ path: path.join('..', '..', 'proof', 'ux-parity', 'theme-picker-menu.png') })
  await shell.getByRole('menuitem', { name: 'Flexoki', exact: true }).click()
  await expect.poll(() => background(shell)).not.toBe(before)
  const file = path.join(configDir, 'theme.json')
  await expect.poll(() => JSON.parse(fs.readFileSync(file, 'utf8')).base).toBe('Flexoki')
  expect(await shell.evaluate(() => (window as unknown as { __themeMarker: Element }).__themeMarker === document.querySelector('[data-testid=settings-theme]'))).toBe(true)
  await shell.locator('.eva-theme-mode-row label').filter({ hasText: 'Light' }).click()
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', 'light')
  await app.close()
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  saved.shared = { ...saved.shared, ring: '#abcdef' }
  saved.externalPreference = { retained: true }
  fs.writeFileSync(file, JSON.stringify(saved))
  const second = await launchApp(configDir)
  try {
    const page = await second.firstWindow()
    await openTheme(page)
    await expect(page.getByRole('button', { name: 'Theme family' })).toContainText('Flexoki')
    await expect(page.locator('html')).toHaveAttribute('data-resolved', 'light')
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--eva-c-ring').trim())).toBe('#abcdef')
    await page.getByRole('button', { name: 'Theme family' }).click()
    await page.getByRole('menuitem', { name: 'EvaOS', exact: true }).click()
    await expect.poll(() => JSON.parse(fs.readFileSync(file, 'utf8')).base).toBe('EvaOS')
    const final = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(final.shared.ring).toBe('#abcdef')
    expect(final.externalPreference).toEqual({ retained: true })
    await page.screenshot({ path: path.join('..', '..', 'proof', 'ux-parity', 'theme-picker.png') })
  } finally { await second.close() }
})
