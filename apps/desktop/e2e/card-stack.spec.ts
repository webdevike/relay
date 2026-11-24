// The card stack on the composer of an assistant's thread, against the fake host: its open asks
// (questions first, oldest in front) then the sessions it runs (a clock, the provider's logo and
// the model, the recent work, Open session). Collapsed it is an inset tab with a sliver behind it;
// open it grows up into the front card with dots under it. CARD_STACK_PROOF=<dir> writes light and
// dark screenshots of each state there.
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT } from './helpers/paths'

const PROOF = process.env.CARD_STACK_PROOF ?? ''
const AGENT = 'nova'

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
      JSON.stringify({ agents: [{ id: AGENT, title: 'Nova', scope: 'Work', avatar: 'nova-1' }] }),
    )
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    await use({ ...fx.launchEnv, EVAOS_EVA_ROOT: evaRoot, EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fx.cleanup()
  },
})
test.use({ startOnChat: false, toolPanes: false })

const sel = (id: string): string => `[data-testid="${id}"]`

type MainGlobal = { __evaosTest: { win: { setContentSize(w: number, h: number): void } } }
type ShellHooks = { __evaosShell: { setAppearance(a: 'light' | 'dark'): void } }

const T0 = Date.now() - 60 * 60_000
const ASKS = [
  {
    id: 'a1b2c3d4',
    source: 'replies',
    label: 'Which drone design?',
    question: 'I compared three airframes for the Bug Bux spray run.',
    replies: ['Quad frame', 'Hex frame', 'Fixed wing hybrid'],
    at: T0,
  },
  {
    id: 'e5f6a7b8',
    source: 'replies',
    label: 'Publish the OTA?',
    question: 'Build 4.12.0 passed all 38 checks. It reaches about 1,200 devices.',
    replies: ['Publish now', 'Hold'],
    at: T0 + 60_000,
  },
]
const run = (id: string, over: Record<string, unknown>) => ({
  id: `session:${id}`,
  kind: 'session',
  owner: `assistant:${AGENT}`,
  status: 'working',
  updatedAt: Date.now(),
  open: { to: 'chat', thread: `session:${id}`, session: id },
  ...over,
})
const RUNS = [
  run('guardian', {
    title: 'Workshop look on rigged Guardian',
    intent: 'Comparing shot 4 against the reference frame',
    startedAt: Date.now() - 35 * 60_000 - 12_000,
    model: 'Claude Opus 5.5',
    vendor: 'anthropic',
    thinking: 'high',
    log: [
      'Imported the rigged Guardian into the workshop scene',
      'Matched the key light to the Tiny Glade reference',
      'Rim light pass done, 4 of 6 shots rendered',
      'Comparing shot 4 against the reference frame',
    ],
  }),
  run('waterfall', {
    title: 'Solstice waterfall options',
    intent: 'Variant 2 rendered, starting the lighting pass',
    startedAt: Date.now() - 12 * 60_000 - 30_000,
    model: 'GPT-5',
    vendor: 'openai',
    thinking: 'high',
    log: [
      'Blocked out three waterfall silhouettes',
      'Variant 1 rendered with mist and spray',
      'Variant 2 rendered, starting the lighting pass',
    ],
  }),
]

async function openThread(app: ElectronApplication, shell: Page): Promise<void> {
  await app.evaluate(
    (_e, [w, h]) => (globalThis as unknown as MainGlobal).__evaosTest.win.setContentSize(w, h),
    [1200, 800] as const,
  )
  host.setAsks(AGENT, ASKS)
  host.upsert({
    id: 'p4-ecard',
    status: 'idle',
    kind: 'assistant',
    assistant: AGENT,
    title: 'Nova',
  })
  await shell.getByTestId('nav-assistants').click()
  await shell.getByTestId(`sidebar-agent-${AGENT}`).click()
  await expect(shell.locator(sel('chat-log'))).toBeVisible()
}

async function shots(shell: Page, name: string): Promise<void> {
  if (PROOF === '') return
  fs.mkdirSync(PROOF, { recursive: true })
  for (const s of ['light', 'dark'] as const) {
    await shell.evaluate((v) => (window as unknown as ShellHooks).__evaosShell.setAppearance(v), s)
    await expect(shell.locator('html')).toHaveAttribute('data-resolved', s)
    await shell.waitForTimeout(150)
    await shell.screenshot({ path: path.join(PROOF, `${name}-${s}.png`) })
  }
}

test('the card stack: questions then running sessions, a tab that opens into the front card', async ({
  app,
  shell,
}) => {
  await openThread(app, shell)
  const stack = shell.locator(sel('card-stack'))
  const tab = shell.locator(sel('card-stack-tab'))

  // Questions only: the oldest in front, its label on the tab, a sliver for the next, no count.
  await expect(stack).toHaveAttribute('data-front', 'ask:a1b2c3d4')
  await expect(tab).toHaveText('Which drone design?')
  await expect(shell.locator(sel('card-stack-peek'))).toBeVisible()
  await expect(stack).not.toContainText(/\d+ of \d+/)

  // The running sessions join after the questions.
  host.setActivity(RUNS)
  await tab.click()
  await expect(stack).toHaveAttribute('data-state', 'expanded')
  const dots = shell.locator(sel('card-stack-dot'))
  await expect(dots).toHaveCount(4)
  expect(await dots.evaluateAll((els) => els.map((e) => e.dataset['cardId']))).toEqual([
    'ask:a1b2c3d4',
    'ask:e5f6a7b8',
    'run:session:guardian',
    'run:session:waterfall',
  ])
  // Open: title and collapse only in the header; the detail, the options and a typed answer.
  const head = shell.locator('.eva-stack-head')
  await expect(head.getByRole('button')).toHaveCount(1)
  await expect(head.getByRole('button')).toHaveAccessibleName('Collapse')
  const card = shell.locator(sel('card-stack-card'))
  await expect(card).toContainText('I compared three airframes for the Bug Bux spray run.')
  await expect(card.getByRole('button', { name: 'Hex frame' })).toBeVisible()
  await expect(card.getByRole('textbox', { name: 'Or type an answer' })).toBeVisible()
  // The active dot is the wider pill.
  const widths = await dots.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width))
  expect(widths).toEqual([16, 6, 6, 6])
  await shell.mouse.move(5, 5)
  await shots(shell, '01-question-open')

  // Two answers sit side by side.
  await dots.nth(1).click()
  await expect(shell.locator(sel('card-stack-title'))).toHaveText('Publish the OTA?')
  await expect(card.getByRole('button', { name: 'Publish now' })).toBeVisible()
  await shots(shell, '02-question-two-answers-open')

  // Collapsed on a question: the tab and its sliver.
  await shell.locator(sel('card-stack-collapse')).click()
  await expect(stack).toHaveAttribute('data-state', 'collapsed')
  await expect(tab).toHaveText('Publish the OTA?')
  await shots(shell, '03-question-tab-collapsed')

  // A running card: its clock, the provider's logo and the model, the recent work, Open session.
  await tab.click()
  await dots.nth(2).click()
  await expect(shell.locator(sel('card-stack-title'))).toHaveText(
    'Workshop look on rigged Guardian',
  )
  await expect(shell.locator(sel('card-stack-timer'))).toHaveText(/^35m \d\ds$/)
  await expect(shell.locator(sel('card-stack-model'))).toHaveText('Opus 5.5 high')
  await expect(
    shell.locator(sel('card-stack-model')).locator('img[data-vendor="anthropic"]'),
  ).toBeVisible()
  await expect(shell.locator(sel('card-stack-log')).locator('div')).toHaveCount(4)
  await expect(shell.locator(sel('card-stack-open-session'))).toBeVisible()
  await expect(shell.locator('[role=progressbar]')).toHaveCount(0)
  await shell.mouse.move(5, 5)
  await shots(shell, '04-running-open')

  // The OpenAI one: its mark beside the model.
  await shell.keyboard.press('ArrowRight')
  await expect(shell.locator(sel('card-stack-title'))).toHaveText('Solstice waterfall options')
  await expect(
    shell.locator(sel('card-stack-model')).locator('img[data-vendor="openai"]'),
  ).toBeVisible()
  await expect(shell.locator(sel('card-stack-model'))).toHaveText('GPT-5 high')
  await shots(shell, '05-running-openai-open')

  // Esc folds it: the running tab is its title and a quiet Open session link.
  await shell.keyboard.press('Escape')
  await expect(stack).toHaveAttribute('data-state', 'collapsed')
  await expect(tab).toHaveText('Solstice waterfall options')
  await expect(shell.locator(sel('card-stack-open-link'))).toHaveText('Open session')
  await shots(shell, '06-running-tab-collapsed')

  // A click outside folds the open card too.
  await tab.click()
  await shell.locator(sel('chat-log')).click({ position: { x: 20, y: 20 } })
  await expect(stack).toHaveAttribute('data-state', 'collapsed')

  // Answering the front question resolves it on the host; the stack moves on.
  await tab.click()
  await dots.first().click()
  await card.getByRole('button', { name: 'Hex frame' }).click()
  await expect.poll(() => host.openAsks(AGENT).map((a) => a.id)).toEqual(['e5f6a7b8'])
  await expect(dots).toHaveCount(3)

  // Nothing waiting or running: no tab at all.
  host.setAsks(AGENT, [])
  host.setActivity([])
  await expect(stack).toHaveCount(0)
})
