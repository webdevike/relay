// Open asks on desktop: the questions an assistant thread's host still waits on Isaac for (the
// phone's badges: `assistant.snapshot` asks). A turn holding one wears a ring on its navigator tick
// (the card tells the question), the filter's Open asks keeps only those turns, a quiet line above
// the composer counts them with the oldest one's label, a click jumps to the bubble (it flashes,
// then keeps a thin accent edge and a "Waiting on you" tag), the arrows step to the next, and
// answering (a reply chip, or the host resolving it) clears it live. Saves screenshots to
// proof/desktop-asks/ (EVAOS_PROOF=1).
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   EVAOS_PROOF=1 pnpm -C apps/desktop exec playwright test e2e/chat-asks.spec.ts
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT, REPO_ROOT } from './helpers/paths'
import { proofShot } from './helpers/proofShot'

const OUT = path.join(REPO_ROOT, 'proof', 'desktop-asks')
const T0 = 1792486874000
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
test.use({ startOnChat: false, reducedMotion: 'reduce', toolPanes: false })

const sel = (id: string): string => `[data-testid="${id}"]`
const line = (entry: unknown): string => JSON.stringify(entry)
const LOG = '[data-testid=chat-pane] [data-testid=chat-log]'

type MainGlobal = {
  __evaosTest: { win: { setContentSize(w: number, h: number): void } }
}
const resize = (app: ElectronApplication, w: number, h: number) =>
  app.evaluate(
    (_e, [cw, ch]) => (globalThis as unknown as MainGlobal).__evaosTest.win.setContentSize(cw, ch),
    [w, h] as const,
  )

const prompt = (id: string, parent: string | null, text: string, at: number): string =>
  line({
    type: 'message',
    id,
    parentId: parent,
    message: { role: 'user', content: text, attribution: 'user', timestamp: at },
  })
const reply = (id: string, parent: string, text: string, at: number): string =>
  line({
    type: 'message',
    id,
    parentId: parent,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      stopReason: 'stop',
      timestamp: at,
    },
  })

const FILLER =
  'Filler answer. A few lines of text so the log scrolls a good way.\n\nSecond paragraph, still nothing to flag here, just height.'
const FIRST_Q = 'The branch is green. Push it to prod?'
const SECOND_Q = 'The importer is drafted. Start on the exporter next?'
const FIRST_AT = T0 + 3 * 20_000 + 5000
const SECOND_AT = T0 + 15 * 20_000 + 5000

const ask = (id: string, label: string, question: string, messageId: string, at: number) => ({
  id,
  source: 'replies',
  label,
  question,
  replies: ['Yes, push it', 'Not yet'],
  at,
  messageId,
})
const OPEN = [
  ask('a1b2c3d4', 'Push to prod?', FIRST_Q, 'ask1a', FIRST_AT),
  ask('e5f6a7b8', 'Exporter next?', SECOND_Q, 'ask2a', SECOND_AT),
]

async function openChat(app: ElectronApplication, shell: Page): Promise<void> {
  let parent = 'a1'
  let at = T0
  const turn = async (id: string, q: string, a: string): Promise<void> => {
    await fx.append('p4-ecard', prompt(`${id}u`, parent, q, at))
    await fx.append('p4-ecard', reply(`${id}a`, `${id}u`, a, at + 5000))
    parent = `${id}a`
    at += 20_000
  }
  for (let i = 0; i < 3; i++) await turn(`f${i}`, `Filler question ${i}`, FILLER)
  await turn('ask1', 'Is the branch ready?', `${FIRST_Q}\n\n[[replies: Yes, push it | Not yet]]`)
  for (let i = 3; i < 14; i++) await turn(`f${i}`, `Filler question ${i}`, FILLER)
  await turn('ask2', 'Draft the importer', `${SECOND_Q}\n\n[[replies: Yes, push it | Not yet]]`)
  for (let i = 14; i < 17; i++) await turn(`f${i}`, `Filler question ${i}`, FILLER)
  host.setAsks(AGENT, OPEN)
  host.upsert({
    id: 'p4-ecard',
    status: 'idle',
    kind: 'assistant',
    assistant: AGENT,
    title: 'Nova',
  })
  await resize(app, 1900, 1000)
  await shell.getByTestId('nav-assistants').click()
  await shell.getByTestId(`sidebar-agent-${AGENT}`).click()
  await expect(shell.locator(LOG)).toContainText('Filler question 16')
}

async function shot(app: ElectronApplication, shell: Page, name: string): Promise<void> {
  await shell.waitForTimeout(150)
  const tmp = await proofShot(app, shell, name, { phase: 'desktop-asks' })
  fs.mkdirSync(OUT, { recursive: true })
  fs.copyFileSync(tmp, path.join(OUT, `${name}.png`))
  fs.rmSync(tmp, { force: true })
}

const ticks = (shell: Page) => shell.locator(`${sel('turn-minimap')} ${sel('turn-tick')}`)
const waitingTicks = (shell: Page) =>
  shell.locator(`${sel('turn-minimap')} ${sel('turn-tick')}[data-waiting="true"]`)
const badge = (shell: Page) => shell.locator(sel('ask-badge'))
const row = (shell: Page, id: string) => shell.locator(`[data-testid="msg-${id}"]`)

test('open asks: tick marks, the Open asks filter, the badge line that jumps and cycles, answering clears', async ({
  app,
  shell,
}) => {
  test.setTimeout(180_000)
  await openChat(app, shell)
  const total = await ticks(shell).count()

  // 1. Each turn holding an open ask wears a ring on its tick; the card tells the question.
  await expect(waitingTicks(shell)).toHaveCount(2)
  await expect(waitingTicks(shell).first().locator('.eva-tm-wait')).toBeVisible()
  await waitingTicks(shell).first().hover()
  await expect(shell.locator(sel('turn-card-asked'))).toContainText(FIRST_Q)
  await shot(app, shell, 'tick-mark-and-card')
  await shell.mouse.move(900, 400)
  await expect(shell.locator(sel('turn-card'))).toHaveCount(0)

  // 2. The filter's Open asks keeps only those turns.
  await shell.locator(sel('turn-minimap-filter')).click()
  await expect(shell.locator(sel('turn-minimap-show-asks'))).toBeVisible()
  await shot(app, shell, 'filter-menu')
  await shell.locator(sel('turn-minimap-show-asks')).click()
  await expect(ticks(shell)).toHaveCount(2)
  await shell.locator(sel('turn-minimap-filter')).click()
  await shell.locator(sel('turn-minimap-show-all')).click()
  await expect(ticks(shell)).toHaveCount(total)

  // 3. The line above the composer: the count and the oldest question's label.
  await expect(badge(shell)).toContainText('2 waiting')
  await expect(shell.locator(sel('ask-badge-label'))).toHaveText('Push to prod?')
  await shot(app, shell, 'badge-line')

  // 4. A click scrolls to the asking bubble, flashes it, then it keeps an edge and a tag.
  await expect(row(shell, 'ask1a')).toHaveCount(0)
  await badge(shell).click()
  await expect(row(shell, 'ask1a')).toBeVisible()
  await expect(row(shell, 'ask1a')).toHaveAttribute('data-waiting', 'true')
  await expect(row(shell, 'ask1a').locator(sel('waiting-tag'))).toHaveText('Waiting on you')
  await expect(row(shell, 'ask1a').locator(sel('reply-chips'))).toBeVisible()
  await shot(app, shell, 'jumped-bubble-waiting')
  // The flash is brief; the edge stays.
  await expect(row(shell, 'ask1a')).not.toHaveAttribute('data-flash', 'true', { timeout: 5000 })
  await expect(row(shell, 'ask1a')).toHaveAttribute('data-waiting', 'true')
  // The newest reply is not the asking bubble of the oldest ask: the other one keeps its mark too.
  await expect(row(shell, 'ask2a')).toHaveCount(0)

  // 5. The arrow steps to the next ask; its click jumps there.
  await shell.locator(sel('ask-next')).click()
  await expect(shell.locator(sel('ask-badge-label'))).toHaveText('Exporter next?')
  await badge(shell).click()
  await expect(row(shell, 'ask2a')).toBeVisible()
  await expect(row(shell, 'ask2a')).toHaveAttribute('data-waiting', 'true')

  // 6. Tapping a reply chip answers: the ask closes on the host and clears here at once.
  await row(shell, 'ask2a').locator(sel('reply-chips')).getByText('Not yet').click()
  await expect(row(shell, 'ask2a')).not.toHaveAttribute('data-waiting', 'true')
  await expect(badge(shell)).toContainText('1 waiting')
  await expect(waitingTicks(shell)).toHaveCount(1)
  await expect.poll(() => host.openAsks(AGENT).map((a) => a.id)).toEqual(['a1b2c3d4'])
  expect(host.commands.find((c) => c.cmd.kind === 'assistant.ask.resolve')?.cmd).toMatchObject({
    agent: AGENT,
    id: 'e5f6a7b8',
    how: 'answered',
    answer: 'Not yet',
  })
  await shot(app, shell, 'answered-one-left')

  // 7. The host resolving the last one (the assistant, or the phone) clears the line and the mark.
  host.setAsks(AGENT, [])
  await expect(badge(shell)).toHaveCount(0)
  await expect(waitingTicks(shell)).toHaveCount(0)
  await expect(shell.locator('[data-waiting="true"]').locator('visible=true')).toHaveCount(0)

  // A new ask arrives live.
  host.setAsks(AGENT, [OPEN[1]!])
  await expect(badge(shell)).toContainText('1 waiting')
  await expect(waitingTicks(shell)).toHaveCount(1)

  // Another session's question has no bubble: the line opens a small card with its answers, and
  // an answer there reaches the host only.
  host.setAsks(AGENT, [
    {
      id: '0a0b0c0d',
      source: 'session',
      label: 'Golf: merge it?',
      question: 'Golf: the PR is green. Merge it?',
      replies: ['Merge', 'Hold'],
      at: SECOND_AT + 1000,
      from: 'Golf',
    },
  ])
  await expect(shell.locator(sel('ask-badge-label'))).toHaveText('Golf: merge it?')
  await badge(shell).click()
  await expect(shell.locator(sel('ask-card'))).toContainText('Merge it?')
  await shot(app, shell, 'session-ask-card')
  await shell.locator(sel('ask-card')).getByRole('button', { name: 'Merge' }).click()
  await expect(badge(shell)).toHaveCount(0)
  expect(host.commands.at(-1)?.cmd).toMatchObject({
    kind: 'assistant.ask.resolve',
    id: '0a0b0c0d',
    how: 'answered',
    answer: 'Merge',
  })
})
