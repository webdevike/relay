import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { proofShot } from './helpers/proofShot'

// Shared writers: a send into a chat another pane (or another omp) writes asks first, and
// `Send anyway` never starts a second omp process for a file this app already runs.
// Pane 2 is created through the e2e test hook; real second panes arrive in Phase 6.
const LOG = path.join(os.tmpdir(), `evaos-fake-omp-writers-${process.pid}.log`)

type Ev = { event: string; detail: { message?: string; resumeFile?: string } | null }
const readLog = (): Ev[] =>
  fs.existsSync(LOG)
    ? fs
        .readFileSync(LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Ev)
    : []
const prompts = (): string[] =>
  readLog()
    .filter((e) => e.event === 'prompt')
    .map((e) => e.detail?.message ?? '')
const spawnsFor = (file: string): number =>
  readLog().filter(
    (e) =>
      e.event === 'spawn' &&
      e.detail?.resumeFile &&
      fs.realpathSync(e.detail.resumeFile) === fs.realpathSync(file),
  ).length

type Hooks = {
  openInPane(p: string, file: string): void
  sendFromPane(p: string, text: string): Promise<void>
}

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
const openRow = async (shell: Page, id: string): Promise<void> => {
  await shell.locator(sel('nav-chat')).click()
  await shell.waitForSelector('[role=tree]')
  for (const more of await shell.locator('[data-testid^="chat-show-more-"]').all()) {
    const t = (await more.textContent()) ?? ''
    if (t.startsWith('Show ') && !t.includes('fewer')) await more.click()
  }
  await shell.locator(sel(`chat-row-${id}`)).click()
  await expect(shell.locator(sel('chat-pane'))).toBeVisible()
}

test('confirm before writing into a chat another pane owns, one process per file', async ({
  app,
  shell,
}) => {
  const writer = fx.file('p4-writer')
  await app.evaluate(async ({}, file) => {
    const hooks = (globalThis as unknown as { __evaosTest: { hooks: { chat: Hooks } } }).__evaosTest
      .hooks.chat
    hooks.openInPane('pane-2', file)
    await hooks.sendFromPane('pane-2', 'first')
  }, writer)
  await expect.poll(prompts).toEqual([expect.stringContaining('first')])
  expect(spawnsFor(writer)).toBe(1)

  await openRow(shell, 'p4-writer')
  await expect(shell.locator(sel('chat-header'))).toContainText('Owned by another pane')

  const box = shell.locator(sel('composer-input'))
  await box.fill('second')
  await box.press('Enter')
  const modal = shell.locator(sel('writer-prompt'))
  await expect(modal).toBeVisible()
  await expect(modal).toContainText('Chat is open elsewhere')
  await expect(shell.getByRole('button', { name: "Don't send" })).toBeFocused()
  await proofShot(app, shell, 'writer-prompt', { phase: 'phase-4' })

  // Escape keeps the text and writes nothing.
  await shell.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
  await expect(box).toHaveValue('second')
  expect(prompts()).toHaveLength(1)

  // Don't send does the same.
  await box.press('Enter')
  await expect(modal).toBeVisible()
  await shell.getByRole('button', { name: "Don't send" }).click()
  await expect(modal).toHaveCount(0)
  await expect(box).toHaveValue('second')
  expect(prompts()).toHaveLength(1)

  // Send anyway routes to the owning process: still one spawn, the prompt arrives with a surface tag.
  await box.press('Enter')
  await shell.getByRole('button', { name: 'Send anyway' }).click()
  await expect(modal).toHaveCount(0)
  await expect(box).toHaveValue('')
  await expect.poll(prompts).toHaveLength(2)
  expect(prompts()[1]).toContain('<surface>')
  expect(prompts()[1]).toContain('second')
  expect(spawnsFor(writer)).toBe(1)

  // Remembered: the third send goes straight through.
  await box.fill('third')
  await box.press('Enter')
  await expect(modal).toHaveCount(0)
  await expect.poll(prompts).toHaveLength(3)
  expect(spawnsFor(writer)).toBe(1)
})

test('a chat written in the last 10 minutes that no pane owns prompts first', async ({ shell }) => {
  fx.touch('p4-other7', 0)
  await openRow(shell, 'p4-other7')
  const box = shell.locator(sel('composer-input'))
  await box.fill('hello')
  await box.press('Enter')
  const modal = shell.locator(sel('writer-prompt'))
  await expect(modal).toBeVisible()
  expect(readLog().filter((e) => e.event === 'spawn')).toHaveLength(0)
  await shell.getByRole('button', { name: 'Send anyway' }).click()
  await expect(modal).toHaveCount(0)
  await expect.poll(prompts).toHaveLength(1)
  expect(spawnsFor(fx.file('p4-other7'))).toBe(1)
})
