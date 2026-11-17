import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeEvaFixture, type EvaFixture } from './helpers/eva-fixture'

// Opt-in live spec: the Agents page's Specialists view over the real atomic-agents service on this
// Mac (its installed CLI and journal, read only: `runs` and `result --wait 0ms`), with the real
// assistant registry so callers show their portraits. EVAOS_SPECIALISTS_SHOTS=<dir> keeps the
// screenshots there.
const HOME =
  process.env.ATOMIC_AGENTS_HOME ?? path.join(os.homedir(), '.config/relay/atomic-agents')
const REGISTRY = path.join(os.homedir(), 'Eva/.omp/assistant/agents.json')
const SHOTS =
  process.env.EVAOS_SPECIALISTS_SHOTS ?? path.join(__dirname, '../test-results/agents-specialists')

const test = base.extend<{ evaFx: EvaFixture }>({
  evaFx: async ({}, use) => {
    const fx = makeEvaFixture()
    const registry = path.join(fx.root, '.omp/assistant/agents.json')
    fs.mkdirSync(path.dirname(registry), { recursive: true })
    fs.copyFileSync(REGISTRY, registry)
    await use(fx)
    fx.cleanup()
  },
  launchEnv: async ({ evaFx }, use) => {
    await use({ ...evaFx.env, EVAOS_ATOMIC_AGENTS_HOME: HOME })
  },
})
test.use({ startOnChat: false })
test.skip(process.env.EVAOS_LIVE !== '1', 'the real atomic-agents journal is opt-in (EVAOS_LIVE=1)')
test.setTimeout(120_000)

const sel = (id: string): string => `[data-testid="${id}"]`
type Shell = { __evaosShell: { openPlace(page: string): void } }

async function shot(shell: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await shell.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

test('the real specialist runs: callers, cost and time, and a run opens its reply', async ({
  app,
  shell,
}) => {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1500, 950))
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('agents'))
  await shell.locator(sel('agents-view')).getByText('Specialists').click()
  const rows = shell.locator('[data-testid^="specialists-run-"][data-status]')
  await expect(rows.first()).toBeVisible({ timeout: 30_000 })
  await expect(shell.locator(sel('specialists-usage-web-researcher'))).toBeVisible()
  await shot(shell, 'specialists')

  // The newest run Nova asked opens beside the list with its reply.
  const novas = rows.filter({ hasText: 'for Nova' })
  await novas.first().click()
  const panel = shell.locator(sel('specialists-panel'))
  await expect(panel.locator(sel('agents-answer'))).toBeVisible({ timeout: 30_000 })
  await shot(shell, 'specialists-run')
})
