import { test, expect } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import { recordMetrics } from './helpers/metrics'
import { APP_DIR } from './helpers/paths'
import * as path from 'node:path'
import type { Page } from '@playwright/test'

interface PC {
  readText(): Promise<string>
  evaluate(expr: string): Promise<unknown>
}
type G = {
  __evaosTest: {
    hooks: {
      browser: {
        host: { snapshot(): { activeId: string } }
        pageControl(tabId: string): PC
      }
    }
  }
}

const TEST_EXT = path.join(APP_DIR, 'e2e/fixtures/test-extension')
test.use({ launchEnv: { EVAOS_TEST_EXTENSION_DIR: TEST_EXT } })

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

async function nav(shell: Page, input: string): Promise<void> {
  const addr = shell.locator('[data-testid=address-input]')
  await addr.fill(input)
  await addr.press('Enter')
}

test('a checked-in MV3 extension runs its content script in persist:browser only', async ({
  app,
  shell,
}) => {
  const list = (await shell.evaluate(() =>
    (
      window as unknown as { eva: { invoke(c: string, i: unknown): Promise<unknown> } }
    ).eva.invoke('browser.extensions', {}),
  )) as { ok: boolean; value: { extensions: Array<{ name: string }> } }
  expect(list.ok).toBe(true)
  expect(list.value.extensions.map((e) => e.name)).toContain('EvaOS Test Extension')

  await nav(shell, server.url('/a.html'))
  await expect(shell.locator('[data-testid^=tab-t]').first()).toContainText('Page A')
  const tabId = await app.evaluate(
    () => (globalThis as unknown as G).__evaosTest.hooks.browser.host.snapshot().activeId,
  )
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
