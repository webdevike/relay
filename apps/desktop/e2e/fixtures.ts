import {
  test as base,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { APP_DIR, EVA_FIXTURE_ROOT, FAKE_OMP, SESSIONS_FIXTURE_DIR } from './helpers/paths'

interface Fixtures {
  launchEnv: Record<string, string>
  configDir: string
  app: ElectronApplication
  shell: Page
  rendererErrors: string[]
}

export const test = base.extend<Fixtures>({
  launchEnv: [{}, { option: true }],
  configDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-e2e-'))
    await use(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  },
  app: async ({ configDir, launchEnv }, use) => {
    // Never inherit EVAOS_* from the test process: a spec must not launch the app in live mode by accident.
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
      ...launchEnv,
    })
    const app = await _electron.launch({ args: ['.'], cwd: APP_DIR, env })
    await use(app)
    await app.close()
  },
  rendererErrors: async ({}, use) => {
    await use([])
  },
  shell: async ({ app, rendererErrors }, use) => {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => rendererErrors.push(`pageerror: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error') rendererErrors.push(`console: ${m.text()}`)
    })
    await page.waitForSelector('[data-testid=rail]')
    await use(page)
    // A spec that quits the app itself (quit lifecycle) leaves nothing to ask.
    const mainErrors = await app
      .evaluate(
        () =>
          (globalThis as unknown as { __evaosTest?: { errors: string[] } }).__evaosTest?.errors ??
          [],
      )
      .catch(() => [] as string[])
    expect(rendererErrors, 'renderer console errors').toEqual([])
    expect(mainErrors, 'main-side console errors').toEqual([])
  },
})

export { expect }
