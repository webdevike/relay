import { test, expect, chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { APP_DIR, EVA_FIXTURE_ROOT, FAKE_OMP, SESSIONS_FIXTURE_DIR } from './helpers/paths'

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
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
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

    // The guest browser panel exists and the browser tab strip rendered.
    await expect(shell.locator('[data-testid=browser-slot]')).toBeVisible()
    await shell.waitForTimeout(500)
    expect(errors).toEqual([])
    await browser.close()
  } finally {
    child.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 500))
    fs.rmSync(configDir, { recursive: true, force: true })
  }
})
