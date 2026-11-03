import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { proofShot } from './helpers/proofShot'

// Chat actions from the list: Rename, Pin, Snooze, Settle, Delete. Everything runs on a tmp copy of the
// agent fixture (makeChatFixture); the repo fixtures are never touched.
const LOG = path.join(os.tmpdir(), `evaos-fake-omp-chatops-${process.pid}.log`)

type Ev = { event: string; detail: { argv?: string[]; type?: string } | null }
const readLog = (): Ev[] =>
  fs.existsSync(LOG)
    ? fs
        .readFileSync(LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Ev)
    : []

let fx: ChatFixture
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    await use({ ...fx.launchEnv, FAKE_OMP_DELAY_MS: '5', FAKE_OMP_LOG: LOG })
    fx.cleanup()
  },
})
test.beforeEach(() => {
  fs.rmSync(LOG, { force: true })
})
test.afterAll(() => {
  fs.rmSync(LOG, { force: true })
})

const sel = (id: string): string => `[data-testid="${id}"]`
const openChats = async (shell: Page): Promise<void> => {
  await shell.locator(sel('nav-chat')).click()
  await shell.waitForSelector('[data-testid=chat-tree]')
  for (const more of await shell.locator('[data-testid^="chat-show-more-"]').all()) {
    if (
      (await more.textContent())?.startsWith('Show ') &&
      !(await more.textContent())?.includes('fewer')
    )
      await more.click()
  }
}
const pins = (): string[] =>
  JSON.parse(fs.readFileSync(path.join(fx.agentDir, 'session-pins.json'), 'utf8')) as string[]
const archivedIds = (configDir: string): string[] => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(configDir, 'chat.json'), 'utf8')) as {
      archived_chats?: string[]
    }
    return j.archived_chats ?? []
  } catch {
    return []
  }
}
const menuIds = (shell: Page): Promise<string[]> =>
  shell
    .locator(`${sel('row-menu')} [role=menuitem]`)
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''))
const rowOf = (shell: Page, id: string) => shell.locator(sel(`chat-row-${id}`))
// Pinned rows sit flat in the tree, outside every folder.
const pinnedRow = (shell: Page, id: string) =>
  shell.locator(`${sel('chat-tree')} > .eva-cl-rowwrap ${sel(`chat-row-${id}`)}`)
const chatOrder = (configDir: string): { snoozed?: Record<string, unknown> } => {
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir, 'chat-order.json'), 'utf8'))
  } catch {
    return {}
  }
}

test('menu order, pin and unpin edit session-pins.json', async ({ app, shell }) => {
  await openChats(shell)
  await rowOf(shell, 'p4-other2').click({ button: 'right' })
  await expect(shell.locator(sel('row-menu'))).toBeVisible()
  // Native order: Rename chat, Pin chat, the Snooze presets, Settle, then Move to and Delete.
  const ids = await menuIds(shell)
  expect(ids.slice(0, 2)).toEqual(['row-menu-rename', 'row-menu-pin'])
  expect(ids.slice(2, -3).length).toBeGreaterThan(0)
  expect(ids.slice(2, -3).every((id) => id.startsWith('row-menu-snooze-'))).toBe(true)
  expect(ids.slice(-3)).toEqual(['row-menu-settle', 'row-menu-move', 'row-menu-delete'])
  await expect(shell.locator(sel('row-menu-rename'))).toHaveText('Rename chat')
  await expect(shell.locator(sel('row-menu-pin'))).toHaveText('Pin chat')
  await expect(shell.locator(sel('row-menu-settle'))).toHaveText('Settle')
  await proofShot(app, shell, 'chat-menu', { phase: 'phase-4' })

  await shell.locator(sel('row-menu-pin')).click()
  await expect(pinnedRow(shell, 'p4-other2')).toBeVisible()
  expect(pins()).toEqual(['p4-other2', 'p4-pinned'])

  await rowOf(shell, 'p4-other2').click({ button: 'right' })
  await expect(shell.locator(sel('row-menu-pin'))).toHaveText('Unpin chat')
  await shell.locator(sel('row-menu-pin')).click()
  await expect(pinnedRow(shell, 'p4-other2')).toHaveCount(0)
  await expect(rowOf(shell, 'p4-other2')).toBeVisible()
  expect(pins()).toEqual(['p4-pinned'])
})

test('Shift+F10 opens the menu from the keyboard', async ({ shell }) => {
  await openChats(shell)
  await rowOf(shell, 'p4-other3').focus()
  await shell.keyboard.press('Shift+F10')
  await expect(shell.locator(sel('row-menu'))).toBeVisible()
  await shell.keyboard.press('Escape')
  await expect(shell.locator(sel('row-menu'))).toHaveCount(0)
})

test('settle from the hover action, toast Undo restores', async ({ shell, configDir }) => {
  await openChats(shell)
  const row = rowOf(shell, 'p4-other4')
  await row.hover()
  await shell.locator(sel('chat-settle-p4-other4')).click()
  await expect(shell.getByText('Chat settled')).toBeVisible()
  await expect(row).toHaveCount(0)
  await expect(shell.locator(sel('chat-settled-toggle'))).toHaveText('Settled (1)')
  await expect.poll(() => archivedIds(configDir)).toContain('p4-other4')

  await shell.getByRole('button', { name: 'Undo' }).click()
  await expect(rowOf(shell, 'p4-other4')).toBeVisible()
  await expect(shell.locator(sel('chat-settled-toggle'))).toHaveCount(0)
  await expect.poll(() => archivedIds(configDir)).not.toContain('p4-other4')
})

test('snooze from the menu folds the chat under Snoozed; Unsnooze brings it back', async ({
  shell,
  configDir,
}) => {
  await openChats(shell)
  await rowOf(shell, 'p4-other3').click({ button: 'right' })
  await shell.locator(sel('row-menu-snooze-In 1 hour')).click()
  await expect(rowOf(shell, 'p4-other3')).toHaveCount(0)
  const fold = shell.locator(sel('chat-snoozed-toggle'))
  await expect(fold).toHaveText('Snoozed (1)')
  await expect.poll(() => Object.keys(chatOrder(configDir).snoozed ?? {})).toEqual(['p4-other3'])

  await fold.click()
  const row = rowOf(shell, 'p4-other3')
  await expect(row.getByLabel('Snoozed')).toBeVisible()
  await row.click({ button: 'right' })
  await shell.locator(sel('row-menu-unsnooze')).click()
  await expect(fold).toHaveCount(0)
  await expect(
    shell.locator(`${sel('chat-section-Other')} ${sel('chat-row-p4-other3')}`),
  ).toBeVisible()
  await expect.poll(() => Object.keys(chatOrder(configDir).snoozed ?? {})).toEqual([])
})

test('inline rename: Esc cancels, Enter commits through a short resume with mtime kept', async ({
  app,
  shell,
}) => {
  await openChats(shell)
  const file = fx.file('p4-rename')
  const before = fs.statSync(file).mtimeMs
  await rowOf(shell, 'p4-rename').click({ button: 'right' })
  await shell.locator(sel('row-menu-rename')).click()
  const input = shell.locator(sel('chat-rename-input'))
  await expect(input).toBeFocused()
  await input.fill('Never committed')
  await input.press('Escape')
  await expect(rowOf(shell, 'p4-rename')).toContainText('Rename me')

  await rowOf(shell, 'p4-rename').click({ button: 'right' })
  await shell.locator(sel('row-menu-rename')).click()
  await shell.locator(sel('chat-rename-input')).fill('Renamed by test')
  await proofShot(app, shell, 'chat-rename-inline', { phase: 'phase-4' })
  await shell.locator(sel('chat-rename-input')).press('Enter')
  await expect(rowOf(shell, 'p4-rename')).toContainText('Renamed by test')
  expect(Math.abs(fs.statSync(file).mtimeMs - before)).toBeLessThan(1000)
  const spawns = readLog().filter((e) => e.event === 'spawn')
  expect(
    spawns.some((e) => e.detail?.argv?.includes('rpc') && e.detail.argv.includes('--resume')),
  ).toBe(true)
})

test('a recently active unowned chat refuses rename; Esc leaves the title', async ({ shell }) => {
  fx.touch('p4-other5', 0)
  await openChats(shell)
  await rowOf(shell, 'p4-other5').click({ button: 'right' })
  await shell.locator(sel('row-menu-rename')).click()
  const input = shell.locator(sel('chat-rename-input'))
  await input.fill('Should not apply')
  await input.press('Enter')
  await expect(shell.locator(sel('chat-row-error'))).toHaveText(
    'This chat may be open in a terminal. Rename it there, or try again later.',
  )
  expect(
    readLog().filter((e) => e.detail?.argv?.includes('rpc') && e.detail.argv.includes('--resume')),
  ).toHaveLength(0)
  await expect(rowOf(shell, 'p4-other5')).toContainText('Grocery list 5')
})

test('an owned chat renames over its running omp; delete is refused', async ({ shell }) => {
  await openChats(shell)
  await rowOf(shell, 'p4-ecard').click()
  await expect(shell.locator(sel('chat-log'))).toContainText('Hello from p4-ecard')
  const box = shell.locator(sel('composer-input'))
  await box.fill('hi')
  await box.press('Enter')
  // The prompt reached the owned omp, so the app now owns the session.
  await expect
    .poll(() => readLog().some((e) => e.event === 'stdin-line' && e.detail?.type === 'prompt'))
    .toBe(true)

  await rowOf(shell, 'p4-ecard').click({ button: 'right' })
  await shell.locator(sel('row-menu-rename')).click()
  await shell.locator(sel('chat-rename-input')).fill('Owned rename')
  await shell.locator(sel('chat-rename-input')).press('Enter')
  await expect(rowOf(shell, 'p4-ecard')).toContainText('Owned rename')
  await expect
    .poll(() =>
      readLog().some((e) => e.event === 'stdin-line' && e.detail?.type === 'set_session_name'),
    )
    .toBe(true)

  await rowOf(shell, 'p4-ecard').click({ button: 'right' })
  await shell.locator(sel('row-menu-delete')).click()
  await shell.getByRole('button', { name: 'Delete chat' }).click()
  await expect(shell.locator(sel('delete-chat-error'))).toHaveText(
    'Close this chat before deleting it.',
  )
  expect(fs.existsSync(fx.file('p4-ecard'))).toBe(true)
})

test('delete removes file, folder and backups but not siblings', async ({ app, shell }) => {
  const file = fx.file('p4-other6')
  const stem = file.replace(/\.jsonl$/, '')
  fs.mkdirSync(stem)
  fs.writeFileSync(path.join(stem, 'artifact.txt'), 'x')
  fs.writeFileSync(`${file}.1.bak`, 'bak')
  const sibling = `${stem}-keep.jsonl`
  fs.copyFileSync(fx.file('p4-other7'), sibling)
  await openChats(shell)

  await rowOf(shell, 'p4-other6').click({ button: 'right' })
  await shell.locator(sel('row-menu-delete')).click()
  const modal = shell.locator(sel('delete-chat-modal'))
  await expect(modal).toContainText('Delete this chat?')
  await expect(shell.getByRole('button', { name: 'Keep chat' })).toBeFocused()
  await proofShot(app, shell, 'chat-delete-modal', { phase: 'phase-4' })
  await shell.getByRole('button', { name: 'Delete chat' }).click()
  await expect(rowOf(shell, 'p4-other6')).toHaveCount(0)
  expect(fs.existsSync(file)).toBe(false)
  expect(fs.existsSync(stem)).toBe(false)
  expect(fs.existsSync(`${file}.1.bak`)).toBe(false)
  expect(fs.existsSync(sibling)).toBe(true)
})
