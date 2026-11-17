import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { z } from 'zod'
import { test, expect, launchApp } from './fixtures'
import { REPO_ROOT } from './helpers/paths'
import { startStaticServer, type StaticServer } from './helpers/static-server'

// The window mirror through a real Relay Host (apps/linux, control + `workspace.*` + host boards,
// isolated config): the Mini's own desktop (local mode, its boards folder is the host's) and the
// MacBook (remote mode, paired) show the same app tabs, panes and web pages, and the same boards.
// Boards the MacBook kept before go up to the host once. The MacBook restores the mirrored window
// after a restart. Both windows stay hidden; WORKSPACE_MIRROR_OUT=<dir> keeps the videos and shots.

const HOST_SCRIPT = path.join(REPO_ROOT, 'apps/linux/test/control-host.ts')
const BOARDS_SEED = path.join(REPO_ROOT, 'fixtures/canvases')
const BOOK_ID = `relay-desktop-${os.hostname()}:dev`
const SIZE = { width: 1400, height: 860 }

const ServeSchema = z.object({ port: z.number(), controlToken: z.string() })
const DevicesSchema = z.object({
  ok: z.literal(true),
  value: z.object({
    devices: z.array(z.object({ id: z.string(), local: z.boolean() })),
  }),
})
const ReplySchema = z.object({ ok: z.boolean(), value: z.unknown().optional() })
const PagesSchema = z.object({
  tabs: z.array(z.object({ tabId: z.string(), url: z.string() })),
})

let host: ChildProcess | null = null
let port = 0
let token = ''

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

/** layout.read of the workspace on screen, as text to look for tab args in. */
const layoutOf = async (target: string): Promise<string> =>
  JSON.stringify(await run(target, 'layout.read'))
const paneCount = async (target: string): Promise<number> =>
  (await layoutOf(target)).match(/"pane":"/g)?.length ?? 0
/** The URL of every web page the desktop has, by tab id. */
const pagesOf = async (target: string): Promise<Record<string, string>> =>
  Object.fromEntries(
    PagesSchema.parse(await run(target, 'browser.tabs')).tabs.map((t) => [t.tabId, t.url]),
  )

async function shot(page: Page, dir: string, name: string): Promise<void> {
  await page.waitForTimeout(500)
  fs.mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: path.join(dir, `${name}.png`) })
}

async function ready(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid=rail]')
  await page.waitForFunction(() => '__evaosShell' in window)
  return page
}

test.afterEach(() => {
  host?.kill('SIGTERM')
  host = null
})

test('two Macs show one window and one set of boards through the Relay Host', async ({
  configDir,
}, testInfo) => {
  test.setTimeout(240_000)
  const out = process.env['WORKSPACE_MIRROR_OUT'] ?? testInfo.outputPath('proof')
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-mirror-')))
  const web: StaticServer = await startStaticServer()
  const apps: ElectronApplication[] = []
  try {
    const xdg = path.join(tmp, 'xdg')
    const relayDir = path.join(xdg, 'relay')
    const boards = path.join(tmp, 'boards')
    fs.mkdirSync(relayDir, { recursive: true })
    fs.cpSync(BOARDS_SEED, boards, { recursive: true })
    // The MacBook made one board of its own before boards lived on the host.
    const bookBoards = path.join(tmp, 'book-boards')
    fs.mkdirSync(bookBoards, { recursive: true })
    const own = z
      .object({ title: z.string() })
      .passthrough()
      .parse(JSON.parse(fs.readFileSync(path.join(BOARDS_SEED, 'user-flow.json'), 'utf8')))
    fs.writeFileSync(
      path.join(bookBoards, 'trip-plan.json'),
      JSON.stringify({ ...own, title: 'Trip plan' }),
    )

    host = spawn('bun', [HOST_SCRIPT, '--port', '0', '--mirror', '--canvases', boards], {
      cwd: path.join(REPO_ROOT, 'apps/linux'),
      env: { ...process.env, XDG_CONFIG_HOME: xdg },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    await new Promise<void>((resolve, reject) => {
      host!.once('exit', (code) => reject(new Error(`control host exited ${String(code)}`)))
      host!.stdout!.on('data', (d: Buffer) => {
        if (/ready \d+/.test(d.toString())) resolve()
      })
    })
    const serve = ServeSchema.parse(
      JSON.parse(fs.readFileSync(path.join(relayDir, 'serve.json'), 'utf8')),
    )
    port = serve.port
    token = serve.controlToken

    // The Mini: local mode on the host's own boards folder.
    const mini = await launchApp(
      configDir,
      { EVAOS_RELAY_DIR: relayDir, EVAOS_CANVAS_DIR: boards, EVAOS_AGENT_CONTROL: '1' },
      { dir: path.join(out, 'video-mini'), size: SIZE },
    )
    apps.push(mini)
    const miniPage = await ready(mini)

    // The MacBook: remote mode, paired with the host.
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
    const bookEnv = { EVAOS_AGENT_CONTROL: '1', EVAOS_CANVAS_DIR: bookBoards }
    let book = await launchApp(bookConfig, bookEnv, {
      dir: path.join(out, 'video-book'),
      size: SIZE,
    })
    apps.push(book)
    let bookPage = await ready(book)

    const devices = async () => DevicesSchema.parse(await control('/control/devices')).value.devices
    await expect.poll(async () => (await devices()).length, { timeout: 30_000 }).toBe(2)
    const MINI_ID = (await devices()).find((d) => d.local)!.id

    // The MacBook's own board went up to the host, and its old folder was set aside.
    await expect
      .poll(() => fs.existsSync(path.join(boards, 'trip-plan.json')), { timeout: 20_000 })
      .toBe(true)
    expect(fs.existsSync(bookBoards)).toBe(false)

    // A board opened beside the chat on the Mini shows on the MacBook.
    await run(MINI_ID, 'tab.open', { kind: 'page', args: { page: 'canvas', canvas: 'user-flow' } })
    await expect
      .poll(() => layoutOf(BOOK_ID), { timeout: 15_000 })
      .toContain('"canvas":"user-flow"')
    await shot(miniPage, out, '1-mini-board-opened')
    await shot(bookPage, out, '1-book-board-mirrored')

    // A web page opened on the Mini opens on the MacBook at the same address, same tab id.
    const opened = z
      .object({ tabId: z.string() })
      .parse(await run(MINI_ID, 'browser.open', { url: web.url('/a.html') }))
    await expect
      .poll(async () => (await pagesOf(BOOK_ID))[opened.tabId], { timeout: 15_000 })
      .toBe(web.url('/a.html'))
    await expect.poll(() => layoutOf(BOOK_ID)).toContain(`"tabId":"${opened.tabId}"`)

    // The MacBook navigates it: the Mini follows.
    await run(BOOK_ID, 'browser.navigate', { tabId: opened.tabId, url: web.url('/b.html') })
    await expect
      .poll(async () => (await pagesOf(MINI_ID))[opened.tabId], { timeout: 15_000 })
      .toBe(web.url('/b.html'))
    await shot(bookPage, out, '2-book-navigated')
    await shot(miniPage, out, '2-mini-followed')

    // A split made on the MacBook shows on the Mini; closed there, it goes on the MacBook.
    const before = await paneCount(MINI_ID)
    const split = z
      .object({ pane: z.string() })
      .parse(await run(BOOK_ID, 'pane.split', { dir: 'down', tab: { kind: 'files' } }))
    await expect.poll(() => paneCount(MINI_ID), { timeout: 15_000 }).toBe(before + 1)
    await shot(miniPage, out, '3-mini-split-from-book')
    await run(MINI_ID, 'pane.close', { pane: split.pane })
    await expect.poll(() => paneCount(BOOK_ID), { timeout: 15_000 }).toBe(before)

    // A card added on the MacBook is on the board the Mini reads (the host's file).
    await run(BOOK_ID, 'canvas.add', { slug: 'user-flow', title: 'Added on the MacBook' })
    await expect
      .poll(async () => JSON.stringify(await run(MINI_ID, 'canvas.read', { slug: 'user-flow' })), {
        timeout: 15_000,
      })
      .toContain('Added on the MacBook')
    // A board made on the MacBook is a file on the host.
    const made = z
      .object({ slug: z.string() })
      .parse(await run(BOOK_ID, 'canvas.open', { title: 'Made on the MacBook' }))
    expect(fs.existsSync(path.join(boards, `${made.slug}.json`))).toBe(true)
    await expect
      .poll(async () => JSON.stringify(await run(MINI_ID, 'canvas.read', { slug: made.slug })))
      .toContain('Made on the MacBook')
    await shot(bookPage, out, '4-book-board-made')
    await shot(miniPage, out, '4-mini-board-made')

    // The MacBook restarts: the window it saved on its own disk comes back.
    const shown = await layoutOf(BOOK_ID)
    expect(shown).toContain(`"canvas":"${made.slug}"`)
    await book.close()
    apps.splice(apps.indexOf(book), 1)
    const saved = fs.readFileSync(path.join(bookConfig, 'layout.json'), 'utf8')
    expect(saved).toContain(made.slug)
    expect(saved).toContain(`"${opened.tabId}"`)
    book = await launchApp(bookConfig, bookEnv, {
      dir: path.join(out, 'video-book-relaunch'),
      size: SIZE,
    })
    apps.push(book)
    bookPage = await ready(book)
    await expect
      .poll(() => layoutOf(BOOK_ID), { timeout: 20_000 })
      .toContain(`"canvas":"${made.slug}"`)
    expect(await layoutOf(BOOK_ID)).toContain(`"tabId":"${opened.tabId}"`)
    await expect
      .poll(async () => (await pagesOf(BOOK_ID))[opened.tabId], { timeout: 15_000 })
      .toBe(web.url('/b.html'))
    await shot(bookPage, out, '5-book-restored')

    // Settled, neither Mac sends the other anything more (no echo of a change it was sent).
    const revOf = (): number =>
      z
        .object({ rev: z.number() })
        .parse(JSON.parse(fs.readFileSync(path.join(relayDir, 'workspace.json'), 'utf8'))).rev
    await miniPage.waitForTimeout(1500)
    const settled = revOf()
    await miniPage.waitForTimeout(3000)
    expect(revOf()).toBe(settled)
  } finally {
    for (const app of apps) await app.close().catch(() => undefined)
    await web.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
