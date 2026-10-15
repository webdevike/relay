import { test, expect, chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { makeChatFixture } from './helpers/chat-fixture'
import {
  APP_DIR,
  EVA_FIXTURE_ROOT,
  FAKE_GATE,
  FAKE_JOB_RUN,
  FAKE_OMP,
  SESSIONS_FIXTURE_DIR,
} from './helpers/paths'

const EXE = path.join(APP_DIR, 'release/mac-arm64/EvaOS Electron.app/Contents/MacOS/EvaOS Electron')

test.skip(process.env.EVAOS_PACKAGED !== '1', 'set EVAOS_PACKAGED=1 after pnpm package')

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
    s.on('error', reject)
  })

type Invoke = { eva: { invoke(c: string, i: unknown): Promise<unknown> } }

// Playwright's _electron.launch only injects its main-process loader for the unpackaged electron
// binary, so the packaged .app is started directly and attached over CDP (renderer only).
test('packaged dir build launches, shows the shell and starts the extension host', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-pkg-'))
  const port = await freePort()
  const fakeLog = path.join(configDir, 'fake-log.jsonl')
  // Chats read a disposable copy of the fixture agent dir, never the live ~/.omp.
  const chatFx = makeChatFixture()
  const ompLog = path.join(configDir, 'fake-omp.jsonl')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('EVAOS_')) env[k] = v
  }
  Object.assign(env, {
    EVAOS_E2E: '1',
    EVAOS_CONFIG_DIR: configDir,
    EVAOS_EVA_ROOT: EVA_FIXTURE_ROOT,
    EVAOS_OMP_BIN: FAKE_OMP,
    EVAOS_SESSIONS_DIR: SESSIONS_FIXTURE_DIR,
    // Packaged builds default to live mode; the fakes win so the smoke never touches real Eva tools.
    EVAOS_HABIT_GATE_BIN: FAKE_GATE,
    EVAOS_JOB_RUN_BIN: FAKE_JOB_RUN,
    FAKE_LOG: fakeLog,
    FAKE_GATE_STATE: path.join(configDir, 'fake-gate.json'),
    FAKE_GATE_PHOTOS: path.join(configDir, 'habit-photos'),
    EVAOS_HABIT_PHOTOS_DIR: path.join(configDir, 'habit-photos'),
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    ...chatFx.launchEnv,
    FAKE_OMP_LOG: ompLog,
    FAKE_OMP_DELAY_MS: '10',
    EVAOS_HIDDEN_WINDOW: '1',
  })
  const child = spawn(EXE, [`--remote-debugging-port=${port}`], { env, stdio: 'ignore' })
  try {
    const browser = await (async () => {
      for (let i = 0; i < 100; i++) {
        try {
          return await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
        } catch {
          await new Promise((r) => setTimeout(r, 200))
        }
      }
      throw new Error('packaged app did not expose CDP')
    })()
    const errors: string[] = []
    const findShell = async () => {
      for (let i = 0; i < 100; i++) {
        const p = browser
          .contexts()
          .flatMap((c) => c.pages())
          .find((pg) => pg.url().includes('out/renderer/index.html'))
        if (p) return p
        await new Promise((r) => setTimeout(r, 200))
      }
      throw new Error('shell page not found')
    }
    const shell = await findShell()
    shell.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    shell.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`)
    })
    await shell.waitForSelector('[data-testid=rail]')
    // Loaded from inside the asar, i.e. the packaged build, not the dev tree.
    expect(shell.url()).toContain('app.asar')

    const info = (await shell.evaluate(() =>
      (window as unknown as Invoke).eva.invoke('app.info', {}),
    )) as { ok: boolean; value: Record<string, unknown> }
    expect(info.ok).toBe(true)
    expect(info.value.evaRoot).toBe(EVA_FIXTURE_ROOT)
    expect(info.value.configDir).toBe(configDir)
    expect(info.value.version).toBeTruthy()

    const ext = (await shell.evaluate(() =>
      (window as unknown as Invoke).eva.invoke('browser.extensions', {}),
    )) as { ok: boolean }
    expect(ext.ok).toBe(true)

    // Dashboard renders in the packaged build (banner assets and chokidar bundled).
    await expect(shell.locator('[data-testid=page-dashboard]')).toBeVisible()
    await expect(shell.locator('[data-testid=dash-hero]')).toBeVisible()
    // One habits poll, then prove only the fakes ran. The main-process 'spawnLog' hook is not
    // reachable over CDP in a packaged run, so the fakes' own FAKE_LOG is the record: every
    // spawn (gate or job-run) must have gone through them, and the gate was polled at least once.
    await shell.evaluate(() =>
      (
        window as unknown as { __evaosShell: { openPlace(p: string): void } }
      ).__evaosShell.openPlace('habits'),
    )
    await expect(shell.locator('[data-testid=page-habits]')).toBeVisible()
    await expect
      .poll(() => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim() : ''))
      .not.toBe('')
    const tools = fs
      .readFileSync(fakeLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { tool: string }).tool)
    expect(tools.length).toBeGreaterThan(0)
    for (const t of tools) expect(['gate', 'job-run']).toContain(t)

    // Chats: the tree lists the fixture sessions and a sent prompt starts only the fake omp,
    // resuming a file inside the fixture sessions dir (T-04-60).
    await shell.locator('[data-testid=nav-chat]').click()
    await shell.waitForSelector('[role=tree]')
    await expect(shell.locator('[data-testid="chat-row-p4-ecard"]')).toBeVisible()
    expect(await shell.locator('[data-testid^="chat-row-"]').count()).toBeGreaterThan(3)
    await shell.locator('[data-testid="chat-row-p4-ecard"]').click()
    await expect(shell.locator('[data-testid=chat-log]')).toContainText('Hello from p4-ecard')
    const box = shell.locator('[data-testid=composer-input]')
    await box.fill('packaged hello')
    await box.press('Enter')
    await expect(shell.locator('[data-testid=chat-log]')).toContainText(
      'Foxes are primarily nocturnal hunters',
    )
    const spawns = fs
      .readFileSync(ompLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; detail: { resumeFile?: string } | null })
      .filter((e) => e.event === 'spawn')
    expect(spawns.length).toBeGreaterThan(0)
    // Spawns without a resume file are side probes (e.g. the model catalog); any that resume a
    // session must resume one inside the fixture sessions dir, and at least one does.
    const resumed = spawns.map((sp) => sp.detail?.resumeFile).filter((f): f is string => !!f)
    expect(resumed.length).toBeGreaterThan(0)
    for (const f of resumed)
      expect(fs.realpathSync(f).startsWith(fs.realpathSync(chatFx.sessionsDir))).toBe(true)

    // The guest browser panel exists and the browser tab strip rendered.
    await expect(shell.locator('[data-testid=browser-slot]')).toBeVisible()
    await shell.waitForTimeout(500)
    expect(errors).toEqual([])
    await browser.close()
  } finally {
    child.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 500))
    fs.rmSync(configDir, { recursive: true, force: true })
    chatFx.cleanup()
  }
})
