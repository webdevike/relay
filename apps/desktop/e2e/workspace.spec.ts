import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeEvaFixture, type EvaFixture } from './helpers/eva-fixture'
import { proofShot } from './helpers/proofShot'

type Snap = {
  active: number
  list: Array<{ id: number; page: string; pinned: boolean; title: string }>
}
type Shell = { __evaosShell: { tabs(): Snap; openPlace(p: string, n?: boolean): void } }
type OpenHook = { calls: Array<{ path: string }>; failNext: boolean }
type G = { __evaosTest: { hooks: { openPath: OpenHook } } }

const pad = (n: number): string => String(n).padStart(2, '0')
const daysAgo = (n: number): string => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const test = base.extend<{ evaFx: EvaFixture }>({
  evaFx: async ({}, use) => {
    const fx = makeEvaFixture()
    const file = path.join(fx.root, 'workspaces', 'flo.md')
    const extra = [4, 5, 6, 7, 8].map((n, i) => `- ${daysAgo(n)} extra note ${i + 1}`).join('\n')
    fs.writeFileSync(
      file,
      fs.readFileSync(file, 'utf8').replace('\n## Notes', `${extra}\n\n## Notes`),
    )
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
const openPlace = (shell: Page, p: string): Promise<void> =>
  shell.evaluate((place) => (window as unknown as Shell).__evaosShell.openPlace(place), p)
const hook = <T>(app: ElectronApplication, fn: (h: OpenHook) => T): Promise<T> =>
  app.evaluate((_e, src) => {
    const h = (globalThis as unknown as G).__evaosTest.hooks.openPath
    return new Function('h', `return (${src})(h)`)(h)
  }, fn.toString())

test.beforeEach(async ({ shell }) => {
  await expect(shell.locator(sel('dash-hero'))).toBeVisible()
})

test('a workspace card opens the page with chips, timeline, todos and sections', async ({
  app,
  shell,
}) => {
  const card = shell.locator(sel('ws-card-flo'))
  if (await card.count()) await card.click()
  else await shell.locator('.eva-dash-name-link', { hasText: 'Flo' }).first().click()
  const page = shell.locator(sel('page-workspace'))
  await expect(page).toBeVisible()
  const header = shell.locator(sel('ws-header'))
  await expect(header).toContainText('Flo')
  await expect(header.getByText('Active', { exact: true })).toBeVisible()
  await expect(header.getByText('2 open todos')).toBeVisible()

  const snap = await tabs(shell)
  expect(snap.list[snap.active]!.page).toBe('workspace:flo')
  expect(snap.list[snap.active]!.title).toBe('Flo')
  await expect(shell.locator('.eva-tab-title', { hasText: 'Flo' }).first()).toBeVisible()

  const rows = shell.locator(sel('ws-timeline')).locator(sel('ws-timeline-row'))
  await expect(rows).toHaveCount(8)
  const toggle = shell.locator(sel('ws-timeline-toggle'))
  await expect(toggle).toHaveText('Show all 11')
  await toggle.click()
  await expect(rows).toHaveCount(11)
  await expect(toggle).toHaveText('Show fewer')

  const sections = shell.locator(sel('ws-sections'))
  for (const t of ['Threads', 'Notes', 'Links']) {
    await expect(sections.getByRole('button', { name: t, exact: true })).toBeVisible()
  }
  await expect(shell.locator(sel('ws-todos')).locator('li')).toHaveCount(2)
  await shell
    .locator(sel('page-scroll'))
    .evaluate((e) => ((e.firstElementChild as HTMLElement | null) ?? e).scrollTo?.(0, 0))
  await shell.locator(sel('ws-header')).scrollIntoViewIfNeeded()
  await shell.locator(sel('appearance-dark')).click()
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', 'dark')
  await proofShot(app, shell, 'workspace-dark', PHASE)

  await shell.locator(sel('appearance-light')).click()
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', 'light')
  await proofShot(app, shell, 'workspace-light', PHASE)
})

test('New Todo preselects the workspace', async ({ shell }) => {
  await openPlace(shell, 'workspace:flo')
  await shell.locator(sel('ws-new-todo')).click()
  await expect(shell.locator(sel('new-todo-text'))).toBeVisible()
  await expect(shell.locator(sel('new-todo-workspace'))).toHaveValue('Flo')
})

test('Open File records one openPath call and toasts on failure', async ({ app, shell }) => {
  await openPlace(shell, 'workspace:flo')
  await shell.locator(sel('ws-open-file')).click()
  await expect.poll(() => hook(app, (h) => h.calls.length)).toBe(1)
  const calls = await hook(app, (h) => h.calls)
  expect(calls[0]!.path.endsWith('workspaces/flo.md')).toBe(true)

  await hook(app, (h) => {
    h.failNext = true
  })
  await shell.locator(sel('ws-open-file')).click()
  await expect(shell.getByText('Could not open', { exact: false }).first()).toBeVisible()
  expect(await hook(app, (h) => h.calls.length)).toBe(1)
})

test('the built-in Eva workspace has Open File disabled', async ({ shell }) => {
  await openPlace(shell, 'workspace:eva')
  await expect(shell.locator(sel('ws-header'))).toContainText('Eva')
  await expect(shell.locator(sel('ws-open-file'))).toBeDisabled()
})

test('a missing workspace shows the not found state and returns to the dashboard', async ({
  app,
  shell,
}) => {
  await openPlace(shell, 'workspace:nope')
  await expect(shell.getByText('Workspace not found')).toBeVisible()
  await proofShot(app, shell, 'workspace-missing', PHASE)
  await shell.getByRole('button', { name: 'Open Dashboard' }).click()
  await expect(shell.locator(sel('page-dashboard'))).toBeVisible()
})
