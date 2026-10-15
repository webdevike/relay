import { test, expect } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import { recordMetrics } from './helpers/metrics'
import type { Page } from '@playwright/test'

interface PC {
  readText(): Promise<string>
  click(sel: string): Promise<boolean>
  evaluate(expr: string): Promise<unknown>
  navigate(url: string): void
}
type G = {
  __evaosTest: {
    hooks: {
      browser: {
        host: {
          activeView(): { webContents: { focus(): void; sendInputEvent(e: unknown): void } }
          snapshot(): { tabs: Array<{ id: string; title: string }>; activeId: string }
        }
        pageControl(tabId: string): PC
      }
    }
  }
}

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

test('PageControl over CDP, DevTools detached and coexisting', async ({ app, shell }) => {
  await nav(shell, server.url('/b.html'))
  await expect(shell.locator('[data-testid^=tab-t]').first()).toContainText('Page B')
  const tabId = await app.evaluate(
    () => (globalThis as unknown as G).__evaosTest.hooks.browser.host.snapshot().activeId,
  )
  const pc = (fn: string, arg?: string) =>
    app.evaluate(
      async (_e, a) => {
        const p = (globalThis as unknown as G).__evaosTest.hooks.browser.pageControl(a.tabId)
        const f = (p as unknown as Record<string, (x?: string) => Promise<unknown>>)[a.fn]!
        return f.call(p, a.arg)
      },
      { tabId, fn, arg },
    )

  const text = (await pc('readText')) as string
  expect(text).toContain('PAGE B TEXT')
  expect(await pc('click', '#btn')).toBe(true)
  expect(await pc('readText')).toContain('CLICKED')
  expect(await pc('click', '#nope')).toBe(false)
  expect(await pc('evaluate', 'document.title')).toBe('Page B')
  await pc('navigate', server.url('/a.html'))
  await expect(shell.locator('[data-testid^=tab-t]').first()).toContainText('Page A')

  // PageControl.navigate goes through the host's allow-list like the address bar does.
  await pc('navigate', 'file:///etc/hosts')
  await expect(shell.getByText('This address cannot be opened here')).toBeVisible()
  expect(await pc('evaluate', 'location.href')).toBe(server.url('/a.html'))
  await pc('navigate', server.url('/a.html'))
  await expect(shell.getByText('This address cannot be opened here')).toHaveCount(0)
  await expect(shell.locator('[data-testid^=tab-t]').first()).toContainText('Page A')

  await app.evaluate(() => {
    const wc = (globalThis as unknown as G).__evaosTest.hooks.browser.host.activeView().webContents
    wc.focus()
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'i', modifiers: ['meta', 'alt'] })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'i', modifiers: ['meta', 'alt'] })
  })
  await expect
    .poll(() => app.windows().some((p) => p.url().startsWith('devtools://')), { timeout: 5000 })
    .toBe(true)
  const after = (await pc('readText')) as string
  const devtoolsCoexist = after.includes('PAGE A TEXT')
  expect(devtoolsCoexist).toBe(true)
  recordMetrics('browser', { cdpText: text.slice(0, 80), cdpClick: true, devtoolsCoexist })
})
