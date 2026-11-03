import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeEvaFixture, type EvaFixture } from './helpers/eva-fixture'
import { FAKE_JOB_RUN, SESSIONS_FIXTURE_DIR } from './helpers/paths'
import { proofShot } from './helpers/proofShot'

type Shell = {
  __evaosShell: {
    openPlace(p: string, n?: boolean): void
    tabs(): { active: number; list: Array<{ id: number; page: string }> }
  }
}

const test = base.extend<{ evaFx: EvaFixture }>({
  evaFx: async ({}, use) => {
    const fx = makeEvaFixture({ jobMs: 1500 })
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

test.beforeEach(async ({ shell }) => {
  await expect(shell.locator(sel('dash-hero'))).toBeVisible()
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('jobs'))
  await expect(shell.locator(sel('job-row-nightly'))).toBeVisible()
})

async function openJob(shell: Page, name: string): Promise<void> {
  await shell.locator(sel(`job-row-${name}`)).click()
  await expect(shell.locator(sel('job-steps'))).toBeVisible()
  await expect(shell.locator(sel('job-steps'))).not.toHaveValue('')
}

test('create validates inline and writes a minimal job.md', async ({ app, shell, evaFx }) => {
  await shell.locator(sel('jobs-new')).click()
  await expect(shell.locator(sel('job-steps'))).toBeVisible()
  const save = shell.locator(sel('job-save'))
  await expect(save).toBeDisabled()

  await shell.locator(sel('job-name')).fill('Nightly 2')
  await expect(
    shell.getByText(
      'Use lowercase letters, numbers and hyphens, starting with a letter or number.',
    ),
  ).toBeVisible()
  await proofShot(app, shell, 'job-form-validation', PHASE)
  await shell.locator(sel('job-name')).fill('nightly')
  await expect(shell.getByText('A job named nightly already exists.')).toBeVisible()
  await shell.locator(sel('job-name')).fill('new-job')
  await shell.locator(sel('job-every')).fill('0m')
  await expect(shell.getByText('Must be more than zero.')).toBeVisible()
  await shell.locator(sel('job-every')).fill('15m')
  await shell.locator(sel('job-max-run')).fill('10m')
  await shell.locator(sel('job-keep')).fill('0')
  await shell.locator(sel('job-steps')).fill('Do the thing')
  await expect(save).toBeEnabled()
  await save.click()

  await expect(toast(shell, 'Saved jobs/new-job/job.md.')).toBeVisible()
  const text = evaFx.read('jobs/new-job/job.md')
  expect(text.startsWith('---')).toBe(true)
  expect(text).toContain('every: 15m')
  expect(text).toContain('keep: 0')
  await expect(shell.locator(sel('job-row-new-job'))).toBeVisible()
})

test('edit changes exactly one line', async ({ app, shell, evaFx }) => {
  const file = path.join(evaFx.root, 'jobs/nightly/job.md')
  const before = fs.readFileSync(file, 'utf8')
  await shell.locator(sel('appearance-dark')).click()
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', 'dark')
  await openJob(shell, 'nightly')
  await expect(shell.locator(sel('job-every'))).toHaveValue('2h')
  await shell.locator(sel('job-every')).fill('3h')
  await proofShot(app, shell, 'job-form-edit', PHASE)
  await shell.locator(sel('job-save')).click()
  await expect(toast(shell, 'Saved jobs/nightly/job.md.')).toBeVisible()
  const a = before.split('\n')
  const b = fs.readFileSync(file, 'utf8').split('\n')
  expect(b.filter((l) => !a.includes(l))).toEqual(['every: 3h'])
  expect(a.filter((l) => !b.includes(l))).toEqual(['every: 2h'])
  expect(b).toContain('# comment line')
  expect(b.length).toBe(a.length)
})

test('a job changed on disk is refused until the user chooses', async ({ app, shell, evaFx }) => {
  const file = path.join(evaFx.root, 'jobs/nightly/job.md')
  await openJob(shell, 'nightly')
  await expect(shell.locator(sel('job-max-run'))).toHaveValue('20m')
  await shell.locator(sel('job-max-run')).fill('30m')
  fs.appendFileSync(file, 'External line.\n')
  const external = fs.readFileSync(file, 'utf8')
  await shell.locator(sel('job-save')).click()
  const banner = shell.locator(sel('job-form-stale'))
  await expect(banner).toBeVisible()
  await expect(banner).toContainText(
    'jobs/nightly/job.md changed on disk since you opened it. Your edits were not saved.',
  )
  expect(fs.readFileSync(file, 'utf8')).toBe(external)
  await expect(shell.locator(sel('job-save'))).toBeDisabled()
  await proofShot(app, shell, 'job-form-changed-on-disk', PHASE)
  await shell.locator(sel('job-form-reload')).click()
  await expect(banner).toBeHidden()
  await expect(shell.locator(sel('job-max-run'))).toHaveValue('20m')
  expect(fs.readFileSync(file, 'utf8')).toBe(external)
})

test('Run now spawns the fake job-run and the row follows it', async ({ app, shell, evaFx }) => {
  await openJob(shell, 'nightly')
  await shell.locator(sel('job-run-now')).click()
  await expect(toast(shell, 'Started nightly.')).toBeVisible()

  // The fake, not bun or the real job-run, was spawned detached in the Eva root.
  await expect.poll(() => evaFx.jobLog().length, { timeout: 5000 }).toBe(1)
  const entry = evaFx.jobLog()[0] as { argv: string[]; cwd: string }
  expect(entry.argv).toEqual(['nightly'])
  expect(fs.realpathSync(entry.cwd)).toBe(fs.realpathSync(evaFx.root))
  const spawned = await app.evaluate(
    () =>
      (
        globalThis as unknown as {
          __evaosTest: {
            hooks: { spawnLog?: Array<{ kind: string; argv: string[]; cwd: string }> }
          }
        }
      ).__evaosTest.hooks.spawnLog ?? [],
  )
  const jobSpawns = spawned.filter((s) => s.kind === 'job-run')
  expect(jobSpawns).toHaveLength(1)
  expect(jobSpawns[0]!.argv).toContain(FAKE_JOB_RUN)
  expect(jobSpawns[0]!.argv.at(-1)).toBe('nightly')

  // Observable effect of the fake: a lock while it runs, then a fresh done run directory.
  const runs = path.join(evaFx.root, 'jobs/.runs')
  await expect
    .poll(() => fs.existsSync(path.join(runs, 'nightly.lock')), { timeout: 3000 })
    .toBe(true)
  await shell.locator(sel('job-discard')).click()
  const state = shell.locator(sel('job-state-nightly'))
  await expect
    .poll(
      async () => {
        await shell.locator(sel('jobs-refresh')).click()
        return state.innerText()
      },
      { timeout: 2000 },
    )
    .toBe('running')
  await expect
    .poll(() => fs.existsSync(path.join(runs, 'nightly.lock')), { timeout: 5000 })
    .toBe(false)
  const dirs = fs.readdirSync(path.join(runs, 'nightly')).filter((d) => d !== 'last-run')
  const done = dirs.filter((d) => {
    const st = JSON.parse(fs.readFileSync(path.join(runs, 'nightly', d, 'status.json'), 'utf8'))
    return st.note === 'fake exit 0' && st.state === 'done'
  })
  expect(done).toHaveLength(1)
  await expect
    .poll(
      async () => {
        await shell.locator(sel('jobs-refresh')).click()
        return state.innerText()
      },
      { timeout: 5000 },
    )
    .toBe('ok')
  await expect(shell.locator(sel('job-row-nightly'))).toContainText('just now')
})

test('Open last session opens the run chat', async ({ shell }) => {
  await openJob(shell, 'nightly')
  await shell.locator(sel('job-open-last')).click()
  await expect(shell.locator(sel('job-steps'))).toHaveCount(0)
  await expect(shell.locator(sel('chat-pane'))).toBeVisible()
  const tabs = await shell.evaluate(() => (window as unknown as Shell).__evaosShell.tabs())
  expect(tabs.list.find((t) => t.id === tabs.active)?.page).toBe('chat')
  expect(
    fs.existsSync(path.join(SESSIONS_FIXTURE_DIR, '2026-10-01T09-00-00-000Z_small.jsonl')),
  ).toBe(true)
})

test('Delete asks inline and keeps run history', async ({ shell, evaFx }) => {
  await openJob(shell, 'broken')
  await shell.locator(sel('job-delete')).click()
  await expect(shell.getByText('Delete jobs/broken and everything in it?')).toBeVisible()
  await expect(shell.locator(sel('job-delete-keep'))).toBeFocused()
  await shell.locator(sel('job-delete-confirm')).click()
  await expect(toast(shell, 'Deleted jobs/broken.')).toBeVisible()
  expect(fs.existsSync(path.join(evaFx.root, 'jobs/broken'))).toBe(false)
  expect(fs.existsSync(path.join(evaFx.root, 'jobs/.runs/broken'))).toBe(true)
  await expect(shell.locator(sel('job-row-broken'))).toHaveCount(0)
})

type GG = {
  __stubCalls: Array<{ detail: string }>
  __evaosTest: { hooks: { quitGuard: { guardedClose(): Promise<boolean> } } }
}

test('unsaved job edits are listed by the quit guard', async ({ app, shell }) => {
  await openJob(shell, 'nightly')
  await shell.locator(sel('job-max-run')).fill('45m')
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as GG
    g.__stubCalls = []
    ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async (
      ...args: unknown[]
    ) => {
      g.__stubCalls.push(args[args.length - 1] as { detail: string })
      return { response: 2, checkboxChecked: false }
    }
  })
  const closed = await app.evaluate(() =>
    (globalThis as unknown as GG).__evaosTest.hooks.quitGuard.guardedClose(),
  )
  expect(closed).toBe(false)
  const calls = await app.evaluate(() => (globalThis as unknown as GG).__stubCalls)
  // Teardown quits the app, which the guard would hold open: answer Discard from now on.
  await app.evaluate(({ dialog }) => {
    ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({
      response: 1,
      checkboxChecked: false,
    })
  })
  expect(calls[0]!.detail).toContain('Job nightly')
})
