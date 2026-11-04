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
import {
  APP_DIR,
  EVA_FIXTURE_ROOT,
  FAKE_CLAUDE_BRIDGE,
  FAKE_GATE,
  FAKE_JOB_RUN,
  FAKE_OMP,
  SESSIONS_FIXTURE_DIR,
} from './helpers/paths'

interface Fixtures {
  launchEnv: Record<string, string>
  startOnChat: boolean
  /**
   * The tool panes (Browser, Files, Artifacts right of the chat) show on a fresh config, as in
   * the app. false hides them once the tree is loaded, as Isaac's toggle does.
   */
  toolPanes: boolean
  configDir: string
  app: ElectronApplication
  shell: Page
  rendererErrors: string[]
}

/** Never inherit EVAOS_* from the test process: a spec must not launch the app in live mode by accident. */
export function buildLaunchEnv(
  configDir: string,
  launchEnv: Record<string, string> = {},
): Record<string, string> {
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
    // Phase 3: every launch runs the unlocked fake gate with per-test state, so no spec sees a gate overlay.
    EVAOS_HABIT_GATE_BIN: FAKE_GATE,
    EVAOS_JOB_RUN_BIN: FAKE_JOB_RUN,
    FAKE_GATE_STATE: path.join(configDir, 'fake-gate.json'),
    FAKE_GATE_PHOTOS: path.join(configDir, 'habit-photos'),
    EVAOS_HABIT_PHOTOS_DIR: path.join(configDir, 'habit-photos'),
    // Phase 4: no spec can start a real Claude run.
    EVAOS_CLAUDE_BRIDGE_BIN: FAKE_CLAUDE_BRIDGE,
    EVAOS_CLAUDE_BIN: FAKE_CLAUDE_BRIDGE,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    ...launchEnv,
    // Last, so no spec can make a test window visible over Isaac's work.
    EVAOS_HIDDEN_WINDOW: '1',
  })
  return env
}

/** `recordVideo`: Playwright records the window (still hidden) into that dir as webm. */
export function launchApp(
  configDir: string,
  launchEnv: Record<string, string> = {},
  recordVideo?: { dir: string; size?: { width: number; height: number } },
): Promise<ElectronApplication> {
  return _electron.launch({
    args: ['.'],
    cwd: APP_DIR,
    env: buildLaunchEnv(configDir, launchEnv),
    ...(recordVideo ? { recordVideo } : {}),
  })
}

export const test = base.extend<Fixtures>({
  launchEnv: [{}, { option: true }],
  startOnChat: [true, { option: true }],
  toolPanes: [true, { option: true }],
  configDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-e2e-'))
    await use(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  },
  app: async ({ configDir, launchEnv }, use) => {
    const app = await launchApp(configDir, launchEnv)
    await use(app)
    await app.close()
  },
  rendererErrors: async ({}, use) => {
    await use([])
  },
  shell: async ({ app, rendererErrors, startOnChat, toolPanes }, use) => {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => rendererErrors.push(`pageerror: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error') rendererErrors.push(`console: ${m.text()}`)
    })
    await page.waitForSelector('[data-testid=rail]')
    await page.waitForFunction(() =>
      Boolean((window as unknown as { __evaosShell?: unknown }).__evaosShell),
    )
    if (startOnChat) {
      await page.waitForSelector('[data-testid=tab-strip], [role=tablist]')
      await page.evaluate(() =>
        (window as unknown as { __evaosShell: { openChat(): void } }).__evaosShell.openChat(),
      )
      await page.waitForSelector('[data-testid=chat-pane]', { state: 'visible' })
    }
    if (!toolPanes) {
      type Hooks = { __evaosShell: { setPanel(open: boolean): void } }
      await page.waitForSelector('[data-pane-kind=app]', { state: 'attached' })
      await page.evaluate(() => (window as unknown as Hooks).__evaosShell.setPanel(false))
      await page.waitForSelector('[data-pane-kind=tool]', { state: 'hidden' })
    }
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
