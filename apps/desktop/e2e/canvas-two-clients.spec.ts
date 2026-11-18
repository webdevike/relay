import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { z } from 'zod'
import { test, expect, launchApp } from './fixtures'
import { REPO_ROOT } from './helpers/paths'

// One board open on two Macs through a real Relay Host (apps/linux control host, isolated config):
// the Mini's own desktop writes the boards folder itself, the MacBook writes it through the host.
// The host holds each of the MacBook's writes (`--hold-writes`), so the Mini's agent edits and adds
// cards between the MacBook agent's read of the board and its write. Every acknowledged write must
// be in the file afterwards, and both boards on screen must show the same cards: the MacBook's
// write, made from the older file, is refused by the host and redone over the new one instead of
// overwriting it. Windows stay hidden; CANVAS_TWO_CLIENTS_OUT=<dir> keeps the shots.

const HOST_SCRIPT = path.join(REPO_ROOT, 'apps/linux/test/control-host.ts')
const BOARDS_SEED = path.join(REPO_ROOT, 'fixtures/canvases')
const SLUG = 'user-flow'
const HOLD_MS = 2500

const ServeSchema = z.object({ port: z.number(), controlToken: z.string() })
const DevicesSchema = z.object({
  ok: z.literal(true),
  value: z.object({ devices: z.array(z.object({ id: z.string(), local: z.boolean() })) }),
})
const ReplySchema = z.object({ ok: z.boolean(), value: z.unknown().optional() })

let host: ChildProcess | null = null
let port = 0
let token = ''
/** The text of every write from the MacBook the host held (`held <slug> <base64>`), in order. */
let held: string[] = []

async function control(pathname: string, body?: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${String(port)}${pathname}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return res.json()
}

async function run(target: string, action: string, params: Record<string, unknown> = {}) {
  const reply = ReplySchema.parse(await control('/control/run', { target, action, params }))
  if (!reply.ok) throw new Error(`${action} on ${target}: ${JSON.stringify(reply)}`)
  return reply.value
}

async function ready(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid=rail]')
  await page.waitForFunction(() => '__evaosShell' in window)
  return page
}

const cardTitles = (file: string): string[] =>
  z
    .object({ nodes: z.array(z.object({ data: z.object({ title: z.string() }).partial() })) })
    .parse(JSON.parse(fs.readFileSync(file, 'utf8')))
    .nodes.map((n) => n.data.title ?? '')

test.afterEach(() => {
  host?.kill('SIGTERM')
  host = null
})

test('a board open on two Macs keeps every acknowledged agent write and both converge', async ({
  configDir,
}, testInfo) => {
  test.setTimeout(180_000)
  const out = process.env['CANVAS_TWO_CLIENTS_OUT'] ?? testInfo.outputPath('proof')
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-two-clients-')))
  const apps: ElectronApplication[] = []
  try {
    const xdg = path.join(tmp, 'xdg')
    const relayDir = path.join(xdg, 'relay')
    const boards = path.join(tmp, 'boards')
    fs.mkdirSync(relayDir, { recursive: true })
    fs.cpSync(BOARDS_SEED, boards, { recursive: true })
    const file = path.join(boards, `${SLUG}.json`)

    host = spawn(
      'bun',
      [HOST_SCRIPT, '--port', '0', '--canvases', boards, '--hold-writes', String(HOLD_MS)],
      {
        cwd: path.join(REPO_ROOT, 'apps/linux'),
        env: { ...process.env, XDG_CONFIG_HOME: xdg },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    )
    const started = Promise.withResolvers<void>()
    host.once('exit', (code) => started.reject(new Error(`control host exited ${String(code)}`)))
    let pending = ''
    held = []
    host.stdout!.on('data', (d: Buffer) => {
      const lines = (pending + d.toString()).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const m = /^held \S+ (\S*)$/.exec(line)
        if (m) held.push(Buffer.from(m[1]!, 'base64').toString('utf8'))
        if (/^ready \d+$/.test(line)) started.resolve()
      }
    })
    await started.promise
    const serve = ServeSchema.parse(
      JSON.parse(fs.readFileSync(path.join(relayDir, 'serve.json'), 'utf8')),
    )
    port = serve.port
    token = serve.controlToken

    // The Mini: local mode on the host's own boards folder.
    const mini = await launchApp(configDir, {
      EVAOS_RELAY_DIR: relayDir,
      EVAOS_CANVAS_DIR: boards,
      EVAOS_AGENT_CONTROL: '1',
    })
    apps.push(mini)
    const miniPage = await ready(mini)

    // The MacBook: remote mode, paired with the host; its boards are the host's.
    const bookConfig = path.join(tmp, 'book')
    fs.mkdirSync(bookConfig, { recursive: true })
    const authority = `127.0.0.1:${String(port)}`
    const secretHex = randomBytes(32).toString('hex')
    fs.writeFileSync(
      path.join(bookConfig, 'relay-remote.json'),
      JSON.stringify({ host: authority, paired: { id: authority, secretHex } }),
      { mode: 0o600 },
    )
    fs.writeFileSync(
      path.join(relayDir, 'devices.json'),
      JSON.stringify({
        [`relay-desktop-${os.hostname()}`]: { secretHex, name: 'Relay Desktop', pairedAt: 1 },
      }),
      { mode: 0o600 },
    )
    const book = await launchApp(bookConfig, {
      EVAOS_AGENT_CONTROL: '1',
      EVAOS_CANVAS_DIR: path.join(tmp, 'book-boards'),
    })
    apps.push(book)
    const bookPage = await ready(book)

    const devices = async () => DevicesSchema.parse(await control('/control/devices')).value.devices
    await expect.poll(async () => (await devices()).length, { timeout: 30_000 }).toBe(2)
    const MINI = (await devices()).find((d) => d.local)!.id
    const BOOK = (await devices()).find((d) => !d.local)!.id

    // Both Macs show the board, and settle (the MacBook's first saves, held too, land).
    const boardOn = (page: Page) => page.locator(`[data-testid=canvas-board][data-slug="${SLUG}"]`)
    for (const id of [MINI, BOOK]) {
      await run(id, 'tab.open', { kind: 'page', args: { page: 'canvas', canvas: SLUG } })
    }
    await expect(boardOn(miniPage)).toBeVisible({ timeout: 20_000 })
    await expect(boardOn(bookPage)).toBeVisible({ timeout: 20_000 })
    let quiet = held.length
    await expect
      .poll(
        async () => {
          await miniPage.waitForTimeout(HOLD_MS + 1000)
          const settled = held.length === quiet
          quiet = held.length
          return settled
        },
        { timeout: 60_000, intervals: [0] },
      )
      .toBe(true)

    // The MacBook's agent adds a card: it reads the board, and its write waits at the host...
    const fromBook = run(BOOK, 'canvas.add', { slug: SLUG, title: 'Added on the MacBook' })
    await expect
      .poll(() => held.some((t) => t.includes('Added on the MacBook')), { timeout: 30_000 })
      .toBe(true)
    // ...while the Mini's agent edits a card and adds one, both acknowledged.
    await run(MINI, 'canvas.edit', { slug: SLUG, node: 'login', title: 'Edited on the Mini' })
    await run(MINI, 'canvas.add', { slug: SLUG, title: 'Added on the Mini' })
    const miniWrote = cardTitles(file)
    expect(miniWrote).toContain('Edited on the Mini')
    expect(miniWrote).toContain('Added on the Mini')
    await fromBook

    // Every acknowledged write is in the file...
    const titles = cardTitles(file)
    expect(titles).toEqual(
      expect.arrayContaining(['Edited on the Mini', 'Added on the Mini', 'Added on the MacBook']),
    )
    expect(titles).not.toContain('Sign in')

    // ...both boards on screen show it...
    for (const page of [miniPage, bookPage]) {
      for (const title of ['Edited on the Mini', 'Added on the Mini', 'Added on the MacBook']) {
        await expect(
          boardOn(page).locator('.react-flow__node').filter({ hasText: title }),
        ).toBeVisible({ timeout: 20_000 })
      }
    }
    fs.mkdirSync(out, { recursive: true })
    await miniPage.screenshot({ path: path.join(out, 'mini.png') })
    await bookPage.screenshot({ path: path.join(out, 'book.png') })

    // ...and stays there once every save either board makes after reloading has landed.
    await miniPage.waitForTimeout(2 * HOLD_MS + 1500)
    expect(cardTitles(file)).toEqual(expect.arrayContaining(titles))
  } finally {
    for (const app of apps) await app.close().catch(() => undefined)
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
