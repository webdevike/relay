import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp } from './fixtures'
import { proofShot } from './helpers/proofShot'

test.use({ startOnChat: true, colorScheme: 'dark' })

interface Hooks {
  openPlace(page: string, newTab?: boolean, extra?: { settingsSection: string }): void
  tabs(): { active: number; list: Array<{ id: number; page: string }> }
}
type W = { __evaosShell?: Hooks }

async function openChatSettings(page: Page, newTab = false): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as W).__evaosShell))
  await page.evaluate(
    (nt) =>
      (window as unknown as W).__evaosShell!.openPlace('settings', nt, { settingsSection: 'Chat' }),
    newTab,
  )
  await page.waitForSelector('[data-testid=settings-chat]')
}

const readChat = (dir: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'chat.json'), 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return null
  }
}

test('thinking switch applies live to the open chat and persists in chat.json', async ({
  app,
  shell,
  configDir,
}) => {
  await shell.getByTestId('nav-chat').click()
  await shell
    .getByTestId('chat-tree')
    .getByRole('link', {
      name: /^Fixture chat(?:,|$)/,
    })
    .click()
  const log = shell.locator('[data-testid=chat-log]')
  await expect(log).toContainText('Please sketch a tiny greeter.')
  // Rust default: thinking is off.
  await expect(log.locator('[data-role=thinking]')).toHaveCount(0)

  await openChatSettings(shell, true)
  const thinking = shell.locator('[data-testid=settings-show-thinking]')
  const tools = shell.locator('[data-testid=settings-show-tools]')
  await expect(thinking).not.toBeChecked()
  await expect(tools).not.toBeChecked()
  await proofShot(app, shell, 'settings-chat', { phase: 'phase-4' })
  await shell.getByText('Show thinking', { exact: true }).click()
  await expect(thinking).toBeChecked()
  await expect.poll(() => readChat(configDir)?.['show_thinking']).toBe(true)

  // Settings is its own workspace. Leaving the chat (its only tab, no tool tabs) closed its tab,
  // so the read, done chat fast-settles into the Settled fold. The list moves rows between the
  // list and the fold on its next push, so one isVisible() read can see the row in neither and
  // then wait on a fold that never comes: retry the whole reveal until the row takes the click.
  const sidebar = shell.getByTestId('sidebar')
  const out = shell.getByTestId('sidebar-back')
  const row = sidebar.getByRole('link', { name: /^Fixture chat(?:,|$)/ })
  const settled = shell.getByTestId('chat-settled-toggle')
  await expect(async () => {
    if ((await sidebar.getAttribute('data-sidebar-level')) !== 'chats') {
      if (await out.isVisible()) await out.click({ timeout: 1_000 })
      await shell.getByTestId('nav-chat').click({ timeout: 1_000 })
    }
    if (
      !(await row.isVisible()) &&
      (await settled.getAttribute('aria-expanded', { timeout: 1_000 })) === 'false'
    )
      await settled.click({ timeout: 1_000 })
    await row.click({ timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
  await expect(log).toContainText('Please sketch a tiny greeter.')
  await expect(shell.locator('[data-testid=chat-log] [data-role=thinking]').first()).toBeVisible()
  await app.close()

  const app2 = await launchApp(configDir)
  try {
    const page = await app2.firstWindow()
    await page.waitForSelector('[data-testid=rail]', { state: 'attached' })
    await openChatSettings(page)
    await expect(page.locator('[data-testid=settings-show-thinking]')).toBeChecked()
  } finally {
    await app2.close()
  }
})

test.describe('settings.json fallback', () => {
  test.use({ startOnChat: false })
  test('settings.json values are honored when chat.json has none', async ({ shell, configDir }) => {
    // Written after launch: the first load happens when the Chat section opens.
    fs.writeFileSync(path.join(configDir, 'settings.json'), '{"show_tools":true}')
    await openChatSettings(shell)
    await expect(shell.locator('[data-testid=settings-show-tools]')).toBeChecked()
    await expect(shell.locator('[data-testid=settings-show-thinking]')).not.toBeChecked()
    expect(readChat(configDir)).toBeNull()
  })
})

test.describe('harness', () => {
  test.use({ startOnChat: false })
  test('Claude Code choice persists as harness in chat.json', async ({ shell, configDir }) => {
    await openChatSettings(shell)
    const ctl = shell.locator('[data-testid=settings-harness]')
    await expect(ctl).toContainText('omp')
    await expect(ctl).toContainText('Claude Code')
    await expect(shell.getByText('Applies to new chats.')).toBeVisible()
    await ctl.getByText('Claude Code', { exact: true }).click()
    await expect.poll(() => readChat(configDir)?.['harness']).toBe('claude')
    await expect(
      shell.getByText('Claude Code was not found. Install it, then try again.'),
    ).toHaveCount(0)
  })
})

test.describe('harness missing', () => {
  test.use({
    startOnChat: false,
    launchEnv: { EVAOS_CLAUDE_BIN: '/nonexistent/claude-bin' },
  })
  test('shows the not-found notice', async ({ app, shell }) => {
    await openChatSettings(shell)
    await shell.locator('[data-testid=settings-harness]').getByText('Claude Code').click()
    await expect(
      shell.getByText('Claude Code was not found. Install it, then try again.'),
    ).toBeVisible()
    await proofShot(app, shell, 'settings-harness-missing', { phase: 'phase-4' })
  })
})
