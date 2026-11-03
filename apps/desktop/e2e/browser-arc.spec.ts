import { test, expect } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import { proofShot } from './helpers/proofShot'
import { recordMetrics } from './helpers/metrics'
import { FIXTURES_DIR } from './helpers/paths'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'

const MARK = path.join(os.tmpdir(), `evaos-arc-mark-${process.pid}`)
test.use({
  launchEnv: {
    EVAOS_ARC_EXPORT_CMD: JSON.stringify([
      'node',
      path.join(FIXTURES_DIR, 'arc-export-fixture.mjs'),
    ]),
    ARC_FIXTURE_MARK: MARK,
  },
})

type G = {
  __evaosTest: {
    errors: string[]
    hooks: {
      browser: {
        host: { activeView(): { getVisible(): boolean }; snapshot(): { activeId: string } }
        pageControl(id: string): { readText(): Promise<string> }
      }
    }
  }
}

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
  fs.rmSync(MARK, { force: true })
})
test.afterAll(async () => {
  await server.close()
  fs.rmSync(MARK, { force: true })
})

async function nav(shell: Page, input: string): Promise<void> {
  const addr = shell.locator('[data-testid=address-input]')
  await addr.fill(input)
  await addr.press('Enter')
}

test('Import Arc logins: confirm modal, cookies only in persist:browser, never on launch', async ({
  app,
  shell,
}) => {
  // Launch alone must not run the exporter.
  expect(fs.existsSync(MARK)).toBe(false)

  await nav(shell, server.url('/account.html'))
  await expect(shell.locator('[data-testid^=browser-tab-t]').first()).toContainText('Account')
  const text = () =>
    app.evaluate(async () => {
      const t = (globalThis as unknown as G).__evaosTest.hooks.browser
      return t.pageControl(t.host.snapshot().activeId).readText()
    })
  await expect.poll(text).toContain('SIGNED OUT')

  await shell.locator('[data-testid=btn-import-arc]').click()
  await expect(shell.locator('[data-testid=import-arc-modal]')).toBeVisible()
  await expect(shell.getByText('Import Arc logins', { exact: true }).last()).toBeVisible()
  await expect
    .poll(() =>
      app.evaluate(() =>
        (globalThis as unknown as G).__evaosTest.hooks.browser.host.activeView().getVisible(),
      ),
    )
    .toBe(false)
  expect(fs.existsSync(MARK)).toBe(false)
  await proofShot(app, shell, 'harness-import-arc-modal')

  await shell.locator('[data-testid=import-arc-confirm]').click()
  await expect(shell.getByText('Imported 3 logins. Reloading the page.')).toBeVisible()
  await expect.poll(text).toContain('SIGNED IN fixture-user')
  expect(fs.existsSync(MARK)).toBe(true)

  const counts = await app.evaluate(async ({ session }) => ({
    guest: (await session.fromPartition('persist:browser').cookies.get({ name: 'evaos_session' }))
      .length,
    dflt: (await session.defaultSession.cookies.get({ name: 'evaos_session' })).length,
  }))
  expect(counts).toEqual({ guest: 1, dflt: 0 })

  const errors = await app.evaluate(() => (globalThis as unknown as G).__evaosTest.errors)
  expect(JSON.stringify(errors)).not.toContain('fixture-user')
  recordMetrics('browser', { arcImportCount: 3 })
})
