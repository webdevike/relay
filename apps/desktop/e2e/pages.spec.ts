import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { startStaticServer, type StaticServer } from './helpers/static-server'
import {
  expectViewOnSlot,
  navigate,
  newPage,
  pageTab,
  slotRect,
  toolPane,
  viewVisible,
  webPanel,
} from './helpers/web'

test.use({ startOnChat: false, colorScheme: 'dark' })

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

type Hooks = {
  __evaosShell: {
    openPlace(p: string, n?: boolean, extra?: object): void
    openChat(): void
    setPanel(open: boolean): void
    tabs(): { active: number; list: Array<{ chat: string | null }> }
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
  const file = await shell.evaluate(() => {
    const t = (window as unknown as Hooks).__evaosShell.tabs()
    return t.list[t.active]!.chat ?? ''
  })
  expect(file).toMatch(/\.jsonl$/)

  // Dashboard is a workspace of its own: switching there takes the chat off the screen.
  await open(shell, 'dashboard')
  await expect(shell.locator('[data-testid=chat-pane]')).toBeHidden()

  // Back to the chat's workspace: its chat mounts again from the chat store.
  await shell.evaluate(
    (f) => (window as unknown as Hooks).__evaosShell.openPlace('chat', false, { chat: f }),
    file,
  )
  await expect(shell.locator('[data-testid=chat-pane]')).toBeVisible()
  await expect(log).toContainText('Please sketch a tiny greeter.')
  const box = await log.boundingBox()
  expect(box?.height ?? 0).toBeGreaterThan(50)
})

test('a web page beside a tab stays put while the tab changes place', async ({ app, shell }) => {
  // Canvas is one workspace for every board: a web page in its tool pane stays where it is
  // while the app tab moves from board to board.
  const board = (slug: string): Promise<void> =>
    shell.evaluate(
      (s) => (window as unknown as Hooks).__evaosShell.openPlace('canvas', false, { canvas: s }),
      slug,
    )
  await board('first-board')
  await expect(shell.locator(ACTIVE_APP_TAB)).toContainText('first-board')
  await shell.evaluate(() => (window as unknown as Hooks).__evaosShell.setPanel(true))
  const pane = await toolPane(shell)
  const page = await newPage(shell, pane)
  await navigate(shell, page, server.url('/a.html'))
  await expect(pageTab(shell, page)).toContainText('Page A')
  await expectViewOnSlot(app, shell, page)
  const a = await slotRect(shell, page)
  for (const slug of ['second-board', 'third-board']) {
    await board(slug)
    await expect(shell.locator(ACTIVE_APP_TAB)).toContainText(slug)
    await expect(webPanel(shell, page)).toBeVisible()
    await expect.poll(() => slotRect(shell, page)).toEqual(a)
    await expect.poll(() => viewVisible(app, page)).toBe(true)
  }
})
