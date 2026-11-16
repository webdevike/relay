// Specialist agents in a chat: Nova asks the web researcher through the relay MCP server's
// agents_ask (omp's xd device write to xd://mcp__relay_agents_ask). While the call is out, a teal
// rosette sits in the left margin and a muted caption under the turn ticks ("Web researcher is on
// it · 0:12"); once the research is back and Nova replies, the caption moves under her reply
// ("Answered with Web researcher · 29s · 2 sources") and a click opens the request, the answer
// and its verified sources. Saves screenshots to proof/agents-caption/ (EVAOS_PROOF=1).
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   EVAOS_PROOF=1 pnpm -C apps/desktop exec playwright test e2e/agents-caption.spec.ts
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { APP_DIR, EVA_FIXTURE_ROOT, REPO_ROOT } from './helpers/paths'

const PROOF =
  process.env.EVAOS_PROOF === '1'
    ? path.join(REPO_ROOT, 'proof', 'agents-caption')
    : path.join(APP_DIR, 'test-results/proof/agents-caption')
const THREAD = 'p4-ecard'

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
      JSON.stringify({ agents: [{ id: 'nova', title: 'Nova', scope: 'Personal' }] }),
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

const QUESTION = 'Which 2TB USB4 SSD under $200 has the best sustained write speed?'
const REQUEST = { question: QUESTION, depth: 'quick' }
const RESEARCH = {
  run: '6f1c2d3e-0000-4000-8000-000000000001',
  agent: 'web-researcher',
  status: 'done',
  request: REQUEST,
  reply: {
    answer:
      'The Acasis 40Gbps enclosure with a WD SN7100 2TB holds about 3 GB/s sustained writes for $189.',
    citations: [
      {
        url: 'https://www.tomshardware.com/reviews/acasis-usb4-enclosure',
        quote: 'sustained writes held near 3 GB/s across the full 2TB',
        verified: true,
        checked: 'page',
        via: 'read',
      },
      {
        url: 'https://www.westerndigital.com/products/sn7100',
        quote: 'WD_BLACK SN7100 2TB',
        verified: true,
        checked: 'page',
        via: 'read',
      },
    ],
    model: 'fast',
    toolCalls: 4,
  },
  text: 'The Acasis 40Gbps enclosure with a WD SN7100 2TB holds about 3 GB/s sustained writes for $189.',
  requestedAt: new Date(Date.now() - 30_000).toISOString(),
  seconds: 29.4,
  cost: 0.004,
}

test('a specialist run shows a margin badge and a ticking caption, then the done caption under the reply that opens its sources', async ({
  app,
  shell,
}) => {
  const asked = Date.now() - 12_000
  await fx.append(
    THREAD,
    line({
      type: 'message',
      id: 'ag-u',
      parentId: 'a1',
      message: { role: 'user', content: QUESTION, attribution: 'user', timestamp: asked - 2000 },
    }),
  )
  await fx.append(
    THREAD,
    line({
      type: 'message',
      id: 'ag-c',
      parentId: 'ag-u',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'toolu_agents1',
            name: 'write',
            arguments: {
              path: 'xd://mcp__relay_agents_ask',
              i: 'Asking the web researcher',
              content: JSON.stringify({ agent: 'web-researcher', request: REQUEST }),
            },
          },
        ],
        stopReason: 'toolUse',
        timestamp: asked,
      },
    }),
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

  // While the call is out: the rosette in the margin, tinted, and the clock ticking.
  const caption = log.locator(sel('agents-caption'))
  await expect(caption).toHaveCount(1)
  await expect(caption).toHaveAttribute('data-state', 'running')
  const text = caption.locator(sel('agents-caption-line'))
  await expect(text).toHaveText(/^Web researcher is on it · 0:\d\d$/)
  const first = await text.textContent()
  await expect(text).not.toHaveText(first ?? '', { timeout: 3000 })
  const badge = caption.locator(sel('agents-badge'))
  await expect(badge).toBeVisible()
  // The badge sits left of the turn's column.
  const inner = await caption.evaluate(
    (el) => el.closest('.eva-row-inner')!.getBoundingClientRect().left,
  )
  const badgeBox = (await badge.boundingBox())!
  expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(inner)
  await shot(shell, 'running.png')

  // The research comes back and Nova replies: one caption, now under her reply.
  await fx.append(
    THREAD,
    line({
      type: 'message',
      id: 'ag-r',
      parentId: 'ag-c',
      message: {
        role: 'toolResult',
        toolCallId: 'toolu_agents1',
        toolName: 'write',
        content: [{ type: 'text', text: JSON.stringify(RESEARCH, null, 2) }],
        isError: false,
        timestamp: asked + 29_400,
      },
    }),
  )
  await fx.append(
    THREAD,
    line({
      type: 'message',
      id: 'ag-a',
      parentId: 'ag-r',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Get the **Acasis 40Gbps** enclosure with a **WD SN7100 2TB**: about 3 GB/s sustained writes, $189 all in.',
          },
        ],
        stopReason: 'stop',
        timestamp: asked + 31_000,
      },
    }),
  )
  host.upsert({ id: THREAD, status: 'idle', kind: 'assistant', assistant: 'nova', title: 'Nova' })
  await expect(caption).toHaveAttribute('data-state', 'done')
  await expect(log.locator(sel('agents-caption'))).toHaveCount(1)
  await expect(text).toHaveText('Answered with Web researcher · 29s · 2 sources')
  await expect(log.locator(`${sel('msg-ag-a')} ${sel('agents-caption')}`)).toHaveCount(1)
  await shot(shell, 'done.png')

  // A click opens what was asked, the answer and its verified sources.
  await text.click()
  const details = caption.locator(sel('agents-details'))
  await expect(details).toBeVisible()
  await expect(details).toContainText(QUESTION)
  await expect(details.locator(sel('agents-answer'))).toContainText('Acasis 40Gbps enclosure')
  await expect(details.locator(`${sel('agents-sources')} a`)).toHaveCount(2)
  await expect(details.locator(sel('agents-verified'))).toHaveCount(2)
  await expect(details).toContainText('29s · $0.004')
  await shot(shell, 'expanded.png')
  await caption.screenshot({ path: path.join(PROOF, 'expanded-caption.png') })

  await text.click()
  await expect(details).toHaveCount(0)
})
