import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'

// `@computer` in the composer (SPEC.md): main takes the message in `chat.send`, so it never reaches
// omp, and the run's rows show in the chat. The fixture Eva root has no OpenAI key and the launch
// env blanks OPENAI_API_KEY, so a run fails before it could touch this Mac.
const LOG = path.join(os.tmpdir(), `evaos-fake-omp-computer-${process.pid}.log`)

const prompts = (): string[] =>
  fs.existsSync(LOG)
    ? fs
        .readFileSync(LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { event: string; detail: { message?: string } | null })
        .filter((e) => e.event === 'prompt')
        .map((e) => e.detail?.message ?? '')
    : []

let fx: ChatFixture
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    await use({ ...fx.launchEnv, FAKE_OMP_DELAY_MS: '5', FAKE_OMP_LOG: LOG, OPENAI_API_KEY: '' })
    fx.cleanup()
  },
})

test.beforeEach(() => fs.rmSync(LOG, { force: true }))
test.afterAll(() => fs.rmSync(LOG, { force: true }))

const send = async (shell: Page, text: string): Promise<void> => {
  const box = shell.locator('[data-testid=composer-input]')
  await box.fill(text)
  await box.press('Enter')
}

test('@computer never reaches the agent: help, a run that cannot start, then a normal message does', async ({
  shell,
}) => {
  await shell.locator('[data-testid=nav-chat]').click()
  await shell.locator('[data-testid=chat-new]').click()
  await expect(shell.locator('[data-testid=chat-header]')).toContainText('New chat')
  const log = shell.locator('[data-testid=chat-log]')

  await send(shell, '@computer')
  await expect(log).toContainText('drives this Mac for you')

  await send(shell, '@computer open Calculator and add 2 and 2')
  await expect(log).toContainText('@computer open Calculator and add 2 and 2')
  await expect(log).toContainText('in the background: open Calculator and add 2 and 2')
  await expect(log).toContainText("Couldn't run it: no OpenAI key")

  await send(shell, '@computer stop')
  await expect(log).toContainText('Nothing is running.')
  expect(prompts()).toEqual([])

  // Not a command (the keyword must lead): this one goes to omp as usual.
  await send(shell, 'what does @computer do')
  await expect.poll(() => prompts().length).toBe(1)
  expect(prompts()[0]).toContain('what does @computer do')
})
