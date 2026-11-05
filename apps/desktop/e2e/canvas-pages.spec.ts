import type { ElectronApplication, Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test, expect } from './fixtures'
import { REPO_ROOT } from './helpers/paths'

type G = { __evaosTest: { win: { setContentSize(w: number, h: number): void } } }

test.use({ startOnChat: false, colorScheme: 'dark' })

const sel = (id: string): string => `[data-testid=${id}]`
const PROOF = path.join(REPO_ROOT, 'proof', 'canvas-pages')

interface PageFile {
  nodes: Array<{ id: string }>
  pages?: Array<{ id: string; title: string; nodes?: Array<{ id: string }> }>
}

const read = (configDir: string): PageFile =>
  JSON.parse(fs.readFileSync(path.join(configDir, 'canvases', 'user-flow.json'), 'utf8'))

async function size(app: ElectronApplication, shell: Page, w: number, h: number): Promise<void> {
  await app.evaluate(
    (_e, [ww, hh]) => (globalThis as unknown as G).__evaosTest.win.setContentSize(ww!, hh!),
    [w, h],
  )
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(w)
}

test('pages: add, switch, rename and the panel', async ({ app, configDir, shell }) => {
  await expect(shell.locator(sel('dash-hero'))).toBeVisible()
  await size(app, shell, 1400, 900)
  await shell.locator(sel('nav-canvas')).click()
  await expect(shell.locator(sel('canvas-list'))).toBeVisible()
  await shell.locator(sel('canvas-row-user-flow')).click()
  await expect(shell.locator(sel('canvas-title'))).toHaveText('Sign-in flow')
  await expect(shell.locator(sel('canvas-status'))).toHaveText('5 nodes · 4 edges · saved', {
    timeout: 10_000,
  })
  fs.mkdirSync(PROOF, { recursive: true })

  // A single page board still shows the button; its file has no pages.
  const button = shell.locator(sel('canvas-pages-button'))
  await expect(button).toHaveText('Page 1')
  expect(read(configDir).pages).toBeUndefined()

  await button.click()
  await shell.locator(sel('canvas-page-add')).click()
  await expect(button).toHaveText('Page 2')
  await expect(shell.locator(sel('canvas-status'))).toHaveText('0 nodes · 0 edges · saved', {
    timeout: 10_000,
  })
  await expect.poll(() => read(configDir).pages?.map((p) => p.title)).toEqual(['Page 1', 'Page 2'])

  // Add a note on page 2 (it autosaves into that page), then go back: page 1 is untouched.
  await shell.locator(sel('canvas-tool-note')).click()
  await expect(shell.locator(sel('canvas-status'))).toContainText('1 node', { timeout: 10_000 })
  await button.click()
  await shell.locator(`${sel('canvas-page-row')}[data-page="page-1"]`).click()
  await expect(button).toHaveText('Page 1')
  await expect(shell.locator(sel('canvas-status'))).toHaveText('5 nodes · 4 edges · saved', {
    timeout: 10_000,
  })
  const file = read(configDir)
  expect(file.nodes).toHaveLength(5)
  expect(file.pages?.[1]?.nodes).toHaveLength(1)

  // Rename page 2 in place.
  await button.click()
  await shell.locator(`${sel('canvas-page-row')}:nth-child(2)`).dblclick()
  const input = shell.locator(sel('canvas-page-input'))
  await input.fill('Ideas')
  await input.press('Enter')
  await expect.poll(() => read(configDir).pages?.map((p) => p.title)).toEqual(['Page 1', 'Ideas'])
  await expect(shell.locator(sel('canvas-page-row')).nth(1)).toContainText('Ideas')
  await shell.screenshot({ path: path.join(PROOF, 'desktop-page-panel.png') })

  // Delete asks first and leaves the other page.
  await shell.locator(sel('canvas-page-menu')).nth(1).click()
  await shell.locator(sel('canvas-page-delete')).click()
  await expect(shell.locator(sel('canvas-page-confirm'))).toBeVisible()
  await shell.locator(sel('canvas-page-confirm-delete')).click()
  await expect.poll(() => read(configDir).pages).toBeUndefined()
  await expect(button).toHaveText('Page 1')
})
