import * as fs from 'node:fs'
import * as path from 'node:path'
import { test, expect } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import { navigate, newPage, pageIds, pageTab, toolPane, webPanel } from './helpers/web'

// A pane's + menu lists every tool; a blank page is a quiet state with its address field focused
// and the pages opened last. TOOLS_PROOF_OUT=<dir> also saves shots there.
const OUT = process.env['TOOLS_PROOF_OUT'] ?? ''
type W = { __evaosShell: { setAppearance(a: 'light' | 'dark'): void } }
type G = { __evaosTest: { win: { setContentSize(w: number, h: number): void } } }

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

test(
  'the + menu lists the tools; a blank page focuses its address and offers recent pages',
  { tag: '@smoke' },
  async ({ app, shell }) => {
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

    // The tool pane's + menu: every tool in order, the page first with its shortcut.
    const pane = await toolPane(shell)
    await shell.locator(`[data-testid=pane-add-${pane}]`).click()
    const menu = shell.locator(`[data-testid=pane-add-menu-${pane}]`)
    await expect(menu.locator('[data-testid^=pane-add-tool-]')).toContainText([
      'Browser page',
      'Files',
      'Terminal',
      'Canvas',
      'Studio',
      'Test Bench',
    ])
    await expect(menu.locator(`[data-testid=pane-add-tool-browser-${pane}]`)).toContainText('⌘T')
    await setAppearance('dark')
    await shot('add-menu-dark')
    await setAppearance('light')
    await shot('add-menu-light')
    await shell.keyboard.press('Escape')
    await expect(menu).toBeHidden()

    // A blank page: one quiet line, its address focused, nothing recent yet.
    const first = await newPage(shell, pane)
    const blank = webPanel(shell, first).locator('[data-testid=page-blank]')
    await expect(blank).toHaveText('Type an address or search above.')
    await expect(webPanel(shell, first).locator('[data-testid=address-input]')).toBeFocused()
    await expect(webPanel(shell, first).locator('[data-testid=page-recent]')).toHaveCount(0)
    await expect(shell.locator('[data-testid=tools-grid]')).toHaveCount(0)
    await setAppearance('dark')
    await shot('blank-dark')
    await setAppearance('light')
    await shot('blank-light')

    // Once a page was opened, a new blank page (Cmd+T, in the focused pane) lists it; a row
    // opens it there.
    await navigate(shell, first, server.url('/a.html'))
    await expect(pageTab(shell, first)).toContainText('Page A')
    await shell.keyboard.press('Meta+t')
    await expect.poll(async () => (await pageIds(shell)).length).toBe(2)
    const second = (await pageIds(shell)).find((x) => x !== first)!
    const rows = webPanel(shell, second).locator('[data-testid=page-recent-row]')
    await expect(rows.first()).toContainText('Page A')
    await setAppearance('dark')
    await shot('recent-dark')
    await setAppearance('light')
    await shot('recent-light')
    await rows.first().click()
    await expect(pageTab(shell, second)).toContainText('Page A')

    // A tool from the same menu opens as a tab of the pane; Ctrl+` brings Terminal forward.
    await shell.locator(`[data-testid=pane-add-${pane}]`).click()
    await shell.locator(`[data-testid=pane-add-tool-terminal-${pane}]`).click()
    await expect(shell.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })
    await pageTab(shell, second).click()
    await expect(shell.locator('.xterm').first()).toBeHidden()
    await shell.keyboard.press('Control+`')
    await expect(shell.locator('.xterm').first()).toBeVisible()
  },
)
