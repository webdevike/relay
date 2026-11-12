import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

type Snap = { active: number; list: Array<{ id: number; title: string }> }
type W = {
  __evaosShell: {
    tabs(): Snap
    openPlace(page: string, newTab?: boolean, extra?: object): void
    history(): { index: number; titles: string[]; fronts: Array<string | null> }
  }
}

const sel = (id: string): string => `[data-testid=${id}]`
const hist = (shell: Page) => shell.evaluate(() => (window as unknown as W).__evaosShell.history())
const front = (shell: Page): Promise<string> =>
  shell.evaluate(() => {
    const t = (window as unknown as W).__evaosShell.tabs()
    return t.list[t.active]!.title
  })
const open = (shell: Page, page: string, extra: object = {}): Promise<void> =>
  shell.evaluate(
    ([p, e]) => (window as unknown as W).__evaosShell.openPlace(p as string, false, e as object),
    [page, extra] as const,
  )

/** Waits until the history has recorded `title` as where Isaac is (a spot settles after 150 ms). */
const recorded = (shell: Page, title: string) =>
  expect
    .poll(async () => {
      const h = await hist(shell)
      return h.titles[h.index] === title && h.index === h.titles.length - 1
    })
    .toBe(true)

/** The keyboard on the shell itself, out of any text field. */
async function focusShell(shell: Page): Promise<void> {
  await shell.locator(sel('tabbar-drag')).click()
  await shell.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

test.use({ colorScheme: 'dark' })

test('Cmd+Left x3 goes back to the chat, Cmd+Right forward; the composer keeps the caret', async ({
  shell,
}) => {
  // Chat A: a new chat with an unsent draft, so it stays when Isaac leaves it.
  const composer = shell.locator(sel('composer-input'))
  await composer.fill('chat A draft')
  await recorded(shell, 'New chat')
  const chatTab = await front(shell)
  expect(chatTab).toBe('New chat')

  await open(shell, 'settings', { settingsSection: 'Theme' })
  await recorded(shell, 'Settings: Theme')
  await open(shell, 'settings', { settingsSection: 'Chat' })
  await recorded(shell, 'Settings: Chat')
  await open(shell, 'board:e2e-board')
  await expect.poll(() => hist(shell).then((h) => h.titles.length)).toBeGreaterThanOrEqual(4)
  await expect.poll(() => front(shell)).toBe('e2e-board')
  await recorded(shell, 'e2e-board')

  await focusShell(shell)
  for (let i = 0; i < 3; i++) await shell.keyboard.press('Meta+ArrowLeft')
  await expect.poll(() => front(shell)).toBe('New chat')
  await expect(composer).toHaveValue('chat A draft')
  await expect
    .poll(async () => (await hist(shell)).titles[(await hist(shell)).index])
    .toBe('New chat')

  // Forward redoes where Isaac was, one step.
  await focusShell(shell)
  await shell.keyboard.press('Meta+ArrowRight')
  await expect.poll(() => front(shell)).toBe('Settings: Theme')

  // Back to the chat; in its composer Cmd+Left moves the caret and the history stays put.
  await shell.keyboard.press('Meta+ArrowLeft')
  await expect.poll(() => front(shell)).toBe('New chat')
  const at = (await hist(shell)).index
  await composer.focus()
  await composer.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 5))
  await shell.keyboard.press('Meta+ArrowLeft')
  expect(await composer.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(0)
  expect(await front(shell)).toBe('New chat')
  expect((await hist(shell)).index).toBe(at)
  // Cmd+[ is not a caret chord: it steps even from the composer.
  await shell.keyboard.press('Meta+[')
  await expect.poll(async () => (await hist(shell)).index).toBeLessThan(at)
})

test('the header buttons step, and right-click lists the entries', async ({ shell }) => {
  await shell.locator(sel('composer-input')).fill('keep this chat')
  await recorded(shell, 'New chat')
  await open(shell, 'settings', { settingsSection: 'Theme' })
  await recorded(shell, 'Settings: Theme')
  await open(shell, 'settings', { settingsSection: 'Chat' })
  await recorded(shell, 'Settings: Chat')

  const back = shell.locator(sel('history-back'))
  const forward = shell.locator(sel('history-forward'))
  await expect(back).toBeEnabled()
  await expect(forward).toBeDisabled()

  await back.click({ button: 'right' })
  const entries = shell.locator(sel('history-entry'))
  // Nearest first: Settings: Theme, the chat, the Dashboard the window started on.
  await expect(entries).toHaveCount(3)
  await expect(entries.nth(0)).toHaveText('Settings: Theme')
  await expect(entries.nth(1)).toHaveText('New chat')
  await entries.nth(1).click()
  await expect.poll(() => front(shell)).toBe('New chat')
  await expect(forward).toBeEnabled()
  await expect(back).toBeEnabled()

  await forward.click()
  await expect.poll(() => front(shell)).toBe('Settings: Theme')
  await back.click()
  await expect.poll(() => front(shell)).toBe('New chat')
})

test('the focused tool tab is an entry: Back returns the focus to the chat', async ({ shell }) => {
  await shell.locator(sel('composer-input')).fill('chat with panes')
  await recorded(shell, 'New chat')
  const appPane = shell.locator('[data-pane-kind=app]').first()
  const toolPane = shell.locator('[data-pane-kind=tool]').first()
  await toolPane.locator('.dv-tab').first().click()
  await expect(toolPane).toHaveAttribute('data-focused', /.*/)
  // The tool tab is in front of the focused pane: a spot of its own once it stays 150 ms.
  await expect
    .poll(async () => {
      const h = await hist(shell)
      return h.index === h.fronts.length - 1 && h.fronts[h.index] !== null
    })
    .toBe(true)

  // The tool pane has the keyboard (a click on the shell would be a move of its own).
  await shell.keyboard.press('Meta+[')
  await expect(appPane).toHaveAttribute('data-focused', /.*/)
  await expect(toolPane).not.toHaveAttribute('data-focused', /.*/)
  await shell.keyboard.press('Meta+]')
  await expect(toolPane).toHaveAttribute('data-focused', /.*/)
})

test('mouse buttons 4 and 5 and a trackpad swipe step the history', async ({ app, shell }) => {
  await shell.locator(sel('composer-input')).fill('mouse chat')
  await recorded(shell, 'New chat')
  await open(shell, 'settings', { settingsSection: 'Theme' })
  await recorded(shell, 'Settings: Theme')
  await open(shell, 'settings', { settingsSection: 'Chat' })
  await recorded(shell, 'Settings: Chat')

  const press = (button: number) =>
    shell.evaluate((b) => {
      for (const type of ['mousedown', 'mouseup'])
        window.dispatchEvent(new MouseEvent(type, { button: b, bubbles: true, cancelable: true }))
    }, button)
  await press(3)
  await expect.poll(() => front(shell)).toBe('Settings: Theme')
  await press(4)
  await expect.poll(() => front(shell)).toBe('Settings: Chat')

  // The window's swipe event (macOS trackpad): left is Back, right is Forward.
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.emit('swipe', {}, 'left'))
  await expect.poll(() => front(shell)).toBe('Settings: Theme')
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.emit('swipe', {}, 'right'))
  await expect.poll(() => front(shell)).toBe('Settings: Chat')
})
