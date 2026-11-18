// Eva's specialist router in an assistant thread: before each of Isaac's messages reaches Nova, the
// router hook writes its decision (an omp `custom` entry, customType eva.specialist-router) just before
// the user message, and the turn's outcome at its end. Under each of Isaac's bubbles one quiet line
// shows it: the picked specialist with its confidence and why, or none; once the turn ended, whether
// Nova used it. A click opens the whole decision. The entries come in as the transcript grows (the
// thread rereads its file), so a turn's mark appears when its outcome is written. Saves screenshots
// to proof/specialist-router/<scheme>/ (EVAOS_PROOF=1, or EVAOS_PROOF_DIR).
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   EVAOS_PROOF=1 [EVAOS_SCHEME=light] pnpm -C apps/desktop exec playwright test e2e/specialist-router.spec.ts
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
      ? path.join(REPO_ROOT, 'proof', 'specialist-router')
      : path.join(APP_DIR, 'test-results/proof/specialist-router')),
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

const router = (id: string, parentId: string, data: Record<string, unknown>) =>
  line({
    type: 'custom',
    id,
    parentId,
    timestamp: new Date().toISOString(),
    customType: 'eva.specialist-router',
    data,
  })
const decision = (
  id: string,
  parentId: string,
  srId: string,
  over: Record<string, unknown>,
): string =>
  router(id, parentId, {
    v: 1,
    kind: 'decision',
    id: srId,
    at: new Date().toISOString(),
    assistant: 'nova',
    mode: 'shadow',
    alternatives: [],
    threshold: 0.7,
    hinted: false,
    latencyMs: 380,
    prompt: 'x',
    ...over,
  })
const outcome = (
  id: string,
  parentId: string,
  srId: string,
  over: Record<string, unknown>,
): string =>
  router(id, parentId, {
    v: 1,
    kind: 'outcome',
    id: srId,
    at: new Date().toISOString(),
    ...over,
  })
const user = (id: string, parentId: string, text: string, at: number): string =>
  line({
    type: 'message',
    id,
    parentId,
    message: { role: 'user', content: text, attribution: 'user', timestamp: at },
  })
const reply = (id: string, parentId: string, text: string, at: number): string =>
  line({
    type: 'message',
    id,
    parentId,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      stopReason: 'stop',
      timestamp: at,
    },
  })

const MATCH_USED =
  'Router: web-researcher · 0.86 · wants current prices with sources it can check · used'
const MATCH_SKIPPED =
  'Router: prop-render · 0.74 · asks to see the enclosure, a render fits · skipped: Isaac asked for words, not a picture'
const NONE = 'Router: none'

test('the router decision shows under each of Isaac messages, with whether the turn used it, and opens in full', async ({
  app,
  shell,
}) => {
  const t0 = Date.now() - 60_000
  // Turn 1: the router picks the web researcher and Nova uses it.
  await fx.append(
    THREAD,
    decision('sr-d1', 'a1', 'sr-1', {
      agent: 'web-researcher',
      confidence: 0.857,
      why: 'wants current prices with sources it can check',
      alternatives: [
        { agent: 'web-researcher', p: 0.857 },
        { agent: 'none', p: 0.09 },
        { agent: 'diagram', p: 0.03 },
      ],
      suggestedRequest: { question: 'Best 2TB USB4 SSD under $200', depth: 'quick' },
    }),
  )
  await fx.append(
    THREAD,
    user('sr-u1', 'sr-d1', 'Which 2TB USB4 SSD under $200 has the best sustained writes?', t0),
  )
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
  const rows = log.locator('[data-testid=router-row]')

  // While the turn runs: the decision, no mark.
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toHaveText(
    'Router: web-researcher · 0.86 · wants current prices with sources it can check',
  )
  await expect(rows.first().locator('[data-testid=router-mark]')).toHaveCount(0)
  await shot(shell, 'running.png')

  // The turn ends and the outcome is written: the mark appears without reopening the thread.
  await fx.append(
    THREAD,
    reply(
      'sr-a1',
      'sr-u1',
      'Get the **Acasis 40Gbps** enclosure with a **WD SN7100 2TB**.',
      t0 + 20_000,
    ),
  )
  await fx.append(
    THREAD,
    outcome('sr-o1', 'sr-a1', 'sr-1', { used: true, usedAgents: ['web-researcher'] }),
  )
  await expect(rows.first()).toHaveText(MATCH_USED)

  // Turn 2: a match Nova skipped, saying why.
  await fx.append(
    THREAD,
    decision('sr-d2', 'sr-o1', 'sr-2', {
      agent: 'prop-render',
      confidence: 0.74,
      why: 'asks to see the enclosure, a render fits',
      mode: 'live',
      hinted: true,
    }),
  )
  await fx.append(
    THREAD,
    user('sr-u2', 'sr-d2', 'What would it look like on my desk?', t0 + 30_000),
  )
  await fx.append(
    THREAD,
    reply('sr-a2', 'sr-u2', 'A matte grey slab about the size of a deck of cards.', t0 + 35_000),
  )
  await fx.append(
    THREAD,
    outcome('sr-o2', 'sr-a2', 'sr-2', {
      used: false,
      usedAgents: [],
      skipReason: 'Isaac asked for words, not a picture',
    }),
  )

  // Turn 3: small talk, no specialist.
  await fx.append(
    THREAD,
    decision('sr-d3', 'sr-o2', 'sr-3', {
      agent: 'none',
      confidence: 0.93,
      why: 'thanks, nothing to do',
      noneReason: 'chat',
    }),
  )
  await fx.append(THREAD, user('sr-u3', 'sr-d3', 'Thanks!', t0 + 40_000))
  await fx.append(THREAD, reply('sr-a3', 'sr-u3', 'Any time.', t0 + 41_000))
  await fx.append(THREAD, outcome('sr-o3', 'sr-a3', 'sr-3', { used: false, usedAgents: [] }))
  host.upsert({ id: THREAD, status: 'idle', kind: 'assistant', assistant: 'nova', title: 'Nova' })

  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toHaveText(MATCH_USED)
  await expect(rows.nth(1)).toHaveText(MATCH_SKIPPED)
  await expect(rows.nth(2)).toHaveText(NONE)
  // Each line sits under its own bubble, and the first chat message (no router entry) has none.
  await expect(log.locator('[data-testid="msg-u1"] [data-testid=router-row]')).toHaveCount(0)
  await expect(log.locator('[data-testid="msg-sr-u3"] [data-testid=router-row]')).toHaveText(NONE)
  await shot(shell, 'rows.png')

  // A click opens the whole decision and its outcome.
  await rows.nth(0).click()
  const details = shell.locator('[data-testid=router-details]')
  await expect(details).toBeVisible()
  await expect(details).toContainText('web-researcher 0.86, none 0.09, diagram 0.03')
  await expect(details).toContainText('"depth": "quick"')
  await expect(details).toContainText('shadow')
  await expect(details).toContainText('380 ms')
  await expect(details).not.toContainText('\u2014')
  await shot(shell, 'details.png')
  await rows.nth(0).click()
  await expect(details).toHaveCount(0)
})
