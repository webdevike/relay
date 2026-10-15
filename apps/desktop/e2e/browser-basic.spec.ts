import { test, expect } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import { recordMetrics } from './helpers/metrics'
import type { ElectronApplication, Page } from '@playwright/test'

type Rect = { x: number; y: number; width: number; height: number }

interface HostLike {
  activeView(): {
    getVisible(): boolean
    getBounds(): Rect
    webContents: {
      session: unknown
      getURL(): string
      getLastWebPreferences(): { sandbox?: boolean; contextIsolation?: boolean; preload?: string }
      executeJavaScript(code: string): Promise<unknown>
    }
  }
}

function activeInfo(app: ElectronApplication) {
  return app.evaluate(({ session }) => {
    const t = (globalThis as unknown as { __evaosTest: { hooks: { browser: { host: HostLike } } } })
      .__evaosTest
    const v = t.hooks.browser.host.activeView()
    const prefs = v.webContents.getLastWebPreferences()
    return {
      visible: v.getVisible(),
      bounds: v.getBounds(),
      samePartition: v.webContents.session === session.fromPartition('persist:browser'),
      sandbox: prefs.sandbox,
      contextIsolation: prefs.contextIsolation,
      preload: prefs.preload ?? null,
    }
  })
}

function guestEval(app: ElectronApplication, code: string): Promise<unknown> {
  return app.evaluate((_e, c) => {
    const t = (globalThis as unknown as { __evaosTest: { hooks: { browser: { host: HostLike } } } })
      .__evaosTest
    return t.hooks.browser.host.activeView().webContents.executeJavaScript(c)
  }, code)
}

async function slotRect(shell: Page): Promise<Rect> {
  const box = await shell.locator('[data-testid=browser-slot]').boundingBox()
  if (!box) throw new Error('slot has no box')
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  }
}

async function frames(shell: Page): Promise<void> {
  await shell.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => r(), 50))),
      ),
  )
}

async function navigate(shell: Page, input: string): Promise<void> {
  const addr = shell.locator('[data-testid=address-input]')
  await addr.fill(input)
  await addr.press('Enter')
}

async function expectBoundsEqualSlot(app: ElectronApplication, shell: Page): Promise<number> {
  await expect
    .poll(async () => JSON.stringify((await activeInfo(app)).bounds), { timeout: 5000 })
    .toBe(JSON.stringify(await slotRect(shell)))
  const b = (await activeInfo(app)).bounds
  const s = await slotRect(shell)
  return Math.max(
    Math.abs(b.x - s.x),
    Math.abs(b.y - s.y),
    Math.abs(b.width - s.width),
    Math.abs(b.height - s.height),
  )
}

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

test('browser panel: navigate, history, bounds, overlay, hardening, errors', async ({
  app,
  shell,
}) => {
  const title = shell.locator('[data-testid^=tab-t1]').first()
  await expect(shell.getByText('New tab', { exact: true }).first()).toBeVisible()
  await expect(
    shell.getByText('Type a web address, a search, or a local port such as 3000.'),
  ).toBeVisible()

  await navigate(shell, String(server.port))
  await expect(title).toContainText('Page A')
  await expect.poll(async () => (await activeInfo(app)).visible).toBe(true)
  let maxDelta = await expectBoundsEqualSlot(app, shell)

  await navigate(shell, `127.0.0.1:${server.port}/b.html`)
  await expect(title).toContainText('Page B')
  await expect(shell.locator('[data-testid=nav-back]')).toBeEnabled()
  await shell.locator('[data-testid=nav-back]').click()
  await expect(title).toContainText('Page A')
  await expect(shell.locator('[data-testid=nav-forward]')).toBeEnabled()
  await shell.locator('[data-testid=nav-reload]').click()
  await expect(title).toContainText('Page A')

  const url = `http://127.0.0.1:${server.port}/`
  await shell.locator('[data-testid=btn-copy-link]').click()
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(url)

  await app.evaluate(({ shell: sh }) => {
    const g = globalThis as unknown as { __opened: string[] }
    g.__opened = []
    sh.openExternal = async (u: string) => {
      g.__opened.push(u)
    }
  })
  await shell.locator('[data-testid=btn-open-external]').click()
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened[0]))
    .toBe(url)

  // Window resize and divider drag keep the view glued to the slot.
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1100, 760))
  await frames(shell)
  maxDelta = Math.max(maxDelta, await expectBoundsEqualSlot(app, shell))
  const div = await shell.locator('[data-testid=panel-divider]').boundingBox()
  if (!div) throw new Error('no divider')
  const cx = div.x + div.width / 2
  const cy = div.y + div.height / 2
  await shell.mouse.move(cx, cy)
  await shell.mouse.down()
  await shell.mouse.move(cx - 60, cy, { steps: 4 })
  await shell.mouse.move(cx - 120, cy, { steps: 4 })
  await shell.mouse.up()
  await frames(shell)
  maxDelta = Math.max(maxDelta, await expectBoundsEqualSlot(app, shell))

  // Overlay hides the view and restores it with identical bounds.
  const before = (await activeInfo(app)).bounds
  await shell.locator('[data-testid=overlay-open]').click()
  await expect(shell.locator('[data-testid=overlay-test]')).toBeVisible()
  await expect(shell.getByText('Test overlay', { exact: true }).last()).toBeVisible()
  await expect.poll(async () => (await activeInfo(app)).visible).toBe(false)
  await shell
    .getByTestId('overlay-test')
    .getByRole('button', { name: 'Close', exact: true })
    .click()
  await expect.poll(async () => (await activeInfo(app)).visible).toBe(true)
  const after = (await activeInfo(app)).bounds
  expect(after).toEqual(before)

  // Hardening.
  const info = await activeInfo(app)
  expect(info.samePartition).toBe(true)
  expect(info.sandbox).toBe(true)
  expect(info.contextIsolation).toBe(true)
  expect(info.preload).toBeFalsy()
  expect(await guestEval(app, 'typeof window.eva')).toBe('undefined')
  expect(await guestEval(app, 'window.open("about:blank") === null')).toBe(true)
  const perm = await guestEval(
    app,
    'navigator.permissions.query({name:"geolocation"}).then(r=>r.state)',
  )
  expect(perm).not.toBe('granted')
  const geoErr = await guestEval(
    app,
    'new Promise(r => navigator.geolocation.getCurrentPosition(() => r("ok"), () => r("error")))',
  )
  expect(geoErr).toBe('error')

  // Search URL (the request itself is cancelled by the e2e network rule).
  const tabs = await shell.evaluate(() =>
    (window as unknown as { eva: { invoke(c: string, i: unknown): Promise<unknown> } }).eva.invoke(
      'browser.state',
      {},
    ),
  )
  const tabId = (tabs as { ok: true; value: { activeId: string } }).value.activeId
  const res = await shell.evaluate(
    (id) =>
      (
        window as unknown as { eva: { invoke(c: string, i: unknown): Promise<unknown> } }
      ).eva.invoke('browser.navigate', { tabId: id, input: 'hello world' }),
    tabId,
  )
  expect((res as { ok: true; value: { url: string } }).value.url).toBe(
    'https://www.google.com/search?q=hello+world',
  )

  // Error card.
  await navigate(shell, '127.0.0.1:1')
  await expect(shell.getByText('This page could not be loaded')).toBeVisible()
  await expect(shell.getByRole('button', { name: 'Try again' })).toBeVisible()
  await expect.poll(async () => (await activeInfo(app)).visible).toBe(false)

  // Schemes outside http/https/about typed in the address bar never reach the guest view.
  const guestUrl = () =>
    app.evaluate(() => {
      const t = (
        globalThis as unknown as { __evaosTest: { hooks: { browser: { host: HostLike } } } }
      ).__evaosTest
      return t.hooks.browser.host.activeView().webContents.getURL()
    })
  for (const blocked of ['file:///etc/hosts', 'chrome://settings']) {
    await navigate(shell, blocked)
    await expect(shell.getByText('This address cannot be opened here')).toBeVisible()
    await expect(shell.getByRole('button', { name: 'Try again' })).toHaveCount(0)
    expect(await guestUrl()).not.toMatch(/^(file|chrome):/)
    await expect.poll(async () => (await activeInfo(app)).visible).toBe(false)
  }

  recordMetrics('browser', {
    boundsDeltaPx: maxDelta,
    overlayHidesView: true,
    boundsRestoredAfterOverlay: true,
  })
})
