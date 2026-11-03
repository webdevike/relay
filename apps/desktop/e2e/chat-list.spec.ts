import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, writeChatPrefs, type ChatFixture } from './helpers/chat-fixture'
import { proofShot } from './helpers/proofShot'

// One tmp copy of the agent-p4 fixture per test; p4-archived is archived through chat.json.
let fx: ChatFixture
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    await use(fx.launchEnv)
    fx.cleanup()
  },
  configDir: async ({ configDir }, use) => {
    writeChatPrefs(configDir, { archived_chats: ['p4-archived'] })
    await use(configDir)
  },
})

const sel = (id: string): string => `[data-testid="${id}"]`
const openChats = async (shell: Page): Promise<void> => {
  await shell.locator(sel('nav-chat')).click()
  await shell.waitForSelector('[data-testid=chat-tree]')
}

test('pinned rows sit flat on top, folders follow newest first, ten rows per folder', async ({
  app,
  shell,
}) => {
  await openChats(shell)
  // Pinned rows have no header: the first row of the tree, outside every folder.
  await expect(shell.locator(`${sel('chat-tree')} > .eva-cl-rowwrap`).first()).toContainText(
    'Pinned planning notes',
  )

  const groups = await shell.$$eval('[data-testid^="chat-group-"]', (els) =>
    els.map((e) => e.getAttribute('data-testid')),
  )
  // Folders follow their newest return (the fixture's file times on a first look).
  expect(groups).toEqual([
    'chat-group-eCard',
    'chat-group-Relay',
    'chat-group-EvaOS',
    'chat-group-Other',
    'chat-group-Eva',
  ])

  // Other holds the seven grocery lists plus four more untitled-by-workspace chats: 11 in all.
  const other = shell.locator(sel('chat-section-Other'))
  await expect(shell.locator(sel('chat-group-Other'))).toContainText('Other11')
  await expect(other.locator('[data-testid^="chat-row-"]')).toHaveCount(10)
  const more = shell.locator(sel('chat-show-more-Other'))
  await expect(more).toHaveText('Show 1 more')
  await proofShot(app, shell, 'chat-list', { phase: 'phase-4' })

  await more.click()
  await expect(other.locator('[data-testid^="chat-row-"]')).toHaveCount(11)
  await expect(more).toHaveText('Show fewer')
  await proofShot(app, shell, 'chat-list-expanded', { phase: 'phase-4' })
  await more.click()
  await expect(other.locator('[data-testid^="chat-row-"]')).toHaveCount(10)
})

test('a recently written chat returns to the top; its folder still collapses', async ({
  shell,
}) => {
  fx.touch('p4-other7', 0)
  // The list reads on mount; reopen the sub page by reloading the renderer.
  await shell.reload()
  await shell.waitForSelector(sel('rail'))
  await openChats(shell)
  const other = shell.locator(sel('chat-section-Other'))
  await expect(other.locator('[data-testid^="chat-row-"]').first()).toHaveAttribute(
    'data-testid',
    'chat-row-p4-other7',
  )
  await expect(shell.locator('[data-testid^="chat-group-"]').first()).toHaveAttribute(
    'data-testid',
    'chat-group-Other',
  )
  // A folder with a running chat still collapses on a click, and its header keeps the hint.
  const header = shell.locator(sel('chat-group-Other'))
  await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  await expect(shell.locator(sel('chat-row-p4-other7'))).toHaveCount(0)
  await expect(header.getByRole('img', { name: 'Done' })).toBeVisible()
  await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'true')
  await expect(shell.locator(sel('chat-row-p4-other7'))).toBeVisible()
})

test('clicking a chat opens its transcript in the chat pane', async ({ shell }) => {
  await openChats(shell)
  await shell.locator(sel('chat-row-p4-ecard')).click()
  await expect(shell.locator(sel('chat-header'))).toContainText('eCard reports app cleanup')
  await expect(shell.locator(sel('chat-log'))).toContainText('Hello from p4-ecard')
  await expect(shell.locator(sel('chat-row-p4-ecard'))).toHaveAttribute('data-active', 'true')
})

test('every fixture session appears: tree rows plus hidden plus settled', async ({ shell }) => {
  await openChats(shell)
  for (const name of ['Other']) await shell.locator(sel(`chat-show-more-${name}`)).click()
  const rows = await shell.locator('[data-testid^="chat-row-"]').count()
  // 17 sessions: 1 archived stays behind the Settled fold.
  expect(rows).toBe(16)
  const settled = shell.locator(sel('chat-settled-toggle'))
  await expect(settled).toHaveText('Settled (1)')
  await expect(settled).toHaveAttribute('aria-expanded', 'false')
  await settled.click()
  await expect(shell.locator(sel('chat-row-p4-archived'))).toBeVisible()
})
