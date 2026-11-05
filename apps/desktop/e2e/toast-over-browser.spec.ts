import type { ElectronApplication } from '@playwright/test'
import { test, expect } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import { proofShot } from './helpers/proofShot'

// The browser is a native view that paints over the shell page, so a toast drawn by the page would
// sit under it. The renderer reports each toast's rect (browser.setHoles) and main moves the
// view's edge away from it: the toast is fully visible and the page stays on screen.
type Rect = { x: number; y: number; width: number; height: number }
type Hooks = {
  __evaosTest: {
    shell: { webContents: { send(channel: string, payload: unknown): void } }
    hooks: {
      update: { offer(u: object): void }
      browser: { host: { activeView(): { getVisible(): boolean; getBounds(): Rect } } }
    }
  }
}

const viewState = (app: ElectronApplication) =>
  app.evaluate(() => {
    const v = (globalThis as unknown as Hooks).__evaosTest.hooks.browser.host.activeView()
    return { visible: v.getVisible(), bounds: v.getBounds() }
  })

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

test('a toast shows over the browser view, which keeps the rest of its page', async ({
  app,
  shell,
}) => {
  await shell.locator('[data-testid=browser-tab-new]').click()
  const addr = shell.locator('[data-testid=address-input]')
  await addr.fill(server.url('/a.html'))
  await addr.press('Enter')
  await expect.poll(async () => (await viewState(app)).visible).toBe(true)
  const slot = (await shell.locator('[data-testid=browser-slot]').boundingBox())!
  await expect
    .poll(async () => (await viewState(app)).bounds)
    .toEqual({
      x: Math.round(slot.x),
      y: Math.round(slot.y),
      width: Math.round(slot.width),
      height: Math.round(slot.height),
    })

  await app.evaluate(() => {
    ;(globalThis as unknown as Hooks).__evaosTest.hooks.update.offer({
      summary: 'Canvas pages and a fix for comment replies',
      build: 'e2e1234abcd',
    })
  })
  const toast = shell.locator('[data-testid=update-toast]')
  await expect(toast).toBeVisible()
  await expect(shell.locator('[data-testid=update-toast-summary]')).toHaveText(
    'Canvas pages and a fix for comment replies',
  )
  // More toasts stack under the update one; hovering spreads the stack down over the pane, past
  // the page's top edge, which is where a native view would paint over them.
  await app.evaluate(() => {
    const wc = (globalThis as unknown as Hooks).__evaosTest.shell.webContents
    for (const message of ['Opened in a new tab', 'Link copied', 'Logins imported'])
      wc.send('browser.notice', { message })
  })
  await expect(shell.locator('.mantine-Notifications-notification')).toHaveCount(4)
  await shell.locator('.mantine-Notifications-notification').first().hover()
  // The view gives way once the stack has spread and settled.
  await expect
    .poll(async () => (await viewState(app)).bounds.y, { timeout: 8000 })
    .toBeGreaterThan(slot.y)
  const clipped = await viewState(app)
  expect(clipped.visible).toBe(true)
  expect(clipped.bounds.height).toBeGreaterThan(slot.height / 2) // the page is cut, not hidden
  expect(clipped.bounds.width).toBe(Math.round(slot.width))
  for (const n of await shell.locator('.mantine-Notifications-notification').all()) {
    const box = (await n.boundingBox())!
    expect(overlaps(clipped.bounds, box), 'a toast sits under the browser view').toBe(false)
  }
  await proofShot(app, shell, 'toast-over-browser', { phase: 'toast-over-browser' })

  // Later hides the update toast and its rect stops cutting the page.
  await shell.getByRole('button', { name: 'Later' }).click()
  await expect(toast).toHaveCount(0)
})
