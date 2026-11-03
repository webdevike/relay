import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeEvaFixture, type EvaFixture } from './helpers/eva-fixture'
import { proofShot } from './helpers/proofShot'

type Shell = { __evaosShell: { openPlace(p: string, n?: boolean): void } }

const test = base.extend<{ evaFx: EvaFixture }>({
  evaFx: async ({}, use) => {
    const fx = makeEvaFixture()
    await use(fx)
    fx.cleanup()
  },
  launchEnv: async ({ evaFx }, use) => {
    await use(evaFx.env)
  },
})

test.use({ startOnChat: false, colorScheme: 'dark' })

const PHASE = { phase: 'phase-3' }
const sel = (id: string): string => `[data-testid=${id}]`
const toast = (shell: Page, text: string) =>
  shell.locator('.mantine-Notification-root', { hasText: text }).first()
const argvs = (fx: EvaFixture): string[][] =>
  (fx.gateLog() as Array<{ argv: string[] }>).map((e) => e.argv)

async function setScheme(shell: Page, mode: 'dark' | 'light'): Promise<void> {
  await shell.locator(sel(`appearance-${mode}`)).click()
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', mode)
}

test.beforeEach(async ({ shell }) => {
  await expect(shell.locator(sel('dash-hero'))).toBeVisible()
})

async function openHabits(shell: Page): Promise<void> {
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('habits'))
  await expect(shell.locator(sel('page-habits'))).toBeVisible()
  await expect(shell.locator(sel('habit-row-stretch'))).toBeVisible()
}

test('shows gate status, habits, tasks, breaks and history, polled since launch', async ({
  app,
  shell,
  evaFx,
}) => {
  // Launch-time poll: a status call exists before the Habits page was ever opened.
  await expect.poll(() => argvs(evaFx).some((a) => a[0] === 'status')).toBe(true)
  await openHabits(shell)
  const strip = shell.locator(sel('habit-gate-strip'))
  await expect(strip).toContainText('Unlocked. Next break at 11:30 PM.')
  await expect(strip).toContainText('From your calendar')
  await expect(shell.locator(sel('habit-row-stretch'))).toContainText('2 days')
  await expect(shell.locator(sel('task-row-taxes'))).toBeVisible()
  const breaks = shell.locator(sel('breaks-today'))
  await expect(breaks).toContainText('Done')
  await expect(breaks).toContainText('Upcoming')
  const history = shell.locator(sel('habit-history'))
  await expect(history).toContainText('Today')
  await expect(history).toContainText('Yesterday')
  await setScheme(shell, 'dark')
  await proofShot(app, shell, 'habits-dark', PHASE)
  await setScheme(shell, 'light')
  await proofShot(app, shell, 'habits-light', PHASE)
})

test('an external state change appears without any UI action', async ({ shell, evaFx }) => {
  await openHabits(shell)
  const file = evaFx.env.FAKE_GATE_STATE!
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  state.habits.push({ id: 'water', name: 'Water', minutes: 5, photo: false })
  fs.writeFileSync(file, JSON.stringify(state))
  await expect(shell.locator(sel('habit-row-water'))).toBeVisible({ timeout: 6000 })
})

test('adds, edits and removes a habit through the CLI', async ({ shell, evaFx }) => {
  await openHabits(shell)
  await shell.locator(sel('habits-add')).click()
  await shell.locator(sel('habit-name')).fill('Read')
  await shell.locator(sel('habit-minutes')).fill('15')
  await shell.locator(sel('habit-save')).click()
  await expect(toast(shell, 'Saved Read.')).toBeVisible()
  await expect(shell.locator(sel('habit-row-read'))).toBeVisible()
  expect(argvs(evaFx)).toContainEqual(['habit', 'add', 'Read', '--minutes', '15', '--json'])

  await shell.locator(sel('habit-row-read')).click()
  await shell.locator(sel('habit-minutes')).fill('20')
  await shell.locator(sel('habit-save')).click()
  await expect(shell.locator(sel('habit-row-read'))).toContainText('20')
  expect(argvs(evaFx)).toContainEqual([
    'habit',
    'edit',
    'read',
    '--name=Read',
    '--minutes',
    '20',
    '--no-photo',
    '--json',
  ])

  await shell.locator(sel('habit-row-read')).click()
  await shell.locator(sel('habit-remove')).click()
  await expect(shell.locator(sel('habit-remove-panel'))).toContainText(
    'Remove Read? Its history stays.',
  )
  await shell.locator(sel('habit-remove-confirm')).click()
  await expect(shell.locator(sel('habit-row-read'))).toHaveCount(0)
  expect(argvs(evaFx)).toContainEqual(['habit', 'rm', 'read', '--json'])
})

test('adds and removes a one-time task', async ({ shell, evaFx }) => {
  await openHabits(shell)
  await shell.locator(sel('task-name')).fill('File receipts')
  await shell.locator(sel('task-add')).click()
  await expect(shell.locator(sel('task-row-file-receipts'))).toBeVisible()
  expect(argvs(evaFx)).toContainEqual(['task', 'add', 'File receipts', '--json'])
  await shell
    .locator(sel('task-row-file-receipts'))
    .getByRole('button', { name: 'Remove task' })
    .click()
  await expect(shell.locator(sel('task-row-file-receipts'))).toHaveCount(0)
  expect(argvs(evaFx)).toContainEqual(['task', 'rm', 'file-receipts', '--json'])
})

test('a failing gate keeps the last status and surfaces edit errors', async ({
  app,
  shell,
  evaFx,
}) => {
  await openHabits(shell)
  const fail = `${evaFx.env.FAKE_GATE_STATE}.fail`
  fs.writeFileSync(fail, '')
  await expect(shell.locator(sel('habits-stale'))).toHaveText(
    'Showing the last status. Retrying.',
    {
      timeout: 6000,
    },
  )
  await expect(shell.locator(sel('habit-row-stretch'))).toBeVisible()
  await proofShot(app, shell, 'habits-stale', PHASE)
  await shell.locator(sel('habits-add')).click()
  await shell.locator(sel('habit-name')).fill('Nope')
  await shell.locator(sel('habit-minutes')).fill('5')
  await shell.locator(sel('habit-save')).click()
  await expect(shell.locator(sel('habit-form-error'))).toContainText('simulated failure')
  await shell.locator(sel('habit-discard')).click()
  fs.rmSync(fail)
  await expect(shell.locator(sel('habits-stale'))).toHaveCount(0, { timeout: 6000 })
})

test('the proof photo opens a file inside the photos dir', async ({ app, shell, evaFx }) => {
  await openHabits(shell)
  await shell.locator(sel('history-photo')).first().click()
  await expect
    .poll(
      () =>
        app.evaluate(
          () =>
            (
              globalThis as unknown as {
                __evaosTest: { hooks: { openPath: { calls: Array<{ path: string }> } } }
              }
            ).__evaosTest.hooks.openPath.calls,
        ),
      { timeout: 3000 },
    )
    .toHaveLength(1)
  const calls = await app.evaluate(
    () =>
      (
        globalThis as unknown as {
          __evaosTest: { hooks: { openPath: { calls: Array<{ path: string }> } } }
        }
      ).__evaosTest.hooks.openPath.calls,
  )
  const photos = fs.realpathSync(path.join(evaFx.dir, 'photos'))
  expect(calls[0]!.path.startsWith(photos + path.sep)).toBe(true)
})
