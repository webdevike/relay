import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost, type HostSession } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT } from './helpers/paths'

// The Working tab of an assistant's Artifacts popover: everything agents run, from the host's one
// activity list. A helper shows once (the Artifacts rows draw it, the activity row for it is left
// out), sessions, harnesses and canvas agents carry their kind and live intent line, what waits on
// Isaac is pinned on top with its question, other owners get their own group, and what finished
// sits under "Finished today". The composer chips show the in-progress work this chat's assistant
// spun off, with the kind icon. EVAOS_WORKING_SHOTS=<dir> also writes dark and light screenshots.
const SHOTS = process.env.EVAOS_WORKING_SHOTS ?? ''

let fx: ChatFixture
let host: FakeRelayHost
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    const evaRoot = path.join(fx.root, 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
    fs.mkdirSync(path.join(evaRoot, '.omp/assistant'), { recursive: true })
    fs.writeFileSync(
      path.join(evaRoot, '.omp/assistant/agents.json'),
      JSON.stringify({
        agents: [
          { id: 'astra', title: 'Astra', scope: 'eCard Systems work', avatar: 'astra-2' },
          { id: 'nova', title: 'Nova', scope: 'Personal', avatar: 'astra-2' },
        ],
      }),
    )
    host = await FakeRelayHost.start(path.join(fx.root, 'relay'))
    await use({
      ...fx.launchEnv,
      EVAOS_EVA_ROOT: evaRoot,
      EVAOS_RELAY_DIR: path.join(fx.root, 'relay'),
    })
    await host.close()
    fx.cleanup()
  },
})
test.use({ startOnChat: false, toolPanes: false })

const sel = (id: string): string => `[data-testid="${id}"]`
const NOVA_THREAD: HostSession = {
  id: 'nova-1',
  status: 'idle',
  kind: 'assistant',
  assistant: 'nova',
  title: 'Nova',
}

const at = Date.now()
const minutes = (n: number): number => at - n * 60_000
const chatOf = (session: string) => ({ to: 'chat', thread: `session:${session}`, session })
const row = (over: Record<string, unknown>): Record<string, unknown> => ({
  status: 'working',
  intent: '',
  startedAt: minutes(5),
  updatedAt: minutes(1),
  ...over,
})

const HELPER_PATH = '/host/sessions/nova-1/WorkingList.jsonl'
const items = (autoWork: 'working' | 'done'): Array<Record<string, unknown>> => [
  // The same helper the Artifacts rows draw: the host lists it in the activity list too.
  row({
    id: `helper:${HELPER_PATH}`,
    kind: 'helper',
    owner: 'assistant:nova',
    title: 'WorkingList',
    intent: 'Reading the popover',
    open: { to: 'subagent', file: HELPER_PATH, name: 'WorkingList' },
  }),
  row({
    id: 'session:aw1',
    kind: 'session',
    owner: 'assistant:nova',
    title: 'ENG-6630 auto-work',
    status: autoWork,
    intent: 'Running the tests',
    model: 'Opus',
    open: chatOf('aw1'),
  }),
  row({
    id: 'canvas:roadmap',
    kind: 'canvas',
    owner: 'assistant:nova',
    title: 'Roadmap',
    intent: 'Astra with Isaac',
    cost: 0.42,
    open: { to: 'canvas', slug: 'roadmap' },
  }),
  row({
    id: 'harness:w1:p3',
    kind: 'harness',
    owner: 'other',
    title: 'demo-claude',
    intent: 'claude in harness-demo',
    open: { to: 'terminal', pane: 'w1:p3' },
  }),
  row({
    id: 'session:ask1',
    kind: 'session',
    owner: 'assistant:astra',
    title: 'ENG-6631 auto-work',
    status: 'waiting',
    intent: 'Approve bash: git push origin main',
    open: chatOf('ask1'),
  }),
  row({
    id: 'harness:w1:p4',
    kind: 'harness',
    owner: 'assistant:nova',
    title: 'demo-muse',
    status: 'done',
    intent: 'muse in harness-demo, idle',
    updatedAt: minutes(30),
    open: { to: 'terminal', pane: 'w1:p4' },
  }),
]

/** The renderer's e2e hooks (src/renderer/hotkeys/e2e-hooks.ts), as this spec uses them. */
type ShellHooks = { __evaosShell: { setAppearance(a: 'light' | 'dark'): void } }

async function scheme(shell: Page, s: 'light' | 'dark'): Promise<void> {
  await shell.evaluate((v) => (window as unknown as ShellHooks).__evaosShell.setAppearance(v), s)
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', s)
}

test("an assistant's Working tab lists everything its agents run, and the composer chips follow", async ({
  shell,
}) => {
  await shell.locator(sel('nav-assistants')).click()
  await shell.locator(sel('sidebar-agent-nova')).click()
  await shell.locator(sel('start-nova')).click()
  await expect.poll(() => host.kinds()).toContain('assistant.turn')
  host.upsert(NOVA_THREAD)
  fs.writeFileSync(
    path.join(fx.sessionsDir, '2026-11-04T10-00-00-000Z_nova-1.jsonl'),
    [
      { type: 'session', version: 3, id: 'nova-1', timestamp: new Date().toISOString(), cwd: '/' },
      { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'Hi Nova' } },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n',
  )
  await expect(shell.locator(sel('chat-log'))).toContainText('Hi Nova', { timeout: 10_000 })

  host.setArtifacts('assistant:nova', [
    {
      id: `subagent:${HELPER_PATH}`,
      kind: 'subagent',
      title: 'WorkingList',
      path: HELPER_PATH,
      mentions: 1,
      firstSeen: minutes(5),
      lastSeen: minutes(1),
      sources: [],
      addedBy: 'extractor',
      subagent: { state: 'running', startedAt: minutes(5), line: 'Reading the popover' },
    },
  ])
  host.setActivity(items('working'))

  // The composer chips: this assistant's in-progress sessions and canvas agents, kind icon each.
  // Not the harness nobody owns, not what waits under another assistant, not finished work.
  const chip = (id: string) => shell.locator(sel(`activity-chip-${id}`))
  await expect(chip('session:aw1')).toHaveAttribute('data-kind', 'session')
  await expect(chip('canvas:roadmap')).toHaveAttribute('data-kind', 'canvas')
  await expect(chip('session:aw1').locator('svg')).toHaveCount(1)
  await expect(shell.locator('[data-testid^="activity-chip-"]')).toHaveCount(2)

  // The popover: the tab is called Working, and what waits on Isaac is on top with its question.
  await shell.locator(sel('artifacts-button')).click()
  const tab = shell.locator(sel('artifacts-tab-subagents'))
  await expect(tab).toHaveText('Working')
  await tab.click()
  const list = shell.locator(sel('working-list'))
  await expect(list).toContainText('Waiting on you')
  await expect(shell.locator(sel('working-waiting-head'))).toContainText('Waiting on you')
  // Waiting on you is the first group, Running after it.
  const order = await list
    .locator('[data-testid$="-head"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
  expect(order.slice(0, 2)).toEqual(['working-waiting-head', 'working-running-head'])
  const asking = shell.locator(sel('activity-row-session:ask1'))
  await expect(asking).toHaveAttribute('data-state', 'waiting')
  await expect(asking).toContainText('Approve bash: git push origin main')
  await expect(asking).toContainText('Session')
  await expect(asking.locator('.eva-art-owner')).toHaveText('Astra')

  // One row per helper: the Artifacts row, not a second one from the activity list.
  await expect(shell.locator('[data-testid^="artifact-row-subagent:"]')).toHaveCount(1)
  await expect(shell.locator(sel(`activity-row-helper:${HELPER_PATH}`))).toHaveCount(0)
  await expect(
    shell.locator(`${sel(`artifact-row-subagent:${HELPER_PATH}`)} .eva-art-kind`),
  ).toHaveText('Helper')
  await expect(shell.locator(sel(`artifact-row-subagent:${HELPER_PATH}`))).toContainText(
    'Reading the popover',
  )

  // Each kind carries its label and its live intent line; model and cost stay out of the row.
  const canvas = shell.locator(sel('activity-row-canvas:roadmap'))
  await expect(canvas.locator('.eva-art-kind')).toHaveText('Canvas')
  await expect(canvas).toContainText('Astra with Isaac')
  await expect(canvas).not.toContainText('$0.42')
  const session = shell.locator(sel('activity-row-session:aw1'))
  await expect(session.locator('.eva-art-kind')).toHaveText('Session')
  await expect(session).not.toContainText('Opus')
  // Other owners get their own group: the harness nobody owns sits under Other chats.
  const harness = shell.locator(sel('activity-row-harness:w1:p3'))
  await expect(harness.locator('.eva-art-kind')).toHaveText('Harness')
  await expect(list).toContainText('Other chats')
  // What finished is under Finished today, and nothing finished is listed as running.
  await expect(list).toContainText('Finished today')
  await expect(shell.locator(sel('activity-row-harness:w1:p4'))).toHaveAttribute(
    'data-state',
    'done',
  )
  await expect(session).toHaveAttribute('data-state', 'working')

  if (SHOTS !== '') {
    fs.mkdirSync(SHOTS, { recursive: true })
    const popover = shell.locator(sel('artifacts-popover'))
    for (const s of ['dark', 'light'] as const) {
      await shell.keyboard.press('Escape')
      await expect(popover).toHaveCount(0)
      await scheme(shell, s)
      await shell.locator(sel('artifacts-button')).click()
      await expect(session).toBeVisible()
      await shell.screenshot({ path: path.join(SHOTS, `working-${s}.png`) })
    }
  }

  // The run ends on the host: the chip goes and the row moves to Finished today.
  host.setActivity(items('done'))
  await expect(chip('session:aw1')).toHaveCount(0)
  await expect(session).toHaveAttribute('data-state', 'done')
})
