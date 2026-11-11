import { test, expect } from './fixtures'
import { proofShot } from './helpers/proofShot'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import { openPage, pageIds, paneOfPage, webPanel } from './helpers/web'

// The shared browser: Relay's page tabs read like a real browser (one-click New tab, an address
// field that shows the host first), and assistants drive pages in Isaac's signed-in session.

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

test('browser chrome: New tab in one click, host-first address', async ({ app, shell }) => {
  const first = await openPage(shell, server.url('/a.html?q=1'), 'Page A')
  const panel = webPanel(shell, first)
  const shown = panel.locator('[data-testid=address-display]')
  await expect(shown).toHaveText(`http://127.0.0.1:${server.port}/a.html?q=1`)
  await expect(shown.locator('span')).toHaveText('/a.html?q=1')
  await proofShot(app, shell, 'chrome-address', { phase: 'shared-browser' })
  // Editing shows the whole address as typed.
  await panel.locator('[data-testid=address-input]').click()
  await expect(shown).toHaveCount(0)
  await expect(panel.locator('[data-testid=address-input]')).toHaveValue(server.url('/a.html?q=1'))
  await shell.keyboard.press('Escape')

  // A pane of pages: + opens a blank page right there, its address focused.
  const pane = await paneOfPage(shell, first)
  await shell.locator(`[data-testid=page-new-tab-${pane}]`).click()
  await expect.poll(async () => (await pageIds(shell)).length).toBe(2)
  const second = (await pageIds(shell)).find((x) => x !== first)!
  expect(await paneOfPage(shell, second)).toBe(pane)
  await expect(webPanel(shell, second).locator('[data-testid=address-input]')).toBeFocused()
  // The add menu stays one click away, behind the chevron.
  await shell.locator(`[data-testid=pane-add-${pane}]`).click()
  await expect(shell.locator(`[data-testid=pane-add-menu-${pane}]`)).toBeVisible()
})
