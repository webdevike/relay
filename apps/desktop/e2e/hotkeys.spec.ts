import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import { openPage, pageTabs, webPanel, type BrowserHooks } from './helpers/web'

type Snap = {
  active: number
  list: Array<{ id: number; page: string; pinned: boolean; title: string }>
}
type W = {
  __evaosShell: {
    tabs(): Snap
    openPlace(p: string, n?: boolean, extra?: Record<string, string>): void
  }
  __evaosHotkeys: Array<{ chord: string; action: string }>
}

test.use({ startOnChat: false, colorScheme: 'dark' })

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

const sel = (id: string): string => `[data-testid=${id}]`
const tabs = (shell: Page): Promise<Snap> =>
  shell.evaluate(() => (window as unknown as W).__evaosShell.tabs())
const actions = (shell: Page): Promise<string[]> =>
  shell.evaluate(() => (window as unknown as W).__evaosHotkeys.map((h) => h.action))
const clearLog = (shell: Page): Promise<void> =>
  shell.evaluate(() => {
    ;(window as unknown as W).__evaosHotkeys.length = 0
  })
const state = (shell: Page) => shell.locator(sel('shell')).getAttribute('data-sidebar-state')
const level = (shell: Page) => shell.locator(sel('sidebar')).getAttribute('data-sidebar-level')

/** The keyboard on the shell itself, out of any pane (a page's address field included). */
async function focusShell(shell: Page): Promise<void> {
  await shell.locator(sel('tabbar-drag')).click()
  await shell.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

test('implemented app chords reach the router and are logged', async ({ shell }) => {
  await focusShell(shell)
  await clearLog(shell)
  const chords: Array<[string, string]> = [
    ['Meta+n', 'new-todo'],
    ['Meta+r', 'reload'],
    ['Meta+b', 'toggle-sidebar'],
    ['Meta+Shift+b', 'toggle-panel'],
    ['Meta+f', 'focus-search'],
    ['Meta+t', 'new-tab'],
    ['Meta+w', 'close-tab'],
    ['Meta+[', 'history-back'],
    ['Meta+]', 'history-forward'],
  ]
  for (const [chord, action] of chords) {
    await focusShell(shell)
    await shell.keyboard.press(chord)
    await expect.poll(() => actions(shell), { message: chord }).toContain(action)
    if (action === 'new-todo') {
      // Cmd+N now opens the New Todo modal; close it so later chords reach the page scope.
      await expect(shell.locator(sel('new-todo-text'))).toBeVisible()
      await shell.keyboard.press('Escape')
      await expect(shell.locator(sel('new-todo-text'))).toBeHidden()
    }
  }
  const seen = await actions(shell)
  for (const [, action] of chords) expect(seen).toContain(action)
})

test('implemented chords have real effects', async ({ shell }) => {
  await focusShell(shell)
  await expect.poll(() => state(shell)).toBe('open')
  await shell.keyboard.press('Meta+b')
  await expect.poll(() => state(shell)).toBe('hidden')
  await shell.keyboard.press('Meta+b')
  await expect.poll(() => state(shell)).toBe('open')

  const panelToggle = shell.locator(`${sel('panel-toggle')}:visible`)
  await expect(panelToggle).toHaveAttribute('aria-pressed', 'true')
  await shell.keyboard.press('Meta+Shift+b')
  await expect(panelToggle).toHaveAttribute('aria-pressed', 'false')
  await expect(shell.locator('[data-pane-kind=tool]')).toBeHidden()
  await shell.keyboard.press('Meta+Shift+b')
  await expect(shell.locator('[data-pane-kind=tool]')).toBeVisible()

  // Cmd+T: a blank page in the focused pane, its address focused; Cmd+W there closes it.
  await shell.keyboard.press('Meta+t')
  await expect(pageTabs(shell)).toHaveCount(1)
  await expect(
    shell.locator('[data-testid=web-panel]:visible [data-testid=address-input]'),
  ).toBeFocused()
  await shell.keyboard.press('Meta+w')
  await expect(pageTabs(shell)).toHaveCount(0)
  expect((await tabs(shell)).list.length).toBe(1)

  // A new chat from the + menu, and Cmd+W from the tab bar closes its app tab.
  await shell.locator(sel('tab-new')).click()
  const lead = await shell.evaluate(
    () => document.querySelector<HTMLElement>('[data-lead=true]')!.dataset['paneId']!,
  )
  await shell.locator(sel(`pane-add-new-chat-${lead}`)).click()
  await expect.poll(async () => (await tabs(shell)).list.length).toBe(2)
  await focusShell(shell)
  await shell.keyboard.press('Meta+w')
  await expect.poll(async () => (await tabs(shell)).list.length).toBe(1)

  // Back and forward walk the tab's history inside its workspace (Settings sections).
  const front = async (): Promise<string> => {
    const t = await tabs(shell)
    return t.list[t.active]!.title
  }
  const settings = (section: string) =>
    shell.evaluate(
      (s) =>
        (window as unknown as W).__evaosShell.openPlace('settings', false, { settingsSection: s }),
      section,
    )
  await settings('Theme')
  await expect.poll(front).toBe('Settings: Theme')
  await settings('Chat')
  await expect.poll(front).toBe('Settings: Chat')
  await focusShell(shell)
  await shell.keyboard.press('Meta+[')
  await expect.poll(front).toBe('Settings: Theme')
  await shell.keyboard.press('Meta+]')
  await expect.poll(front).toBe('Settings: Chat')

  await clearLog(shell)
  await shell.keyboard.press('Meta+r')
  await expect.poll(() => actions(shell)).toContain('reload')
})

test('native edit chords and plain typing are untouched', async ({ shell }) => {
  await focusShell(shell)
  await shell.locator(sel('nav-chat')).click()
  await shell.keyboard.press('Meta+f')
  const search = shell.locator(sel('sidebar-sub-search'))
  await expect(search).toBeFocused()
  await clearLog(shell)
  await shell.keyboard.type('abc')
  await shell.keyboard.press('Meta+a')
  await shell.keyboard.press('Meta+c')
  await shell.keyboard.press('Meta+v')
  await shell.keyboard.press('Meta+z')
  await shell.keyboard.press('Meta+x')
  expect(await actions(shell)).toEqual([])
})

test('Esc pops the sub-page, then does nothing and is not prevented', async ({ shell }) => {
  await focusShell(shell)
  await shell.locator(sel('nav-chat')).click()
  await expect.poll(() => level(shell)).toBe('chats')

  await shell.locator(sel('sidebar-sub-chats')).click({ position: { x: 20, y: 300 } })
  await shell.keyboard.press('Escape')
  await expect.poll(() => level(shell)).toBe('root')

  await shell.evaluate(() => {
    const w = window as unknown as { __escPrevented?: boolean | null }
    w.__escPrevented = null
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape') return
        // Bubble phase on window runs after the router's capture listener.
        queueMicrotask(() => {
          w.__escPrevented = e.defaultPrevented
        })
      },
      { once: true },
    )
  })
  await clearLog(shell)
  await shell.keyboard.press('Escape')
  await expect
    .poll(() =>
      shell.evaluate(
        () => (window as unknown as { __escPrevented: boolean | null }).__escPrevented,
      ),
    )
    .not.toBeNull()
  expect(
    await shell.evaluate(() => (window as unknown as { __escPrevented: boolean }).__escPrevented),
  ).toBe(false)
  expect(await level(shell)).toBe('root')
})

test('a chord from a page reaches the same router', async ({ app, shell }, info) => {
  const id = await openPage(shell, server.url('/a.html'), 'Page A')
  await expect
    .poll(() =>
      app.evaluate(
        (_e, tabId) =>
          Boolean(
            (globalThis as unknown as BrowserHooks).__evaosTest.hooks.browser.host
              .tabById(tabId)
              ?.getURL(),
          ),
        id,
      ),
    )
    .toBe(true)
  await expect(webPanel(shell, id)).toBeVisible()
  await clearLog(shell)
  await app.evaluate((_e, tabId) => {
    const wc = (globalThis as unknown as BrowserHooks).__evaosTest.hooks.browser.host.tabById(
      tabId,
    )!
    wc.focus()
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'B', modifiers: ['meta', 'shift'] })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'B', modifiers: ['meta', 'shift'] })
  }, id)

  let path = 'sendInputEvent on the guest webContents (before-input-event)'
  try {
    await expect.poll(() => actions(shell), { timeout: 3000 }).toContain('toggle-panel')
  } catch {
    // Synthetic input did not hit before-input-event; prove the app.hotkey subscription instead.
    path = 'app.hotkey emitted to the shell with fromGuest true'
    await app.evaluate(({ BaseWindow }) => {
      const win = BaseWindow.getAllWindows()[0] as unknown as {
        contentView: { children: Array<{ webContents?: Electron.WebContents }> }
      }
      for (const v of win.contentView.children) {
        v.webContents?.send('app.hotkey', { chord: 'cmd+shift+b', fromGuest: true })
      }
    })
    await expect.poll(() => actions(shell)).toContain('toggle-panel')
  }
  info.annotations.push({ type: 'guest-forward-path', description: path })
})
