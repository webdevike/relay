import { test, expect } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import type { ElectronApplication, Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

type Rect = { x: number; y: number; width: number; height: number }
interface ViewLike {
  getVisible(): boolean
  getBounds(): Rect
  webContents: {
    executeJavaScript(code: string): Promise<unknown>
    focus(): void
    sendInputEvent(e: unknown): void
  }
}
interface HostLike {
  views(): ViewLike[]
  activeView(): ViewLike
  snapshot(): { tabs: Array<{ id: string; title: string }>; activeId: string }
}
type G = {
  __evaosTest: { win: { isDestroyed(): boolean }; hooks: { browser: { host: HostLike } } }
}

const states = (app: ElectronApplication) =>
  app.evaluate(() => {
    const t = (globalThis as unknown as G).__evaosTest
    return t.hooks.browser.host.views().map((v, i) => ({
      i,
      visible: v.getVisible(),
      bounds: v.getBounds(),
    }))
  })
const snap = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as G).__evaosTest.hooks.browser.host.snapshot())

function guest(app: ElectronApplication, code: string): Promise<unknown> {
  return app.evaluate((_e, c) => {
    const h = (globalThis as unknown as G).__evaosTest.hooks.browser.host
    return h.activeView().webContents.executeJavaScript(c)
  }, code)
}
function sendKey(app: ElectronApplication, key: string, modifiers: string[]): Promise<void> {
  return app.evaluate(
    (_e, a) => {
      const h = (globalThis as unknown as G).__evaosTest.hooks.browser.host
      const wc = h.activeView().webContents
      wc.focus()
      wc.sendInputEvent({ type: 'keyDown', keyCode: a.key, modifiers: a.modifiers })
      wc.sendInputEvent({ type: 'keyUp', keyCode: a.key, modifiers: a.modifiers })
    },
    { key, modifiers },
  )
}
async function nav(shell: Page, input: string): Promise<void> {
  const addr = shell.locator('[data-testid=address-input]')
  await addr.fill(input)
  await addr.press('Enter')
}
const tabCount = (shell: Page) => shell.locator('[data-testid^=tab-t]').count()

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

test('tabs: create, switch, close, target=_blank, last tab, hotkeys from the guest', async ({
  app,
  shell,
}) => {
  const a = server.url('/a.html')
  const b = server.url('/b.html')
  await shell.locator('[data-testid=tab-new]').click()
  await shell.locator('[data-testid=tab-new]').click()
  await expect.poll(() => tabCount(shell)).toBe(3)
  expect((await states(app)).length).toBe(3)

  await shell.locator('[data-testid=tab-t2]').click()
  await nav(shell, a)
  await expect(shell.locator('[data-testid=tab-t2]')).toContainText('Page A')
  await shell.locator('[data-testid=tab-t3]').click()
  await nav(shell, b)
  await expect(shell.locator('[data-testid=tab-t3]')).toContainText('Page B')

  await shell.locator('[data-testid=tab-t2]').click()
  await expect
    .poll(async () => (await states(app)).map((s) => s.visible))
    .toEqual([false, true, false])
  const slot = await shell.locator('[data-testid=browser-slot]').boundingBox()
  const bounds = (await states(app))[1]!.bounds
  expect(bounds).toEqual({
    x: Math.round(slot!.x),
    y: Math.round(slot!.y),
    width: Math.round(slot!.width),
    height: Math.round(slot!.height),
  })

  // Middle-click closes.
  await shell.locator('[data-testid=tab-t3]').click({ button: 'middle' })
  await expect.poll(() => tabCount(shell)).toBe(2)

  // target=_blank opens a new foreground tab.
  await app.evaluate(() => {
    const h = (globalThis as unknown as G).__evaosTest.hooks.browser.host
    return h
      .activeView()
      .webContents.executeJavaScript('document.querySelector("a[target=_blank]").click()')
  })
  await expect.poll(() => tabCount(shell)).toBe(3)
  await expect
    .poll(async () => {
      const s = await snap(app)
      return s.tabs.find((t) => t.id === s.activeId)?.title
    })
    .toBe('Page B')

  // Close everything; one blank tab remains.
  for (let n = 0; n < 5; n++) {
    const first = shell.locator('[data-testid^=tab-close-]').first()
    if ((await first.count()) === 0) break
    await shell.locator('[data-testid^=tab-t]').first().hover()
    await first.click({ force: true })
    if ((await tabCount(shell)) === 1 && (await shell.getByText('New tab').count()) > 0) break
  }
  await expect.poll(() => tabCount(shell)).toBe(1)
  await expect(shell.locator('[data-testid^=tab-t]').first()).toContainText('New tab')

  // Hotkeys pressed while the guest is focused go to the shell, not the page.
  await nav(shell, a)
  await expect(shell.locator('[data-testid^=tab-t]').first()).toContainText('Page A')
  await guest(
    app,
    'window.__kd = 0; document.addEventListener("keydown", () => { window.__kd++ }); 0',
  )
  await sendKey(app, 't', ['meta'])
  await expect.poll(() => tabCount(shell)).toBe(2)
  await shell.locator('[data-testid^=tab-t]').first().click()
  await sendKey(app, 'l', ['meta'])
  await expect(shell.locator('[data-testid=address-input]')).toBeFocused()
  // The page saw none of the forwarded chords.
  expect(await guest(app, 'window.__kd')).toBe(0)
  await sendKey(app, 'w', ['meta'])
  await expect.poll(() => tabCount(shell)).toBe(1)
  expect(
    await app.evaluate(() => !(globalThis as unknown as G).__evaosTest.win.isDestroyed()),
  ).toBe(true)
})

test('suggestions from in-app history', async ({ app, shell, configDir }) => {
  const a = server.url('/a.html')
  const b = server.url('/b.html')
  await nav(shell, a)
  await expect(shell.locator('[data-testid^=tab-t]').first()).toContainText('Page A')
  await nav(shell, b)
  await expect(shell.locator('[data-testid^=tab-t]').first()).toContainText('Page B')
  await expect
    .poll(() => fs.existsSync(path.join(configDir, 'browser-history.json')), { timeout: 5000 })
    .toBe(true)

  const addr = shell.locator('[data-testid=address-input]')
  await addr.fill('page')
  const list = shell.locator('[data-testid=suggestions]')
  await expect(list).toBeVisible()
  await expect(list.getByText('Page A')).toBeVisible()
  await expect(list.getByText('Page B')).toBeVisible()
  expect(await list.locator('[data-testid=suggestion-row]').count()).toBeLessThanOrEqual(6)
  await expect
    .poll(() =>
      app.evaluate(() =>
        (globalThis as unknown as G).__evaosTest.hooks.browser.host.activeView().getVisible(),
      ),
    )
    .toBe(false)

  await addr.press('ArrowDown')
  await addr.press('Enter')
  await expect(list).toBeHidden()
  await expect.poll(async () => (await snap(app)).tabs[0]!.title).toMatch(/Page [AB]/)

  await addr.fill('page')
  await expect(list).toBeVisible()
  await addr.press('Escape')
  await expect(list).toBeHidden()
  await expect
    .poll(() =>
      app.evaluate(() =>
        (globalThis as unknown as G).__evaosTest.hooks.browser.host.activeView().getVisible(),
      ),
    )
    .toBe(true)
})
