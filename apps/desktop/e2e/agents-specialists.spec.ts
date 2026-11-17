import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { makeEvaFixture, type EvaFixture } from './helpers/eva-fixture'
import { proofShot } from './helpers/proofShot'

// The Agents page: every atomic-agents specialist the service loads, with its model, status and
// week; a row opens the agent's folder in the Files tree and editor, and its runs with their
// output. A save lands in the installed copy (what the service loads) and is committed to the
// repo's main with git plumbing. Main reads the service through its CLI in
// EVAOS_ATOMIC_AGENTS_HOME; here a fake CLI answers `list --json`, `runs`, `result <run>` and
// `agent validate <file>` like the real one (packages/atomic-agents src/cli.ts), and the repo is a
// throwaway clone of a bare origin. The Board page (the agents' kanban) is its own page now.
// EVAOS_PROOF=1 writes the screenshots to proof/agents-page/.

const PHASE = 'agents-page'
const at = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString()

const AGENT_MD = `---
id: web-researcher
purpose: Answer one question from the web with verified quotes and their links.
model: anthropic/claude-sonnet-5-5
fallbackModel: anthropic/claude-haiku-5-5
thinking: low
request: research.requested
reply: research.answered
knowledge:
  - sources.md
---

You are Isaac's web researcher. You get one question and answer it from pages you read yourself.

How you work:

1. Search, open the three best pages, and quote them word for word.
2. Every claim carries its link. Drop a claim you cannot quote.
`

/** The agents' files as the service's installed copy and the repo both have them. */
const DOMAINS: Record<string, string> = {
  'research/agents/web-researcher/AGENT.md': AGENT_MD,
  'research/agents/web-researcher/knowledge/sources.md':
    '# Sources\n\nPrefer the maker, then retailers that list a price.\n',
  'research/agents/web-researcher/bench/cases.json': '[{"question":"Acasis TBU405 price"}]\n',
  'design/design-critic.json': JSON.stringify(
    {
      id: 'design-critic',
      purpose: "Score one rendered UI against Isaac's design rules and list the fixes, ranked.",
      model: 'anthropic/claude-opus-5-5',
      knowledge: ['design-critic.rules.md'],
    },
    null,
    2,
  ),
  'design/design-critic.rules.md': '# Rules\n\n- One primary action per view.\n',
  'design/bench/design-critic.ts': 'export const cases = []\n',
  // Another agent's spec in the same folder: not this agent's files.
  'design/widget.json': '{"id":"widget"}\n',
}

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
      job: 'answer',
      model: 'anthropic/claude-sonnet-5-5',
      requestedAt: at(5),
      seconds: 21.5,
      cost: 0.0042,
    },
    {
      run: 'run-c',
      agent: 'web-researcher',
      status: 'running',
      summary: 'Which USB4 docks ship with a 100 W charger?',
      job: 'answer',
      startedAt: at(1),
    },
    {
      run: 'run-a',
      agent: 'design-critic',
      status: 'done',
      caller: 'agent:nova',
      summary: 'http://localhost:5173/settings',
      job: 'critique',
      model: 'anthropic/claude-opus-5-5',
      requestedAt: at(90),
      seconds: 48,
    },
  ],
  agents: [],
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

/**
 * The service's journal (what main folds for trial arms): Nova's design-critic request ran as a
 * trial on three models; her own run is arm A, B answered, C still runs, and nobody picked yet.
 */
const journalLine = (type: string, run: string, minutesAgo: number, data: object): string =>
  JSON.stringify({
    id: `${type}-${run}`,
    type: `design-critic/${type}`,
    component: 'design-critic',
    job: 'critique',
    run,
    at: at(minutesAgo),
    data,
  })
const trialArm = (letter: string) => ({ trial: { id: 't1', letter, role: 'arm' } })
const JOURNAL =
  [
    journalLine('trial.started', 't1', 90, {
      trialId: 't1',
      requestId: 'run-a',
      caller: 'agent:nova',
      request: 'http://localhost:5173/settings',
      job: 'critique',
      arms: [
        { letter: 'A', model: 'anthropic/claude-opus-5-5', default: true },
        { letter: 'B', model: 'anthropic/claude-sonnet-5-5', default: false },
        { letter: 'C', model: 'openai-codex/gpt-6.1-sol', default: false },
      ],
    }),
    journalLine('job.started', 'arm-b', 90, {
      model: 'anthropic/claude-sonnet-5-5',
      ...trialArm('B'),
    }),
    journalLine('job.started', 'arm-c', 90, {
      model: 'openai-codex/gpt-6.1-sol',
      ...trialArm('C'),
    }),
    journalLine('trial.result', 't1', 89, { trialId: 't1', letter: 'B', ok: true, seconds: 41 }),
  ].join('\n') + '\n'

/** The fake CLI: the roster names the agents' files in the installed copy it sits in. */
const CLI = `
const home = process.env.ATOMIC_AGENTS_HOME
const domains = home + '/app/atomic-agents/domains'
const RUNS = ${JSON.stringify(RUNS)}
const RESULT = ${JSON.stringify(RESULT)}
const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
const [verb, sub] = args
if (verb === 'list') {
  console.log(JSON.stringify([
    { id: 'web-researcher', purpose: 'Answer one question from the web with verified quotes and their links.',
      kind: 'spec', file: domains + '/research/agents/web-researcher/AGENT.md',
      knowledge: [domains + '/research/agents/web-researcher/knowledge/sources.md'],
      enabled: true, mode: 'live', model: 'anthropic/claude-sonnet-5-5', fallbackModel: 'anthropic/claude-haiku-5-5',
      candidates: ['anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-5-5'], thinking: 'low', how: 'ask',
      runs: { week: 14, failed: 1, running: 1, lastAt: ${JSON.stringify(at(1))} } },
    { id: 'design-critic', purpose: "Score one rendered UI against Isaac's design rules and list the fixes, ranked.",
      kind: 'spec', file: domains + '/design/design-critic.json',
      knowledge: [domains + '/design/design-critic.rules.md'],
      enabled: true, mode: 'live', model: 'anthropic/claude-opus-5-5', candidates: [], how: 'ask',
      trial: { on: true, arms: ['anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5', 'openai-codex/gpt-6.1-sol'] },
      runs: { week: 3, failed: 1, running: 0, lastAt: ${JSON.stringify(at(90))} } },
    { id: 'mail-triage', purpose: 'Sort new mail into reply, read later and archive.',
      kind: 'code', enabled: false, model: 'anthropic/claude-haiku-5-5', candidates: [],
      runs: { week: 0, failed: 0, running: 0 } },
  ]))
} else if (verb === 'runs') {
  const agent = flag('--agent')
  console.log(JSON.stringify({ ...RUNS, runs: RUNS.runs.filter((r) => agent === undefined || r.agent === agent) }))
} else if (verb === 'result') {
  console.log(JSON.stringify(RESULT))
} else if (verb === 'agent' && sub === 'validate') {
  const text = await Bun.file(args[2]).text()
  if (text.includes('BROKEN')) { console.log('FAIL ' + args[2] + ': frontmatter does not parse'); process.exit(1) }
  console.log('ok ' + args[2])
} else process.exit(2)
`

interface Fx {
  home: string
  /** The bare origin the save is pushed to. */
  origin: string
  eva: EvaFixture
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const ledger = (key: string, title: string, stage: string): string =>
  `---\nkey: ${key}\ntitle: ${title}\nworkspace: ecardsystems\nstage: ${stage}\nmove: isaac\nnext: Isaac: review\nupdated: ${new Date().toISOString().slice(0, 10)}\n---\n\n## Context\n`

const test = base.extend<{ fx: Fx }>({
  fx: async ({}, use) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-agents-page-'))
    const home = path.join(tmp, 'home')
    const app = path.join(home, 'app/atomic-agents')
    const origin = path.join(tmp, 'origin.git')
    const clone = path.join(tmp, 'relay')
    const write = (root: string): void => {
      for (const [rel, text] of Object.entries(DOMAINS)) {
        const file = path.join(root, rel)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, text)
      }
    }
    write(path.join(app, 'domains'))
    fs.mkdirSync(path.join(app, 'src'), { recursive: true })
    fs.writeFileSync(path.join(app, 'src/cli.ts'), CLI)
    fs.writeFileSync(path.join(home, 'events.ndjson'), JOURNAL)

    git(tmp, 'init', '--quiet', '--bare', '--initial-branch=main', origin)
    git(tmp, 'clone', '--quiet', origin, clone)
    write(path.join(clone, 'packages/atomic-agents/domains'))
    git(clone, 'add', '-A')
    git(clone, '-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '-qm', 'agents')
    git(clone, 'push', '--quiet', 'origin', 'HEAD:main')
    fs.writeFileSync(
      path.join(home, 'app/source.json'),
      JSON.stringify({ gitDir: path.join(clone, '.git'), package: 'packages/atomic-agents' }),
    )

    const eva = makeEvaFixture()
    const items = path.join(eva.root, 'work/items')
    fs.mkdirSync(items, { recursive: true })
    fs.writeFileSync(
      path.join(items, 'ENG-9001.md'),
      ledger('ENG-9001', 'Versions for deleted assets', '9 PR (draft)'),
    )
    fs.writeFileSync(
      path.join(items, 'ENG-9002.md'),
      ledger('ENG-9002', 'Card art upload retries', '5 Build'),
    )
    await use({ home, origin, eva })
    eva.cleanup()
    fs.rmSync(tmp, { recursive: true, force: true })
  },
  launchEnv: async ({ fx }, use) => {
    await use({
      ...fx.eva.env,
      EVAOS_ATOMIC_AGENTS_HOME: fx.home,
      GIT_AUTHOR_NAME: 'Relay Test',
      GIT_AUTHOR_EMAIL: 'relay-test@example.com',
      GIT_COMMITTER_NAME: 'Relay Test',
      GIT_COMMITTER_EMAIL: 'relay-test@example.com',
    })
  },
})

test.use({ startOnChat: false })

const sel = (id: string): string => `[data-testid="${id}"]`
type Shell = { __evaosShell: { openPlace(page: string): void } }

test('lists the specialists; one opens its folder to edit (saved live and committed) and its runs; the kanban is the Board page', async ({
  app,
  shell,
  fx,
}) => {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1500, 950))
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('agents'))

  // The list: every agent the service loads, with its purpose, model, status and week.
  await expect(shell.locator(sel('agents-list'))).toBeVisible()
  await expect(shell.locator(sel('agents-summary'))).toHaveText('3 agents, 1 running')
  const researcher = shell.locator(sel('agent-row-web-researcher'))
  await expect(researcher).toContainText('Web researcher')
  await expect(researcher).toContainText('verified quotes')
  await expect(researcher).toContainText('claude-sonnet-5-5')
  await expect(shell.locator(sel('agent-status-web-researcher'))).toHaveText('Running')
  await expect(shell.locator(sel('agent-week-web-researcher'))).toHaveText('14')
  await expect(shell.locator(sel('agent-status-design-critic'))).toHaveText('Trial')
  await expect(shell.locator(sel('agent-status-mail-triage'))).toHaveText('Off')
  await proofShot(app, shell, 'agents-list', { phase: PHASE })

  // A folder agent opens on its AGENT.md, in the Files tree and editor rooted at its folder.
  await researcher.click()
  const detail = shell.locator(sel('agent-detail'))
  await expect(detail.locator('h1')).toHaveText('Web researcher')
  const facts = shell.locator(sel('agent-facts'))
  await expect(facts).toContainText('Modelclaude-sonnet-5-5')
  await expect(facts).toContainText('Fallbackclaude-haiku-5-5')
  await expect(facts).toContainText('Live')
  await expect(shell.locator(sel('agent-files-root'))).toHaveText('web-researcher')
  // The page's own tree and editor (a Files tool tab may sit parked elsewhere in the window).
  const files = shell.locator(sel('agent-files'))
  const tree = files.locator(sel('files-tree'))
  for (const name of ['AGENT.md', 'knowledge', 'bench'])
    await expect(tree.locator(`${sel('files-row')}[data-path="${name}"]`)).toBeVisible()
  const tabs = files.locator(sel('files-tab'))
  await expect(tabs).toHaveCount(1)
  await expect(tabs.first()).toContainText('AGENT.md')
  const editor = files.locator(sel('files-editor'))
  await expect(editor).toContainText("You are Isaac's web researcher")
  await expect(shell.locator(sel('agent-files-status'))).toHaveText(
    'Saves go live at once and are committed to main.',
  )
  await proofShot(app, shell, 'agent-detail-agent-md', { phase: PHASE })

  // Edit and save: the installed copy changes at once, and main gets the same text.
  await editor.locator('.view-line', { hasText: 'Drop a claim' }).click()
  await shell.keyboard.press('End')
  await shell.keyboard.press('Enter')
  await shell.keyboard.type('3. Quote every price with its currency.')
  await expect(tabs.first()).toHaveAttribute('data-dirty', 'true')
  await proofShot(app, shell, 'agent-editing', { phase: PHASE })
  await shell.keyboard.press('ControlOrMeta+s')
  await expect(tabs.first()).not.toHaveAttribute('data-dirty', 'true')
  const status = shell.locator(sel('agent-files-status'))
  await expect(status).toHaveAttribute('data-tone', 'ok', { timeout: 20_000 })
  await expect(status).toContainText(/^AGENT\.md: Live, and committed to main as [0-9a-f]{7}\.$/)
  const live = path.join(
    fx.home,
    'app/atomic-agents/domains/research/agents/web-researcher/AGENT.md',
  )
  expect(fs.readFileSync(live, 'utf8')).toContain('3. Quote every price with its currency.')
  const repoFile = 'main:packages/atomic-agents/domains/research/agents/web-researcher/AGENT.md'
  expect(git(fx.origin, 'show', repoFile)).toBe(fs.readFileSync(live, 'utf8').trim())
  expect(git(fx.origin, 'log', '-1', '--format=%s', 'main')).toBe(
    'web-researcher: edit AGENT.md (from the Relay Agents page)',
  )
  await proofShot(app, shell, 'agent-saved', { phase: PHASE })

  // A save the agent does not load with stays live but is not committed.
  await editor.locator('.view-line', { hasText: 'thinking: low' }).click()
  await shell.keyboard.press('End')
  await shell.keyboard.type(' BROKEN')
  await shell.keyboard.press('ControlOrMeta+s')
  await expect(status).toHaveAttribute('data-tone', 'bad', { timeout: 20_000 })
  await expect(status).toContainText('does not load with it')
  expect(git(fx.origin, 'show', repoFile)).not.toContain('BROKEN')

  // Its runs, asked for or not; one opens its output beside the list.
  await shell.locator(sel('agent-tab-runs')).click()
  const run = shell.locator(sel('agent-run-run-b'))
  await expect(run).toContainText('What does the Acasis TBU405 enclosure cost?')
  await expect(shell.locator(sel('agent-run-run-c'))).toHaveAttribute('data-status', 'running')
  await expect(shell.locator(sel('agent-run-run-a'))).toHaveCount(0)
  await run.click()
  const panel = shell.locator(sel('specialists-panel'))
  await expect(panel).toContainText('Asked by')
  await expect(panel.locator(sel('agents-answer'))).toContainText('About $90 at most US retailers.')
  await proofShot(app, shell, 'agent-runs', { phase: PHASE })
  await shell.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)

  // A spec agent's tree shows only its own files: the spec, its knowledge, its bench.
  await shell.locator(sel('agent-back')).click()
  await shell.locator(sel('agent-row-design-critic')).click()
  await expect(shell.locator(sel('agent-detail')).locator('h1')).toHaveText('Design critic')
  await expect(shell.locator(sel('agent-facts'))).toContainText(
    'TrialOn: claude-opus-5-5, claude-sonnet-5-5, gpt-6.1-sol',
  )
  await expect(shell.locator(sel('agent-facts'))).toContainText('ModeLive')
  await expect(tabs.first()).toContainText('design-critic.json')
  await expect(tree.locator(sel('files-row'))).toHaveText([
    'bench',
    'design-critic.json',
    'design-critic.rules.md',
  ])
  await expect(tree.locator(`${sel('files-row')}[data-path="widget.json"]`)).toHaveCount(0)
  await proofShot(app, shell, 'agent-json-spec', { phase: PHASE })

  // On trial: Nova's request ran on all three models; the arms are lettered runs, models hidden.
  await shell.locator(sel('agent-tab-runs')).click()
  await expect(shell.locator(sel('agent-run-run-a'))).toContainText('Asked by Nova · Trial A')
  await expect(shell.locator(sel('agent-run-t1:B'))).toHaveAttribute('data-status', 'done')
  await expect(shell.locator(sel('agent-run-t1:C'))).toHaveAttribute('data-status', 'running')
  await shell.locator(sel('agent-run-t1:B')).click()
  await expect(shell.locator(sel('specialists-panel-trial'))).toHaveText(
    'Arm B of a blind trial. Its result is on the trial card in the chat that asked, and its model shows once you pick.',
  )
  await proofShot(app, shell, 'agent-trial-runs', { phase: PHASE })

  // The kanban moved to its own Board page.
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('board'))
  await expect(shell.locator(sel('page-board'))).toBeVisible()
  await expect(shell.locator(sel('agents-board'))).toBeVisible()
  await expect(shell.locator(sel('agents-card-ENG-9001'))).toBeVisible()
  await proofShot(app, shell, 'board', { phase: PHASE })
})
