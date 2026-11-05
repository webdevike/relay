import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import { navigate, newPage, pageTabs, viewVisible } from './helpers/web'

type G = {
  __evaosTest: {
    win: { setContentSize(w: number, h: number): void }
  }
}
type Snap = {
  active: number
  list: Array<{ id: number; page: string; pinned: boolean; title: string }>
}
type Shell = {
  __evaosShell: { tabs(): Snap; openPlace(p: string, n?: boolean, extra?: object): void }
}

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
const open = (shell: Page, page: string, newTab = false, extra: object = {}): Promise<void> =>
  shell.evaluate(
    ([p, n, e]) =>
      (window as unknown as Shell).__evaosShell.openPlace(p as string, n as boolean, e as object),
    [page, newTab, extra] as const,
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

// Tool panes have tabs too: the app's tabs are the ones in the tab bar (dockview's tab element
// holds Relay's `.eva-tab`, which says whether it is in front).
const APP_TAB = '[data-testid=tabbar] .eva-tab'

test('fresh launch has one active Dashboard tab', async ({ shell }) => {
  await expect(shell.locator(APP_TAB)).toHaveCount(1)
  await expect(shell.locator(APP_TAB).first()).toHaveAttribute('data-active', 'true')
  expect(await titles(shell)).toEqual(['Dashboard'])
})

/**
 * A new chat from the lead pane's + menu (a new chat is a workspace of its own). With `draft`
 * typed in, it stays when left; an empty one closes.
 */
async function newChat(shell: Page, draft?: string): Promise<void> {
  await shell.locator('[data-testid=tab-new]').click()
  await shell.locator('[data-testid=pane-add-new-chat-p1]').click()
  if (draft !== undefined) await shell.locator('[data-testid=composer-input]').fill(draft)
}

test('Cmd+T, Cmd+W and the last tab', async ({ shell }) => {
  // Cmd+T opens a blank web page in the focused pane; Cmd+W closes it again.
  await focusShell(shell)
  await shell.keyboard.press('Meta+t')
  await expect(pageTabs(shell)).toHaveCount(1)
  await expect(shell.locator('[data-testid=pane-p1] [data-testid^="pane-tab-web:"]')).toHaveCount(1)
  expect(await titles(shell)).toEqual(['Dashboard'])
  await shell.keyboard.press('Meta+w')
  await expect(pageTabs(shell)).toHaveCount(0)

  // New chats come from the + menu, each a tab of its own; one with a draft stays when left.
  await newChat(shell, 'a draft to keep')
  await expect.poll(async () => (await titles(shell)).length).toBe(2)
  await newChat(shell)
  await expect.poll(async () => await titles(shell)).toEqual(['Dashboard', 'New chat', 'New chat'])
  expect((await tabs(shell)).active).toBe(2)
  await focusShell(shell)
  await shell.keyboard.press('Meta+w')
  await expect.poll(async () => (await titles(shell)).length).toBe(2)
  await shell.keyboard.press('Meta+w')
  await expect.poll(async () => (await titles(shell)).length).toBe(1)
  await shell.keyboard.press('Meta+w')
  await expect.poll(async () => await titles(shell)).toEqual(['Dashboard'])

  // An empty new chat closes when Isaac leaves it.
  await newChat(shell)
  await expect.poll(async () => (await titles(shell)).length).toBe(2)
  await open(shell, 'dashboard')
  await expect.poll(async () => await titles(shell)).toEqual(['Dashboard'])
})

test('navigation, history chords and place dedupe', async ({ shell }) => {
  await focusShell(shell)
  // Dashboard on screen with its one tab: going to a workspace with no tab yet takes that tab
  // along, with Back history (Back switches to Dashboard again, Forward returns).
  await open(shell, 'habits')
  await expect.poll(() => titles(shell)).toEqual(['Habits'])
  await shell.keyboard.press('Meta+[')
  await expect.poll(() => titles(shell)).toEqual(['Dashboard'])
  await shell.keyboard.press('Meta+]')
  await expect.poll(() => titles(shell)).toEqual(['Habits'])
  // Back and Forward walk one tab's history inside a workspace (all boards share Canvas).
  await open(shell, 'canvas', false, { canvas: 'first-board' })
  await open(shell, 'canvas', false, { canvas: 'second-board' })
  const board = async (): Promise<string | null> => {
    const t = await tabs(shell)
    return t.list[t.active]!.page === 'canvas' ? t.list[t.active]!.title : null
  }
  await expect.poll(board).toBe('second-board')
  const count = (await tabs(shell)).list.length
  await shell.keyboard.press('Meta+[')
  await expect.poll(board).toBe('first-board')
  await shell.keyboard.press('Meta+]')
  await expect.poll(board).toBe('second-board')
  expect((await tabs(shell)).list).toHaveLength(count)

  // A place that already has a tab brings it forward instead of opening another.
  await open(shell, 'dashboard')
  await expect.poll(async () => (await tabs(shell)).list[(await tabs(shell)).active]!.page).toBe(
    'dashboard',
  )
  await open(shell, 'jobs', true)
  await expect.poll(() => titles(shell)).toContain('Jobs')
  const n = (await tabs(shell)).list.length
  await open(shell, 'dashboard')
  await expect.poll(async () => (await tabs(shell)).list[(await tabs(shell)).active]!.page).toBe(
    'dashboard',
  )
  expect((await tabs(shell)).list.filter((t) => t.page === 'dashboard')).toHaveLength(1)
  expect((await tabs(shell)).list.length).toBeLessThanOrEqual(n)
})

test('context menu, pin, pinned rules', async ({ app, shell }) => {
  // A web page beside Dashboard, in the tool pane.
  const page = await newPage(shell)
  await navigate(shell, page, String(server.port))
  await expect.poll(() => viewVisible(app, page)).toBe(true)
  const [first] = (await tabs(shell)).list

  await shell.locator(`[data-testid=tab-${first!.id}]`).click({ button: 'right' })
  await expect(shell.locator('[data-testid=tab-menu]')).toBeVisible()
  // The native page hides while the menu is open, so it never covers it.
  await expect.poll(() => viewVisible(app, page)).toBe(false)
  await shell.keyboard.press('Escape')
  await expect(shell.locator('[data-testid=tab-menu]')).toBeHidden()
  await expect.poll(() => viewVisible(app, page)).toBe(true)

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
  expect((await tabs(shell)).list).toHaveLength(1)
  // Navigating from a pinned tab opens another tab; the pinned one shows there as a shortcut.
  await open(shell, 'jobs')
  await expect.poll(async () => (await tabs(shell)).list.length).toBe(2)
  expect((await tabs(shell)).list[0]!.page).toBe('dashboard')
  await expect(pinned).toBeVisible()
  // Two boards of the Canvas workspace, side by side in its strip with the pinned shortcut.
  await open(shell, 'canvas', false, { canvas: 'first-board' })
  await open(shell, 'canvas', true, { canvas: 'second-board' })
  await expect
    .poll(async () => (await titles(shell)).filter((t) => t.endsWith('-board')))
    .toEqual(['first-board', 'second-board'])
  await expect(pinned).toBeVisible()

  // Close others skips pinned tabs.
  const second = (await tabs(shell)).list.find((t) => t.title === 'second-board')!
  await shell.locator(`[data-testid=tab-${second.id}]`).click({ button: 'right' })
  await shell.locator('[data-testid=tab-menu-close-others]').click()
  await expect.poll(() => titles(shell)).toEqual(['Dashboard', 'second-board'])
  expect((await tabs(shell)).list[0]!.pinned).toBe(true)
  await expect(pinned).toBeVisible()
})

test('tabs persist across a relaunch', async ({ app, shell, configDir }) => {
  const first = (await tabs(shell)).list[0]!
  await shell.locator(`[data-testid=tab-${first.id}]`).click({ button: 'right' })
  await shell.locator('[data-testid=tab-menu-pin]').click()
  await newChat(shell, 'a draft to keep')
  await expect.poll(async () => (await tabs(shell)).list.length).toBe(2)
  await newChat(shell)
  await expect.poll(async () => (await tabs(shell)).list.length).toBe(3)
  const before = await tabs(shell)
  await expect
    .poll(() => layoutTabs(configDir).list?.some((t) => t.pinned === true) ?? false)
    .toBe(true)
  await expect.poll(() => layoutTabs(configDir).list?.length).toBe(3)
  const entry = layoutTabs(configDir).list![0]!
  // The id is saved too, so per-tab state (composer drafts) finds its tab after a restart.
  expect(Object.keys(entry).sort()).toEqual(['back', 'forward', 'here', 'id', 'pinned'].sort())
  // On screen: the pinned Dashboard and the new chat in front (the other chat is its own workspace).
  const shown = await shell.locator(APP_TAB).count()
  await app.close()

  const app2 = await launchApp(configDir)
  try {
    const page = await app2.firstWindow()
    await page.waitForSelector('[data-testid=rail]', { state: 'attached' })
    await page.waitForFunction(() => Boolean((window as unknown as Partial<Shell>).__evaosShell))
    await expect(page.locator(APP_TAB)).toHaveCount(shown)
    const after = await tabs(page)
    expect(after.list.map((t) => [t.id, t.title, t.pinned])).toEqual(
      before.list.map((t) => [t.id, t.title, t.pinned]),
    )
    expect(after.active).toBe(before.active)
  } finally {
    await app2.close()
  }
})

test('sidebar toggle keeps clear of the traffic lights and folds', async ({ app, shell }) => {
  await app.evaluate(() => (globalThis as unknown as G).__evaosTest.win.setContentSize(1280, 800))
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(1280)
  const toggle = shell.locator('[data-testid=sidebar-toggle]:visible')
  await expect(toggle).toHaveAttribute('aria-label', 'Hide sidebar')
  await focusShell(shell)
  await shell.keyboard.press('Meta+b')
  await expect(toggle).toHaveAttribute('aria-label', 'Show sidebar')
  await shell.keyboard.press('Meta+b')
  await expect(toggle).toHaveAttribute('aria-label', 'Hide sidebar')

  await app.evaluate(() => (globalThis as unknown as G).__evaosTest.win.setContentSize(760, 720))
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(760)
  await expect(toggle).toHaveAttribute(
    'aria-label',
    'Sidebar hidden to fit the window. Widen the window or close a pane to bring it back.',
  )
})

test('panel toggle and Cmd+Shift+B agree', async ({ shell }) => {
  const toggle = shell.locator('[data-testid=panel-toggle]:visible')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await focusShell(shell)
  await shell.keyboard.press('Meta+Shift+b')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await shell.keyboard.press('Meta+Shift+b')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
})
