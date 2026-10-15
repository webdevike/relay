import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeEvaFixture, type EvaFixture } from './helpers/eva-fixture'
import { proofShot } from './helpers/proofShot'
import { startStaticServer, type StaticServer } from './helpers/static-server'

type Shell = { __evaosShell: { openPlace(p: string, n?: boolean): void } }
type G = {
  __evaosTest: { hooks: { browser: { host: { activeView(): { getVisible(): boolean } } } } }
}

const test = base.extend<{ evaFx: EvaFixture }>({
  evaFx: async ({}, use) => {
    const fx = makeEvaFixture({ minuteMs: 300 })
    await use(fx)
    fx.cleanup()
  },
  launchEnv: async ({ evaFx }, use) => {
    await use(evaFx.env)
  },
})

test.use({ startOnChat: false, colorScheme: 'dark' })

const PHASE = { phase: 'phase-3' }
const sel = (id: string): string => `[data-testid=${id}]`
const argvs = (fx: EvaFixture): string[][] =>
  (fx.gateLog() as Array<{ argv: string[] }>).map((e) => e.argv)
const viewVisible = (app: ElectronApplication): Promise<boolean> =>
  app.evaluate(() =>
    (globalThis as unknown as G).__evaosTest.hooks.browser.host.activeView().getVisible(),
  )
const tabCount = (shell: Page): Promise<number> =>
  shell.locator('[data-testid^=browser-tab-t]').count()

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

function lockGate(fx: EvaFixture): void {
  const file = fx.env.FAKE_GATE_STATE!
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  state.locked = true
  state.lockedAt = new Date().toISOString()
  state.reason = 'Break due'
  state.active = null
  fs.writeFileSync(file, JSON.stringify(state))
}

async function showBrowser(app: ElectronApplication, shell: Page): Promise<void> {
  const addr = shell.locator(sel('address-input'))
  await addr.fill(server.url('/a.html'))
  await addr.press('Enter')
  await expect.poll(() => viewVisible(app)).toBe(true)
}

async function waitLocked(shell: Page): Promise<void> {
  await expect(shell.locator(sel('gate-overlay'))).toBeVisible({ timeout: 6000 })
}

test.beforeEach(async ({ shell }) => {
  await expect(shell.locator(sel('dash-hero'))).toBeVisible()
})

test('locking hides the browser and swallows chords and Escape', async ({ app, shell, evaFx }) => {
  await showBrowser(app, shell)
  const before = await tabCount(shell)
  lockGate(evaFx)
  await waitLocked(shell)
  await expect.poll(() => viewVisible(app)).toBe(false)
  await shell.keyboard.press('Meta+t')
  await shell.keyboard.press('Meta+n')
  await shell.keyboard.press('Escape')
  await expect(shell.locator(sel('new-todo-modal'))).toBeHidden()
  expect(await tabCount(shell)).toBe(before)
  await expect(shell.locator(sel('gate-overlay'))).toBeVisible()
  await expect(shell.locator(sel('gate-start'))).toBeFocused()
  await proofShot(app, shell, 'gate-locked', PHASE)
})

test('start, timer, done unlocks and brings the browser back', async ({ app, shell, evaFx }) => {
  await showBrowser(app, shell)
  lockGate(evaFx)
  await waitLocked(shell)
  await shell.locator(sel('gate-pick-stretch')).click()
  await shell.locator(sel('gate-start')).click()
  await expect(shell.locator(sel('gate-countdown'))).toBeVisible()
  await expect(shell.locator(sel('gate-done'))).toBeDisabled()
  await proofShot(app, shell, 'gate-timer', PHASE)
  await expect(shell.locator(sel('gate-done'))).toBeEnabled({ timeout: 8000 })
  await shell.locator(sel('gate-done')).click()
  await expect(shell.locator(sel('gate-overlay'))).toHaveCount(0, { timeout: 2000 })
  await expect.poll(() => viewVisible(app)).toBe(true)
  const a = argvs(evaFx)
  expect(a).toContainEqual(['start', 'stretch', '--json'])
  expect(a).toContainEqual(['done', 'stretch', '--json'])
})

test('a photo habit needs the timer and a chosen photo', async ({ app, shell, evaFx }) => {
  const png = path.join(evaFx.dir, 'proof-pic.png')
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgo=', 'base64'))
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as never
  }, png)
  lockGate(evaFx)
  await waitLocked(shell)
  await shell.locator(sel('gate-pick-walk')).click()
  await shell.locator(sel('gate-start')).click()
  await expect(shell.locator(sel('gate-countdown'))).toBeVisible()
  await expect(shell.locator(sel('gate-photo'))).toBeVisible()
  await expect(shell.locator("text=Time's up. Mark break done to unlock.")).toBeVisible({
    timeout: 10_000,
  })
  await expect(shell.locator(sel('gate-done'))).toBeDisabled()
  await shell.locator(sel('gate-photo')).click()
  await expect(shell.locator(sel('gate-photo-name'))).toHaveText('proof-pic.png')
  await expect(shell.locator(sel('gate-done'))).toBeEnabled()
  await shell.locator(sel('gate-done')).click()
  await expect(shell.locator(sel('gate-overlay'))).toHaveCount(0, { timeout: 2000 })
  const done = argvs(evaFx).find((a) => a[0] === 'done' && a[1] === 'walk')!
  expect(done[done.indexOf('--photo') + 1]).toBe(png)
})

test('override needs a reason and is recorded in the history', async ({ app, shell, evaFx }) => {
  lockGate(evaFx)
  await waitLocked(shell)
  await shell.locator(sel('gate-override')).click()
  await shell.locator(sel('gate-override-reason')).fill('ab')
  await expect(shell.locator(sel('gate-overlay'))).toContainText('Give a reason to override.')
  await expect(shell.locator(sel('gate-override-submit'))).toBeDisabled()
  await shell.locator(sel('gate-override-reason')).fill('Too tired today')
  await expect(shell.locator(sel('gate-override-submit'))).toBeEnabled()
  await proofShot(app, shell, 'gate-override', PHASE)
  await shell.locator(sel('gate-override-submit')).click()
  await expect(shell.locator(sel('gate-overlay'))).toHaveCount(0, { timeout: 2000 })
  expect(argvs(evaFx)).toContainEqual(['override', 'Too tired today', '--json'])
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('habits'))
  await expect(shell.locator(sel('habit-history'))).toContainText('Overridden: Too tired today')
})

test('a failing gate command shows the error', async ({ shell, evaFx }) => {
  lockGate(evaFx)
  await waitLocked(shell)
  fs.writeFileSync(`${evaFx.env.FAKE_GATE_STATE}.fail`, '')
  await shell.locator(sel('gate-start')).click()
  await expect(shell.getByRole('alert')).toContainText('simulated failure')
})
