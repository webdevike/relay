import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'

// The composer's `@` menu: Computer opens its modes, picking one leaves a chip in the box, and a
// message with the chip runs `@computer` in that mode. The fixture has no OpenAI key, so a run
// stops after its first row (which names the mode) and never touches this Mac.
const LOG = path.join(os.tmpdir(), `evaos-fake-omp-at-menu-${process.pid}.log`)
const PROOF = path.resolve(__dirname, '../../../proof/at-menu')

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

const shot = async (shell: Page, name: string): Promise<void> => {
  fs.mkdirSync(PROOF, { recursive: true })
  await shell.screenshot({ path: path.join(PROOF, `${name}.png`) })
}

test('@ opens Computer and its modes, the chip sends in its mode', async ({ shell }) => {
  await shell.locator('[data-testid=nav-chat]').click()
  await shell.locator('[data-testid=chat-new]').click()
  await expect(shell.locator('[data-testid=chat-header]')).toContainText('New chat')
  const box = shell.locator('[data-testid=composer-input]')
  const menu = shell.locator('[data-testid=at-menu]')
  const chip = shell.locator('[data-testid=computer-chip]')
  const log = shell.locator('[data-testid=chat-log]')

  await box.pressSequentially('@')
  await expect(menu).toContainText('Computer')
  await expect(menu).toContainText('Control Mac apps on the Mini')
  await shot(shell, '1-menu-open')

  await box.pressSequentially('com')
  await expect(menu.locator('[role=option]')).toHaveCount(1)
  await shot(shell, '2-filtered')

  // Enter on the parent opens its modes in place; Left goes back.
  await box.press('Enter')
  await expect(menu.locator('[role=option]')).toHaveText([
    /Computer\s*Back/,
    /Background/,
    /Live/,
    /Walk/,
  ])
  await shot(shell, '3-modes')
  await box.press('ArrowLeft')
  await expect(menu.locator('[role=option]').first()).toContainText('Control Mac apps')
  await box.press('ArrowRight')
  await box.press('ArrowDown')
  await box.press('Enter')
  await expect(chip).toHaveAttribute('data-mode', 'live')
  await expect(chip).toContainText('Computer live')
  await expect(menu).toHaveCount(0)
  await shot(shell, '4-chip')

  // One unit: a single Backspace removes it.
  await box.press('Backspace')
  await expect(chip).toHaveCount(0)

  // Pick again from the middle of some text; the chip's own menu changes the mode.
  await box.fill('open Calculator and add 2 and 2 ')
  await box.pressSequentially('@com')
  await box.press('Enter')
  await box.press('Enter')
  await expect(chip).toHaveAttribute('data-mode', 'headless')
  await chip.locator('[data-testid=computer-chip-mode]').click()
  await shot(shell, '5-chip-menu')
  await shell.locator('[data-testid=computer-chip-walk]').click()
  await expect(chip).toHaveAttribute('data-mode', 'walk')
  await expect(box).toHaveValue('open Calculator and add 2 and 2 ')

  // The run (no key here, so it fails at once) folds to one line; its mode and task are inside.
  const lastRun = log.locator('[data-testid=widget-collapse]').last()
  const ranAs = async (line: string): Promise<void> => {
    await expect(lastRun).toContainText("@computer · Failed: Couldn't run it")
    await lastRun.locator('.eva-wb-collapse-head').click()
    await expect(lastRun.getByText(line, { exact: true })).toBeVisible()
  }
  await box.press('Enter')
  await ranAs('walkthrough: open Calculator and add 2 and 2')
  await expect(chip).toHaveCount(0)
  await expect(box).toHaveValue('')

  // Plain text still works.
  await box.fill('@computer live open TextEdit')
  await box.press('Enter')
  await expect(log.locator('[data-testid=widget-collapse]')).toHaveCount(2)
  await ranAs('live: open TextEdit')
})
