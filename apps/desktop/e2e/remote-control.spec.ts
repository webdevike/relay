import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import type { ElectronApplication, Page } from '@playwright/test'
import { z } from 'zod'
import { test as base, expect, launchApp } from './fixtures'
import { REPO_ROOT } from './helpers/paths'

// Remote control through a real Relay Host (apps/linux, only remote control on, isolated config):
// the fixture app is the Mini's own desktop (local mode, loopback), a second hidden instance is
// the MacBook (remote mode, paired with the host). Agents on the Mini reach whichever one Isaac
// used last ("active"), the Mini's while neither has been touched; settings.set shows its Undo
// toast on the desktop that changed. relay-ctl (Eva's .omp/tools, RELAY_CTL overrides) is driven
// the same way when it is there.

const HOST_SCRIPT = path.join(REPO_ROOT, 'apps/linux/test/control-host.ts')
const RELAY_CTL = process.env.RELAY_CTL ?? path.join(os.homedir(), 'Eva/.omp/tools/relay-ctl.ts')
const BOOK_ID = `relay-desktop-${os.hostname()}:dev`

let host: ChildProcess
let tmp: string
let port = 0
let serveFile: string
let token = ''

const ServeSchema = z.object({ port: z.number(), controlToken: z.string() })
const DevicesSchema = z.object({
  ok: z.literal(true),
  value: z.object({
    active: z.string().nullable(),
    devices: z.array(z.object({ id: z.string(), local: z.boolean(), active: z.boolean() })),
  }),
})
const ReplySchema = z.object({
  ok: z.boolean(),
  value: z.unknown().optional(),
  code: z.string().optional(),
  device: z.object({ id: z.string(), name: z.string() }).nullable(),
})

const Described = z.object({ text: z.string() })

async function control(
  pathname: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${String(port)}${pathname}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json() }
}

const devices = async () => DevicesSchema.parse((await control('/control/devices')).json).value
const run = async (body: Record<string, unknown>) =>
  ReplySchema.parse((await control('/control/run', body)).json)

const test = base.extend({
  launchEnv: async ({}, use) => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-remote-control-')))
    const xdg = path.join(tmp, 'xdg')
    const relayDir = path.join(xdg, 'relay')
    fs.mkdirSync(relayDir, { recursive: true })
    host = spawn('bun', [HOST_SCRIPT, '--port', '0'], {
      cwd: path.join(REPO_ROOT, 'apps/linux'),
      env: { ...process.env, XDG_CONFIG_HOME: xdg },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    await new Promise<void>((resolve, reject) => {
      host.once('exit', (code) => reject(new Error(`control host exited ${String(code)}`)))
      host.stdout!.on('data', (d: Buffer) => {
        if (/ready \d+/.test(d.toString())) resolve()
      })
    })
    serveFile = path.join(relayDir, 'serve.json')
    const serve = ServeSchema.parse(JSON.parse(fs.readFileSync(serveFile, 'utf8')))
    port = serve.port
    token = serve.controlToken
    await use({ EVAOS_RELAY_DIR: relayDir, EVAOS_AGENT_CONTROL: '1' })
    host.kill('SIGTERM')
    fs.rmSync(tmp, { recursive: true, force: true })
  },
})
test.use({ startOnChat: false })

/** The MacBook: a hidden instance in remote mode, already paired with the host. */
async function launchBook(): Promise<{ app: ElectronApplication; page: Page }> {
  const configDir = path.join(tmp, 'book')
  fs.mkdirSync(configDir, { recursive: true })
  const authority = `127.0.0.1:${String(port)}`
  const secretHex = randomBytes(32).toString('hex')
  fs.writeFileSync(
    path.join(configDir, 'relay-remote.json'),
    JSON.stringify({ host: authority, paired: { id: authority, secretHex } }),
    { mode: 0o600 },
  )
  // The host's side of that pairing (what a PIN pairing writes).
  const devicesFile = path.join(tmp, 'xdg/relay/devices.json')
  const known = fs.existsSync(devicesFile)
    ? (JSON.parse(fs.readFileSync(devicesFile, 'utf8')) as Record<string, unknown>)
    : {}
  known[`relay-desktop-${os.hostname()}`] = { secretHex, name: 'Relay Desktop', pairedAt: 1 }
  fs.writeFileSync(devicesFile, JSON.stringify(known), { mode: 0o600 })
  const app = await launchApp(configDir, { EVAOS_AGENT_CONTROL: '1' })
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid=rail]')
  return { app, page }
}

test('agents on the Mini drive the desktop Isaac used last, through the Relay Host', async ({
  shell,
  configDir,
}) => {
  test.setTimeout(120_000)
  const book = await launchBook()
  try {
    // Both desktops register; untouched, "active" is the Mini's own app.
    await expect.poll(async () => (await devices()).devices.length, { timeout: 30_000 }).toBe(2)
    const before = await devices()
    const mini = before.devices.find((d) => d.local)!
    expect(before.devices.find((d) => !d.local)!.id).toBe(BOOK_ID)
    expect(before.active).toBe(mini.id)

    // Each shows a different page.
    expect(
      (await run({ target: BOOK_ID, action: 'page.open', params: { page: 'settings' } })).ok,
    ).toBe(true)
    expect((await run({ target: mini.id, action: 'page.open', params: { page: 'jobs' } })).ok).toBe(
      true,
    )

    // Isaac presses a key on the MacBook: it becomes active, describe answers its screen.
    await book.page.keyboard.press('Shift')
    await expect.poll(async () => (await devices()).active, { timeout: 10_000 }).toBe(BOOK_ID)
    const seen = await run({ action: 'describe' })
    expect(seen.device?.id).toBe(BOOK_ID)
    expect(Described.parse(seen.value).text).toMatch(/^Page: Settings/)

    // A setting changes on the MacBook, with Nova's Undo toast there and not on the Mini.
    const set = await run({
      action: 'settings.set',
      params: { key: 'theme.mode', value: 'dark' },
      scope: 'agent:nova',
    })
    expect(set).toMatchObject({ ok: true, value: { value: 'dark', changed: true } })
    await expect(book.page.getByTestId('agent-change-toast')).toHaveText(
      'Nova changed appearance to dark·Undo',
    )
    await expect(shell.getByTestId('agent-change-toast')).toHaveCount(0)
    expect(await run({ action: 'settings.undo' })).toMatchObject({
      ok: true,
      value: { key: 'theme.mode', value: 'light' },
    })
    const mode = await run({ action: 'settings.get', params: { key: 'theme.mode' } })
    expect(mode.value).toMatchObject({ settings: [{ value: 'light' }] })

    // Destructive rules are the desktop's: no confirm, no quit.
    expect(await run({ action: 'app.quit' })).toMatchObject({ ok: false, code: 'confirm-required' })

    // relay-ctl, as an agent on the Mini runs it.
    if (fs.existsSync(RELAY_CTL)) {
      // A fallback to the local app would reach the test's Mini, never Isaac's live app.
      const env = {
        ...process.env,
        RELAY_HOST_FILE: serveFile,
        RELAY_CTL_FILE: path.join(configDir, 'agent-control.json'),
        RELAY_ASSISTANT: 'nova',
      }
      const { stdout, stderr } = await promisify(execFile)(
        'bun',
        [RELAY_CTL, 'describe', '--device', 'active'],
        { env },
      )
      expect(stdout).toContain('Page: Settings')
      expect(stderr).toContain(`(${BOOK_ID}) via the Relay Host`)
    }

    // Back at the Mini: it is active again.
    await shell.keyboard.press('Shift')
    await expect.poll(async () => (await devices()).active, { timeout: 10_000 }).toBe(mini.id)
    const back = await run({ action: 'describe' })
    expect(Described.parse(back.value).text).toMatch(/^Page: Jobs/)
  } finally {
    await book.app.close()
  }
  // The MacBook's app quit: the host forgets it.
  await expect.poll(async () => (await devices()).devices.length).toBe(1)
})

test('the host refuses control without its token', async ({ shell }) => {
  await shell.waitForSelector('[data-testid=rail]')
  const res = await fetch(`http://127.0.0.1:${String(port)}/control/run`, {
    method: 'POST',
    headers: { authorization: `Bearer ${'0'.repeat(64)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'describe' }),
  })
  expect(res.status).toBe(401)
})
