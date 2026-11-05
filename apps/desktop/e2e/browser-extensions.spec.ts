import { test, expect } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import { recordMetrics } from './helpers/metrics'
import { APP_DIR } from './helpers/paths'
import { openPage, webPanel } from './helpers/web'
import * as path from 'node:path'

interface PC {
  readText(): Promise<string>
  evaluate(expr: string): Promise<unknown>
}
type G = { __evaosTest: { hooks: { browser: { pageControl(tabId: string): PC } } } }

const TEST_EXT = path.join(APP_DIR, 'e2e/fixtures/test-extension')
test.use({ launchEnv: { EVAOS_TEST_EXTENSION_DIR: TEST_EXT } })

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

test('a checked-in MV3 extension runs its content script in persist:browser only', async ({
  app,
  shell,
}) => {
  const list = (await shell.evaluate(() =>
    (window as unknown as { eva: { invoke(c: string, i: unknown): Promise<unknown> } }).eva.invoke(
      'browser.extensions',
      {},
    ),
  )) as { ok: boolean; value: { extensions: Array<{ name: string }> } }
  expect(list.ok).toBe(true)
  expect(list.value.extensions.map((e) => e.name)).toContain('EvaOS Test Extension')

  const tabId = await openPage(shell, server.url('/a.html'), 'Page A')
  const pc = (fn: 'readText' | 'evaluate', arg?: string) =>
    app.evaluate(
      async (_e, a) => {
        const p = (globalThis as unknown as G).__evaosTest.hooks.browser.pageControl(a.tabId)
        return a.fn === 'readText' ? p.readText() : p.evaluate(a.arg!)
      },
      { tabId, fn, arg },
    )
  await expect.poll(() => pc('readText'), { timeout: 5000 }).toContain('EXT OK')
  expect(await pc('evaluate', 'document.documentElement.dataset.ext')).toBe('loaded')

  // The extension is bound to the guest partition only.
  expect(await shell.locator('#ext-ok').count()).toBe(0)
  recordMetrics('browser', { extensionLoaded: true, extensionContentScript: true })
})

test('extension action button shows in the toolbar and opens its popup', async ({ app, shell }) => {
  // Actions act on the active page, so they show in that page's toolbar.
  const tabId = await openPage(shell, server.url('/a.html'), 'Page A')
  const actions = webPanel(shell, tabId).locator('[data-testid=extension-actions]')
  const action = actions.locator('browser-action-list')
  await expect(action).toBeAttached()
  const button = actions.locator('browser-action-list >> [part=action]').first()
  let result = 'ok'
  try {
    await expect(button).toBeVisible({ timeout: 8000 })
    await button.click()
    await expect
      .poll(
        async () =>
          app
            .windows()
            .map((w) => w.url())
            .find((u) => u.startsWith('chrome-extension://') && u.includes('popup.html')) ?? '',
        { timeout: 8000 },
      )
      .toContain('chrome-extension://')
    const popup = app.windows().find((w) => w.url().startsWith('chrome-extension://'))!
    await expect(popup.locator('body')).toContainText('TEST POPUP')
  } catch (e) {
    result = `deferred: ${(e as Error).message.split('\n')[0]}`
    throw e
  } finally {
    recordMetrics('browser', { extensionPopup: result })
  }
})
