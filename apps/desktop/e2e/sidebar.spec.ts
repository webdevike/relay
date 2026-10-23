import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'

type Snap = {
  active: number
  list: Array<{ id: number; page: string; pinned: boolean; title: string }>
}
type Shell = { __evaosShell: { tabs(): Snap; openPlace(p: string, n?: boolean): void } }
type G = {
  __evaosTest: { hooks: { browser: { host: { activeView(): { getVisible(): boolean } } } } }
}

test.use({ startOnChat: false, colorScheme: 'dark' })

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

const tabs = (shell: Page): Promise<Snap> =>
  shell.evaluate(() => (window as unknown as Shell).__evaosShell.tabs())
const sel = (id: string): string => `[data-testid=${id}]`
const viewVisible = (app: ElectronApplication): Promise<boolean> =>
  app.evaluate(() =>
    (globalThis as unknown as G).__evaosTest.hooks.browser.host.activeView().getVisible(),
  )
const level = (shell: Page): Promise<string | null> =>
  shell.locator(sel('sidebar')).getAttribute('data-sidebar-level')

test('nav rows, counts and recent items come from the fixture root', async ({ shell }) => {
  const ids = await shell.$$eval('[data-testid=sidebar-main] [data-testid^="nav-"]', (els) =>
    els.map((e) => e.getAttribute('data-testid')),
  )
  expect(ids).toEqual([
    'nav-assistants',
    'nav-dashboard',
    'nav-chat',
    'nav-canvas',
    'nav-test-bench',
    'nav-jobs',
    'nav-habits',
    'nav-meetings',
    'nav-setting',
  ])
  await expect(shell.locator(sel('nav-dashboard'))).toHaveAttribute('data-active', 'true')
  await expect(shell.locator(sel('count-jobs'))).toHaveText('1')
  await expect(shell.locator(sel('recent-item'))).toHaveCount(3)
  for (const t of await shell.$$eval(sel('recent-item'), (els) => els.map((e) => e.textContent))) {
    expect((t ?? '').length).toBeGreaterThan(0)
  }
})

test('plain click replaces, cmd-click opens a tab, pinned opens another', async ({ shell }) => {
  await shell.locator(sel('nav-habits')).click()
  await expect.poll(async () => (await tabs(shell)).list.map((t) => t.title)).toEqual(['Habits'])
  await expect(shell.locator(sel('nav-habits'))).toHaveAttribute('data-active', 'true')
  await expect(shell.locator(sel('nav-dashboard'))).not.toHaveAttribute('data-active', 'true')

  await shell.locator(sel('nav-dashboard')).click({ modifiers: ['Meta'] })
  await expect.poll(async () => (await tabs(shell)).list.length).toBe(2)

  const first = (await tabs(shell)).list[0]!
  await shell.locator(`[data-testid=tab-${first.id}]`).click({ button: 'right' })
  await shell.locator(sel('tab-menu-pin')).click()
  await shell.locator(`[data-testid=tab-pinned-${first.id}]`).click()
  await expect.poll(async () => (await tabs(shell)).active).toBe(0)
  await shell.locator(sel('nav-jobs')).click()
  await expect.poll(async () => (await tabs(shell)).list.length).toBe(3)
  const list = (await tabs(shell)).list
  expect(list[0]!.page).toBe('habits')
  expect(list[0]!.pinned).toBe(true)
})

test('chats sub-page slides, Back and Esc return, Cmd+F focuses its search', async ({ shell }) => {
  await shell.locator(sel('nav-chat')).click()
  await expect.poll(() => level(shell)).toBe('chats')
  await expect(shell.locator(sel('sidebar-sub-chats'))).toBeVisible()
  await expect(shell.locator(sel('chat-pane'))).toBeVisible()
  await expect(shell.locator(sel('chat-tree'))).toBeVisible()
  await shell.keyboard.press('Meta+f')
  await expect(shell.locator(sel('sidebar-sub-search'))).toBeFocused()
  await shell.keyboard.press('Escape')
  await shell.locator(sel('sidebar-sub-chats')).click({ position: { x: 20, y: 300 } })
  await shell.locator(sel('sidebar-back')).click()
  await expect.poll(() => level(shell)).toBe('root')
  expect((await tabs(shell)).list.map((t) => t.page)).toEqual(['chat'])

  await shell.locator(sel('nav-chat')).click()
  await expect.poll(() => level(shell)).toBe('chats')
  await shell.locator(sel('sidebar-sub-chats')).click({ position: { x: 20, y: 300 } })
  await shell.keyboard.press('Escape')
  await expect.poll(() => level(shell)).toBe('root')
  expect((await tabs(shell)).list.map((t) => t.page)).toEqual(['chat'])

  await shell.locator(sel('nav-chat')).click()
  await shell.locator(sel('chat-new')).click()
  await expect.poll(async () => (await tabs(shell)).list.map((t) => t.title)).toContain('New chat')
})

test('account menu takes Esc first and hides the browser view', async ({ app, shell }) => {
  const addr = shell.locator(sel('address-input'))
  await addr.fill(String(server.port))
  await addr.press('Enter')
  await expect.poll(() => viewVisible(app)).toBe(true)
  await shell.locator(sel('account-trigger')).click()
  await expect(shell.locator(sel('account-menu'))).toBeVisible()
  await expect(shell.locator(sel('account-quit'))).toBeVisible()
  await expect.poll(() => viewVisible(app)).toBe(false)
  await shell.keyboard.press('Escape')
  await expect(shell.locator(sel('account-menu'))).toBeHidden()
  await expect.poll(() => viewVisible(app)).toBe(true)
})

test('settings sub-page opens a settings section', async ({ shell }) => {
  await shell.locator(sel('nav-setting')).click()
  await expect.poll(() => level(shell)).toBe('settings')
  await expect(shell.locator('[data-testid^=settings-item-]')).toHaveCount(2)
  await shell.locator(sel('settings-item-chat')).click()
  await expect
    .poll(async () => (await tabs(shell)).list[(await tabs(shell)).active]!.title)
    .toBe('Settings: Chat')
  await expect(shell.locator(sel('settings-item-chat'))).toHaveAttribute('data-active', 'true')
})

test('search focus, filter, hide and show with Cmd+F, reload action', async ({ shell }) => {
  await shell.locator(sel('sidebar-main')).click({ position: { x: 10, y: 5 } })
  await shell.keyboard.press('Meta+f')
  await expect(shell.locator(sel('sidebar-search'))).toBeFocused()
  await shell.keyboard.type('second')
  await expect(shell.locator(sel('recent-item'))).toHaveCount(1)
  await shell.locator(sel('sidebar-search')).fill('zzzzqq')
  await expect(shell.getByText('No recent items match your search')).toBeVisible()
  await shell.keyboard.press('Escape')
  await expect(shell.locator(sel('sidebar-search'))).toHaveValue('')
  await shell.keyboard.press('Escape')
  await expect(shell.locator(sel('sidebar-search'))).not.toBeFocused()
  await expect(shell.locator(sel('recent-item'))).toHaveCount(3)

  await shell.keyboard.press('Meta+b')
  await expect(shell.locator(sel('shell'))).toHaveAttribute('data-sidebar-state', 'hidden')
  await shell.keyboard.press('Meta+f')
  await expect(shell.locator(sel('shell'))).toHaveAttribute('data-sidebar-state', 'open')
  await expect(shell.locator(sel('sidebar-search'))).toBeFocused()

  await shell.keyboard.press('Meta+r')
  await expect
    .poll(() =>
      shell.evaluate(() =>
        (
          (window as unknown as { __evaosHotkeys?: Array<{ action: string }> }).__evaosHotkeys ?? []
        ).some((h) => h.action === 'reload'),
      ),
    )
    .toBe(true)
})

test('Appearance in the sidebar does not recreate the sidebar', async ({ shell }) => {
  await shell.evaluate(() => {
    ;(window as unknown as { __sb: Element | null }).__sb =
      document.querySelector('[data-testid=sidebar]')
  })
  await shell.locator(sel('appearance-light')).click()
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', 'light')
  expect(
    await shell.evaluate(() => {
      const el = (window as unknown as { __sb: Element }).__sb
      return el.isConnected && el === document.querySelector('[data-testid=sidebar]')
    }),
  ).toBe(true)
})
