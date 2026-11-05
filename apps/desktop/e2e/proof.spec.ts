import { test, expect } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import { proofShot } from './helpers/proofShot'
import { proofOutDir, recordMetrics } from './helpers/metrics'
import { APP_DIR } from './helpers/paths'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { navigate, newPage, openPage, pageTab, slotRect, viewOf, webPanel } from './helpers/web'

type G = {
  __evaosTest: {
    win: { setContentSize(w: number, h: number): void }
    hooks: { browser: { pageControl(id: string): { readText(): Promise<string> } } }
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
  const a = await openPage(shell, server.url('/a.html'), 'Page A')
  const b = await newPage(shell)
  await navigate(shell, b, server.url('/b.html'))
  await expect(pageTab(shell, b)).toContainText('Page B')
  await expect(pageTab(shell, a)).toContainText('Page A')
  await expect.poll(async () => (await viewOf(app, b))?.visible).toBe(true)
  await expect.poll(async () => (await viewOf(app, b))?.bounds).toEqual(await slotRect(shell, b))
  await proofShot(app, shell, 'browser-two-tabs')
})

test('browser-suggestions', async ({ app, shell }) => {
  const id = await openPage(shell, server.url('/a.html'), 'Page A')
  await navigate(shell, id, server.url('/b.html'))
  await expect(pageTab(shell, id)).toContainText('Page B')
  await webPanel(shell, id).locator('[data-testid=address-input]').fill('page')
  await expect(shell.locator('[data-testid=suggestions]')).toBeVisible()
  await expect.poll(async () => (await viewOf(app, id))?.visible).toBe(false)
  await proofShot(app, shell, 'browser-suggestions')
})

test('overlay-open', async ({ app, shell }) => {
  const id = await openPage(shell, server.url('/a.html'), 'Page A')
  await shell.evaluate(() =>
    (
      window as unknown as { __evaosShell: { openTestOverlay(): void } }
    ).__evaosShell.openTestOverlay(),
  )
  await expect(shell.locator('[data-testid=overlay-test]')).toBeVisible()
  await expect.poll(async () => (await viewOf(app, id))?.visible).toBe(false)
  await proofShot(app, shell, 'overlay-open')
})

test('import-arc-confirm', async ({ app, shell }) => {
  const id = await openPage(shell, server.url('/a.html'), 'Page A')
  await webPanel(shell, id).locator('[data-testid=btn-import-arc]').click()
  await expect(shell.locator('[data-testid=import-arc-modal]')).toBeVisible()
  await expect(shell.getByText('Import Arc logins', { exact: true }).last()).toBeVisible()
  await expect.poll(async () => (await viewOf(app, id))?.visible).toBe(false)
  await proofShot(app, shell, 'import-arc-confirm')
})

test('extension-loaded', async ({ app, shell }) => {
  const id = await openPage(shell, server.url('/a.html'), 'Page A')
  const text = () =>
    app.evaluate(
      async (_e, tabId) =>
        (globalThis as unknown as G).__evaosTest.hooks.browser.pageControl(tabId).readText(),
      id,
    )
  await expect.poll(text, { timeout: 8000 }).toContain('EXT OK')
  await expect.poll(async () => (await viewOf(app, id))?.visible).toBe(true)
  await proofShot(app, shell, 'extension-loaded')
})

test('chat proof shots from the benchmark exist', async () => {
  test.skip(process.env.EVAOS_PROOF !== '1', 'only meaningful when writing the committed proof')
  const dir = proofOutDir('phase-1')
  for (const n of ['chat-streaming', 'chat-jump-to-latest', 'chat-new-reply'])
    expect(fs.existsSync(path.join(dir, `${n}.png`)), n).toBe(true)
})
