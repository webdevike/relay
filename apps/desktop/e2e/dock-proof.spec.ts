import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp } from './fixtures'

// Proof of the pane chrome: shots for a before/after compare against an older build (the same
// states on a fresh config), and a video of a tab dragged into a split (Playwright recordVideo,
// the window still hidden). Runs only with DOCK_PROOF_OUT=<dir> (shots there, video in video/).

const OUT = process.env['DOCK_PROOF_OUT'] ?? ''
type Shell = {
  openPlace(page: string, newTab?: boolean): void
  setPanel(open: boolean): void
  setAppearance(a: 'light' | 'dark'): void
}
type W = { __evaosShell: Shell }
type G = { __evaosTest: { win: { setContentSize(w: number, h: number): void } } }

test.skip(OUT === '', 'proof shots only with DOCK_PROOF_OUT')

async function size(app: ElectronApplication, shell: Page, w: number, h: number): Promise<void> {
  await app.evaluate(
    (_e, [ww, hh]) => (globalThis as unknown as G).__evaosTest.win.setContentSize(ww!, hh!),
    [w, h],
  )
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(w)
}

async function shot(shell: Page, name: string): Promise<void> {
  // Tooltips and hovers off the chrome, and a beat for the layout to settle.
  await shell.mouse.move(130, 700)
  await shell.waitForTimeout(600)
  fs.mkdirSync(OUT, { recursive: true })
  await shell.screenshot({ path: path.join(OUT, `${name}.png`) })
}

test('pane chrome: one strip of app tabs, the tool pane beside it, light and dark', async ({
  app,
  shell,
}) => {
  await size(app, shell, 1400, 860)
  await shell.evaluate(() => {
    const s = (window as unknown as W).__evaosShell
    s.openPlace('jobs', true)
    s.openPlace('dashboard', true)
  })
  await shot(shell, '1-tabs-and-tool-pane-light')
  await shell.evaluate(() => (window as unknown as W).__evaosShell.setPanel(false))
  await shot(shell, '2-tabs-alone-light')
  await shell.evaluate(() => {
    const s = (window as unknown as W).__evaosShell
    s.setAppearance('dark')
    s.setPanel(true)
  })
  await shot(shell, '3-tabs-and-tool-pane-dark')
})

test('video: an app tab dragged onto the pane edge splits the app tabs', async ({ configDir }) => {
  const dir = path.join(OUT, 'video')
  const app = await launchApp(configDir, {}, { dir, size: { width: 1400, height: 860 } })
  try {
    const shell = await app.firstWindow()
    await shell.waitForSelector('[data-testid=rail]')
    await size(app, shell, 1400, 860)
    await shell.evaluate(() => (window as unknown as W).__evaosShell.openPlace('jobs', true))
    await shell.mouse.move(130, 700)
    await shell.waitForTimeout(1200)
    // Jobs, in front, out of the strip and slowly onto the pane's right edge: the overlay shows
    // the half it takes; then it lets go and the app tabs split in two panes.
    const tab = (await shell
      .locator('[data-testid=tabbar] .eva-tab[data-active=true]')
      .boundingBox())!
    const body = (await shell.locator('[data-testid=pane-body-p1]').boundingBox())!
    await shell.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2, { steps: 20 })
    await shell.waitForTimeout(400)
    await shell.mouse.down()
    await shell.mouse.move(tab.x + tab.width / 2 + 8, tab.y + tab.height / 2 + 8, { steps: 4 })
    await shell.mouse.move(body.x + body.width / 2, body.y + body.height / 2, { steps: 40 })
    await shell.mouse.move(body.x + body.width - 40, body.y + body.height / 2, { steps: 40 })
    await shell.waitForTimeout(1200)
    await shell.mouse.up()
    await expect(shell.locator('[data-pane-kind=app]')).toHaveCount(2)
    await shell.mouse.move(130, 700, { steps: 20 })
    await shell.waitForTimeout(2000)
  } finally {
    await app.close()
  }
})
