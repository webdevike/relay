import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeEvaFixture, EXPECT_P3, type EvaFixture } from './helpers/eva-fixture'
import { proofShot } from './helpers/proofShot'
import { startStaticServer, type StaticServer } from './helpers/static-server'

type G = {
  __evaosTest: { hooks: { browser: { host: { activeView(): { getVisible(): boolean } } } } }
}

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
const pad = (n: number): string => String(n).padStart(2, '0')
const today = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const viewVisible = (app: ElectronApplication): Promise<boolean> =>
  app.evaluate(() =>
    (globalThis as unknown as G).__evaosTest.hooks.browser.host.activeView().getVisible(),
  )

let server: StaticServer
test.beforeAll(async () => {
  server = await startStaticServer()
})
test.afterAll(async () => {
  await server.close()
})

test.beforeEach(async ({ shell }) => {
  await expect(shell.locator(sel('dash-hero'))).toBeVisible()
})

async function chooseWorkspace(shell: Page, label: string): Promise<void> {
  await shell.locator(sel('new-todo-workspace')).click()
  await shell.getByRole('option', { name: label, exact: true }).click()
}

test('Cmd+N adds a row right after the last open row', async ({ app, shell, evaFx }) => {
  await shell.locator(sel('dash-hero')).click()
  await shell.keyboard.press('Meta+n')
  const modal = shell.locator(sel('new-todo-text'))
  await expect(modal).toBeVisible()
  await expect(shell.locator(sel('new-todo-workspace'))).toHaveValue('Eva')
  await chooseWorkspace(shell, 'Relay')
  await shell.locator(sel('new-todo-text')).fill('Ship the relay build')
  const row = `T16 [relay] Ship the relay build (added ${today()})`
  await expect(shell.locator(sel('new-todo-preview'))).toHaveText(row)
  await proofShot(app, shell, 'new-todo-modal', PHASE)

  const before = evaFx.read('memory/todos.md').split('\n')
  await shell.locator(sel('new-todo-submit')).click()
  await expect(modal).toBeHidden()
  await expect(shell.getByText('Added T16 to Relay.')).toBeVisible()

  const after = evaFx.read('memory/todos.md').split('\n')
  const at = before.findIndex((l) => l.startsWith('- [ ] T11 [flo] Second flo todo'))
  expect(at).toBeGreaterThanOrEqual(0)
  expect(after[at + 1]).toBe(`- [ ] ${row}`)
  expect([...after.slice(0, at + 1), ...after.slice(at + 2)]).toEqual(before)
  await expect(shell.locator(sel('dash-summary'))).toContainText(
    `${EXPECT_P3.openTodos + 1} open todos`,
  )
})

test('the hero button preselects the last used workspace and ids keep counting', async ({
  shell,
  evaFx,
}) => {
  await shell.locator(sel('dash-new-todo')).click()
  await expect(shell.locator(sel('new-todo-workspace'))).toHaveValue('Eva')
  await shell.locator(sel('new-todo-text')).fill('First')
  await shell.keyboard.press('Meta+Enter')
  await expect(shell.locator(sel('new-todo-text'))).toBeHidden()
  await shell.locator(sel('dash-new-todo')).click()
  await expect(shell.locator(sel('new-todo-workspace'))).toHaveValue('Eva')
  await shell.locator(sel('new-todo-text')).fill('Second')
  await expect(shell.locator(sel('new-todo-preview'))).toContainText('T17 [eva] Second')
  await shell.locator(sel('new-todo-submit')).click()
  await expect(shell.locator(sel('new-todo-text'))).toBeHidden()
  const todos = evaFx.read('memory/todos.md')
  expect(todos).toContain('T16 [eva] First')
  expect(todos).toContain('T17 [eva] Second')
})

test('the modal hides the native browser view and Escape restores it', async ({ app, shell }) => {
  const addr = shell.locator(sel('address-input'))
  await addr.fill(String(server.port))
  await addr.press('Enter')
  await expect.poll(() => viewVisible(app)).toBe(true)
  await shell.keyboard.press('Meta+n')
  await expect(shell.locator(sel('new-todo-text'))).toBeVisible()
  await expect.poll(() => viewVisible(app)).toBe(false)
  await shell.keyboard.press('Escape')
  await expect(shell.locator(sel('new-todo-text'))).toBeHidden()
  await expect.poll(() => viewVisible(app)).toBe(true)
})

test('a todos.md without ## Open keeps the modal open with the error', async ({
  app,
  shell,
  evaFx,
}) => {
  const file = path.join(evaFx.root, 'memory/todos.md')
  const broken = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '## Open')
    .join('\n')
  fs.writeFileSync(file, broken)
  await shell.locator(sel('dash-new-todo')).click()
  await shell.locator(sel('new-todo-text')).fill('Will fail')
  await shell.locator(sel('new-todo-submit')).click()
  const alert = shell.locator(sel('new-todo-modal')).getByRole('alert')
  await expect(alert).toHaveText(
    'Could not add the todo. memory/todos.md changed while you were typing or could not be written. Review the preview and try again.',
  )
  await expect(shell.locator(sel('new-todo-text'))).toBeVisible()
  expect(fs.readFileSync(file, 'utf8')).toBe(broken)
  await proofShot(app, shell, 'new-todo-error', PHASE)
})

test('Cmd+N is ignored while the account menu is open', async ({ shell }) => {
  await shell.locator(sel('account-trigger')).click()
  await expect(shell.locator(sel('account-menu'))).toBeVisible()
  await shell.keyboard.press('Meta+n')
  await expect(shell.locator(sel('new-todo-text'))).toBeHidden()
})
