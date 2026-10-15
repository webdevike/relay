import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { proofShot } from './helpers/proofShot'

// Composer toolbar: model picker, access mode, account selector (unsent chats only) and the
// context ring, all against the fake omp.
const LOG = path.join(os.tmpdir(), `evaos-fake-omp-composer-${process.pid}.log`)

type Ev = { event: string; detail: Record<string, unknown> | null }
const readLog = (): Ev[] =>
  fs.existsSync(LOG)
    ? fs
        .readFileSync(LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Ev)
    : []
// Only chat processes (rpc-ui); the model catalog process also logs a spawn.
const spawns = (): Ev[] =>
  readLog().filter((e) => e.event === 'spawn' && argvOf(e).includes('rpc-ui'))
const argvOf = (e: Ev): string[] => (e.detail?.argv as string[] | undefined) ?? []

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
const send = async (shell: Page, text: string): Promise<void> => {
  const box = shell.locator(sel('composer-input'))
  await box.fill(text)
  await box.press('Enter')
}

test('toolbar: model, context ring, access restart, images flag', async ({ app, shell }) => {
  await openRow(shell, 'p4-ecard')
  await send(shell, 'hi')
  await expect(shell.locator(sel('chat-log'))).toContainText(
    'Foxes are primarily nocturnal hunters',
  )
  // The phrase appears before the recorded turn ends. Its remaining assistant frames
  // still carry the old model, so finish that turn before testing an idle model change.
  await expect(shell.getByRole('img', { name: 'Eva is replying' })).toHaveCount(0)

  // 1. Model picker: pick another model, set_model reaches omp and the label follows get_state.
  const model = shell.locator(sel('composer-model'))
  await model.click()
  await expect(shell.locator(sel('model-option-fake-text-only'))).toBeVisible()
  await expect(shell.locator(sel('model-option-anthropic-claude-opus-5-5'))).toBeVisible()
  await proofShot(app, shell, 'composer-model-picker', { phase: 'phase-4' })
  await shell.locator(sel('model-option-anthropic-claude-opus-5-5')).click()
  await expect
    .poll(() => readLog().find((e) => e.event === 'set-model')?.detail)
    .toEqual({ provider: 'anthropic', modelId: 'claude-opus-5-5' })
  await expect(model).toContainText('Opus 5.5')

  // 2. Context ring: 42000 of 200000 from get_state.
  const ring = shell.locator(sel('composer-context'))
  await expect(ring).toHaveAttribute('aria-label', 'Context 21% used')
  await ring.hover()
  await expect(shell.getByRole('tooltip')).toHaveText('Context 21% used')
  await shell.mouse.move(0, 0)

  // 3. Access: Full access by default; Ask before edits restarts omp on the same file, no signal.
  const access = shell.locator(sel('composer-access'))
  await expect(access).toContainText('Full access')
  const before = spawns().length
  await access.click()
  await shell.locator(sel('access-option-always-ask')).click()
  await expect(access).toContainText('Ask before edits')
  await expect.poll(() => spawns().length).toBe(before + 1)
  const restarted = argvOf(spawns().at(-1)!)
  expect(restarted).toContain('--approval-mode')
  expect(restarted[restarted.indexOf('--approval-mode') + 1]).toBe('always-ask')
  expect(restarted).toContain('--resume')
  const log = readLog()
  const ended = log.findIndex((e) => e.event === 'stdin-end')
  expect(ended).toBeGreaterThanOrEqual(0)
  expect(log.filter((e) => e.event === 'signal')).toHaveLength(0)
  expect(log.filter((e) => e.event === 'exit').every((e) => e.detail?.code === 0)).toBe(true)
  await proofShot(app, shell, 'composer-toolbar', { phase: 'phase-4' })

  // 5. A model without image support disables attaching.
  await model.click()
  await shell.locator(sel('model-option-fake-text-only')).click()
  await expect(shell.getByRole('button', { name: 'Attach image' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
})

test('account selector shows on unsent chats only and adds --profile', async ({ app, shell }) => {
  await shell.locator(sel('nav-chat')).click()
  await shell.locator(sel('chat-new')).click()
  await expect(shell.locator(sel('chat-header'))).toContainText('New chat')
  const account = shell.locator(sel('composer-account'))
  await expect(account).toBeVisible()
  await expect(account).toContainText('Current')
  await account.click()
  await expect(shell.locator(sel('account-option-personal'))).toBeVisible()
  await shell.locator(sel('account-option-work')).click()
  await expect(account).toContainText('Work')
  await proofShot(app, shell, 'composer-account', { phase: 'phase-4' })
  await send(shell, 'hello account')
  await expect(shell.locator(sel('chat-log'))).toContainText(
    'Foxes are primarily nocturnal hunters',
  )
  const argv = argvOf(spawns()[0]!)
  expect(argv).toContain('--profile')
  expect(argv[argv.indexOf('--profile') + 1]).toBe('work')
  await expect(account).toHaveCount(0)
})

test('toolbar controls are disabled while the session is closed', async ({ shell }) => {
  await openRow(shell, 'p4-ecard')
  await send(shell, 'hi')
  await expect(shell.locator(sel('chat-log'))).toContainText(
    'Foxes are primarily nocturnal hunters',
  )
  const model = shell.locator(sel('composer-model'))
  await expect(model).toHaveAttribute('aria-disabled', 'false')
  await shell.evaluate(() =>
    (
      window as unknown as {
        eva: { invoke(c: string, i: unknown): Promise<unknown> }
      }
    ).eva.invoke('chat.close', { paneId: 'pane-1' }),
  )
  await expect(model).toHaveAttribute('aria-disabled', 'true')
  await expect(shell.locator(sel('composer-access'))).toHaveAttribute('aria-disabled', 'true')
  const opacity = await model.evaluate((el) => getComputedStyle(el).opacity)
  expect(Number(opacity)).toBeCloseTo(0.5, 1)
})
