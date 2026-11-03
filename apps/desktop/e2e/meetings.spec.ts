import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeEvaFixture, type EvaFixture } from './helpers/eva-fixture'
import { proofShot } from './helpers/proofShot'

type Snap = {
  active: number
  list: Array<{ id: number; page: string; pinned: boolean; title: string }>
}
type Shell = { __evaosShell: { tabs(): Snap } }
type OpenHook = { calls: Array<{ path: string }>; failNext: boolean }
type G = { __evaosTest: { hooks: { openPath: OpenHook } } }

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
const tabs = (shell: Page): Promise<Snap> =>
  shell.evaluate(() => (window as unknown as Shell).__evaosShell.tabs())
const calls = (app: ElectronApplication): Promise<Array<{ path: string }>> =>
  app.evaluate(() => (globalThis as unknown as G).__evaosTest.hooks.openPath.calls)

const retroLabel = (): string => {
  const d = new Date()
  d.setDate(d.getDate() - 10)
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(d)
}

async function openMeetings(shell: Page): Promise<void> {
  await shell.locator(sel('nav-meetings')).click()
  await expect(shell.locator(sel('sidebar-sub-meetings'))).toBeVisible()
  await expect(shell.locator(sel('meetings-list'))).toBeVisible()
}

test.beforeEach(async ({ shell }) => {
  await expect(shell.locator(sel('dash-hero'))).toBeVisible()
})

test('the sidebar lists meetings by day with folded test calls and search', async ({
  app,
  shell,
}) => {
  await openMeetings(shell)
  await expect(shell.locator(sel('meetings-day'))).toHaveText([
    'Today',
    'Yesterday',
    retroLabel(),
    'Undated',
  ])
  await expect(shell.locator(sel('meeting-row-standup'))).toContainText('Daily standup')
  await expect(shell.locator(sel('meeting-row-planning'))).toContainText('Sprint planning')
  const fold = shell.locator(sel('meetings-tests'))
  await expect(fold).toHaveText(/Test calls \(1\)/)
  await expect(fold).toHaveAttribute('aria-expanded', 'false')
  await expect(shell.locator(sel('meeting-row-test-call'))).toHaveCount(0)

  await shell.keyboard.press('Meta+f')
  await expect(shell.locator(sel('sidebar-sub-search'))).toBeFocused()
  await shell.keyboard.type('test')
  await expect(fold).toHaveAttribute('aria-expanded', 'true')
  await expect(shell.locator(sel('meeting-row-test-call'))).toContainText('Test call')
  await expect(shell.locator(sel('meeting-row-standup'))).toHaveCount(0)
  await shell.locator(sel('sidebar-sub-search')).fill('')
  await expect(shell.locator(sel('meeting-row-standup'))).toBeVisible()
  await proofShot(app, shell, 'meetings-sidebar', PHASE)
})

test('meeting detail shows the overview, transcript and opens the notes', async ({
  app,
  shell,
}) => {
  await openMeetings(shell)
  await shell.locator(sel('meeting-row-standup')).click()
  const page = shell.locator(sel('page-meeting'))
  await expect(page).toBeVisible()
  await expect(shell.locator(sel('meeting-title'))).toHaveText('Daily standup')
  await expect(shell.locator(sel('meeting-attendees'))).toContainText('Isaac')
  await expect(shell.locator(sel('meeting-attendees'))).toContainText('Sam')
  await expect(shell.locator(sel('meeting-attendees'))).toContainText('Priya')
  await expect(page).toContainText('The team reviewed the beta build')
  await expect(page.getByRole('heading', { name: 'Decisions' })).toBeVisible()
  await expect(
    shell.locator(sel('meeting-for-you')).locator('[data-testid^=proposal-]'),
  ).toHaveCount(2)
  const remembered = shell.locator(sel('meeting-remembered'))
  await expect(remembered).toContainText('Book the room')
  await expect(remembered).toContainText('Accepted')
  const snap = await tabs(shell)
  expect(snap.list[snap.active]!.title).toBe('Daily standup')

  await shell.locator(sel('sidebar-back')).click()
  await shell.locator(sel('appearance-dark')).click()
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', 'dark')
  await proofShot(app, shell, 'meeting-detail-dark', PHASE)
  await shell.locator(sel('appearance-light')).click()
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', 'light')
  await proofShot(app, shell, 'meeting-detail-light', PHASE)

  await shell.locator(sel('meeting-tab-transcript')).click()
  await expect(shell.locator(sel('meeting-line'))).toHaveCount(4)
  await expect(shell.locator(sel('meeting-line')).first()).toContainText('Isaac')
  await shell.locator(sel('meeting-transcript-filter')).fill('beta')
  await expect(shell.locator(sel('meeting-line'))).toHaveCount(1)
  await shell.locator(sel('meeting-transcript-filter')).fill('')
  await proofShot(app, shell, 'meeting-transcript', PHASE)

  await shell.locator(sel('meeting-open-notes')).click()
  await expect.poll(async () => (await calls(app)).length).toBe(1)
  expect((await calls(app))[0]!.path.endsWith('work/meetings/notes/standup.md')).toBe(true)
})

test('a test call explains why it was skipped', async ({ shell }) => {
  await openMeetings(shell)
  await shell.locator(sel('meetings-tests')).click()
  await shell.locator(sel('meeting-row-test-call')).click()
  await expect(shell.locator(sel('page-meeting'))).toContainText('Eva skipped this as a test call.')
})

test('Meetings home shows the summary, waiting proposals and who is out', async ({
  app,
  shell,
}) => {
  await openMeetings(shell)
  await shell.locator(sel('meetings-home')).click()
  await expect(shell.locator(sel('page-meetings'))).toBeVisible()
  await expect(shell.locator(sel('meetings-summary'))).toHaveText(
    '2 meetings this week, 3 waiting on you',
  )
  await expect(
    shell.locator(sel('meetings-waiting')).locator('[data-testid^=proposal-]'),
  ).toHaveCount(3)
  await expect(shell.locator(sel('meetings-out'))).toContainText('Sam is out')
  await proofShot(app, shell, 'meetings-home', PHASE)
})
