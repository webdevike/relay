import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

test.use({ startOnChat: false, colorScheme: 'dark' })

const SMALL = '2026-10-01T09-00-00-000Z_small'

type Hooks = {
  __evaosShell: {
    openPlace(p: string, n?: boolean): void
    openChat(): void
    setPageFiller(on: boolean): void
  }
}
const open = (shell: Page, slug: string): Promise<void> =>
  shell.evaluate((s) => (window as unknown as Hooks).__evaosShell.openPlace(s), slug)

const PAGES: Array<[string, string, string, string]> = [
  ['inbox', 'Inbox', 'Inbox', 'Digests and approvals from Eva will appear here in a later update.'],
  ['calendar', 'Calendar', 'Calendar', 'Your calendar will appear here in a later update.'],
  ['tasks', 'Tasks', 'Tasks', 'Your open todos will appear here in a later update.'],
  ['memory', 'Memory', 'Memory', "Eva's memory will appear here in a later update."],
  ['files', 'Files', 'Files', 'Browse and edit files from here in a later update.'],
  [
    'help',
    'Help Center',
    'Help Center',
    'Guides and shortcuts will appear here in a later update.',
  ],
]

test('every placeholder page renders its copy and tab title', async ({ shell }) => {
  for (const [slug, title, tabTitle, desc] of PAGES) {
    await open(shell, slug)
    const page = shell.locator(`[data-testid=page-${slug}]`)
    await expect(page).toBeVisible()
    await expect(page.locator('h1')).toHaveText(title)
    await expect(page).toContainText(desc)
    await expect(shell.locator('[role=tab][data-active=true]')).toContainText(tabTitle)
  }
})

test('dashboard is a real page, not a placeholder', async ({ shell }) => {
  await open(shell, 'inbox')
  await open(shell, 'dashboard')
  await expect(shell.locator('[data-testid=page-dashboard]')).toBeVisible()
  await expect(shell.locator('[data-testid=dash-hero]')).toBeVisible()
  await expect(shell.locator('[role=tab][data-active=true]')).toContainText('Dashboard')
})

test('jobs is a real page, not a placeholder', async ({ shell }) => {
  await open(shell, 'jobs')
  await expect(shell.locator('[data-testid=page-jobs]')).toBeVisible()
  await expect(shell.locator('[data-testid=jobs-table]')).toBeVisible()
  await expect(shell.locator('[role=tab][data-active=true]')).toContainText('Jobs')
})

test('habits is a real page, not a placeholder', async ({ shell }) => {
  await open(shell, 'habits')
  await expect(shell.locator('[data-testid=page-habits]')).toBeVisible()
  await expect(shell.locator('[data-testid=habit-gate-strip]')).toBeVisible()
  await expect(shell.locator('[role=tab][data-active=true]')).toContainText('Habits')
})

test('scroll memory, fades and contained overscroll', async ({ shell }) => {
  await shell.evaluate(() => (window as unknown as Hooks).__evaosShell.setPageFiller(true))
  await open(shell, 'inbox')
  const scroll = shell.locator('[data-testid=page-scroll]')
  const viewport = scroll.locator('.eva-scroll-viewport')
  await expect(scroll).toHaveAttribute('data-fade-top', 'false')
  await expect(scroll).toHaveAttribute('data-fade-bottom', 'true')
  expect(await viewport.evaluate((el) => getComputedStyle(el).overscrollBehaviorY)).toBe('contain')
  await viewport.evaluate((el) => (el.scrollTop = 150))
  await expect(scroll).toHaveAttribute('data-fade-top', 'true')
  await shell.waitForTimeout(100)

  await open(shell, 'tasks')
  await expect(shell.locator('[data-testid=page-tasks]')).toBeVisible()
  expect(await viewport.evaluate((el) => el.scrollTop)).toBe(0)

  await open(shell, 'inbox')
  await expect(shell.locator('[data-testid=page-inbox]')).toBeVisible()
  await expect.poll(() => viewport.evaluate((el) => Math.abs(el.scrollTop - 150) <= 2)).toBe(true)

  await viewport.evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect(scroll).toHaveAttribute('data-fade-bottom', 'false')
})

test('chat pane survives tab switches', async ({ shell }) => {
  await shell.evaluate(() => (window as unknown as Hooks).__evaosShell.openChat())
  await shell.locator(`[data-testid=session-${SMALL}]`).click()
  const log = shell.locator('[data-testid=chat-log]')
  await expect(log).toContainText('Please sketch a tiny greeter.')

  await open(shell, 'dashboard')
  await expect(shell.locator('[data-testid=chat-pane]')).toBeHidden()
  await expect(shell.locator('[data-testid=chat-pane]')).toHaveCount(1)

  await shell.locator('[data-testid=tabbar-drag]').click()
  await shell.keyboard.press('Meta+[')
  await expect(shell.locator('[data-testid=chat-pane]')).toBeVisible()
  await expect(log).toContainText('Please sketch a tiny greeter.')
  const box = await log.boundingBox()
  expect(box?.height ?? 0).toBeGreaterThan(50)
})

test('browser panel slot is unaffected by page changes', async ({ shell }) => {
  const rect = () =>
    shell.locator('[data-testid=browser-slot]').evaluate((el) => {
      const r = el.getBoundingClientRect()
      return [r.x, r.y, r.width, r.height]
    })
  await open(shell, 'inbox')
  const a = await rect()
  await open(shell, 'jobs')
  await open(shell, 'tasks')
  expect(await rect()).toEqual(a)
})
