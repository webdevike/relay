import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { proofShot } from './helpers/proofShot'
import { test, expect } from './fixtures'

const SMALL = '2026-10-01T09-00-00-000Z_small'
const LOG = path.join(os.tmpdir(), `evaos-fake-omp-questions-${process.pid}.log`)

type Ev = { event: string; detail: Record<string, unknown> | null }
const readLog = (): Ev[] =>
  fs.existsSync(LOG)
    ? fs
        .readFileSync(LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Ev)
    : []
const uiResponses = (): Array<Record<string, unknown>> =>
  readLog()
    .filter((e) => e.event === 'ui-response')
    .map((e) => e.detail ?? {})

const card = (shell: Page) => shell.locator('[data-testid=pending-dialog]')
const logOf = (shell: Page) => shell.locator('[data-testid=chat-log]')

async function ask(shell: Page, text: string): Promise<void> {
  const box = shell.locator('[data-testid=composer-input]')
  await box.fill(text)
  await box.press('Enter')
}

test.describe('question cards and extension UI', () => {
  test.use({ launchEnv: { FAKE_OMP_LOG: LOG, FAKE_OMP_DELAY_MS: '10' } })
  test.beforeEach(async ({ shell }) => {
    fs.rmSync(LOG, { force: true })
    await shell.locator(`[data-testid=session-${SMALL}]`).click()
    await expect(logOf(shell)).toContainText('Please sketch a tiny greeter.')
  })
  test.afterAll(() => {
    fs.rmSync(LOG, { force: true })
  })

  test('[ask] answers with key 2 once the composer is blurred', async ({ app, shell }) => {
    await ask(shell, '[ask] q')
    const group = card(shell).getByRole('radiogroup', { name: 'Which database?' })
    await expect(group).toBeVisible()
    await expect(group.getByRole('radio')).toHaveCount(4)
    await expect(group.locator('kbd')).toHaveText(['1', '2', '3', '4'])
    await shell.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await proofShot(app, shell, 'question-card', { phase: 'phase-4' })
    await shell.keyboard.press('2')
    await expect.poll(() => uiResponses().length).toBe(1)
    expect(uiResponses()[0]).toMatchObject({
      answers: [{ id: 'q1', selectedOptions: ['SQLite'] }],
    })
    await expect(logOf(shell)).toContainText('Answered: SQLite')
    await expect(logOf(shell)).toContainText('Answer received')
    await expect(card(shell)).toHaveCount(0)
  })

  test('digits type into the composer while it is focused', async ({ shell }) => {
    await ask(shell, '[ask] q')
    await expect(card(shell)).toBeVisible()
    const box = shell.locator('[data-testid=composer-input]')
    await box.focus()
    await box.press('1')
    await expect(box).toHaveValue('1')
    expect(uiResponses()).toHaveLength(0)
    await expect(card(shell)).toBeVisible()
    // Clicking an option still answers.
    await card(shell)
      .getByRole('radio', { name: /Postgres/ })
      .click()
    await expect.poll(() => uiResponses().length).toBe(1)
  })

  test('[ask-multi] sends one frame once every question is answered', async ({ shell }) => {
    await ask(shell, '[ask-multi] q')
    await expect(card(shell)).toBeVisible()
    const send = card(shell).getByRole('button', { name: 'Send answer' })
    await expect(send).toBeDisabled()
    await card(shell)
      .getByRole('radio', { name: /SQLite/ })
      .click()
    expect(uiResponses()).toHaveLength(0)
    await card(shell).getByRole('checkbox', { name: /Auth/ }).click()
    await card(shell)
      .getByRole('checkbox', { name: /Export/ })
      .click()
    await send.click()
    await expect.poll(() => uiResponses().length).toBe(1)
    expect(uiResponses()[0]).toMatchObject({
      answers: [
        { id: 'db', selectedOptions: ['SQLite'] },
        { id: 'f', selectedOptions: ['Auth', 'Export'] },
      ],
    })
    await expect(logOf(shell)).toContainText('Answered: SQLite, Auth, Export')
  })

  test('[select] option 5 has no key chip and is reached by arrows and Enter', async ({
    shell,
  }) => {
    await ask(shell, '[select] q')
    const group = card(shell).getByRole('radiogroup', { name: 'Pick one' })
    await expect(group.getByRole('radio')).toHaveCount(5)
    await expect(group.locator('kbd')).toHaveCount(4)
    await group.getByRole('radio').first().focus()
    for (let i = 0; i < 4; i++) await shell.keyboard.press('ArrowDown')
    await expect(group.getByRole('radio').nth(4)).toBeFocused()
    await shell.keyboard.press('Enter')
    await expect.poll(() => uiResponses().length).toBe(1)
    expect(uiResponses()[0]).toMatchObject({ value: 'Epsilon' })
    await expect(logOf(shell)).toContainText('Answered: Epsilon')
  })

  test('[confirm] focuses Decline and Decline cancels', async ({ app, shell }) => {
    await ask(shell, '[confirm] q')
    const decline = card(shell).getByRole('button', { name: 'Decline' })
    await expect(decline).toBeFocused()
    await expect(card(shell).getByRole('button', { name: 'Confirm' })).toBeVisible()
    await proofShot(app, shell, 'question-confirm', { phase: 'phase-4' })
    await decline.click()
    await expect.poll(() => uiResponses().length).toBe(1)
    expect(uiResponses()[0]).toMatchObject({ cancelled: true })
    await expect(logOf(shell)).toContainText('Answered: Declined')
  })

  test('[confirm] Confirm sends confirmed true', async ({ shell }) => {
    await ask(shell, '[confirm] q')
    await card(shell).getByRole('button', { name: 'Confirm' }).click()
    await expect.poll(() => uiResponses().length).toBe(1)
    expect(uiResponses()[0]).toMatchObject({ confirmed: true })
  })

  test('[input] sends the typed value', async ({ shell }) => {
    await ask(shell, '[input] q')
    await card(shell).getByRole('textbox').fill('abc')
    await card(shell).getByRole('button', { name: 'Send answer' }).click()
    await expect.poll(() => uiResponses().length).toBe(1)
    expect(uiResponses()[0]).toMatchObject({ value: 'abc' })
  })

  test('[editor] Discard input cancels', async ({ shell }) => {
    await ask(shell, '[editor] q')
    await expect(card(shell).getByRole('textbox')).toBeFocused()
    await card(shell).getByRole('button', { name: 'Discard input' }).click()
    await expect.poll(() => uiResponses().length).toBe(1)
    expect(uiResponses()[0]).toMatchObject({ cancelled: true })
  })

  test('[ask-bad] is cancelled with a notice', async ({ shell }) => {
    await ask(shell, '[ask-bad] q')
    await expect(logOf(shell)).toContainText(
      "omp asked a question EvaOS couldn't read, so it was cancelled.",
    )
    await expect.poll(() => uiResponses().length).toBe(1)
    expect(uiResponses()[0]).toMatchObject({ cancelled: true })
    await expect(card(shell)).toHaveCount(0)
  })

  test('a question left when omp exits shows the dead card', async ({ app, shell }) => {
    await ask(shell, '[select] q')
    await expect(card(shell)).toBeVisible()
    const r = await shell.evaluate(() =>
      (
        window as unknown as { eva: { invoke(c: string, i: unknown): Promise<{ ok: boolean }> } }
      ).eva.invoke('chat.close', { paneId: 'pane-1' }),
    )
    expect(r.ok).toBe(true)
    await expect(card(shell)).toHaveAttribute('data-dead', 'true')
    await expect(card(shell)).toContainText('This question can no longer be answered.')
    await expect(card(shell).getByRole('radio').first()).toBeDisabled()
    await proofShot(app, shell, 'question-dead', { phase: 'phase-4' })
  })
})
