import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { test, expect, buildLaunchEnv, launchApp } from './fixtures'
import { pickScheme } from './helpers/appearance'
import { APP_DIR } from './helpers/paths'

// Isaac's rule: what he changes in the UI stays changed across a renderer reload, a quit and
// reopen, and a bundle swap (a new build, same user data dir). One test, one Electron at a time.

const sel = (id: string): string => `[data-testid="${id}"]`
const TOOL = '[data-pane-kind=tool]'
type G = { __evaosTest: { win: { setContentSize(w: number, h: number): void } } }
type Hooks = { __evaosShell: { openChat(): void; setPanel(open: boolean): void } }

async function ready(app: ElectronApplication): Promise<Page> {
  const shell = await app.firstWindow()
  await shell.waitForSelector(sel('rail'), { state: 'attached' })
  await shell.waitForFunction(() =>
    Boolean((window as unknown as { __evaosShell?: unknown }).__evaosShell),
  )
  await app.evaluate(
    (_e, [w, h]) => (globalThis as unknown as G).__evaosTest.win.setContentSize(w!, h!),
    [1280, 1000],
  )
  return shell
}

async function openChatWithTools(shell: Page): Promise<void> {
  await shell.waitForSelector('[data-pane-kind=app]', { state: 'attached' })
  await shell.evaluate(() => (window as unknown as Hooks).__evaosShell.openChat())
  await shell.waitForSelector(sel('chat-pane'), { state: 'visible' })
  await shell.evaluate(() => (window as unknown as Hooks).__evaosShell.setPanel(true))
  await shell.waitForSelector(TOOL, { state: 'visible' })
}

interface Snapshot {
  scheme: string | null
  body: string
  nav: Array<string | null>
  sidebarOpen: string | null
  tool: number
}

async function snapshot(shell: Page): Promise<Snapshot> {
  const state = await shell.evaluate(() => ({
    scheme: document.documentElement.getAttribute('data-mantine-color-scheme'),
    body: getComputedStyle(document.documentElement)
      .getPropertyValue('--mantine-color-body')
      .trim()
      .toLowerCase(),
  }))
  const nav = await shell.$$eval('[data-testid=sidebar-main] [data-testid^="nav-"]', (els) =>
    els.slice(0, 2).map((e) => e.getAttribute('data-testid')),
  )
  const tool = (await shell.locator(TOOL).boundingBox())?.width ?? 0
  const sidebarOpen = await shell
    .locator(sel('sidebar-toggle'))
    .first()
    .getAttribute('aria-pressed')
  return { ...state, nav, sidebarOpen, tool: Math.round(tool) }
}

const layoutFile = (dir: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(dir, 'layout.json'), 'utf8')) as Record<string, unknown>

/** A copy of the built app in another folder: what an update leaves behind. */
function copyBundle(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-e2e-bundle-'))
  fs.cpSync(path.join(APP_DIR, 'out'), path.join(dir, 'out'), { recursive: true })
  fs.copyFileSync(path.join(APP_DIR, 'package.json'), path.join(dir, 'package.json'))
  fs.symlinkSync(path.join(APP_DIR, 'node_modules'), path.join(dir, 'node_modules'))
  return dir
}

test.use({ startOnChat: false })

test('theme, sidebar order, sidebar and panel widths survive reload, quit and a bundle swap', async ({
  configDir,
  launchEnv,
}) => {
  let app = await launchApp(configDir, launchEnv)
  let shell = await ready(app)
  let swapDir: string | null = null
  try {
    await openChatWithTools(shell)

    // Theme: preset Forest, dark.
    await shell.evaluate(() =>
      (
        window as unknown as {
          __evaosShell: {
            openPlace(p: string, n: boolean, x: { settingsSection: string }): void
          }
        }
      ).__evaosShell.openPlace('settings', false, { settingsSection: 'Theme' }),
    )
    await shell.getByTestId('theme-preset-picker').click()
    await shell.getByRole('option', { name: 'Forest' }).click()
    await pickScheme(shell, 'dark')
    await expect
      .poll(() =>
        shell.evaluate(() => document.documentElement.getAttribute('data-mantine-color-scheme')),
      )
      .toBe('dark')
    await shell.evaluate(() => (window as unknown as Hooks).__evaosShell.openChat())
    await shell.waitForSelector(sel('chat-pane'), { state: 'visible' })

    // Sidebar order: Meetings dragged above Assistants in Customize sidebar.
    await shell.locator(sel('nav-jobs')).click({ button: 'right' })
    await shell.locator(sel('sidebar-menu-customize')).click()
    const dialog = shell.locator(sel('customize-sidebar'))
    const grip = dialog.locator(sel('cz-grip-meetings'))
    const target = dialog.locator(sel('cz-row-assistants'))
    const g = (await grip.boundingBox())!
    const t = (await target.boundingBox())!
    await shell.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
    await shell.mouse.down()
    await shell.mouse.move(g.x + 20, g.y - 40, { steps: 6 })
    await shell.mouse.move(t.x + 40, t.y + t.height / 2, { steps: 12 })
    await shell.mouse.up()
    await expect
      .poll(() =>
        shell.$$eval('[data-testid^="cz-row-"]', (els) =>
          els.slice(0, 2).map((e) => e.getAttribute('data-testid')),
        ),
      )
      .toEqual(['cz-row-meetings', 'cz-row-assistants'])
    await shell.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // Sidebar width: drag its grip 60px wider.
    const grab = (await shell.locator(sel('grip-sidebar')).boundingBox())!
    const x = grab.x + grab.width / 2
    const y = grab.y + grab.height / 2
    await shell.mouse.move(x, y)
    await shell.mouse.down()
    await shell.mouse.move(x + 30, y, { steps: 3 })
    await shell.mouse.move(x + 60, y, { steps: 3 })
    await shell.mouse.up()
    await expect.poll(() => layoutFile(configDir)['sidebar_width']).toBe(332)

    // Tool panel width: drag the sash 80px.
    const sash = async () => {
      for (const el of await shell.locator('.dv-sash').all()) {
        const b = await el.boundingBox()
        if (b && b.height > 100) return b
      }
      throw new Error('no sash')
    }
    const before = (await shell.locator(TOOL).boundingBox())!.width
    const s = await sash()
    await shell.mouse.move(s.x + s.width / 2, s.y + s.height / 2)
    await shell.mouse.down()
    await shell.mouse.move(s.x + s.width / 2 - 40, s.y + s.height / 2, { steps: 3 })
    await shell.mouse.move(s.x + s.width / 2 - 80, s.y + s.height / 2, { steps: 3 })
    await shell.mouse.up()
    await expect
      .poll(async () => Math.round((await shell.locator(TOOL).boundingBox())!.width))
      .toBe(Math.round(before + 80))

    // The sidebar folded away.
    await shell.locator(sel('sidebar-toggle')).first().click()
    await expect(shell.locator(sel('sidebar-toggle')).first()).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    await expect
      .poll(async () => (await snapshot(shell)).tool)
      .toBeGreaterThan(Math.round(before + 80) - 1)
    // localStorage (reviews' viewed files, skills groups, launcher recents) rides on the same profile.
    await shell.evaluate(() => localStorage.setItem('e2e.probe', 'kept'))
    // Let the debounced saves land.
    await shell.waitForTimeout(600)
    const want = await snapshot(shell)
    expect(want.scheme).toBe('dark')
    expect(want.nav).toEqual(['nav-meetings', 'nav-assistants'])
    expect(want.sidebarOpen).toBe('false')
    expect(layoutFile(configDir)['ui']).toMatchObject({ 'shell.sidebarOpen': false })

    const same = async (page: Page, label: string): Promise<void> => {
      await page.waitForSelector(TOOL, { state: 'visible' })
      await expect
        .poll(
          async () => {
            const got = await snapshot(page)
            return { ...got, tool: Math.abs(got.tool - want.tool) <= 6 ? want.tool : got.tool }
          },
          { message: label },
        )
        .toEqual(want)
    }

    // (a) Renderer reload.
    await shell.reload()
    await shell.waitForSelector(sel('rail'), { state: 'attached' })
    await same(shell, 'after a renderer reload')

    // (b) Quit and reopen, same user data dir.
    await app.close()
    app = await launchApp(configDir, launchEnv)
    shell = await ready(app)
    await same(shell, 'after quit and reopen')
    // The saved sidebar width is the width shown when the sidebar comes back.
    await shell.locator(sel('sidebar-toggle')).first().click()
    await expect
      .poll(async () => (await shell.locator(sel('sidebar')).boundingBox())?.width)
      .toBe(332)
    await shell.locator(sel('sidebar-toggle')).first().click()
    await app.close()

    // (c) Bundle swap: the same build from another folder, same user data dir.
    swapDir = copyBundle()
    app = await _electron.launch({
      args: ['.'],
      cwd: swapDir,
      env: buildLaunchEnv(configDir, launchEnv),
    })
    shell = await ready(app)
    await same(shell, 'after a bundle swap')
    expect(await shell.evaluate(() => localStorage.getItem('e2e.probe'))).toBe('kept')
  } finally {
    await app.close().catch(() => {})
    if (swapDir) fs.rmSync(swapDir, { recursive: true, force: true })
  }
})
