import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeEvaFixture, type EvaFixture } from './helpers/eva-fixture'
import { proofShot } from './helpers/proofShot'

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
// Proposal ids contain '#', so they need quoted attribute selectors.
const q = (id: string): string => `[data-testid="${id}"]`
const pad = (n: number): string => String(n).padStart(2, '0')
const today = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function openStandup(shell: Page): Promise<void> {
  await shell.locator(sel('nav-meetings')).click()
  await expect(shell.locator(sel('meetings-list'))).toBeVisible()
  await shell.locator(sel('meeting-row-standup')).click()
  await expect(shell.locator(sel('page-meeting'))).toBeVisible()
}

test.beforeEach(async ({ shell }) => {
  await expect(shell.locator(sel('dash-hero'))).toBeVisible()
})

test('Accept todo appends the row, marks the proposal and moves it to Remembered', async ({
  app,
  shell,
  evaFx,
}) => {
  const original = JSON.parse(evaFx.read('work/meetings/standup.json'))
  await openStandup(shell)
  await shell.locator(q('meeting-accept-standup#1')).click()
  await expect(shell.getByText('Added T16 to Flo.')).toBeVisible()

  const lines = evaFx.read('memory/todos.md').split('\n')
  const at = lines.findIndex((l) => l.startsWith('- [ ] T11 [flo] Second flo todo'))
  expect(lines[at + 1]).toBe(
    `- [ ] T16 [flo] Send the beta build to Sam (from meeting Daily standup, ${today()}) (added ${today()})`,
  )
  const rec = JSON.parse(evaFx.read('work/meetings/standup.json'))
  expect(rec.proposals[0].status).toBe('accepted')
  expect(rec.extra.keep).toBe('me')
  expect(Object.keys(rec)).toEqual(Object.keys(original))
  expect(rec.proposals[2]).toEqual(original.proposals[2])

  await expect(
    shell.locator(sel('meeting-remembered')).locator(q('proposal-standup#1')),
  ).toContainText('Accepted')
  await expect(shell.locator(sel('meeting-for-you')).locator(q('proposal-standup#1'))).toHaveCount(
    0,
  )
  await proofShot(app, shell, 'meeting-accepted', PHASE)
})

test('a second accept is refused without a duplicate todo', async ({ shell, evaFx }) => {
  await openStandup(shell)
  await shell.locator(q('meeting-accept-standup#1')).click()
  await expect(shell.getByText('Added T16 to Flo.')).toBeVisible()
  const todos = evaFx.read('memory/todos.md')
  const r = await shell.evaluate(() =>
    (
      window as unknown as {
        eva: { invoke(c: string, i: unknown): Promise<{ ok: boolean; error?: { code: string } }> }
      }
    ).eva.invoke('meetings.accept', { stem: 'standup', proposalId: 'standup#1' }),
  )
  expect(r.ok).toBe(false)
  expect(r.error?.code).toBe('not-proposed')
  expect(evaFx.read('memory/todos.md')).toBe(todos)
})

test('a ticket without a workspace becomes a Draft ticket for Eva', async ({ shell, evaFx }) => {
  await openStandup(shell)
  await shell.locator(q('meeting-accept-standup#2')).click()
  await expect(shell.getByText('Added T16 to Eva.')).toBeVisible()
  expect(evaFx.read('memory/todos.md')).toContain('T16 [eva] Draft ticket: Crash on login')
})

test('Dismiss on Meetings home closes the proposal and leaves todos alone', async ({
  app,
  shell,
  evaFx,
}) => {
  const todos = evaFx.read('memory/todos.md')
  await shell.locator(sel('nav-meetings')).click()
  await shell.locator(sel('meetings-home')).click()
  await expect(shell.locator(sel('meetings-summary'))).toHaveText(
    '2 meetings this week, 3 waiting on you',
  )
  await shell.locator(q('meeting-dismiss-planning#2')).click()
  await expect(shell.getByText('Dismissed.')).toBeVisible()
  const rec = JSON.parse(evaFx.read('work/meetings/planning.json'))
  expect(rec.proposals.find((p: { id: string }) => p.id === 'planning#2').status).toBe('dismissed')
  expect(evaFx.read('memory/todos.md')).toBe(todos)
  await expect(shell.locator(sel('meetings-summary'))).toHaveText(
    '2 meetings this week, 2 waiting on you',
  )
  await expect(shell.locator(q('proposal-planning#2'))).toHaveCount(0)
  await proofShot(app, shell, 'meeting-dismissed', PHASE)
})

test('a stale view shows the changed-on-disk alert and Reload refreshes the row', async ({
  shell,
  evaFx,
}) => {
  await openStandup(shell)
  const file = path.join(evaFx.root, 'work/meetings/standup.json')
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
  rec.proposals[1].status = 'accepted'
  fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`)
  const todos = evaFx.read('memory/todos.md')
  await shell.locator(q('meeting-accept-standup#2')).click()
  const alert = shell.locator(q('meeting-refusal-standup#2'))
  await expect(alert).toContainText(
    'work/meetings/standup.json changed on disk. Reload the meeting and try again.',
  )
  expect(evaFx.read('memory/todos.md')).toBe(todos)
  await alert.getByRole('button', { name: 'Reload' }).click()
  await expect(
    shell.locator(sel('meeting-remembered')).locator(q('proposal-standup#2')),
  ).toContainText('Accepted')
})
