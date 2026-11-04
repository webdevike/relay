import * as fs from 'node:fs'
import * as path from 'node:path'
import { test, expect } from './fixtures'

// The Browser's new-tab state is a Tools launcher. TOOLS_PROOF_OUT=<dir> also saves shots there.
const OUT = process.env['TOOLS_PROOF_OUT'] ?? ''
type W = { __evaosShell: { setAppearance(a: 'light' | 'dark'): void } }
type G = { __evaosTest: { win: { setContentSize(w: number, h: number): void } } }

test('the blank browser tab lists tools; a row opens that tool in the pane', async ({
  app,
  shell,
}) => {
  await app.evaluate(() => (globalThis as unknown as G).__evaosTest.win.setContentSize(1400, 860))
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(1400)
  const shot = async (name: string) => {
    if (OUT === '') return
    await shell.mouse.move(130, 700)
    await shell.waitForTimeout(700)
    fs.mkdirSync(OUT, { recursive: true })
    await shell.screenshot({ path: path.join(OUT, `${name}.png`) })
  }
  const setAppearance = (a: 'light' | 'dark') =>
    shell.evaluate((v) => (window as unknown as W).__evaosShell.setAppearance(v), a)

  const grid = shell.locator('[data-testid=tools-grid]')
  await expect(grid).toBeVisible()
  await expect(grid.locator('[data-testid=tools-row-terminal]')).toContainText('Terminal')
  await expect(grid.locator('[data-testid=tools-row-files]')).toContainText('⌘P')
  await expect(grid.locator('[data-testid=tools-row-canvas]')).toHaveCount(0)
  await setAppearance('dark')
  await shot('launcher-dark')
  await shell.locator('[data-testid=tools-more]').click()
  await expect(grid.locator('[data-testid=tools-row-canvas]')).toBeVisible()
  await expect(grid.locator('[data-testid=tools-row-test-bench]')).toBeVisible()
  await shell.locator('[data-testid=tools-more]').click()
  await setAppearance('light')
  await shot('launcher-light')

  await shell.locator('[data-testid=tools-row-terminal]').click()
  await expect(shell.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })
  await shot('after-terminal')

  // Ctrl+` brings Terminal forward from another tab of the pane.
  await shell.locator('[data-testid=pane-tab-browser]').click()
  await expect(shell.locator('[data-testid=tools-grid]')).toBeVisible()
  await shell.keyboard.press('Control+`')
  await expect(shell.locator('[data-testid=tools-grid]')).toBeHidden()
  await expect(shell.locator('.xterm').first()).toBeVisible()
})
