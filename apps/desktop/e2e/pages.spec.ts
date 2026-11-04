import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

test.use({ startOnChat: false, colorScheme: 'dark' })

type Hooks = {
  __evaosShell: {
    openPlace(p: string, n?: boolean): void
    openChat(): void
  }
}
const open = (shell: Page, slug: string): Promise<void> =>
  shell.evaluate((s) => (window as unknown as Hooks).__evaosShell.openPlace(s), slug)
// Tool panes have tabs too: the app tab in front is the tab bar's.
const ACTIVE_APP_TAB = '[data-testid=tabbar] .eva-tab[data-active=true]'

test('dashboard renders its data and tab title', async ({ shell }) => {
  await open(shell, 'jobs')
  await open(shell, 'dashboard')
  await expect(shell.locator('[data-testid=page-dashboard]')).toBeVisible()
  await expect(shell.locator('[data-testid=dash-hero]')).toBeVisible()
  await expect(shell.locator(ACTIVE_APP_TAB)).toContainText('Dashboard')
})

test('jobs renders its table and tab title', async ({ shell }) => {
  await open(shell, 'jobs')
  await expect(shell.locator('[data-testid=page-jobs]')).toBeVisible()
  await expect(shell.locator('[data-testid=jobs-table]')).toBeVisible()
  await expect(shell.locator(ACTIVE_APP_TAB)).toContainText('Jobs')
})

test('habits renders its gate and tab title', async ({ shell }) => {
  await open(shell, 'habits')
  await expect(shell.locator('[data-testid=page-habits]')).toBeVisible()
  await expect(shell.locator('[data-testid=habit-gate-strip]')).toBeVisible()
  await expect(shell.locator(ACTIVE_APP_TAB)).toContainText('Habits')
})

test('scroll memory per page', async ({ shell }) => {
  await shell.addStyleTag({ content: '[data-testid="page-jobs"] { min-height: 2000px; }' })
  await open(shell, 'jobs')
  const scroll = shell.locator('[data-testid=page-scroll]')
  const viewport = scroll.locator('.mantine-ScrollArea-viewport')
  await viewport.evaluate((el) => (el.scrollTop = 150))
  await shell.waitForTimeout(100)

  await open(shell, 'habits')
  await expect(shell.locator('[data-testid=page-habits]')).toBeVisible()
  expect(await viewport.evaluate((el) => el.scrollTop)).toBe(0)

  await open(shell, 'jobs')
  await expect(shell.locator('[data-testid=page-jobs]')).toBeVisible()
  await expect.poll(() => viewport.evaluate((el) => Math.abs(el.scrollTop - 150) <= 2)).toBe(true)
})

test('chat pane survives tab switches', async ({ shell }) => {
  await shell.evaluate(() => (window as unknown as Hooks).__evaosShell.openChat())
  await shell.getByTestId('nav-chat').click()
  await shell
    .getByTestId('chat-tree')
    .getByRole('link', {
      name: /^Fixture chat(?:,|$)/,
    })
    .click()
  const log = shell.locator('[data-testid=chat-log]')
  await expect(log).toContainText('Please sketch a tiny greeter.')

  // The tab moves on to Dashboard: its chat leaves the screen (it mounts again from the chat
  // store when the tab comes back to it).
  await open(shell, 'dashboard')
  await expect(shell.locator('[data-testid=chat-pane]')).toBeHidden()

  await shell.locator('[data-testid=tabbar-drag]').click()
  await shell.keyboard.press('Meta+[')
  await expect(shell.locator('[data-testid=chat-pane]')).toBeVisible()
  await expect(log).toContainText('Please sketch a tiny greeter.')
  const box = await log.boundingBox()
  expect(box?.height ?? 0).toBeGreaterThan(50)
})

test('browser slot is unaffected by page changes', async ({ shell }) => {
  const rect = () =>
    shell.locator('[data-testid=browser-slot]').evaluate((el) => {
      const r = el.getBoundingClientRect()
      return [r.x, r.y, r.width, r.height]
    })
  // The tool panes are global: the browser stays in its pane while the page in front changes.
  const openPage = async (slug: string): Promise<void> => {
    await open(shell, slug)
    await expect(shell.locator(`[data-testid=page-${slug}]`)).toBeVisible()
    await expect(
      shell.locator('[data-testid=pane-body-p2] [data-testid=browser-panel]'),
    ).toBeVisible()
  }
  await openPage('dashboard')
  const a = await rect()
  await openPage('jobs')
  await expect.poll(rect).toEqual(a)
  await openPage('habits')
  await expect.poll(rect).toEqual(a)
})
