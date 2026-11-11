// Assistants popping into each other's chats (Rooms inside Assistants, slice 3). Nova's thread
// file gets the relay-guest rows the host's consult writes: Penny joins (she shows typing until
// she speaks), says something as a guest bubble, leaves, and her errand becomes one work card that
// runs (orbiting border) and then shows its result in place. The card opens Penny's chat, and its
// follow-up button puts "@Penny " in Nova's composer. Narrow, the result keeps the room and the
// time goes short. Screenshots go to proof/rooms-assistants/s3-*.png.
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT, REPO_ROOT } from './helpers/paths'

const PROOF = path.join(REPO_ROOT, 'proof', 'rooms-assistants')
const THREAD = 'p4-ecard'
const PENNY = { id: 'penny', title: 'Penny', color: '#2f9e44' }

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
          { id: 'nova', title: 'Nova', scope: 'Personal' },
          { id: 'penny', title: 'Penny', scope: 'Errands' },
        ],
      }),
    )
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    await use({ ...fx.launchEnv, EVAOS_EVA_ROOT: evaRoot, EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fx.cleanup()
  },
})
test.use({ startOnChat: false, toolPanes: false, colorScheme: 'dark' })

const sel = (id: string): string => `[data-testid="${id}"]`
const LOG = '[data-testid=chat-pane] [data-testid=chat-log]'
const line = (entry: unknown): string => JSON.stringify(entry)
const guest = (id: string, parent: string, content: string, details: unknown): string =>
  line({
    type: 'custom_message',
    customType: 'relay-guest',
    content,
    display: true,
    details,
    id,
    parentId: parent,
    timestamp: new Date().toISOString(),
  })

type MainGlobal = { __evaosTest: { win: { setContentSize(w: number, h: number): void } } }
const resize = (app: ElectronApplication, w: number, h: number) =>
  app.evaluate(
    (_e, [cw, ch]) => (globalThis as unknown as MainGlobal).__evaosTest.win.setContentSize(cw, ch),
    [w, h] as const,
  )
const shot = async (shell: Page, name: string): Promise<void> => {
  await shell.waitForTimeout(200)
  fs.mkdirSync(PROOF, { recursive: true })
  await shell.screenshot({ path: path.join(PROOF, name) })
}

test('S3 a guest joins, answers as a guest bubble, leaves, and its errand is one work card that opens its chat', async ({
  app,
  shell,
}) => {
  const started = Date.now() - 4_000
  const work = (state: 'working' | 'done', extra: Record<string, unknown> = {}) => ({
    kind: 'work',
    agent: PENNY,
    work: {
      id: 'w1',
      title: 'Find a 2TB USB4 SSD under $200',
      state,
      startedAt: started,
      link: 'agent:penny',
      ...extra,
    },
  })
  await fx.append(
    THREAD,
    line({
      type: 'message',
      id: 'g-u',
      parentId: 'a1',
      message: {
        role: 'user',
        content: '@Penny find a 2TB USB4 SSD under $200',
        attribution: 'user',
        timestamp: started - 1000,
      },
    }),
  )
  await fx.append(
    THREAD,
    guest('g-j', 'g-u', 'Penny joined the chat', { kind: 'join', agent: PENNY }),
  )
  host.upsert({
    id: THREAD,
    status: 'working',
    kind: 'assistant',
    assistant: 'nova',
    title: 'Nova',
  })
  await resize(app, 1280, 900)
  await shell.getByTestId('nav-assistants').click()
  await shell.getByTestId('sidebar-agent-nova').click()
  const log = shell.locator(LOG)
  await expect(log.locator(sel('guest-line'))).toContainText('Penny joined the chat')
  // Isaac's "@Penny ..." is the room's chip in his bubble, the rest plain text.
  const bubble = log.locator('.eva-turn-user .eva-bubble', { hasText: 'find a 2TB USB4 SSD' })
  await expect(bubble.locator('.eva-at-chip')).toHaveText('@Penny')
  await expect(bubble).toContainText('find a 2TB USB4 SSD under $200')
  await bubble.screenshot({ path: path.join(PROOF, 's5-polish-chip.png') })
  // Joined and not spoken yet: Penny is typing.
  await expect(log.locator(`${sel('chat-typing')} [aria-label="Penny is typing"]`)).toBeVisible()

  await fx.append(
    THREAD,
    guest('g-s', 'g-j', "Penny: On it, I'll report back in my chat.", {
      kind: 'say',
      agent: PENNY,
      text: "On it, I'll report back in my chat.",
    }),
  )
  await fx.append(
    THREAD,
    guest('g-l', 'g-s', 'Penny left the chat', { kind: 'leave', agent: PENNY }),
  )
  await fx.append(
    THREAD,
    guest('g-w', 'g-l', 'Penny is working on Find a 2TB USB4 SSD under $200', work('working')),
  )
  host.upsert({ id: THREAD, status: 'idle', kind: 'assistant', assistant: 'nova', title: 'Nova' })
  const say = log.locator(sel('guest-say'))
  await expect(say).toContainText("On it, I'll report back in my chat.")
  await expect(say).toContainText('guest')
  await expect(log.locator(sel('guest-line'))).toHaveText([
    'Penny joined the chat',
    'Penny left the chat',
  ])
  await expect(log.locator(sel('chat-typing'))).toHaveCount(0)
  const card = log.locator(sel('work-card'))
  await expect(card).toHaveCount(1)
  await expect(card).toHaveAttribute('data-state', 'working')
  await expect(card.locator(sel('work-card-line'))).toHaveText('Find a 2TB USB4 SSD under $200')
  // The border orbits while the work runs.
  const orbit = await card.evaluate((el) => getComputedStyle(el, '::after').animationName)
  expect(orbit).toBe('eva-work-orbit')
  await shot(shell, 's3-working.png')
  await card.screenshot({ path: path.join(PROOF, 's3-working-card.png') })

  // Penny finishes: the same card, now with her result line and how long it took.
  await fx.append(
    THREAD,
    guest(
      'g-d',
      'g-w',
      'Penny finished Find a 2TB USB4 SSD under $200: Acasis 40Gbps + WD SN7100 2TB · $189',
      {
        ...work('done', { endedAt: started + 134_000 }),
        text: 'Acasis 40Gbps + WD SN7100 2TB · $189',
      },
    ),
  )
  await expect(card).toHaveAttribute('data-state', 'done')
  await expect(log.locator(sel('work-card'))).toHaveCount(1)
  await expect(card.locator(sel('work-card-line'))).toHaveText(
    'Acasis 40Gbps + WD SN7100 2TB · $189',
  )
  await expect(card.locator(sel('work-card-time'))).toContainText('2m 14s')
  await card.hover()
  const ask = card.locator(sel('work-card-ask'))
  await expect(ask).toBeVisible()
  await shot(shell, 's3-done.png')
  await card.screenshot({ path: path.join(PROOF, 's3-done-card.png') })

  // Narrow (a chat in a thin pane): the result line keeps its room; the time goes short, then goes.
  const narrow = async (px: number): Promise<void> => {
    await card.evaluate((el, w) => ((el as HTMLElement).style.width = `${w}px`), px)
    await card.screenshot({ path: path.join(PROOF, `s3-done-${px}.png`) })
  }
  await narrow(300)
  await expect(card.locator('.eva-work-time-short')).toBeVisible()
  await expect(card.locator('.eva-work-time-full')).toBeHidden()
  await expect(card.locator(sel('work-card-line'))).toBeVisible()
  await narrow(230)
  await expect(card.locator(sel('work-card-time'))).toBeHidden()
  await expect(card.locator(sel('work-card-line'))).toBeVisible()
  await card.evaluate((el) => ((el as HTMLElement).style.width = ''))

  // The follow-up puts "@Penny " in Nova's composer.
  await card.hover()
  await ask.click()
  await expect(shell.locator(sel('composer-input'))).toHaveValue('@Penny ')

  // The row opens Penny's chat.
  await card.click()
  await expect(shell.locator(sel('breadcrumb-agent'))).toHaveText('Penny')
})
