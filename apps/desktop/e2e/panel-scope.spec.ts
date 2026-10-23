import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { startStaticServer, type StaticServer } from './helpers/static-server'

// Option 3: each chat (and page) owns its browser tabs, pinned tabs show everywhere, and the
// panel opens or closes with the scope in front.

type Snap = {
  tabs: Array<{ id: string; title: string; pinned: boolean }>
  activeId: string
  scope: string
}
type G = { __evaosTest: { hooks: { browser: { host: { snapshot(): Snap } } } } }
type ShellHooks = {
  __evaosShell: {
    openPlace(page: string, newTab?: boolean, extra?: object): void
    openChat(): void
    setPanel(open: boolean): void
    browserScope(): string
  }
}

let server: StaticServer
let fx: ChatFixture

const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    // Chat A carries a link to the test page, so it opens the way Isaac opens one.
    await fx.append(
      'p4-ecard',
      JSON.stringify({
        type: 'message',
        id: 'a9',
        parentId: 'a1',
        message: {
          role: 'assistant',
          provider: 'anthropic',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: `See [the page A link](${server.url('/a.html')}).` }],
          stopReason: 'stop',
        },
      }),
    )
    await use({ ...fx.launchEnv, FAKE_OMP_DELAY_MS: '5' })
    fx.cleanup()
  },
})

test.use({ startOnChat: false, panelOpen: false })

test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

const sel = (id: string): string => `[data-testid=${id}]`
const host = (app: ElectronApplication): Promise<Snap> =>
  app.evaluate(() => (globalThis as unknown as G).__evaosTest.hooks.browser.host.snapshot())
const scope = (shell: Page): Promise<string> =>
  shell.evaluate(() => (window as unknown as ShellHooks).__evaosShell.browserScope())
const stripIds = (shell: Page): Promise<string[]> =>
  shell
    .locator('[data-testid^=browser-tab-t]')
    .evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-testid')!.slice('browser-tab-'.length)),
    )

async function openChat(shell: Page, file: string): Promise<void> {
  await shell.evaluate(
    (f) => (window as unknown as ShellHooks).__evaosShell.openPlace('chat', false, { chat: f }),
    file,
  )
  await expect.poll(() => scope(shell)).toBe(`chat:${file}`)
}
async function openPage(shell: Page, page: string): Promise<void> {
  await shell.evaluate((p) => (window as unknown as ShellHooks).__evaosShell.openPlace(p), page)
  await expect.poll(() => scope(shell)).toBe(`page:${page}`)
}
const setPanel = (shell: Page, open: boolean): Promise<void> =>
  shell.evaluate((o) => (window as unknown as ShellHooks).__evaosShell.setPanel(o), open)
async function typeAddress(shell: Page, url: string): Promise<void> {
  const addr = shell.locator(sel('address-input'))
  await addr.fill(url)
  await addr.press('Enter')
}

test('each chat owns its tabs, pinned tabs show everywhere, the panel follows the scope', async ({
  app,
  shell,
}) => {
  const panel = shell.locator(sel('panel-card'))
  const chatA = fx.file('p4-ecard')
  const chatB = fx.file('p4-relay')

  // Chat A: a link opens a tab there and the panel with it.
  await openChat(shell, chatA)
  await expect(panel).toBeHidden()
  await shell.locator(sel('chat-log')).getByText('the page A link').click()
  await expect(panel).toBeVisible()
  await expect(shell.locator('[data-testid^=browser-tab-t]')).toHaveCount(1)
  await expect(shell.locator('[data-testid^=browser-tab-t]').first()).toContainText('Page A')
  const aTab = (await host(app)).activeId
  expect((await host(app)).scope).toBe(`chat:${chatA}`)

  // Chat B has no tabs: the panel closes and A's tab is gone from the strip.
  await openChat(shell, chatB)
  await expect(panel).toBeHidden()
  await expect.poll(async () => (await host(app)).tabs).toEqual([])
  await expect.poll(() => stripIds(shell)).toEqual([])

  // A tab opened in B (Isaac opens the panel, types an address) belongs to B.
  await setPanel(shell, true)
  await expect(panel).toBeVisible()
  await expect(shell.locator(sel('page-blank'))).toBeVisible()
  await typeAddress(shell, server.url('/b.html'))
  await expect(shell.locator('[data-testid^=browser-tab-t]').first()).toContainText('Page B')
  const bTab = (await host(app)).activeId
  expect(bTab).not.toBe(aTab)

  // Back to A: its tab is active again and B's is not there.
  await openChat(shell, chatA)
  await expect(panel).toBeVisible()
  await expect.poll(() => stripIds(shell)).toEqual([aTab])
  expect((await host(app)).activeId).toBe(aTab)
  await expect(shell.locator(sel(`browser-tab-${aTab}`))).toHaveClass(/is-active/)

  // Pin A's tab from the strip's menu.
  await shell.locator(sel(`browser-tab-${aTab}`)).click({ button: 'right' })
  await shell.locator(sel('browser-tab-menu-pin')).click()
  await expect(shell.locator(sel(`browser-tab-pin-${aTab}`))).toBeVisible()
  await expect(panel).toBeVisible()

  // B shows the pinned tab first, keeps its own active tab and its own (open) panel state.
  await openChat(shell, chatB)
  await expect(panel).toBeVisible()
  await expect.poll(() => stripIds(shell)).toEqual([aTab, bTab])
  expect((await host(app)).activeId).toBe(bTab)
  // Isaac closes B's panel; that choice sticks to B even though B has a tab.
  await setPanel(shell, false)
  // A was never toggled and its only tab is pinned now, so A opens closed.
  await openChat(shell, chatA)
  await expect(panel).toBeHidden()
  await expect.poll(() => stripIds(shell)).toEqual([aTab])
  await setPanel(shell, true)
  await openChat(shell, chatB)
  await expect(panel).toBeHidden()
  await openChat(shell, chatA)
  await expect(panel).toBeVisible()

  // Dashboard is its own scope: the pinned tab alone never opens its panel.
  await openPage(shell, 'dashboard')
  await expect(panel).toBeHidden()
  await expect
    .poll(async () => (await host(app)).tabs.map((t) => [t.id, t.pinned]))
    .toEqual([[aTab, true]])
  await setPanel(shell, true)
  // The address bar drives the active (pinned) tab; + opens a Dashboard tab.
  await shell.locator(sel('browser-tab-new')).click()
  await expect.poll(async () => (await host(app)).tabs.length).toBe(2)
  await typeAddress(shell, server.url('/b.html'))
  await expect.poll(() => stripIds(shell)).toHaveLength(2)
  const dashTab = (await host(app)).activeId
  await openChat(shell, chatB)
  await expect.poll(async () => (await host(app)).tabs.map((t) => t.id)).toEqual([aTab, bTab])
  await openPage(shell, 'dashboard')
  await expect(panel).toBeVisible()
  await expect.poll(() => stripIds(shell)).toEqual([aTab, dashTab])

  // A draft chat opens a tab, then omp names its file: the tab stays with the chat.
  const before = fs.readdirSync(fx.sessionsDir)
  await shell.evaluate(() => (window as unknown as ShellHooks).__evaosShell.openChat())
  await expect.poll(() => scope(shell)).toMatch(/^draft:\d+$/)
  await expect(panel).toBeHidden()
  await setPanel(shell, true)
  await shell.locator(sel('browser-tab-new')).click()
  await expect.poll(async () => (await host(app)).tabs.length).toBe(2)
  await typeAddress(shell, server.url('/a.html'))
  await expect.poll(async () => (await host(app)).tabs[1]?.title).toBe('Page A')
  const draftTab = (await host(app)).activeId
  const box = shell.locator(sel('composer-input'))
  await expect(box).toBeVisible()
  await box.fill('hello from a draft')
  await box.press('Enter')
  await expect
    .poll(() => fs.readdirSync(fx.sessionsDir).filter((n) => !before.includes(n)).length)
    .toBe(1)
  const created = path.join(
    fx.sessionsDir,
    fs.readdirSync(fx.sessionsDir).find((n) => !before.includes(n))!,
  )
  await expect.poll(() => scope(shell)).toBe(`chat:${created}`)
  await expect.poll(async () => (await host(app)).scope).toBe(`chat:${created}`)
  expect((await host(app)).activeId).toBe(draftTab)
  await expect(panel).toBeVisible()
  await openChat(shell, chatA)
  await openChat(shell, created)
  await expect(panel).toBeVisible()
  await expect.poll(() => stripIds(shell)).toEqual([aTab, draftTab])
  expect((await host(app)).activeId).toBe(draftTab)

  // A renderer reload re-syncs with the host's scopes: same scope, same tabs, panel open.
  await shell.reload()
  await shell.waitForSelector(sel('rail'))
  await shell.waitForFunction(() => Boolean((window as unknown as ShellHooks).__evaosShell))
  await expect.poll(() => scope(shell)).toBe(`chat:${created}`)
  await expect(panel).toBeVisible()
  await expect.poll(() => stripIds(shell)).toEqual([aTab, draftTab])
  expect((await host(app)).scope).toBe(`chat:${created}`)
  // Toggles live in the renderer for the app run; after a reload B has its own tab, so it opens.
  await openChat(shell, chatB)
  await expect.poll(() => stripIds(shell)).toEqual([aTab, bTab])
  await expect(panel).toBeVisible()
})
