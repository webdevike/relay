import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeEvaFixture, type EvaFixture } from './helpers/eva-fixture'

// Opt-in live spec: the Agents page over the real atomic-agents service on this Mac (its installed
// CLI and journal, read only: `list --json`, `runs` and `result --wait 0ms`; nothing is saved), with
// the real assistant registry so callers show their portraits. EVAOS_SPECIALISTS_SHOTS=<dir> keeps
// the screenshots there.
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

test("the real agents: the list, one agent's files, its runs and one run with its output", async ({
  app,
  shell,
}) => {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1500, 950))
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('agents'))
  const row = shell.locator(sel('agent-row-web-researcher'))
  await expect(row).toBeVisible({ timeout: 30_000 })
  await shot(shell, 'agents')

  await row.click()
  await expect(shell.locator(sel('agent-facts'))).toBeVisible()
  await expect(shell.locator(sel('files-tab')).first()).toBeVisible({ timeout: 30_000 })
  await shot(shell, 'agent-files')

  // The newest run Nova asked opens beside the runs with its reply.
  await shell.locator(sel('agent-tab-runs')).click()
  const runs = shell.locator('[data-testid^="agent-run-"][data-status]')
  await expect(runs.first()).toBeVisible({ timeout: 30_000 })
  await runs.filter({ hasText: 'Asked by Nova' }).first().click()
  const panel = shell.locator(sel('specialists-panel'))
  await expect(panel.locator(sel('agents-answer'))).toBeVisible({ timeout: 30_000 })
  await shot(shell, 'agent-run')
})
