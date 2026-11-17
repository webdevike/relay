import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'

// The Agents page's Specialists view: which assistant asked which specialist, with each
// specialist's week (calls, callers, cost) and every recent run; a run opens its reply beside the
// list. Main reads them through the atomic-agents CLI in EVAOS_ATOMIC_AGENTS_HOME; here a fake CLI
// answers `runs` and `result <run>` like the real one (packages/atomic-agents Requests.ts).

const at = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString()

const RUNS = {
  since: at(7 * 24 * 60),
  days: 7,
  runs: [
    {
      run: 'run-b',
      agent: 'web-researcher',
      status: 'done',
      caller: 'agent:nova',
      summary: 'What does the Acasis TBU405 enclosure cost?',
      model: 'anthropic/claude-haiku-5-5',
      requestedAt: at(5),
      seconds: 21.5,
      cost: 0.0042,
    },
    {
      run: 'run-a',
      agent: 'design-critic',
      status: 'failed',
      summary: 'http://localhost:5173/settings',
      error: 'the page did not load',
      requestedAt: at(90),
    },
  ],
  agents: [
    {
      agent: 'web-researcher',
      calls: 3,
      failed: 0,
      cost: 0.0131,
      callers: [{ caller: 'agent:nova', calls: 2 }, { calls: 1 }],
    },
    { agent: 'design-critic', calls: 1, failed: 1, cost: 0, callers: [{ calls: 1 }] },
  ],
}

const RESULT = {
  run: 'run-b',
  agent: 'web-researcher',
  status: 'done',
  caller: 'agent:nova',
  request: { question: 'What does the Acasis TBU405 enclosure cost?', depth: 'quick' },
  reply: {
    answer: 'About $90 at most US retailers.',
    citations: [{ url: 'https://acasis.com/tbu405', quote: 'USD 89.99', verified: true }],
  },
  text: 'About $90 at most US retailers.',
  seconds: 21.5,
  cost: 0.0042,
}

const test = base.extend<{ agentsHome: string }>({
  agentsHome: async ({}, use) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-atomic-agents-'))
    const src = path.join(home, 'app/atomic-agents/src')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(
      path.join(src, 'cli.ts'),
      `const [verb] = process.argv.slice(2)\n` +
        `console.log(JSON.stringify(verb === 'runs' ? ${JSON.stringify(RUNS)} : ${JSON.stringify(RESULT)}))\n`,
    )
    await use(home)
    fs.rmSync(home, { recursive: true, force: true })
  },
  launchEnv: async ({ agentsHome }, use) => {
    await use({ EVAOS_ATOMIC_AGENTS_HOME: agentsHome })
  },
})

test.use({ startOnChat: false })

const sel = (id: string): string => `[data-testid="${id}"]`
type Shell = { __evaosShell: { openPlace(page: string): void } }

test('lists specialist runs with who asked and what they cost; a run opens its reply', async ({
  app,
  shell,
}) => {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1500, 950))
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('agents'))
  await shell.locator(sel('agents-view')).getByText('Specialists').click()

  await expect(shell.locator(sel('agents-specialists'))).toBeVisible()
  await expect(shell.locator(sel('specialists-summary'))).toHaveText('4 runs in 7 days, $0.01')
  // The week per specialist: calls and cost; who asked shows as faces with their counts.
  const usage = shell.locator(sel('specialists-usage-web-researcher'))
  await expect(usage).toContainText('Web researcher')
  await expect(shell.locator(sel('specialists-calls-web-researcher'))).toHaveText('3')
  await expect(usage).toContainText('$0.01')
  await expect(usage.locator('[data-caller="assistant"]')).toHaveCount(1)
  await expect(usage.locator('[data-caller="none"]')).toHaveCount(1)

  // Runs, newest first: the request on one line, specialist and caller, cost, status, age.
  const rows = shell.locator('[data-testid^="specialists-run-run-"]')
  await expect(rows).toHaveCount(2)
  const first = rows.first()
  await expect(first).toHaveAttribute('data-testid', 'specialists-run-run-b')
  await expect(first).toContainText('What does the Acasis TBU405 enclosure cost?')
  await expect(first).toContainText('Web researcher for Nova')
  await expect(first.locator(sel('specialists-run-cost'))).toHaveText('$0.0042')
  await expect(first).toContainText(/\dm ago/)
  await expect(rows.nth(1)).toHaveAttribute('data-status', 'failed')
  await expect(rows.nth(1)).toContainText('Design critic')

  // A run opens its reply beside the list; Esc closes it.
  await first.click()
  const panel = shell.locator(sel('specialists-panel'))
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('Nova asked Web researcher')
  await expect(panel.locator(sel('agents-answer'))).toContainText('About $90 at most US retailers.')
  await expect(panel.locator(sel('agents-sources'))).toContainText('acasis.com/tbu405')
  await shell.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)

  // The view sticks: the board is one click back.
  await shell.locator(sel('agents-view')).getByText('Board').click()
  await expect(shell.locator(sel('agents-specialists'))).toHaveCount(0)
})
