import { test, expect } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import {
  guestEval,
  navigate,
  newPage,
  openPage,
  pageIds,
  pageTab,
  pageTabs,
  paneOfPage,
  sendKey,
  slotRect,
  viewOf,
  views,
  webPanel,
  type BrowserHooks,
} from './helpers/web'
import type { ElectronApplication } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

const snap = (app: ElectronApplication) =>
  app.evaluate(() =>
    (globalThis as unknown as BrowserHooks).__evaosTest.hooks.browser.host.snapshot(),
  )

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

test('page tabs: create, switch, split, close, target=_blank, last page, hotkeys from the guest', async ({
  app,
  shell,
}) => {
  const a = server.url('/a.html')
  const b = server.url('/b.html')
  // Room for four tabs in the tool pane's strip.
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1600, 900))
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBeGreaterThan(1500)
  // A workspace starts with no pages.
  await expect(pageTabs(shell)).toHaveCount(0)
  const t1 = await newPage(shell)
  const t2 = await newPage(shell)
  const t3 = await newPage(shell)
  await expect(pageTabs(shell)).toHaveCount(3)
  expect((await views(app)).length).toBe(3)
  // Each page is its own tab of the same pane, opened right after the one in front.
  const pane = await paneOfPage(shell, t1)
  expect(await paneOfPage(shell, t3)).toBe(pane)
  expect(await pageIds(shell)).toEqual([t1, t2, t3])

  await pageTab(shell, t2).click()
  await navigate(shell, t2, a)
  await expect(pageTab(shell, t2)).toContainText('Page A')
  await pageTab(shell, t3).click()
  await navigate(shell, t3, b)
  await expect(pageTab(shell, t3)).toContainText('Page B')

  // Only the page in front of its pane shows, glued to its slot.
  await pageTab(shell, t2).click()
  await expect.poll(async () => (await viewOf(app, t2))?.visible).toBe(true)
  await expect.poll(async () => (await viewOf(app, t3))?.visible).toBe(false)
  expect((await viewOf(app, t2))!.bounds).toEqual(await slotRect(shell, t2))

  // Split: Page B gets a pane of its own beside Page A; both views show, each over its slot.
  await shell.locator(`[data-testid="pane-tab-web:${t3}"]`).click()
  await shell.keyboard.press('Meta+\\')
  await expect.poll(() => paneOfPage(shell, t3)).not.toBe(pane)
  await expect.poll(async () => (await viewOf(app, t2))?.visible).toBe(true)
  await expect.poll(async () => (await viewOf(app, t3))?.visible).toBe(true)
  await expect
    .poll(async () => JSON.stringify((await viewOf(app, t2))!.bounds))
    .toBe(JSON.stringify(await slotRect(shell, t2)))
  await expect
    .poll(async () => JSON.stringify((await viewOf(app, t3))!.bounds))
    .toBe(JSON.stringify(await slotRect(shell, t3)))
  expect((await slotRect(shell, t3)).x).toBeGreaterThan((await slotRect(shell, t2)).x)

  // Middle-click closes a page tab and its page.
  await pageTab(shell, t3).click({ button: 'middle' })
  await expect(pageTabs(shell)).toHaveCount(2)
  await expect.poll(async () => (await views(app)).length).toBe(2)

  // target=_blank opens a new page tab right after its opener, in front.
  await guestEval(app, t2, 'document.querySelector("a[target=_blank]").click()')
  await expect(pageTabs(shell)).toHaveCount(3)
  const ids = await pageIds(shell)
  const popup = ids[ids.indexOf(t2) + 1]!
  expect([t1, t2]).not.toContain(popup)
  await expect(pageTab(shell, popup)).toContainText('Page B')
  await expect(webPanel(shell, popup)).toBeVisible()
  await expect
    .poll(async () => {
      const s = await snap(app)
      return s.tabs.find((t) => t.id === s.activeId)?.title
    })
    .toBe('Page B')

  // Close every page; nothing of the browser is left on screen.
  for (let left = await pageTabs(shell).count(); left > 0; left--) {
    const first = pageTabs(shell).first()
    await first.hover()
    await first.locator('[data-testid^="pane-tab-close-web:"]').click({ force: true })
    await expect(pageTabs(shell)).toHaveCount(left - 1)
  }
  await expect(shell.locator('[data-testid=web-panel]:visible')).toHaveCount(0)
  await expect.poll(async () => (await views(app)).length).toBe(0)

  // The pages of the rest of this test live in the Dashboard's workspace (a page workspace one
  // can come back to by name), with Files beside it.
  type Hooks = { __evaosShell: { openPlace(p: string): void; setPanel(open: boolean): void } }
  await shell.evaluate(() => (window as unknown as Hooks).__evaosShell.openPlace('dashboard'))
  await shell.evaluate(() => (window as unknown as Hooks).__evaosShell.setPanel(true))
  await expect(shell.locator('[data-pane-kind=tool]')).toBeVisible()

  // Hotkeys pressed while a page has the focus go to the shell, not the page.
  const page = await openPage(shell, a, 'Page A')
  await guestEval(
    app,
    page,
    'window.__kd = 0; document.addEventListener("keydown", () => { window.__kd++ }); 0',
  )
  // Cmd+T from the page: a blank page in the page's pane, its address focused.
  await sendKey(app, page, 't', ['meta'])
  await expect
    .poll(() =>
      shell.evaluate(() =>
        (
          (window as unknown as { __evaosHotkeys?: Array<{ chord: string; action: string }> })
            .__evaosHotkeys ?? []
        ).some((h) => h.chord === 'cmd+t' && h.action === 'new-tab'),
      ),
    )
    .toBe(true)
  await expect(pageTabs(shell)).toHaveCount(2)
  const blank = (await pageIds(shell)).find((x) => x !== page)!
  expect(await paneOfPage(shell, blank)).toBe(await paneOfPage(shell, page))
  await expect(webPanel(shell, blank).locator('[data-testid=address-input]')).toBeFocused()

  // Another workspace has no pages; back on the Dashboard, its pages return as they were.
  await shell.evaluate(() => (window as unknown as Hooks).__evaosShell.openPlace('jobs'))
  await expect(pageTabs(shell)).toHaveCount(0)
  await expect.poll(async () => (await viewOf(app, page))?.visible).toBe(false)
  await shell.evaluate(() => (window as unknown as Hooks).__evaosShell.openPlace('dashboard'))
  await expect(pageTabs(shell)).toHaveCount(2)
  await expect(pageTab(shell, page)).toContainText('Page A')

  // Cmd+L from the page focuses its own address field.
  await pageTab(shell, page).click()
  await expect.poll(async () => (await viewOf(app, page))?.visible).toBe(true)
  await sendKey(app, page, 'l', ['meta'])
  await expect(webPanel(shell, page).locator('[data-testid=address-input]')).toBeFocused()
  // The page saw none of the forwarded chords.
  expect(await guestEval(app, page, 'window.__kd')).toBe(0)
  // Cmd+W from the page closes it, and only it.
  await sendKey(app, page, 'w', ['meta'])
  await expect(pageTabs(shell)).toHaveCount(1)
  await expect(pageTab(shell, page)).toHaveCount(0)
  expect(
    await app.evaluate(
      () => !(globalThis as unknown as BrowserHooks).__evaosTest.win.isDestroyed(),
    ),
  ).toBe(true)
})

test('suggestions from in-app history', async ({ app, shell, configDir }) => {
  const id = await openPage(shell, server.url('/a.html'), 'Page A')
  await navigate(shell, id, server.url('/b.html'))
  await expect(pageTab(shell, id)).toContainText('Page B')
  await expect
    .poll(() => fs.existsSync(path.join(configDir, 'browser-history.json')), { timeout: 5000 })
    .toBe(true)

  const addr = webPanel(shell, id).locator('[data-testid=address-input]')
  await addr.fill('page')
  const list = shell.locator('[data-testid=suggestions]')
  await expect(list).toBeVisible()
  await expect(list.getByText('Page A')).toBeVisible()
  await expect(list.getByText('Page B')).toBeVisible()
  expect(await list.locator('[data-testid=suggestion-row]').count()).toBeLessThanOrEqual(6)
  await expect.poll(async () => (await viewOf(app, id))?.visible).toBe(false)

  await addr.press('ArrowDown')
  await addr.press('Enter')
  await expect(list).toBeHidden()
  await expect(pageTab(shell, id)).toContainText(/Page [AB]/)

  await addr.fill('page')
  await expect(list).toBeVisible()
  await addr.press('Escape')
  await expect(list).toBeHidden()
  await expect.poll(async () => (await viewOf(app, id))?.visible).toBe(true)
})
