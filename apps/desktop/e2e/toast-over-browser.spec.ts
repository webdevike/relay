import { test, expect } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import { proofShot } from './helpers/proofShot'
import { openPage, slotRect, viewOf, type Rect } from './helpers/web'

// A page is a native view that paints over the shell page, so a toast drawn by the page would
// sit under it. The renderer reports each toast's rect (browser.setHoles) and main moves the
// view's edge away from it: the toast is fully visible and the page stays on screen.
type Hooks = {
  __evaosTest: {
    shell: { webContents: { send(channel: string, payload: unknown): void } }
    hooks: { update: { offer(u: object): void } }
  }
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

test('a toast shows over a page, which keeps the rest of its page', async ({ app, shell }) => {
  const id = await openPage(shell, server.url('/a.html'), 'Page A')
  await expect.poll(async () => (await viewOf(app, id))?.visible).toBe(true)
  const slot = await slotRect(shell, id)
  await expect.poll(async () => (await viewOf(app, id))?.bounds).toEqual(slot)

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
  // The view gives way once the stack has spread and settled: no toast under it.
  const under = async (): Promise<string[]> => {
    const v = (await viewOf(app, id))!.bounds
    const out: string[] = []
    for (const n of await shell.locator('.mantine-Notifications-notification').all()) {
      const b = (await n.boundingBox())!
      if (overlaps(v, b)) out.push(`view ${JSON.stringify(v)} over toast ${JSON.stringify(b)}`)
    }
    return out
  }
  await expect
    .poll(async () => (await viewOf(app, id))!.bounds.y, { timeout: 8000 })
    .toBeGreaterThan(slot.y)
  await expect
    .poll(under, { timeout: 8000, message: 'a toast sits under the page view' })
    .toEqual([])
  const clipped = (await viewOf(app, id))!
  expect(clipped.visible).toBe(true)
  expect(clipped.bounds.height).toBeGreaterThan(slot.height / 2) // the page is cut, not hidden
  expect(clipped.bounds.width).toBe(slot.width)
  await proofShot(app, shell, 'toast-over-browser', { phase: 'toast-over-browser' })

  // Later hides the update toast and its rect stops cutting the page.
  await shell.getByRole('button', { name: 'Later' }).click()
  await expect(toast).toHaveCount(0)
})
