import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { test as base, expect, launchApp } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { proofShot } from './helpers/proofShot'

// Categories: create, rename, delete, Move to, drag and drop and keyboard reorder, persisted in
// chat.json. Runs on a tmp copy of the agent fixture; renderer-level mouse input only.
let fx: ChatFixture
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    await use({ ...fx.launchEnv, FAKE_OMP_DELAY_MS: '5' })
    fx.cleanup()
  },
})

const sel = (id: string): string => `[data-testid="${id}"]`
const openChats = async (shell: Page): Promise<void> => {
  await shell.locator(sel('nav-chat')).click()
  await shell.waitForSelector('[role=tree]')
}
const rowOf = (shell: Page, id: string): Locator => shell.locator(sel(`chat-row-${id}`))
const groupNames = async (shell: Page): Promise<string[]> =>
  (
    await shell
      .locator('[data-testid^="chat-section-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''))
  ).map((t) => t.replace('chat-section-', ''))
const chatJson = (
  configDir: string,
): {
  chat_categories?: string[]
  chat_group_order?: string[]
  chat_assignments?: Record<string, string>
} => {
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir, 'chat.json'), 'utf8'))
  } catch {
    return {}
  }
}

async function dragTo(shell: Page, from: Locator, to: Locator, hold = false): Promise<void> {
  const a = (await from.boundingBox())!
  const b = (await to.boundingBox())!
  await shell.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await shell.mouse.down()
  await shell.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 8, { steps: 3 })
  await shell.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 })
  if (!hold) await shell.mouse.up()
}

test('categories: create, move, drag, keyboard reorder, persist, rename, delete', async ({
  app,
  shell,
  configDir,
}) => {
  await openChats(shell)

  // 1. Create with the inline input; errors show inline.
  await shell.locator(sel('new-category')).click()
  const input = shell.locator(sel('category-input'))
  await expect(input).toBeFocused()
  await input.press('Enter')
  await expect(shell.locator(sel('category-error'))).toHaveText('Give the category a name.')
  await input.fill('Focus')
  await input.press('Enter')
  await expect(shell.locator(sel('chat-section-Focus'))).toBeVisible()
  expect((await groupNames(shell))[0]).toBe('Focus')
  await expect(shell.locator(sel('chat-section-Focus'))).toContainText('No chats in this group')

  await shell.locator(sel('new-category')).click()
  await shell.locator(sel('category-input')).fill('focus')
  await shell.locator(sel('category-input')).press('Enter')
  await expect(shell.locator(sel('category-error'))).toHaveText(
    'A category with that name already exists.',
  )
  await shell.locator(sel('category-input')).press('Escape')
  await expect(shell.locator(sel('category-input'))).toHaveCount(0)

  // 2. Move to via the row menu.
  await rowOf(shell, 'p4-other1').click({ button: 'right' })
  await shell.locator(sel('row-menu-move')).click()
  await shell.locator(sel('row-menu-move-Focus')).click()
  await expect(
    shell.locator(`${sel('chat-section-Focus')} ${sel('chat-row-p4-other1')}`),
  ).toBeVisible()

  // 3. Drag a chat onto a group header.
  await dragTo(shell, rowOf(shell, 'p4-other2'), shell.locator(sel('chat-group-Focus')), true)
  await proofShot(app, shell, 'categories-drag', { phase: 'phase-4' })
  await shell.mouse.up()
  await expect(
    shell.locator(`${sel('chat-section-Focus')} ${sel('chat-row-p4-other2')}`),
  ).toBeVisible()
  await proofShot(app, shell, 'categories', { phase: 'phase-4' })

  // 4. Keyboard reorder: Relay moves above its previous neighbour.
  const before = await groupNames(shell)
  const at = before.indexOf('Relay')
  expect(at).toBeGreaterThan(1)
  await shell.locator(sel('chat-group-Relay')).focus()
  await shell.keyboard.press('Space')
  await shell.keyboard.press('ArrowUp')
  await shell.keyboard.press('Space')
  await expect.poll(() => groupNames(shell).then((g) => g.indexOf('Relay'))).toBe(at - 1)
  const order = await groupNames(shell)

  // 5. Persists across relaunch.
  await expect
    .poll(() => chatJson(configDir).chat_assignments)
    .toEqual({ 'p4-other1': 'Focus', 'p4-other2': 'Focus' })
  expect(chatJson(configDir).chat_categories).toEqual(['Focus'])
  await app.close()
  const app2 = await launchApp(configDir, fx.launchEnv)
  try {
    const page = await app2.firstWindow()
    await page.waitForSelector('[data-testid=rail]', { state: 'attached' })
    await page.locator(sel('nav-chat')).click()
    await page.waitForSelector('[role=tree]')
    await expect(
      page.locator(`${sel('chat-section-Focus')} ${sel('chat-row-p4-other1')}`),
    ).toBeVisible()
    await expect(
      page.locator(`${sel('chat-section-Focus')} ${sel('chat-row-p4-other2')}`),
    ).toBeVisible()
    expect(await groupNames(page)).toEqual(order)

    // 6. Rename, then delete with the confirm modal.
    await page.locator(sel('group-actions-Focus')).click({ force: true })
    await page.locator(sel('group-menu-rename')).click()
    const rename = page.locator(sel('category-input'))
    await rename.fill('Deep work')
    await rename.press('Enter')
    await expect(page.locator(sel('chat-section-Deep work'))).toBeVisible()
    await expect.poll(() => chatJson(configDir).chat_categories).toEqual(['Deep work'])

    await page.locator(sel('group-actions-Deep work')).click({ force: true })
    await page.locator(sel('group-menu-delete')).click()
    const modal = page.locator(sel('delete-category-modal'))
    await expect(modal).toContainText('Delete category "Deep work"?')
    await expect(page.getByRole('button', { name: 'Keep category' })).toBeFocused()
    await proofShot(app2, page, 'category-delete-modal', { phase: 'phase-4' })
    await page.getByRole('button', { name: 'Delete category' }).click()
    await expect(page.locator(sel('chat-section-Deep work'))).toHaveCount(0)
    await expect(
      page.locator(`${sel('chat-section-Other')} ${sel('chat-row-p4-other1')}`),
    ).toBeVisible()
    await expect(
      page.locator(`${sel('chat-section-Other')} ${sel('chat-row-p4-other2')}`),
    ).toBeVisible()
    await expect.poll(() => chatJson(configDir).chat_assignments).toEqual({})
  } finally {
    await app2.close()
  }
})
