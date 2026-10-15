import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'

type G = {
  __evaosTest: {
    win: { setContentSize(w: number, h: number): void }
    hooks: { browser: { host: { activeView(): { getVisible(): boolean } } } }
  }
}
type Snap = {
  active: number
  list: Array<{ id: number; page: string; pinned: boolean; title: string }>
}
type Shell = { __evaosShell: { tabs(): Snap; openPlace(p: string, n?: boolean): void } }

test.use({ colorScheme: 'dark', startOnChat: false })

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

const tabs = (shell: Page): Promise<Snap> =>
  shell.evaluate(() => (window as unknown as Shell).__evaosShell.tabs())
const titles = async (shell: Page): Promise<string[]> =>
  (await tabs(shell)).list.map((t) => t.title)
const open = (shell: Page, page: string, newTab = false): Promise<void> =>
  shell.evaluate(
    ([p, n]) => (window as unknown as Shell).__evaosShell.openPlace(p as string, n as boolean),
    [page, newTab],
  )
const viewVisible = (app: import('@playwright/test').ElectronApplication): Promise<boolean> =>
  app.evaluate(() =>
    (globalThis as unknown as G).__evaosTest.hooks.browser.host.activeView().getVisible(),
  )

const layoutTabs = (dir: string): { active?: number; list?: Array<Record<string, unknown>> } => {
  try {
    const f = JSON.parse(fs.readFileSync(path.join(dir, 'layout.json'), 'utf8')) as {
      tabs?: { active?: number; list?: Array<Record<string, unknown>> }
    }
    return f.tabs ?? {}
  } catch {
    return {}
  }
}

async function focusShell(shell: Page): Promise<void> {
  await shell.locator('[data-testid=tabbar-drag]').click()
}

test('fresh launch has one active Dashboard tab', async ({ shell }) => {
  await expect(shell.locator('[role=tab]')).toHaveCount(1)
  await expect(shell.locator('[role=tab]').first()).toHaveAttribute('data-active', 'true')
  expect(await titles(shell)).toEqual(['Dashboard'])
})

test('Cmd+T, Cmd+W and the last tab', async ({ shell }) => {
  await focusShell(shell)
  await shell.keyboard.press('Meta+t')
  await expect.poll(async () => (await titles(shell)).length).toBe(2)
  await shell.keyboard.press('Meta+t')
  await expect.poll(async () => await titles(shell)).toEqual(['Dashboard', 'New chat', 'New chat'])
  expect((await tabs(shell)).active).toBe(2)
  await shell.keyboard.press('Meta+w')
  await expect.poll(async () => (await titles(shell)).length).toBe(2)
  await shell.keyboard.press('Meta+w')
  await expect.poll(async () => (await titles(shell)).length).toBe(1)
  await shell.keyboard.press('Meta+w')
  await expect.poll(async () => await titles(shell)).toEqual(['Dashboard'])
})

test('navigation, history chords and place dedupe', async ({ shell }) => {
  await focusShell(shell)
  await open(shell, 'inbox')
  await expect.poll(() => titles(shell)).toEqual(['Inbox'])
  await shell.keyboard.press('Meta+[')
  await expect.poll(() => titles(shell)).toEqual(['Dashboard'])
  await shell.keyboard.press('Meta+]')
  await expect.poll(() => titles(shell)).toEqual(['Inbox'])

  await open(shell, 'jobs', true)
  await expect.poll(() => titles(shell)).toEqual(['Inbox', 'Jobs'])
  await open(shell, 'inbox')
  await expect.poll(async () => (await tabs(shell)).active).toBe(0)
  expect((await tabs(shell)).list).toHaveLength(2)
})

test('context menu, pin, pinned rules', async ({ app, shell }) => {
  const addr = shell.locator('[data-testid=address-input]')
  await addr.fill(String(server.port))
  await addr.press('Enter')
  await open(shell, 'inbox', true)
  await expect.poll(async () => (await tabs(shell)).list.length).toBe(2)
  const [first, second] = (await tabs(shell)).list
  await expect.poll(() => viewVisible(app)).toBe(true)

  await shell.locator(`[data-testid=tab-${second!.id}]`).click({ button: 'right' })
  await expect(shell.locator('[data-testid=tab-menu]')).toBeVisible()
  await expect.poll(() => viewVisible(app)).toBe(false)
  await shell.keyboard.press('Escape')
  await expect(shell.locator('[data-testid=tab-menu]')).toBeHidden()
  await expect.poll(() => viewVisible(app)).toBe(true)

  await shell.locator(`[data-testid=tab-${first!.id}]`).click({ button: 'right' })
  await shell.locator('[data-testid=tab-menu-pin]').click()
  const pinned = shell.locator(`[data-testid=tab-pinned-${first!.id}]`)
  await expect(pinned).toBeVisible()
  await expect(shell.locator(`[data-testid=tab-close-${first!.id}]`)).toHaveCount(0)
  await pinned.hover()
  await expect(shell.getByRole('tooltip', { name: 'Dashboard' })).toBeVisible()

  // Cmd+W with the pinned tab active does nothing.
  await pinned.click()
  await shell.keyboard.press('Meta+w')
  expect((await tabs(shell)).list).toHaveLength(2)
  // Navigating from a pinned tab opens another tab.
  await open(shell, 'jobs')
  await expect.poll(async () => (await tabs(shell)).list.length).toBe(3)
  expect((await tabs(shell)).list[0]!.page).toBe('dashboard')

  // Close others skips pinned tabs.
  await shell.locator(`[data-testid=tab-${second!.id}]`).click({ button: 'right' })
  await shell.locator('[data-testid=tab-menu-close-others]').click()
  await expect.poll(async () => (await titles(shell)).length).toBe(2)
  expect((await tabs(shell)).list[0]!.pinned).toBe(true)
})

test('tabs persist across a relaunch', async ({ app, shell, configDir }) => {
  await open(shell, 'inbox', true)
  await expect.poll(async () => (await tabs(shell)).list.length).toBe(2)
  const first = (await tabs(shell)).list[0]!
  await shell.locator(`[data-testid=tab-${first.id}]`).click({ button: 'right' })
  await shell.locator('[data-testid=tab-menu-pin]').click()
  await shell.locator('[data-testid=tab-new]').click()
  await expect.poll(async () => (await tabs(shell)).list.length).toBe(3)
  const before = await tabs(shell)
  await expect
    .poll(() => layoutTabs(configDir).list?.some((t) => t.pinned === true) ?? false)
    .toBe(true)
  await expect.poll(() => layoutTabs(configDir).list?.length).toBe(3)
  const entry = layoutTabs(configDir).list![0]!
  expect(Object.keys(entry).sort()).toEqual(['back', 'forward', 'here', 'pinned'].sort())
  await app.close()

  const app2 = await launchApp(configDir)
  try {
    const page = await app2.firstWindow()
    await page.waitForSelector('[data-testid=rail]', { state: 'attached' })
    await expect(page.locator('[role=tab]')).toHaveCount(3)
    const after = await tabs(page)
    expect(after.list.map((t) => [t.title, t.pinned])).toEqual(
      before.list.map((t) => [t.title, t.pinned]),
    )
    expect(after.active).toBe(before.active)
  } finally {
    await app2.close()
  }
})

test('sidebar toggle keeps clear of the traffic lights and folds', async ({ app, shell }) => {
  await app.evaluate(() => (globalThis as unknown as G).__evaosTest.win.setContentSize(1280, 800))
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(1280)
  const toggle = shell.locator('[data-testid=sidebar-toggle]')
  await expect(toggle).toHaveAttribute('aria-label', 'Hide sidebar')
  await focusShell(shell)
  await shell.keyboard.press('Meta+b')
  await expect(toggle).toHaveAttribute('aria-label', 'Show sidebar')
  await expect.poll(async () => (await toggle.boundingBox())!.x).toBeGreaterThanOrEqual(80)
  await shell.keyboard.press('Meta+b')
  await expect(toggle).toHaveAttribute('aria-label', 'Hide sidebar')

  await app.evaluate(() => (globalThis as unknown as G).__evaosTest.win.setContentSize(760, 720))
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(760)
  await expect(toggle).toHaveAttribute(
    'aria-label',
    'Sidebar hidden to fit the window. Widen the window or close the panel to bring it back.',
  )
  await expect.poll(async () => (await toggle.boundingBox())!.x).toBeGreaterThanOrEqual(80)
})

test('panel toggle and Cmd+Shift+B agree', async ({ shell }) => {
  const toggle = shell.locator('[data-testid=panel-toggle]')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await focusShell(shell)
  await shell.keyboard.press('Meta+Shift+b')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await shell.keyboard.press('Meta+Shift+b')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
})
