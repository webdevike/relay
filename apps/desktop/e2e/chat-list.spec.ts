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

test('chats are grouped with Pinned on top and five visible per group', async ({ app, shell }) => {
  const tree = shell.locator('[role=tree]')
  await expect(tree).toBeVisible()
  await expect(shell.locator(sel('chat-pinned'))).toContainText('Pinned planning notes')

  const groups = await shell.$$eval('[data-testid^="chat-group-"]', (els) =>
    els.map((e) => e.getAttribute('data-testid')),
  )
  expect(groups).toEqual([
    'chat-group-eCard',
    'chat-group-EvaOS',
    'chat-group-Relay',
    'chat-group-Eva',
    'chat-group-Other',
  ])

  // Other holds the seven grocery lists plus four more untitled-by-workspace chats: 11 in all.
  const other = shell.locator(sel('chat-section-Other'))
  await expect(other.locator('[data-testid^="chat-row-"]')).toHaveCount(5)
  const more = shell.locator(sel('chat-show-more-Other'))
  await expect(more).toHaveText('Show 6 more')
  await proofShot(app, shell, 'chat-list', { phase: 'phase-4' })

  await more.click()
  await expect(other.locator('[data-testid^="chat-row-"]')).toHaveCount(11)
  await expect(more).toHaveText('Show fewer')
  await proofShot(app, shell, 'chat-list-expanded', { phase: 'phase-4' })
  await more.click()
  await expect(other.locator('[data-testid^="chat-row-"]')).toHaveCount(5)
})

test('a recently written chat sorts first in its group and counts as running', async ({
  shell,
}) => {
  fx.touch('p4-other7', 0)
  // The list reads on mount; reopen the sub page by reloading the renderer.
  await shell.reload()
  await shell.waitForSelector('[role=tree]')
  const other = shell.locator(sel('chat-section-Other'))
  await expect(other.locator('[data-testid^="chat-row-"]').first()).toHaveAttribute(
    'data-testid',
    'chat-row-p4-other7',
  )
  await expect(shell.locator(sel('chat-group-Other'))).toContainText('1 running')
})

test('clicking a chat opens its transcript in the chat pane', async ({ shell }) => {
  await shell.locator(sel('chat-row-p4-ecard')).click()
  await expect(shell.locator(sel('chat-header'))).toContainText('eCard reports app cleanup')
  await expect(shell.locator(sel('chat-log'))).toContainText('Hello from p4-ecard')
  await expect(shell.locator(sel('chat-row-p4-ecard'))).toHaveAttribute('data-active', 'true')
})

test('every fixture session appears: tree rows plus hidden plus archived', async ({ shell }) => {
  await shell.waitForSelector('[role=tree]')
  for (const name of ['Other']) await shell.locator(sel(`chat-show-more-${name}`)).click()
  const rows = await shell.locator('[data-testid^="chat-row-"]').count()
  // 17 sessions: 1 archived stays behind its toggle.
  expect(rows).toBe(16)
  const archived = shell.locator(sel('chat-archived-toggle'))
  await expect(archived).toContainText('1')
  await archived.click()
  await expect(shell.locator(sel('chat-row-p4-archived'))).toBeVisible()
})
