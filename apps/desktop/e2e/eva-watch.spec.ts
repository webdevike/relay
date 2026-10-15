import * as fs from 'node:fs'
import * as path from 'node:path'
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

const sel = (id: string): string => `[data-testid=${id}]`

test('external edits to the Eva checkout refresh the dashboard without any user action', async ({
  app,
  shell,
  evaFx,
}) => {
  const summary = shell.locator(sel('dash-summary'))
  const count = shell.locator(sel('count-tasks'))
  await expect(shell.locator(sel('dash-hero'))).toBeVisible()
  await expect(summary).toContainText('5 open todos')
  // Let the watcher finish its initial scan before touching files.
  await new Promise((r) => setTimeout(r, 1500))

  const file = path.join(evaFx.root, 'memory/todos.md')
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const at = lines.findIndex((l) => l.includes(' T11 '))
  lines.splice(at + 1, 0, '- [ ] T21 [eva] From the watcher')
  fs.writeFileSync(file, lines.join('\n'))
  await expect(summary).toContainText('6 open todos', { timeout: 3000 })
  await expect(count).toHaveText('6', { timeout: 3000 })

  fs.writeFileSync(path.join(evaFx.root, 'workspaces/zeta.md'), '# Zeta\n')
  await expect(shell.locator(sel('ws-card-zeta'))).toBeVisible({ timeout: 3000 })
  await proofShot(app, shell, 'dashboard-live-change', { phase: 'phase-3' })
})
