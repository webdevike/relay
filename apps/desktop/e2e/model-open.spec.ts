// Chat 3D models open only on a click, one at a time (rich/model-viewer.ts). A chat whose newest
// reply carries 6 openui Model blocks and one over the size limit (the burst that crashed Relay
// in Nova's thread, 2026-11-22): opening it downloads no GLB and creates no WebGL context, each
// frame is a poster with the file's name and size; a click opens one, a second click elsewhere
// disposes the first; the oversized one says so and is never fetched. A stand-in Relay host
// serves every drop the same cube and logs each GET.
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   pnpm -C apps/desktop exec playwright test e2e/model-open.spec.ts
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
const MODELS = 6
/** The extra model the host says is 60 MB (HEAD only). */
const HUGE = MODELS + 1

const name = (i: number): string => `Model ${i}`
const drop = (i: number): string => `/drops/m${i}/tok`

function writeSession(dir: string): void {
  const t0 = Date.parse('2026-11-22T10:00:00.000Z')
  const iso = (n: number) => new Date(t0 + n * 60_000).toISOString()
  const ids = Array.from({ length: HUGE }, (_, k) => k + 1)
  const program = [
    `root = Stack([${ids.map((i) => `m${i}`).join(', ')}])`,
    ...ids.map((i) => `m${i} = Model("${drop(i)}", "${name(i)}")`),
  ]
  const lines = [
    { type: 'title', v: 1, title: TITLE, source: 'auto', updatedAt: iso(2) },
    { type: 'session', version: 3, id: 'chat-models', timestamp: iso(0), cwd: '/fixture' },
    {
      type: 'message',
      id: 'm000',
      parentId: null,
      timestamp: iso(0),
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Show me every scan.' }],
        attribution: 'user',
        timestamp: t0,
      },
    },
    {
      type: 'message',
      id: 'm001',
      parentId: 'm000',
      timestamp: iso(1),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `Scans:\n\n\`\`\`openui\n${program.join('\n')}\n\`\`\`` }],
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
        stopReason: 'stop',
        timestamp: t0 + 60_000,
      },
    },
  ]
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, '2026-11-22T10-00-00-000Z_chat-models.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  )
}

const test = base.extend<{ media: { port: number; gets: number[] } }>({
  media: async ({}, use) => {
    const gets: number[] = []
    const glb = fs.readFileSync(CUBE)
    const server = http.createServer((req, res) => {
      const m = /^\/drops\/m(\d+)\/tok$/.exec(req.url ?? '')
      if (!m) {
        res.writeHead(404)
        res.end()
        return
      }
      const i = Number(m[1])
      const size = i === HUGE ? 60 * 1024 * 1024 : glb.length
      res.writeHead(200, {
        'content-type': 'model/gltf-binary',
        'content-length': String(size),
        'content-disposition': `attachment; filename="scan-${i}.glb"`,
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      gets.push(i)
      res.end(i === HUGE ? Buffer.alloc(size) : glb)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    await use({ port: (server.address() as AddressInfo).port, gets })
    await new Promise<void>((r) => server.close(() => r()))
  },
  launchEnv: async ({}, use) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-model-open-'))
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

/** data-state of each mounted model frame, by model number. */
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

const canvases = (shell: Page): Promise<number> =>
  shell.locator(`${LOG} .eva-w-model canvas`).count()

const frame = (shell: Page, i: number) =>
  shell.locator(`${LOG} .eva-w-model[aria-label="${name(i)}"]`)

test('chat models are posters until clicked, and only one is open at a time', async ({
  app,
  shell,
  media,
}) => {
  test.setTimeout(90_000)
  await app.evaluate(
    (_e, [w, h]) => {
      const hooks = globalThis as unknown as {
        __evaosTest: { win: { setContentSize(w: number, h: number): void } }
      }
      hooks.__evaosTest.win.setContentSize(w, h)
    },
    [1280, 1500] as const,
  )
  await shell.getByTestId('nav-chat').click()
  await shell
    .getByTestId('chat-tree')
    .getByRole('link', { name: new RegExp(`^${TITLE}`) })
    .click()
  await expect(shell.locator(LOG)).toContainText(name(MODELS))

  // Open: posters with the file's name and size; no GLB fetched, no WebGL context.
  await expect.poll(async () => (await states(shell))[MODELS]).toBe('poster')
  await expect(frame(shell, MODELS)).toContainText(`scan-${MODELS}.glb`)
  await expect(frame(shell, MODELS)).toContainText('Click to view in 3D')
  await expect(frame(shell, HUGE)).toContainText('Too large to open in 3D: 60.0 MB')
  await expect(frame(shell, HUGE).getByRole('button')).toHaveCount(0)
  await shell.waitForTimeout(1500)
  expect(media.gets).toEqual([])
  expect(await canvases(shell)).toBe(0)

  // A click opens that one model.
  await frame(shell, MODELS).getByRole('button').click()
  await expect.poll(async () => (await states(shell))[MODELS]).toBe('ready')
  expect(media.gets).toEqual([MODELS])
  expect(await canvases(shell)).toBe(1)

  // Opening another closes the first: still one canvas.
  await frame(shell, MODELS - 1).scrollIntoViewIfNeeded()
  await frame(shell, MODELS - 1)
    .getByRole('button')
    .click()
  await expect.poll(async () => (await states(shell))[MODELS - 1]).toBe('ready')
  expect((await states(shell))[MODELS]).toBe('poster')
  expect(await canvases(shell)).toBe(1)
  expect(media.gets).toEqual([MODELS, MODELS - 1])
  expect(media.gets).not.toContain(HUGE)
})
