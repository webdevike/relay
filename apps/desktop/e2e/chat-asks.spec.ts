// Open asks on desktop: the questions an assistant thread's host still waits on Isaac for (the
// phone's badges: `assistant.snapshot` asks). They live in the turn rail only: a turn holding one
// wears a ring on its tick (the card tells the question and can dismiss it), a click on the tick
// jumps to the bubble (it flashes, then keeps a thin accent edge and a "Waiting on you" tag with a
// dismiss x), the filter's Open asks keeps only those turns, asks with no bubble sit in one entry
// at the end of the rail, and answering or dismissing (or the host resolving it) clears it live.
// No badge line above the composer: the open asks are the question cards on the composer (the
// card stack), which stay when a chat too narrow for the rail beside its text hides the rail.
// Saves screenshots to proof/asks-rail/ (EVAOS_PROOF=1).
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

const OUT = path.join(REPO_ROOT, 'proof', 'asks-rail')
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
  const tmp = await proofShot(app, shell, name, { phase: 'asks-rail' })
  fs.mkdirSync(OUT, { recursive: true })
  fs.copyFileSync(tmp, path.join(OUT, `${name}.png`))
  fs.rmSync(tmp, { force: true })
}

const ticks = (shell: Page) => shell.locator(`${sel('turn-minimap')} ${sel('turn-tick')}`)
const waitingTicks = (shell: Page) =>
  shell.locator(`${sel('turn-minimap')} ${sel('turn-tick')}[data-waiting="true"]`)
const loose = (shell: Page) => shell.locator(sel('turn-tick-loose'))
const row = (shell: Page, id: string) => shell.locator(`[data-testid="msg-${id}"]`)

test('open asks live in the rail: ring, filter, tick click jumps, dismiss from card and tag, session asks at the end', async ({
  app,
  shell,
}) => {
  test.setTimeout(180_000)
  await openChat(app, shell)
  const total = await ticks(shell).count()
  // The badge line above the composer is gone; the asks are the stack's cards, oldest in front.
  await expect(shell.locator(sel('ask-badges'))).toHaveCount(0)
  await expect(shell.locator(sel('ask-badge'))).toHaveCount(0)
  await expect(shell.locator(sel('card-stack'))).toHaveAttribute('data-front', 'ask:a1b2c3d4')
  await expect(shell.locator(sel('card-stack-tab'))).toHaveText('Push to prod?')

  // 1. Each turn holding an open ask wears a ring on its tick; the card tells the question.
  await expect(waitingTicks(shell)).toHaveCount(2)
  await expect(waitingTicks(shell).first().locator('.eva-tm-wait')).toBeVisible()
  await waitingTicks(shell).first().hover()
  await expect(shell.locator(sel('turn-card-asked'))).toContainText(FIRST_Q)
  await expect(shell.locator(sel('turn-card-dismiss'))).toBeVisible()
  await shot(app, shell, 'tick-mark-and-card')
  await shell.mouse.move(900, 400)
  await expect(shell.locator(sel('turn-card'))).toHaveCount(0)

  // 2. The filter's Open asks keeps only those turns.
  await shell.locator(sel('turn-minimap-filter')).click()
  await expect(shell.locator(sel('turn-minimap-show-asks'))).toBeVisible()
  await shot(app, shell, 'filter-menu')
  await shell.locator(sel('turn-minimap-show-asks')).click()
  await expect(ticks(shell)).toHaveCount(2)
  await shot(app, shell, 'filter-open-asks')
  await shell.locator(sel('turn-minimap-filter')).click()
  await shell.locator(sel('turn-minimap-show-all')).click()
  await expect(ticks(shell)).toHaveCount(total)

  // 3. A click on a ringed tick scrolls to the asking bubble, flashes it, then it keeps an edge,
  // a tag and its chips.
  await expect(row(shell, 'ask1a')).toHaveCount(0)
  await waitingTicks(shell).first().click()
  await expect(row(shell, 'ask1a')).toBeVisible()
  await expect(row(shell, 'ask1a')).toHaveAttribute('data-waiting', 'true')
  await expect(row(shell, 'ask1a').locator(sel('waiting-tag'))).toHaveText('Waiting on you')
  await expect(row(shell, 'ask1a').locator(sel('reply-chips'))).toBeVisible()
  await shot(app, shell, 'jumped-bubble-waiting')
  await expect(row(shell, 'ask1a')).not.toHaveAttribute('data-flash', 'true', { timeout: 5000 })
  await expect(row(shell, 'ask1a')).toHaveAttribute('data-waiting', 'true')
  await expect(row(shell, 'ask2a')).toHaveCount(0)

  // 4. Picking the question in the hover card jumps there too.
  await waitingTicks(shell).last().hover()
  await shell.locator(sel('turn-card-asked')).getByRole('button').click()
  await expect(row(shell, 'ask2a')).toBeVisible()

  // 5. Tapping a reply chip answers: the ask closes on the host and clears here at once.
  await row(shell, 'ask2a').locator(sel('reply-chips')).getByText('Not yet').click()
  await expect(row(shell, 'ask2a')).not.toHaveAttribute('data-waiting', 'true')
  await expect(waitingTicks(shell)).toHaveCount(1)
  await expect.poll(() => host.openAsks(AGENT).map((a) => a.id)).toEqual(['a1b2c3d4'])
  expect(host.commands.find((c) => c.cmd.kind === 'assistant.ask.resolve')?.cmd).toMatchObject({
    agent: AGENT,
    id: 'e5f6a7b8',
    how: 'answered',
    answer: 'Not yet',
  })

  // 6. Dismiss from the waiting bubble's tag: no answer, the host's resolve, the ring goes.
  await waitingTicks(shell).first().click()
  await expect(row(shell, 'ask1a')).toBeVisible()
  await shot(app, shell, 'tag-dismiss')
  await row(shell, 'ask1a').locator(sel('waiting-dismiss')).click()
  await expect(row(shell, 'ask1a')).not.toHaveAttribute('data-waiting', 'true')
  await expect(waitingTicks(shell)).toHaveCount(0)
  await expect.poll(() => host.openAsks(AGENT)).toEqual([])
  expect(host.commands.at(-1)?.cmd).toMatchObject({
    kind: 'assistant.ask.resolve',
    id: 'a1b2c3d4',
    how: 'dismissed',
  })

  // 7. Dismiss from the tick's hover card.
  host.setAsks(AGENT, [OPEN[1]!])
  await expect(waitingTicks(shell)).toHaveCount(1)
  await waitingTicks(shell).first().hover()
  await shell.locator(sel('turn-card-dismiss')).click()
  await expect(waitingTicks(shell)).toHaveCount(0)
  await expect.poll(() => host.openAsks(AGENT)).toEqual([])
  expect(host.commands.at(-1)?.cmd).toMatchObject({
    kind: 'assistant.ask.resolve',
    id: 'e5f6a7b8',
    how: 'dismissed',
  })

  // 8. Another session's question has no bubble: an entry at the end of the rail, with answers.
  host.setAsks(AGENT, [
    {
      id: '0a0b0c0d',
      source: 'session',
      label: 'Golf: merge it?',
      question: 'The PR is green. Merge it?',
      replies: ['Merge', 'Hold'],
      at: SECOND_AT + 1000,
      from: 'Golf',
    },
  ])
  await expect(loose(shell)).toBeVisible()
  await expect(waitingTicks(shell)).toHaveCount(0)
  await expect(shell.locator(sel('waiting-tag'))).toHaveCount(0)
  await loose(shell).hover()
  await expect(shell.locator(sel('turn-card'))).toContainText('Merge it?')
  await shot(app, shell, 'session-ask-rail')
  await shell.locator(sel('turn-card')).getByRole('button', { name: 'Merge', exact: true }).click()
  await expect(loose(shell)).toHaveCount(0)
  expect(host.commands.at(-1)?.cmd).toMatchObject({
    kind: 'assistant.ask.resolve',
    id: '0a0b0c0d',
    how: 'answered',
    answer: 'Merge',
  })
  await expect(shell.locator(sel('ask-badge'))).toHaveCount(0)
})

/** Rightmost edge of the turn rail and leftmost edge of the message text on screen, px; null when the rail is hidden. */
const railAndText = (shell: Page) =>
  shell.evaluate((log) => {
    const rail = document.querySelector(`${log} [data-testid="turn-minimap"]`)
    const left = Math.min(
      ...[...document.querySelectorAll(`${log} .eva-row-inner`)].map(
        (el) => el.getBoundingClientRect().left,
      ),
    )
    if (rail === null) return { rail: null, text: left }
    // The rail's own box is pointer-transparent and wider than its ticks: measure what it draws.
    const drawn = [...rail.querySelectorAll('.eva-tm-bar, .eva-tm-wait, .eva-tm-filter')]
    return { rail: Math.max(...drawn.map((el) => el.getBoundingClientRect().right)), text: left }
  }, LOG)

test('the rail never sits on the text: a narrow chat hides it, and the asks stay cards on the composer', async ({
  app,
  shell,
}) => {
  test.setTimeout(180_000)
  await openChat(app, shell)
  const stack = shell.locator(sel('card-stack'))
  const tab = shell.locator(sel('card-stack-tab'))

  // Wide: the rail is beside the text.
  await expect(waitingTicks(shell)).toHaveCount(2)
  const wide = await railAndText(shell)
  expect(wide.rail).not.toBeNull()
  expect(wide.rail!).toBeLessThan(wide.text)

  // Every width down to a narrow window: either the rail clears the text or it is gone.
  for (const w of [1500, 1300, 1150, 1050, 950, 850, 760]) {
    await resize(app, w, 1000)
    await shell.waitForTimeout(150)
    const at = await railAndText(shell)
    if (at.rail !== null) expect(at.rail, `rail overlaps the text at ${w}px`).toBeLessThan(at.text)
  }
  await expect(shell.locator(sel('turn-minimap'))).toHaveCount(0)

  // The asks are still the cards on the composer: the oldest in front, a sliver for the next one,
  // no count.
  await expect(stack).toHaveAttribute('data-front', 'ask:a1b2c3d4')
  await expect(tab).toHaveText('Push to prod?')
  await expect(shell.locator(sel('card-stack-peek'))).toBeVisible()
  await shot(app, shell, 'narrow-ask-tab')

  // Open: the question under its label, its two answers side by side, a typed answer, two dots.
  await tab.click()
  await expect(stack).toHaveAttribute('data-state', 'expanded')
  const card = shell.locator(sel('card-stack-card'))
  await expect(card).toContainText(FIRST_Q)
  await expect(card.getByRole('button', { name: 'Yes, push it' })).toBeVisible()
  await expect(card.getByRole('textbox', { name: 'Or type an answer' })).toBeVisible()
  await expect(shell.locator(sel('card-stack-dot'))).toHaveCount(2)
  await shot(app, shell, 'narrow-ask-card-open')

  // Answering sends Isaac's turn naming the question and resolves the ask; the next card shows.
  await card.getByRole('button', { name: 'Not yet' }).click()
  await expect.poll(() => host.openAsks(AGENT).map((a) => a.id)).toEqual(['e5f6a7b8'])
  expect(
    host.commands.find((c) => c.cmd.kind === 'assistant.ask.resolve' && c.cmd.id === 'a1b2c3d4')
      ?.cmd,
  ).toMatchObject({ how: 'answered', answer: 'Not yet' })
  // Isaac's turn goes out through Relay, tagged with the question it answers.
  await expect
    .poll(() =>
      host.commands.some(
        (c) =>
          c.cmd.kind !== 'assistant.ask.resolve' &&
          JSON.stringify(c.cmd).includes('[answer to: \\"') &&
          JSON.stringify(c.cmd).includes('] Not yet'),
      ),
    )
    .toBe(true)
  await expect(stack).toHaveAttribute('data-front', 'ask:e5f6a7b8')

  // Collapsed, the tab's x dismisses the last one: no answer, the host's resolve, no tab.
  await shell.locator(sel('card-stack-collapse')).click()
  await expect(stack).toHaveAttribute('data-state', 'collapsed')
  await tab.hover()
  await shell.locator(sel('card-stack-dismiss')).click()
  await expect.poll(() => host.openAsks(AGENT)).toEqual([])
  expect(host.commands.at(-1)?.cmd).toMatchObject({
    kind: 'assistant.ask.resolve',
    id: 'e5f6a7b8',
    how: 'dismissed',
  })
  await expect(stack).toHaveCount(0)

  // Wide again: the rail is back, with no ring left.
  await resize(app, 1900, 1000)
  await expect(shell.locator(sel('turn-minimap'))).toBeVisible()
  await expect(waitingTicks(shell)).toHaveCount(0)
})
