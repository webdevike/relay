import * as fs from 'node:fs'
import * as path from 'node:path'
import { test, expect } from './fixtures'

// The Browser's new-tab state is a Tools launcher. TOOLS_PROOF_OUT=<dir> also saves shots there.
const OUT = process.env['TOOLS_PROOF_OUT'] ?? ''
type W = { __evaosShell: { setAppearance(a: 'light' | 'dark'): void } }
type G = { __evaosTest: { win: { setContentSize(w: number, h: number): void } } }

test('the blank browser tab shows tool tiles and Recent; a tile opens that tool in the pane', async ({
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
  const tile = (id: string) => shell.locator(`[data-testid=tools-tile-${id}]`)

  const grid = shell.locator('[data-testid=tools-grid]')
  await expect(grid).toBeVisible()
  // Five tiles in order, no second row, no separate hint or eyebrow.
  await expect(grid.locator('[data-testid^=tools-tile-]')).toHaveText([
    'Terminal',
    'Files',
    'Studio',
    'Canvas',
    'Test Bench',
  ])
  await expect(shell.locator('[data-testid=tools-more]')).toHaveCount(0)
  await expect(shell.locator('[data-testid=page-blank]')).not.toContainText('Or type a web address')
  await expect(shell.locator('[data-testid=address-input]')).toHaveAttribute(
    'placeholder',
    /URL, or port/,
  )
  // Nothing opened yet: no Recent list.
  await expect(shell.locator('[data-testid=tools-recent]')).toHaveCount(0)
  // The shortcut is a tooltip, not a chip on the tile.
  await expect(tile('files')).not.toContainText('⌘P')
  await tile('files').hover()
  await expect(shell.getByRole('tooltip')).toHaveText('⌘P')
  await setAppearance('dark')
  await shot('launcher-dark')
  await setAppearance('light')
  await shot('launcher-light')

  await tile('terminal').click()
  await expect(shell.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })
  await shot('after-terminal')

  // Back on the Browser tab, the tool just opened is the first Recent row; it reopens it.
  await shell.locator('[data-testid=pane-tab-browser]').click()
  const rows = shell.locator('[data-testid=tools-recent-row]')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Terminal')
  await setAppearance('dark')
  await shot('recent-dark')
  await setAppearance('light')
  await shot('recent-light')

  // Ctrl+` brings Terminal forward from another tab of the pane.
  await shell.keyboard.press('Control+`')
  await expect(shell.locator('[data-testid=tools-grid]')).toBeHidden()
  await expect(shell.locator('.xterm').first()).toBeVisible()
})
