import * as fs from 'node:fs'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import { proofShot } from './helpers/proofShot'

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
type Shell = {
  __evaosShell: {
    tabs(): Snap
    openPlace(p: string, n?: boolean, extra?: { settingsSection: string }): void
  }
}

// Fixed scheme so System appearance is deterministic; the fixture opens on a chat.
test.use({ colorScheme: 'dark', startOnChat: true })

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

const sel = (id: string): string => `[data-testid=${id}]`
const PHASE = { phase: 'phase-2' }

async function size(app: ElectronApplication, shell: Page, w: number, h: number): Promise<void> {
  await app.evaluate(
    (_e, [ww, hh]) => (globalThis as unknown as G).__evaosTest.win.setContentSize(ww!, hh!),
    [w, h],
  )
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(w)
  await expect.poll(() => shell.evaluate(() => window.innerHeight)).toBe(h)
  // Layout settled: the card rects stop moving.
  let last = ''
  await expect
    .poll(
      async () => {
        const now = JSON.stringify([await box(shell, 'main-card'), await box(shell, 'panel-card')])
        const same = now === last
        last = now
        return same
      },
      { intervals: [150] },
    )
    .toBe(true)
}

async function box(shell: Page, id: string) {
  const b = await shell.locator(sel(id)).boundingBox()
  if (!b) throw new Error(`no box for ${id}`)
  return b
}

async function loadPage(shell: Page, app: ElectronApplication): Promise<void> {
  const addr = shell.locator(sel('address-input'))
  await addr.fill(server.url('/a.html'))
  await addr.press('Enter')
  await expect(shell.locator('[data-testid^=browser-tab-t]').first()).toContainText('Page A')
  await expect
    .poll(() =>
      app.evaluate(() =>
        (globalThis as unknown as G).__evaosTest.hooks.browser.host.activeView().getVisible(),
      ),
    )
    .toBe(true)
}

const resolved = (shell: Page) => expect(shell.locator('html'))
const tabs = (shell: Page): Promise<Snap> =>
  shell.evaluate(() => (window as unknown as Shell).__evaosShell.tabs())
const countVars = (shell: Page): Promise<number> =>
  shell.evaluate(() => {
    const style = getComputedStyle(document.documentElement)
    let n = 0
    for (let i = 0; i < style.length; i++) if (style.item(i).startsWith('--eva-c-')) n++
    return n
  })

async function finish(app: ElectronApplication, shell: Page, name: string): Promise<void> {
  const file = await proofShot(app, shell, name, PHASE)
  expect(fs.existsSync(file)).toBe(true)
  expect(fs.statSync(file).size).toBeGreaterThan(5_000)
}

test.beforeEach(async ({ app, shell }) => {
  await size(app, shell, 1280, 800)
  await loadPage(shell, app)
})

test('shell-dark-1280x800', async ({ app, shell }) => {
  await shell.locator(sel('appearance-dark')).click()
  await resolved(shell).toHaveAttribute('data-resolved', 'dark')
  await expect(shell.locator(sel('shell'))).toHaveAttribute('data-sidebar-state', 'open')
  expect((await box(shell, 'sidebar')).width).toBe(272)
  expect(Math.abs((await box(shell, 'panel-card')).width - 420)).toBeLessThanOrEqual(1)
  expect(await countVars(shell)).toBe(139)
  await finish(app, shell, 'shell-dark-1280x800')
})

test('shell-light-1280x800', async ({ app, shell }) => {
  await shell.locator(sel('appearance-light')).click()
  await resolved(shell).toHaveAttribute('data-resolved', 'light')
  await finish(app, shell, 'shell-light-1280x800')
})

for (const mode of ['dark', 'light'] as const) {
  test(`shell-folded-${mode}-760x720`, async ({ app, shell }) => {
    await shell.locator(sel(`appearance-${mode}`)).click()
    await resolved(shell).toHaveAttribute('data-resolved', mode)
    await size(app, shell, 760, 720)
    await expect(shell.locator(sel('shell'))).toHaveAttribute('data-sidebar-state', 'folded')
    const panel = await box(shell, 'panel-card')
    const main = await box(shell, 'main-card')
    expect(Math.round(panel.width)).toBe(320)
    expect(panel.x + panel.width).toBeLessThanOrEqual(760)
    expect(main.x + main.width).toBeLessThanOrEqual(panel.x)
    await finish(app, shell, `shell-folded-${mode}-760x720`)
  })

  test(`shell-wide-${mode}-1440x900`, async ({ app, shell }) => {
    await shell.locator(sel(`appearance-${mode}`)).click()
    await resolved(shell).toHaveAttribute('data-resolved', mode)
    await size(app, shell, 1440, 900)
    await expect(shell.locator(sel('shell'))).toHaveAttribute('data-sidebar-state', 'open')
    expect((await box(shell, 'sidebar')).width).toBe(272)
    const panel = await box(shell, 'panel-card')
    const main = await box(shell, 'main-card')
    expect(Math.abs(panel.width - 420)).toBeLessThanOrEqual(1)
    expect(main.width).toBeGreaterThan(1440 - 272 - 420 - 40)
    expect(Math.round(main.x + main.width + 8)).toBe(Math.round(panel.x))
    await finish(app, shell, `shell-wide-${mode}-1440x900`)
  })
}

test('tabs-pinned-menu', async ({ app, shell }) => {
  await shell.locator(sel('tab-new')).click()
  await expect.poll(async () => (await tabs(shell)).list.length).toBe(2)
  await shell.locator(sel('tab-new')).click()
  await expect.poll(async () => (await tabs(shell)).list.length).toBe(3)
  const list = (await tabs(shell)).list
  await shell.locator(sel(`tab-${list[0]!.id}`)).click({ button: 'right' })
  await shell.locator(sel('tab-menu-pin')).click()
  await expect(shell.locator(sel(`tab-pinned-${list[0]!.id}`))).toBeVisible()
  await expect(shell.locator(sel(`tab-close-${list[0]!.id}`))).toHaveCount(0)
  expect((await tabs(shell)).list[0]!.pinned).toBe(true)
  await shell.locator(sel(`tab-${list[1]!.id}`)).click({ button: 'right' })
  await expect(shell.locator(sel('tab-menu'))).toBeVisible()
  await expect(shell.locator(sel('tab-menu-close-others'))).toBeVisible()
  await expect
    .poll(() =>
      app.evaluate(() =>
        (globalThis as unknown as G).__evaosTest.hooks.browser.host.activeView().getVisible(),
      ),
    )
    .toBe(false)
  await finish(app, shell, 'tabs-pinned-menu')
})

test('sidebar-subpage-settings', async ({ app, shell }) => {
  await shell.locator(sel('nav-setting')).click()
  const sb = shell.locator(sel('sidebar'))
  await expect(sb).toHaveAttribute('data-sidebar-level', 'settings')
  await expect(shell.locator(sel('sidebar-back'))).toBeVisible()
  await expect(shell.locator('[data-testid^=settings-item-]')).toHaveCount(3)
  await expect
    .poll(() =>
      shell
        .locator(sel('sidebar-back'))
        .boundingBox()
        .then((b) => b?.x ?? -1),
    )
    .toBeGreaterThanOrEqual(0)
  await expect
    .poll(
      async () =>
        (await shell.locator('[data-testid^=settings-item-]').first().boundingBox())?.x ?? -1,
    )
    .toBeGreaterThanOrEqual(0)
  await finish(app, shell, 'sidebar-subpage-settings')
})

test('sidebar-subpage-chats', async ({ app, shell }) => {
  await shell.locator(sel('nav-chat')).click()
  await expect(shell.locator(sel('sidebar'))).toHaveAttribute('data-sidebar-level', 'chats')
  const search = shell.locator(sel('sidebar-sub-search'))
  await search.click()
  await shell.keyboard.type('plan')
  await expect(search).toBeFocused()
  await expect(search).toHaveValue('plan')
  await expect(shell.locator(sel('sidebar-sub-empty'))).toBeVisible()
  await finish(app, shell, 'sidebar-subpage-chats')
})

test('settings-chat', async ({ app, shell }) => {
  await shell.evaluate(() =>
    (window as unknown as Shell).__evaosShell.openPlace('settings', false, {
      settingsSection: 'Chat',
    }),
  )
  await expect(shell.locator(sel('settings-chat'))).toBeVisible()
  await expect(shell.locator(sel('settings-show-thinking'))).not.toBeChecked()
  await expect(shell.locator(sel('settings-show-tools'))).toBeChecked()
  await finish(app, shell, 'settings-chat')
})

test('settings-theme-light', async ({ app, shell }) => {
  await shell.evaluate(() =>
    (window as unknown as Shell).__evaosShell.openPlace('settings', false, {
      settingsSection: 'Theme',
    }),
  )
  await expect(shell.locator(sel('settings-theme'))).toBeVisible()
  await shell.locator(sel('appearance-settings')).locator(sel('appearance-light')).click()
  await resolved(shell).toHaveAttribute('data-resolved', 'light')
  await expect(
    shell.locator(sel('appearance-settings')).locator(sel('appearance-light')),
  ).toHaveAttribute('data-active', 'true')
  await finish(app, shell, 'settings-theme-light')
})

test('appearance-live-switch', async ({ app, shell }) => {
  await shell.locator(sel('appearance-dark')).click()
  await resolved(shell).toHaveAttribute('data-resolved', 'dark')
  await expect(shell.locator('style[data-mantine-disable-transition]')).toHaveCount(0)
  const before = await shell.evaluate(() => {
    ;(window as unknown as { __sb: Element | null }).__sb =
      document.querySelector('[data-testid=sidebar]')
    return {
      count: document.querySelectorAll('*').length,
      bg: getComputedStyle(document.body).backgroundColor,
    }
  })
  await shell.locator(sel('appearance-light')).click()
  await resolved(shell).toHaveAttribute('data-resolved', 'light')
  // Mantine inserts a transient transition-disabling style tag during a scheme switch.
  await expect(shell.locator('style[data-mantine-disable-transition]')).toHaveCount(0)
  const after = await shell.evaluate(() => ({
    same:
      (window as unknown as { __sb: Element }).__sb ===
        document.querySelector('[data-testid=sidebar]') &&
      (window as unknown as { __sb: Element }).__sb.isConnected,
    count: document.querySelectorAll('*').length,
    bg: getComputedStyle(document.body).backgroundColor,
  }))
  expect(after.same).toBe(true)
  expect(after.count).toBe(before.count)
  expect(after.bg).not.toBe(before.bg)
  await finish(app, shell, 'appearance-live-switch')
})
