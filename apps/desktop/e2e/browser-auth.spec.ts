import { test, expect } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import {
  guestEval,
  navigate,
  openPage,
  pageTab,
  pageTabs,
  webPanel,
  type BrowserHooks,
} from './helpers/web'
import type { ElectronApplication } from '@playwright/test'

// Sign-in popups (T-01-37) and the passkey bar, on local pages only (no network).

/** A real click (trusted input, so it counts as a gesture) on `selector` in page `id`. */
function guestClick(app: ElectronApplication, id: string, selector: string): Promise<void> {
  return app.evaluate(
    async (_e, a) => {
      const wc = (globalThis as unknown as BrowserHooks).__evaosTest.hooks.browser.host.tabById(
        a.id,
      )!
      const r = (await wc.executeJavaScript(
        `(() => { const b = document.querySelector(${JSON.stringify(a.sel)}).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } })()`,
      )) as { x: number; y: number }
      const at = { x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 }
      wc.sendInputEvent({ type: 'mouseDown', ...at })
      wc.sendInputEvent({ type: 'mouseUp', ...at })
    },
    { id, sel: selector },
  )
}

/** Script-opened windows (sign-in popups): every BrowserWindow, the shell being a BaseWindow. */
function popupUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()),
  )
}

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

test('a sign-in button opens a real popup that talks to its opener and closes itself', async ({
  app,
  shell,
}) => {
  const id = await openPage(shell, server.url('/signin.html'), 'Sign in')

  // Without a click, a page cannot open a popup.
  expect(
    await guestEval(app, id, `window.open('/provider.html', 'x', 'width=300,height=300') === null`),
  ).toBe(true)
  expect(await popupUrls(app)).toEqual([])

  await guestClick(app, id, '#signin')
  await expect.poll(() => popupUrls(app)).toEqual([server.url('/provider.html')])
  const prefs = await app.evaluate(({ BrowserWindow, session }) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents
    // Electron has it at runtime but leaves it out of its typings (browser-basic does the same).
    const withPrefs: { getLastWebPreferences(): Electron.WebPreferences | null } =
      wc as unknown as { getLastWebPreferences(): Electron.WebPreferences | null }
    const p = withPrefs.getLastWebPreferences()
    return {
      samePartition: wc.session === session.fromPartition('persist:browser'),
      sandbox: p?.sandbox,
      contextIsolation: p?.contextIsolation,
      nodeIntegration: p?.nodeIntegration,
    }
  })
  expect(prefs).toEqual({
    samePartition: true,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  })

  // The provider posts to window.opener, then window.close() closes the popup.
  await expect
    .poll(() => guestEval(app, id, `document.getElementById('result').textContent`))
    .toBe('signed in: abc123')
  await expect.poll(() => popupUrls(app)).toEqual([])
  expect(await guestEval(app, id, 'window.__popup.closed')).toBe(true)
  // The popup never became a page tab.
  await expect(pageTabs(shell)).toHaveCount(1)
})

test('a passkey request shows the bar; Open in opens the page outside, Dismiss hides it', async ({
  app,
  shell,
}) => {
  await app.evaluate(({ shell: sh }) => {
    const g = globalThis as unknown as { __opened: string[] }
    g.__opened = []
    sh.openExternal = async (u: string) => {
      g.__opened.push(u)
    }
  })
  const url = server.url('/a.html')
  const id = await openPage(shell, url, 'Page A')
  const panel = webPanel(shell, id)
  const bar = panel.locator('[data-testid=passkey-bar]')

  // Passkey autofill (conditional mediation) runs silently on many sign-in pages: no bar.
  await guestEval(
    app,
    id,
    `navigator.credentials.get({ mediation: 'conditional', signal: AbortSignal.timeout(500),
      publicKey: { challenge: new Uint8Array(32) } }).catch(() => {}); true`,
  )
  await shell.waitForTimeout(800)
  await expect(bar).toHaveCount(0)

  await guestEval(
    app,
    id,
    `navigator.credentials.get({ signal: AbortSignal.timeout(30000),
      publicKey: { challenge: new Uint8Array(32) } }).catch(() => {}); true`,
  )
  await expect(bar).toBeVisible()
  await expect(bar).toContainText("Passkeys don't work here.")
  await expect(panel.locator('[data-testid=passkey-open-external]')).toHaveText(/^Open in /)
  await panel.locator('[data-testid=passkey-open-external]').click()
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened))
    .toEqual([url])

  await panel.locator('[data-testid=passkey-dismiss]').click()
  await expect(bar).toHaveCount(0)

  // A new page starts without the bar.
  await guestEval(
    app,
    id,
    `navigator.credentials.create({ signal: AbortSignal.timeout(30000), publicKey: {
      rp: { name: 'x' }, user: { id: new Uint8Array(8), name: 'x', displayName: 'x' },
      challenge: new Uint8Array(32), pubKeyCredParams: [{ type: 'public-key', alg: -7 }] } }).catch(() => {}); true`,
  )
  await expect(bar).toBeVisible()
  await navigate(shell, id, server.url('/b.html'))
  await expect(pageTab(shell, id)).toContainText('Page B')
  await expect(bar).toHaveCount(0)
})
