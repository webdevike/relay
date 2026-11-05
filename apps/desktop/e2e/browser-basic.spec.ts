import { test, expect } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import { recordMetrics } from './helpers/metrics'
import {
  expectViewOnSlot,
  frames,
  guestEval,
  navigate,
  newPage,
  pageTab,
  pageTabs,
  viewOf,
  webPanel,
  type BrowserHooks,
} from './helpers/web'
import type { ElectronApplication } from '@playwright/test'

/** Page `id`'s view: partition, sandboxing and preload, as Electron set them up. */
function hardening(app: ElectronApplication, id: string) {
  return app.evaluate(({ session }, tabId) => {
    const wc = (globalThis as unknown as BrowserHooks).__evaosTest.hooks.browser.host.tabById(
      tabId,
    )!
    const prefs = wc.getLastWebPreferences()
    return {
      samePartition: wc.session === session.fromPartition('persist:browser'),
      sandbox: prefs?.sandbox,
      contextIsolation: prefs?.contextIsolation,
      preload: prefs?.preload ?? null,
    }
  }, id)
}

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

test('a web page: navigate, history, bounds, overlay, hardening, errors', async ({
  app,
  shell,
}) => {
  // A workspace starts with no pages; the + menu opens a blank one with its address focused.
  await expect(pageTabs(shell)).toHaveCount(0)
  const id = await newPage(shell)
  const panel = webPanel(shell, id)
  const addr = panel.locator('[data-testid=address-input]')
  await expect(panel.locator('[data-testid=page-blank]')).toBeVisible()
  await expect(panel.locator('[data-testid=page-blank]')).toContainText(
    'Type an address or search above.',
  )
  await expect(addr).toBeFocused()
  await expect(addr).toHaveAttribute('placeholder', 'Search, URL, or port such as 3000')
  await expect(pageTab(shell, id)).toContainText('New page')

  const title = pageTab(shell, id)
  await navigate(shell, id, String(server.port))
  await expect(title).toContainText('Page A')
  await expect.poll(async () => (await viewOf(app, id))?.visible).toBe(true)
  let maxDelta = await expectViewOnSlot(app, shell, id)

  await navigate(shell, id, `127.0.0.1:${server.port}/b.html`)
  await expect(title).toContainText('Page B')
  await expect(panel.locator('[data-testid=nav-back]')).toBeEnabled()
  await panel.locator('[data-testid=nav-back]').click()
  await expect(title).toContainText('Page A')
  await expect(panel.locator('[data-testid=nav-forward]')).toBeEnabled()
  await panel.locator('[data-testid=nav-reload]').click()
  await expect(title).toContainText('Page A')

  const url = `http://127.0.0.1:${server.port}/`
  await panel.locator('[data-testid=btn-copy-link]').click()
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(url)

  await app.evaluate(({ shell: sh }) => {
    const g = globalThis as unknown as { __opened: string[] }
    g.__opened = []
    sh.openExternal = async (u: string) => {
      g.__opened.push(u)
    }
  })
  await panel.locator('[data-testid=btn-open-external]').click()
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened[0]))
    .toBe(url)

  // Window resize and a drag of the sash between the chat and the page's pane keep the view
  // glued to the slot.
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1100, 760))
  await frames(shell)
  maxDelta = Math.max(maxDelta, await expectViewOnSlot(app, shell, id))
  const div = await shell
    .locator('.dv-split-view-container.dv-horizontal > .dv-sash-container > .dv-sash:visible')
    .first()
    .boundingBox()
  if (!div) throw new Error('no sash')
  const cx = div.x + div.width / 2
  const cy = div.y + div.height / 2
  await shell.mouse.move(cx, cy)
  await shell.mouse.down()
  await shell.mouse.move(cx - 60, cy, { steps: 4 })
  await shell.mouse.move(cx - 120, cy, { steps: 4 })
  await shell.mouse.up()
  await frames(shell)
  maxDelta = Math.max(maxDelta, await expectViewOnSlot(app, shell, id))

  // Overlay hides the view and restores it with identical bounds.
  const before = (await viewOf(app, id))!.bounds
  await shell.evaluate(() =>
    (
      window as unknown as { __evaosShell: { openTestOverlay(): void } }
    ).__evaosShell.openTestOverlay(),
  )
  await expect(shell.locator('[data-testid=overlay-test]')).toBeVisible()
  await expect(shell.getByText('Test overlay', { exact: true }).last()).toBeVisible()
  await expect.poll(async () => (await viewOf(app, id))?.visible).toBe(false)
  await shell
    .getByTestId('overlay-test')
    .getByRole('button', { name: 'Close', exact: true })
    .click()
  await expect.poll(async () => (await viewOf(app, id))?.visible).toBe(true)
  expect((await viewOf(app, id))!.bounds).toEqual(before)

  // Hardening.
  const info = await hardening(app, id)
  expect(info.samePartition).toBe(true)
  expect(info.sandbox).toBe(true)
  expect(info.contextIsolation).toBe(true)
  expect(info.preload).toBeFalsy()
  expect(await guestEval(app, id, 'typeof window.eva')).toBe('undefined')
  expect(await guestEval(app, id, 'window.open("about:blank") === null')).toBe(true)
  const perm = await guestEval(
    app,
    id,
    'navigator.permissions.query({name:"geolocation"}).then(r=>r.state)',
  )
  expect(perm).not.toBe('granted')
  const geoErr = await guestEval(
    app,
    id,
    'new Promise(r => navigator.geolocation.getCurrentPosition(() => r("ok"), () => r("error")))',
  )
  expect(geoErr).toBe('error')

  // Search URL (the request itself is cancelled by the e2e network rule).
  const res = await shell.evaluate(
    (tabId) =>
      (
        window as unknown as { eva: { invoke(c: string, i: unknown): Promise<unknown> } }
      ).eva.invoke('browser.navigate', { tabId, input: 'hello world' }),
    id,
  )
  expect((res as { ok: true; value: { url: string } }).value.url).toBe(
    'https://www.google.com/search?q=hello+world',
  )

  // Error card.
  await navigate(shell, id, '127.0.0.1:1')
  await expect(panel.getByText('This page could not be loaded')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Try again' })).toBeVisible()
  await expect.poll(async () => (await viewOf(app, id))?.visible).toBe(false)

  // Schemes outside http/https/about typed in the address bar never reach the guest view.
  const guestUrl = () =>
    app.evaluate(
      (_e, tabId) =>
        (globalThis as unknown as BrowserHooks).__evaosTest.hooks.browser.host
          .tabById(tabId)!
          .getURL(),
      id,
    )
  for (const blocked of ['file:///etc/hosts', 'chrome://settings']) {
    await navigate(shell, id, blocked)
    await expect(panel.getByText('This address cannot be opened here')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Try again' })).toHaveCount(0)
    expect(await guestUrl()).not.toMatch(/^(file|chrome):/)
    await expect.poll(async () => (await viewOf(app, id))?.visible).toBe(false)
  }

  recordMetrics('browser', {
    boundsDeltaPx: maxDelta,
    overlayHidesView: true,
    boundsRestoredAfterOverlay: true,
  })
})
