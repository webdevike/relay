// Specialist agents in a chat: Nova asks the web researcher through the relay MCP server's
// agents_ask (omp's xd device write to xd://mcp__relay_agents_ask). From the ask on, a squared badge
// in the strip above the composer (beside the session badges) shows it running with a ticking
// clock; once the research is back it reads done with how long it took, and a click opens the
// request, the answer and its verified sources. A failed ask reads failed. The agents calls have
// no row of their own in the log, and no caption repeats the run under the reply. Saves
// screenshots to proof/specialist-badges/<scheme>/ (EVAOS_PROOF=1, or EVAOS_PROOF_DIR).
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   EVAOS_PROOF=1 [EVAOS_SCHEME=light] pnpm -C apps/desktop exec playwright test e2e/specialist-badges.spec.ts
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { APP_DIR, EVA_FIXTURE_ROOT, REPO_ROOT } from './helpers/paths'
import { pickScheme } from './helpers/appearance'

const SCHEME = process.env.EVAOS_SCHEME === 'light' ? 'light' : 'dark'
const PROOF = path.join(
  process.env.EVAOS_PROOF_DIR ??
    (process.env.EVAOS_PROOF === '1'
      ? path.join(REPO_ROOT, 'proof', 'specialist-badges')
      : path.join(APP_DIR, 'test-results/proof/specialist-badges')),
  SCHEME,
)
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
test.use({ startOnChat: false, toolPanes: false })

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

const ask = (id: string, parentId: string, at: number, agent: string, request: unknown) =>
  line({
    type: 'message',
    id,
    parentId,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: `toolu_${id}`,
          name: 'write',
          arguments: {
            path: 'xd://mcp__relay_agents_ask',
            i: 'Asking a specialist',
            content: JSON.stringify({ agent, request }),
          },
        },
      ],
      stopReason: 'toolUse',
      timestamp: at,
    },
  })
const result = (id: string, callId: string, at: number, text: string, isError: boolean) =>
  line({
    type: 'message',
    id,
    parentId: callId,
    message: {
      role: 'toolResult',
      toolCallId: `toolu_${callId}`,
      toolName: 'write',
      content: [{ type: 'text', text }],
      isError,
      timestamp: at,
    },
  })

test('a specialist run is a live badge in the strip: running with a clock, then done, opening its sources; a failed one reads failed', async ({
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
  await fx.append(THREAD, ask('ag-c', 'ag-u', asked, 'web-researcher', REQUEST))
  host.upsert({
    id: THREAD,
    status: 'working',
    kind: 'assistant',
    assistant: 'nova',
    title: 'Nova',
  })
  await resize(app, 1280, 900)
  await pickScheme(shell, SCHEME)
  await shell.getByTestId('nav-assistants').click()
  await shell.getByTestId('sidebar-agent-nova').click()
  const log = shell.locator(LOG)
  const strip = shell.locator(`[data-testid=chat-pane] ${sel('subagent-chips')}`)
  const badges = strip.locator('[data-kind="specialist"]')

  // From the ask on: one running badge in the strip, its clock ticking.
  await expect(badges).toHaveCount(1)
  const badge = badges.first()
  await expect(badge).toHaveAttribute('data-state', 'running')
  await expect(badge).toHaveText(/^Web researcher0:\d\d$/)
  const first = await badge.textContent()
  await expect(badge).not.toHaveText(first ?? '', { timeout: 3000 })
  // The agents call has no row of its own in the log, and nothing under the turn repeats it.
  await expect(log.locator('[data-role="tool"]')).toHaveCount(0)
  await expect(log.locator(sel('tool-group'))).toHaveCount(0)
  await expect(shell.locator(sel('agents-caption'))).toHaveCount(0)
  await shot(shell, 'running.png')
  await strip.screenshot({ path: path.join(PROOF, 'strip-running.png') })

  // The research comes back and Nova replies: the same badge reads done with how long it took.
  await fx.append(
    THREAD,
    result('ag-r', 'ag-c', asked + 29_400, JSON.stringify(RESEARCH, null, 2), false),
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
  await expect(badges).toHaveCount(1)
  await expect(badge).toHaveAttribute('data-state', 'done')
  await expect(badge).toHaveText('Web researcher29s')
  await expect(log.locator('[data-role="tool"]')).toHaveCount(0)
  await expect(shell.locator(sel('agents-caption'))).toHaveCount(0)
  await expect(strip.locator(sel('subagent-clear-done'))).toBeEnabled()
  await shot(shell, 'done.png')
  await strip.screenshot({ path: path.join(PROOF, 'strip-done.png') })

  // A click opens what was asked, the answer and its verified sources.
  await badge.click()
  const details = shell.locator(`${sel(`specialist-details-${RESEARCH.run}`)}`)
  await expect(details).toBeVisible()
  await expect(details).toContainText(QUESTION)
  await expect(details.locator(sel('agents-answer'))).toContainText('Acasis 40Gbps enclosure')
  await expect(details.locator(`${sel('agents-sources')} a`)).toHaveCount(2)
  await expect(details.locator(sel('agents-verified'))).toHaveCount(2)
  await expect(details).toContainText('29s · $0.004')
  await shot(shell, 'expanded.png')
  await badge.click()
  await expect(details).toHaveCount(0)

  // Nova asks a specialist that refuses: a second badge, newest first, failed.
  const again = Date.now() - 4000
  await fx.append(
    THREAD,
    line({
      type: 'message',
      id: 'ag-u2',
      parentId: 'ag-a',
      message: {
        role: 'user',
        content: 'Render it too',
        attribution: 'user',
        timestamp: again - 1000,
      },
    }),
  )
  await fx.append(THREAD, ask('ag-c2', 'ag-u2', again, 'prop-render', { prompt: 'the enclosure' }))
  await expect(badges).toHaveCount(2)
  await expect(badges.first()).toHaveAttribute('data-state', 'running')
  await fx.append(
    THREAD,
    result('ag-r2', 'ag-c2', again + 2000, 'Error: {"error":"prop-render is busy"}', true),
  )
  await expect(badges.first()).toHaveAttribute('data-state', 'failed')
  await expect(badges.first()).toHaveText('Prop render')
  await shot(shell, 'failed.png')
  await strip.screenshot({ path: path.join(PROOF, 'strip-failed.png') })

  // Clear done hides the finished badges.
  await strip.locator(sel('subagent-clear-done')).click()
  await expect(badges).toHaveCount(0)
})
