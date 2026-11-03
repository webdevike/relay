import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'

// Proof shots of the pane chrome, for a before/after compare against an older build: the same
// states on a fresh config. Runs only with DOCK_PROOF_OUT=<dir> (the shots go there).

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
