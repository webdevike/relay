// Chat media load order: a chat with 4 older replies of one openui Model block each, then a reply
// carrying 8 more (the burst Isaac saw in Nova's thread). Models load newest first (the newest
// reply, bottom block first), at most two GLBs are in flight at once, models far above never load
// until Isaac scrolls up, and the newest viewers give their WebGL context back once they are far
// below (media-slot.ts). A stand-in Relay host serves every drop the same cube, slowly
// (GLB_DELAY_MS), and logs when each request starts and ends.
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   pnpm -C apps/desktop exec playwright test e2e/media-priority.spec.ts
import * as fs from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { FIXTURES_DIR } from './helpers/paths'

const CUBE = path.join(FIXTURES_DIR, 'agent-widgets', 'media', 'cube.glb')
const TITLE = 'Model wall'
const LOG = '[data-testid=chat-pane] [data-testid=chat-log]'
const MODELS = 12
/** Models 01..SINGLES each have a reply of their own; the rest share the newest reply. */
const SINGLES = 4
const GLB_DELAY_MS = 1500
/** Media lane limit for 3D models (media-slot.ts). */
const MODEL_LIMIT = 2

const name = (i: number): string => `Model ${String(i).padStart(2, '0')}`
const drop = (i: number): string => `/drops/m${String(i).padStart(2, '0')}/tok`

interface Hit {
  url: string
  start: number
  end: number
}

/** One session: a prompt, SINGLES replies a minute apart with one Model each, then one reply with the rest. */
function writeSession(dir: string): void {
  const t0 = Date.parse('2026-11-14T10:00:00.000Z')
  const at = (minute: number) => ({
    iso: new Date(t0 + minute * 60_000).toISOString(),
    ms: t0 + minute * 60_000,
  })
  const lines: unknown[] = [
    { type: 'title', v: 1, title: TITLE, source: 'auto', updatedAt: at(MODELS + 1).iso },
    { type: 'session', version: 3, id: 'chat-models', timestamp: at(0).iso, cwd: '/fixture' },
    {
      type: 'message',
      id: 'm000',
      parentId: null,
      timestamp: at(0).iso,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Show me every scan.' }],
        attribution: 'user',
        timestamp: at(0).ms,
      },
    },
  ]
  const reply = (n: number, text: string) => ({
    type: 'message',
    id: `m${String(n).padStart(3, '0')}`,
    parentId: `m${String(n - 1).padStart(3, '0')}`,
    timestamp: at(n).iso,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      stopReason: 'stop',
      timestamp: at(n).ms,
    },
  })
  const model = (i: number) => `m${i} = Model("${drop(i)}", "${name(i)}")`
  for (let i = 1; i <= SINGLES; i++)
    lines.push(reply(i, `${name(i)}:\n\n\`\`\`openui\nroot = m${i}\n${model(i)}\n\`\`\``))
  const burst = Array.from({ length: MODELS - SINGLES }, (_, k) => SINGLES + 1 + k)
  const program = [`root = Stack([${burst.map((i) => `m${i}`).join(', ')}])`, ...burst.map(model)]
  lines.push(reply(SINGLES + 1, `The rest:\n\n\`\`\`openui\n${program.join('\n')}\n\`\`\``))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, '2026-11-14T10-00-00-000Z_chat-models.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  )
}

const test = base.extend<{ media: { port: number; hits: Hit[] } }>({
  media: async ({}, use) => {
    const hits: Hit[] = []
    const glb = fs.readFileSync(CUBE)
    const server = http.createServer((req, res) => {
      const url = req.url ?? '/'
      if (!/^\/drops\/m\d+\/tok$/.test(url)) {
        res.writeHead(404)
        res.end()
        return
      }
      const hit = { url, start: Date.now(), end: 0 }
      hits.push(hit)
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'model/gltf-binary' })
        res.end(glb)
        hit.end = Date.now()
      }, GLB_DELAY_MS)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    await use({ port: (server.address() as AddressInfo).port, hits })
    await new Promise<void>((r) => server.close(() => r()))
  },
  launchEnv: async ({}, use) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-media-priority-'))
    const sessions = path.join(root, 'agent', 'sessions', '-fixture')
    writeSession(sessions)
    await use({
      EVAOS_AGENT_DIR: path.join(root, 'agent'),
      EVAOS_SESSIONS_DIR: sessions,
      FAKE_OMP_SESSIONS_DIR: sessions,
    })
    fs.rmSync(root, { recursive: true, force: true })
  },
  configDir: async ({ configDir, media }, use) => {
    fs.mkdirSync(path.join(configDir, 'relay'), { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'relay', 'serve.json'),
      JSON.stringify({ port: media.port }),
    )
    await use(configDir)
  },
})

/** Model number of a drop request. */
const modelOf = (url: string): number => Number(/\/m(\d+)\//.exec(url)![1])

/** Most GLB requests the host had open at once. */
function peakInFlight(hits: Hit[]): number {
  const edges = hits.flatMap((h) => [
    { t: h.start, d: 1 },
    { t: h.end || Infinity, d: -1 },
  ])
  // An end and a start at the same ms: the end first (that slot was already free).
  edges.sort((a, b) => a.t - b.t || a.d - b.d)
  let open = 0
  let peak = 0
  for (const e of edges) {
    open += e.d
    peak = Math.max(peak, open)
  }
  return peak
}

/**
 * Pairs that broke newest first: a request that started after another had finished (so it was
 * granted later) for a newer model. Requests granted together are not ordered against each other.
 */
function orderViolations(hits: Hit[]): string[] {
  return hits.flatMap((a) =>
    hits
      .filter((b) => b.start >= a.end && a.end > 0 && modelOf(b.url) > modelOf(a.url))
      .map((b) => `${modelOf(b.url)} after ${modelOf(a.url)}`),
  )
}

/** data-state of each model frame mounted now, by model number (virtua unmounts far rows). */
const states = (shell: Page): Promise<Record<number, string>> =>
  shell
    .locator(`${LOG} .eva-w-model`)
    .evaluateAll((els) =>
      Object.fromEntries(
        els.map((el) => [
          Number(/(\d+)$/.exec(el.getAttribute('aria-label') ?? '')![1]),
          el.getAttribute('data-state') ?? '',
        ]),
      ),
    )

/** WebGL canvases alive in the chat. */
const canvases = (shell: Page): Promise<number> =>
  shell.locator(`${LOG} .eva-w-model canvas`).count()

test('chat models load newest first, two at a time, and far ones wait or unload', async ({
  app,
  shell,
  media,
}) => {
  test.setTimeout(120_000)
  await app.evaluate(
    (_e, [w, h]) => {
      const hooks = globalThis as unknown as {
        __evaosTest: { win: { setContentSize(w: number, h: number): void } }
      }
      hooks.__evaosTest.win.setContentSize(w, h)
    },
    // Tall enough that four models sit near the viewport: two load, two wait their turn.
    [1280, 1500] as const,
  )
  await shell.getByTestId('nav-chat').click()
  await shell
    .getByTestId('chat-tree')
    .getByRole('link', { name: new RegExp(`^${TITLE}`) })
    .click()
  await expect(shell.locator(LOG)).toContainText(name(MODELS))

  // The chat opens at the newest reply's bottom: the models near it load, newest first.
  await expect.poll(async () => (await states(shell))[MODELS], { timeout: 30_000 }).toBe('ready')
  await expect.poll(() => media.hits.every((h) => h.end > 0), { timeout: 30_000 }).toBe(true)
  // Settled: whatever was near has asked; nothing else trickles in.
  await shell.waitForTimeout(2000)
  const t0 = media.hits[0]!.start
  const timeline = (hits: Hit[]) =>
    hits.map((h) => `${name(modelOf(h.url))} ${h.start - t0}-${h.end - t0}ms`).join(', ')
  const opened = media.hits.map((h) => modelOf(h.url))
  console.log(`[media-priority] open, requested in order: ${JSON.stringify(opened)}`)
  console.log(`[media-priority] open, timeline: ${timeline(media.hits)}`)
  expect(opened.slice(0, MODEL_LIMIT)).toContain(MODELS)
  expect(orderViolations(media.hits)).toEqual([])
  expect(peakInFlight(media.hits)).toBeLessThanOrEqual(MODEL_LIMIT)
  // Off screen: the older replies' models and the burst's top ones are never fetched.
  for (let i = 1; i <= SINGLES; i++) expect(opened).not.toContain(i)
  // More near models than slots, so a second wave waited its turn; the burst's top ones never asked.
  expect(opened.length).toBeGreaterThan(MODEL_LIMIT)
  expect(opened.length).toBeLessThan(MODELS - SINGLES)
  console.log(
    `[media-priority] open: ${await canvases(shell)} WebGL canvases, states ${JSON.stringify(await states(shell))}`,
  )

  // Up to the burst's first model: its reply row stays mounted, so the newest viewers, now
  // thousands of px below, are this change's to unload: back to waiting, their canvases gone.
  const first = shell.locator(`${LOG} .eva-w-model[aria-label="${name(SINGLES + 1)}"]`)
  await expect
    .poll(
      async () => {
        await first.evaluate((el) => el.scrollIntoView({ block: 'center' }))
        return (await states(shell))[SINGLES + 1]
      },
      { timeout: 30_000 },
    )
    .toBe('ready')
  const burstTop = await states(shell)
  console.log(
    `[media-priority] burst top: ${await canvases(shell)} WebGL canvases, states ${JSON.stringify(burstTop)}`,
  )
  expect(burstTop[MODELS]).toBe('waiting')
  expect(burstTop[MODELS - 1]).toBe('waiting')

  // Scroll to the oldest reply: it loads now, and the newest viewers, far below, unload.
  const scroller = shell.locator(LOG).locator(':scope > *').first()
  await expect
    .poll(
      async () => {
        await scroller.evaluate((el) => {
          el.scrollTop = 0
        })
        return (await states(shell))[1]
      },
      { timeout: 20_000 },
    )
    .toBe('ready')
  await expect.poll(() => media.hits.every((h) => h.end > 0), { timeout: 20_000 }).toBe(true)
  const scrolled = media.hits.map((h) => modelOf(h.url))
  console.log(
    `[media-priority] after scroll to top, requested in order: ${JSON.stringify(scrolled)}`,
  )
  console.log(`[media-priority] after scroll to top, timeline: ${timeline(media.hits)}`)
  const top = await states(shell)
  console.log(
    `[media-priority] top: ${await canvases(shell)} WebGL canvases, states ${JSON.stringify(top)}`,
  )
  expect(scrolled).toContain(1)
  expect(peakInFlight(media.hits)).toBeLessThanOrEqual(MODEL_LIMIT)
  // The newest model is far below now: unmounted by the list or back to waiting, never live.
  expect(top[MODELS] ?? 'unmounted').not.toBe('ready')
  expect(await canvases(shell)).toBeLessThan(MODELS)
})
