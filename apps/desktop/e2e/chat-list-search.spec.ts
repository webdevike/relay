import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect, launchApp } from './fixtures'
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
  await shell.waitForSelector('[role=tree]')
}

test('Archived (n) hides archived chats until activated', async ({ shell }) => {
  await openChats(shell)
  await expect(shell.locator(sel('chat-row-p4-archived'))).toHaveCount(0)
  const toggle = shell.locator(sel('chat-archived-toggle'))
  await expect(toggle).toContainText('Archived (1)')
  await toggle.click()
  await expect(shell.locator(sel('chat-row-p4-archived'))).toBeVisible()
})

test('search opens every group, includes archived chats and clears with Escape', async ({
  app,
  shell,
}) => {
  await openChats(shell)
  const before = await shell.locator('[data-testid^="chat-row-"]').count()
  const search = shell.locator(sel('sidebar-sub-search'))
  await search.click()
  await shell.keyboard.type('chat')
  await expect(shell.locator(sel('chat-row-p4-archived'))).toBeVisible()
  await expect(shell.locator(sel('chat-row-p4-archived'))).toContainText('Archived')
  await expect(shell.locator('[data-testid^="chat-show-more-"]')).toHaveCount(0)
  await expect(shell.locator(sel('chat-archived-toggle'))).toHaveCount(0)
  await proofShot(app, shell, 'chat-search', { phase: 'phase-4' })

  await search.fill('zzz')
  await expect(shell.locator(sel('sidebar-sub-empty'))).toContainText('No chats match "zzz"')
  await expect(shell.locator(sel('sidebar-sub-empty'))).toContainText('Try a different title.')

  await shell.keyboard.press('Escape')
  await expect(search).toHaveValue('')
  await expect(shell.locator('[data-testid^="chat-row-"]')).toHaveCount(before)
  await expect(shell.locator(sel('chat-archived-toggle'))).toContainText('Archived (1)')
})

test('a collapsed group stays collapsed across relaunch', async ({ app, shell, configDir }) => {
  await openChats(shell)
  const other = shell.locator(sel('chat-section-Other'))
  await expect(other.locator('[data-testid^="chat-row-"]').first()).toBeVisible()
  await shell.locator(sel('chat-group-Other')).click()
  await expect(other.locator('[data-testid^="chat-row-"]')).toHaveCount(0)
  await expect(shell.locator(sel('chat-group-Other'))).toHaveAttribute('aria-expanded', 'false')
  await proofShot(app, shell, 'chat-collapsed', { phase: 'phase-4' })

  const file = path.join(configDir, 'chat.json')
  await expect
    .poll(() => {
      try {
        return (JSON.parse(fs.readFileSync(file, 'utf8')) as { collapsed_groups?: string[] })
          .collapsed_groups
      } catch {
        return undefined
      }
    })
    .toContain('Other')
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).archived_chats).toEqual(['p4-archived'])
  await app.close()

  const app2 = await launchApp(configDir, fx.launchEnv)
  try {
    const page = await app2.firstWindow()
    await page.waitForSelector('[data-testid=rail]', { state: 'attached' })
    await page.locator(sel('nav-chat')).click()
    await page.waitForSelector('[role=tree]')
    await expect(page.locator(sel('chat-group-Other'))).toHaveAttribute('aria-expanded', 'false')
    await expect(
      page.locator(sel('chat-section-Other')).locator('[data-testid^="chat-row-"]'),
    ).toHaveCount(0)
  } finally {
    await app2.close()
  }
})
