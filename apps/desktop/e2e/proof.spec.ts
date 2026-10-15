import { test, expect } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import { proofShot } from './helpers/proofShot'
import { proofOutDir, recordMetrics } from './helpers/metrics'
import { APP_DIR } from './helpers/paths'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'

type G = {
  __evaosTest: {
    win: { setContentSize(w: number, h: number): void }
    hooks: {
      browser: {
        host: {
          activeView(): { getVisible(): boolean; getBounds(): Record<string, number> }
          snapshot(): { activeId: string }
        }
        pageControl(id: string): { readText(): Promise<string> }
      }
    }
  }
}

const TEST_EXT = path.join(APP_DIR, 'e2e/fixtures/test-extension')
test.use({ launchEnv: { EVAOS_TEST_EXTENSION_DIR: TEST_EXT }, colorScheme: 'dark' })

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

const viewVisible = (app: ElectronApplication) =>
  app.evaluate(() =>
    (globalThis as unknown as G).__evaosTest.hooks.browser.host.activeView().getVisible(),
  )

async function nav(shell: Page, input: string): Promise<void> {
  const addr = shell.locator('[data-testid=address-input]')
  await addr.fill(input)
  await addr.press('Enter')
}

test.beforeEach(async ({ app, shell }) => {
  await app.evaluate(() => (globalThis as unknown as G).__evaosTest.win.setContentSize(1280, 800))
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(1280)
  const d = await app.evaluate(({ screen }) => {
    const p = screen.getPrimaryDisplay()
    return {
      hz: p.displayFrequency,
      scale: p.scaleFactor,
      width: p.size.width,
      height: p.size.height,
    }
  })
  recordMetrics('display', d)
})

test('browser-two-tabs', async ({ app, shell }) => {
  await nav(shell, server.url('/a.html'))
  await expect(shell.locator('[data-testid^=tab-t]').first()).toContainText('Page A')
  await shell.locator('[data-testid=tab-new]').click()
  await expect.poll(() => shell.locator('[data-testid^=tab-t]').count()).toBe(2)
  await shell.locator('[data-testid=tab-t2]').click()
  await nav(shell, server.url('/b.html'))
  await expect(shell.locator('[data-testid=tab-t2]')).toContainText('Page B')
  await expect(shell.locator('[data-testid=tab-t1]')).toContainText('Page A')
  await expect.poll(() => viewVisible(app)).toBe(true)
  const slot = (await shell.locator('[data-testid=browser-slot]').boundingBox())!
  const bounds = await app.evaluate(() =>
    (globalThis as unknown as G).__evaosTest.hooks.browser.host.activeView().getBounds(),
  )
  expect(bounds).toEqual({
    x: Math.round(slot.x),
    y: Math.round(slot.y),
    width: Math.round(slot.width),
    height: Math.round(slot.height),
  })
  await proofShot(app, shell, 'browser-two-tabs')
})

test('browser-suggestions', async ({ app, shell }) => {
  await nav(shell, server.url('/a.html'))
  await expect(shell.locator('[data-testid^=tab-t]').first()).toContainText('Page A')
  await nav(shell, server.url('/b.html'))
  await expect(shell.locator('[data-testid^=tab-t]').first()).toContainText('Page B')
  await shell.locator('[data-testid=address-input]').fill('page')
  await expect(shell.locator('[data-testid=suggestions]')).toBeVisible()
  await expect.poll(() => viewVisible(app)).toBe(false)
  await proofShot(app, shell, 'browser-suggestions')
})

test('overlay-open', async ({ app, shell }) => {
  await nav(shell, server.url('/a.html'))
  await expect(shell.locator('[data-testid^=tab-t]').first()).toContainText('Page A')
  await shell.locator('[data-testid=overlay-open]').click()
  await expect(shell.locator('[data-testid=overlay-test]')).toBeVisible()
  await expect.poll(() => viewVisible(app)).toBe(false)
  await proofShot(app, shell, 'overlay-open')
})

test('import-arc-confirm', async ({ app, shell }) => {
  await nav(shell, server.url('/a.html'))
  await expect(shell.locator('[data-testid^=tab-t]').first()).toContainText('Page A')
  await shell.locator('[data-testid=btn-import-arc]').click()
  await expect(shell.locator('[data-testid=import-arc-modal]')).toBeVisible()
  await expect(shell.getByText('Import Arc logins', { exact: true }).last()).toBeVisible()
  await expect.poll(() => viewVisible(app)).toBe(false)
  await proofShot(app, shell, 'import-arc-confirm')
})

test('extension-loaded', async ({ app, shell }) => {
  await nav(shell, server.url('/a.html'))
  await expect(shell.locator('[data-testid^=tab-t]').first()).toContainText('Page A')
  const text = () =>
    app.evaluate(async () => {
      const t = (globalThis as unknown as G).__evaosTest.hooks.browser
      return t.pageControl(t.host.snapshot().activeId).readText()
    })
  await expect.poll(text, { timeout: 8000 }).toContain('EXT OK')
  await expect.poll(() => viewVisible(app)).toBe(true)
  await proofShot(app, shell, 'extension-loaded')
})

test('chat proof shots from the benchmark exist', async () => {
  test.skip(process.env.EVAOS_PROOF !== '1', 'only meaningful when writing the committed proof')
  const dir = proofOutDir('phase-1')
  for (const n of ['chat-streaming', 'chat-jump-to-latest', 'chat-new-reply'])
    expect(fs.existsSync(path.join(dir, `${n}.png`)), n).toBe(true)
})
