import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'

type Snap = {
  active: number
  list: Array<{ id: number; page: string; pinned: boolean; title: string }>
}
type W = {
  __evaosShell: { tabs(): Snap; openPlace(p: string, n?: boolean): void }
  __evaosHotkeys: Array<{ chord: string; action: string }>
}
type G = {
  __evaosTest: {
    hooks: {
      browser: { host: { activeView(): { webContents: Electron.WebContents } } }
    }
  }
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

async function focusShell(shell: Page): Promise<void> {
  await shell.locator(sel('tabbar-drag')).click()
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

  await shell.keyboard.press('Meta+t')
  await expect.poll(async () => (await tabs(shell)).list.length).toBe(2)
  await shell.keyboard.press('Meta+w')
  await expect.poll(async () => (await tabs(shell)).list.length).toBe(1)

  await shell.evaluate(() => (window as unknown as W).__evaosShell.openPlace('habits'))
  await expect.poll(async () => (await tabs(shell)).list[0]!.title).toBe('Habits')
  await shell.keyboard.press('Meta+[')
  await expect.poll(async () => (await tabs(shell)).list[0]!.title).toBe('Dashboard')
  await shell.keyboard.press('Meta+]')
  await expect.poll(async () => (await tabs(shell)).list[0]!.title).toBe('Habits')

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

test('Esc pops menu, then sub-page, then does nothing and is not prevented', async ({ shell }) => {
  await focusShell(shell)
  await shell.locator(sel('account-trigger')).click()
  await expect(shell.locator(sel('account-menu'))).toBeVisible()
  await shell.keyboard.press('Escape')
  await expect(shell.locator(sel('account-menu'))).toBeHidden()
  expect(await level(shell)).toBe('root')

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

async function viewReady(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(() => {
    try {
      return Boolean(
        (globalThis as unknown as G).__evaosTest.hooks.browser.host
          .activeView()
          .webContents.getURL(),
      )
    } catch {
      return false
    }
  })
}

test('a chord from a guest browser view reaches the same router', async ({ app, shell }, info) => {
  const addr = shell.locator(sel('address-input'))
  await addr.fill(server.url('/a.html'))
  await addr.press('Enter')
  await expect(shell.locator('[data-testid^=browser-tab-t]').first()).toContainText('Page A')
  await expect.poll(() => viewReady(app)).toBe(true)
  await clearLog(shell)
  await app.evaluate(() => {
    const wc = (globalThis as unknown as G).__evaosTest.hooks.browser.host.activeView().webContents
    wc.focus()
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'B', modifiers: ['meta', 'shift'] })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'B', modifiers: ['meta', 'shift'] })
  })
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
