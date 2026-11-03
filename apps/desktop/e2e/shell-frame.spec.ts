import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp } from './fixtures'

type G = {
  __evaosTest: {
    win: { setContentSize(w: number, h: number): void }
    // A scope may have no tabs, and so no active view.
    hooks: { browser: { host: { activeView(): { getVisible(): boolean } | undefined } } }
  }
}
type Hk = { __evaosHotkeys?: Array<{ action: string }> }

test.use({ colorScheme: 'dark' })

async function size(app: ElectronApplication, shell: Page, w: number, h = 800): Promise<void> {
  await app.evaluate(
    (_e, [ww, hh]) => (globalThis as unknown as G).__evaosTest.win.setContentSize(ww!, hh!),
    [w, h],
  )
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(w)
}

const box = async (shell: Page, id: string) => {
  const b = await shell.locator(`[data-testid=${id}]`).boundingBox()
  if (!b) throw new Error(`no box for ${id}`)
  return b
}

const layoutFile = (dir: string): Record<string, unknown> => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'layout.json'), 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return {}
  }
}

async function drag(shell: Page, id: string, dx: number): Promise<void> {
  const b = await box(shell, id)
  const x = b.x + b.width / 2
  const y = b.y + b.height / 2
  await shell.mouse.move(x, y)
  await shell.mouse.down()
  await shell.mouse.move(x + dx / 2, y, { steps: 4 })
  await shell.mouse.move(x + dx, y, { steps: 4 })
  await shell.mouse.up()
}

const state = (shell: Page) =>
  shell.locator('[data-testid=shell]').getAttribute('data-sidebar-state')

/** The tool pane's share of its row in the saved tree (the root split's last child). */
const savedToolShare = (dir: string): number | undefined => {
  const t = layoutFile(dir)['tiling'] as { root?: { sizes?: number[] } } | undefined
  return t?.root?.sizes?.[1]
}

test('widths at 1280 and the fold vectors', async ({ app, shell }) => {
  await size(app, shell, 1280)
  expect((await box(shell, 'sidebar')).width).toBe(272)
  // The chat and the default tool pane share the room right of the sidebar, 8px apart, with
  // 8px to the window edge; the tool pane's card starts level with the chat's card.
  const main = await box(shell, 'main-card')
  const tool = await box(shell, 'pane-p2')
  expect(main.x).toBe(272)
  expect(Math.round(tool.x - (main.x + main.width))).toBe(8)
  expect(Math.round(tool.x + tool.width)).toBe(1280 - 8)
  expect(tool.y).toBe(main.y)
  expect(Math.abs(tool.width / (tool.width + main.width) - 0.34)).toBeLessThan(0.01)
  expect((await box(shell, 'footer')).height).toBe(32)

  // The sidebar folds only when it cannot keep 200px beside the panes' smallest width
  // (chat 480 + gap 8 + tool pane 240).
  await size(app, shell, 936)
  await expect.poll(() => state(shell)).toBe('open')
  await expect.poll(async () => (await box(shell, 'sidebar')).width).toBe(200)

  await size(app, shell, 935)
  await expect.poll(() => state(shell)).toBe('folded')
  await expect.poll(async () => (await box(shell, 'sidebar')).width).toBe(0)
  await expect.poll(async () => (await box(shell, 'main-card')).x).toBe(8)

  for (const w of [800, 760]) {
    await size(app, shell, w)
    await expect
      .poll(async () => {
        const p = await box(shell, 'pane-p2')
        return Math.round(p.x + p.width)
      })
      .toBe(w - 8)
    const p = await box(shell, 'pane-p2')
    const m = await box(shell, 'main-card')
    expect(m.x + m.width).toBeLessThanOrEqual(p.x)
    expect(m.width).toBeGreaterThanOrEqual(480)
    expect(p.width).toBeGreaterThanOrEqual(240)
  }
})

test('Cmd+B and Cmd+Shift+B go through the router', async ({ app, shell }) => {
  await size(app, shell, 1280)
  await shell.locator('[data-testid=shell]').click({ position: { x: 600, y: 790 } })
  await shell.keyboard.press('Meta+b')
  await expect.poll(() => state(shell)).toBe('hidden')
  await shell.keyboard.press('Meta+b')
  await expect.poll(() => state(shell)).toBe('open')

  await size(app, shell, 760)
  await expect.poll(() => state(shell)).toBe('folded')
  await shell.keyboard.press('Meta+b')
  await expect.poll(() => state(shell)).toBe('hidden')
  await shell.keyboard.press('Meta+b')
  await expect.poll(() => state(shell)).toBe('folded')

  await size(app, shell, 1280)
  await shell.keyboard.press('Meta+Shift+b')
  await expect(shell.locator('[data-testid=pane-p2]')).toBeHidden()
  await expect
    .poll(() =>
      app.evaluate(
        () =>
          (globalThis as unknown as G).__evaosTest.hooks.browser.host.activeView()?.getVisible() ??
          false,
      ),
    )
    .toBe(false)
  await shell.keyboard.press('Meta+Shift+b')
  await expect(shell.locator('[data-testid=pane-p2]')).toBeVisible()
  const actions = await shell.evaluate(() =>
    ((window as unknown as Hk).__evaosHotkeys ?? []).map((e) => e.action),
  )
  expect(actions).toContain('toggle-sidebar')
  expect(actions).toContain('toggle-panel')
})

test('grips and dividers drag, reset, occlude and keep unknown keys', async ({
  app,
  shell,
  configDir,
}) => {
  await size(app, shell, 1280)
  // Let the app write its first layout, then add an unknown key.
  const file = path.join(configDir, 'layout.json')
  fs.writeFileSync(file, JSON.stringify({ ...layoutFile(configDir), zoom: 2 }))

  const g = await box(shell, 'grip-sidebar')
  const x = g.x + g.width / 2
  const y = g.y + g.height / 2
  await shell.mouse.move(x, y)
  await shell.mouse.down()
  await shell.mouse.move(x + 30, y, { steps: 3 })
  await shell.mouse.move(x + 60, y, { steps: 3 })
  expect((await box(shell, 'sidebar')).width).toBe(332)
  // Nothing is written while the button is down.
  expect(layoutFile(configDir)['sidebar_width']).not.toBe(332)
  await shell.mouse.up()
  await expect.poll(() => layoutFile(configDir)['sidebar_width']).toBe(332)
  expect(layoutFile(configDir)['zoom']).toBe(2)

  await shell.locator('[data-testid=grip-sidebar]').dblclick()
  await expect.poll(() => layoutFile(configDir)['sidebar_width']).toBe(272)
  expect((await box(shell, 'sidebar')).width).toBe(272)

  // The divider between the chat and the tool pane: the browser view hides while it moves.
  const before = await box(shell, 'pane-p2')
  const p = await box(shell, 'divider-s1-0')
  const px = p.x + p.width / 2
  const py = p.y + p.height / 2
  await shell.mouse.move(px, py)
  await shell.mouse.down()
  await shell.mouse.move(px - 40, py, { steps: 3 })
  await shell.mouse.move(px - 80, py, { steps: 3 })
  await expect
    .poll(() =>
      app.evaluate(
        () =>
          (globalThis as unknown as G).__evaosTest.hooks.browser.host.activeView()?.getVisible() ??
          false,
      ),
    )
    .toBe(false)
  await shell.mouse.up()
  const want = Math.round(before.width + 80)
  await expect.poll(async () => Math.round((await box(shell, 'pane-p2')).width)).toBe(want)
  // The share is of the row's room without its gap.
  const room = (await box(shell, 'tiling')).width - 8
  await expect
    .poll(() => Math.abs((savedToolShare(configDir) ?? 0) - want / room))
    .toBeLessThan(0.002)
  expect(layoutFile(configDir)['zoom']).toBe(2)
  // Double-click shares the two evenly.
  await shell.locator('[data-testid=divider-s1-0]').dblclick()
  await expect.poll(() => savedToolShare(configDir)).toBe(0.5)
  expect(layoutFile(configDir)['zoom']).toBe(2)
})

test('widths survive a relaunch', async ({ app, shell, configDir }) => {
  await size(app, shell, 1280)
  await drag(shell, 'grip-sidebar', 28)
  await drag(shell, 'divider-s1-0', -40)
  await expect.poll(() => layoutFile(configDir)['sidebar_width']).toBe(300)
  const tool = Math.round((await box(shell, 'pane-p2')).width)
  // The divider drag is saved before the app quits.
  await expect.poll(() => savedToolShare(configDir)).not.toBeCloseTo(0.34, 2)
  await app.close()

  const app2 = await launchApp(configDir)
  try {
    const page = await app2.firstWindow()
    await page.waitForSelector('[data-testid=rail]', { state: 'attached' })
    await app2.evaluate(() =>
      (globalThis as unknown as G).__evaosTest.win.setContentSize(1280, 800),
    )
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1280)
    await expect.poll(async () => (await box(page, 'sidebar')).width).toBe(300)
    await expect.poll(async () => Math.round((await box(page, 'pane-p2')).width)).toBe(tool)
  } finally {
    await app2.close()
  }
})

test('an old side panel seeds the first tree once', async ({ configDir }) => {
  fs.writeFileSync(
    path.join(configDir, 'layout.json'),
    JSON.stringify({
      sidebar_width: 272,
      panel_width: 420,
      panel_tool: 'files',
      panel_choices: { 'page:dashboard': false },
    }),
  )
  const app2 = await launchApp(configDir)
  try {
    const page = await app2.firstWindow()
    await page.waitForSelector('[data-testid=pane-p2]')
    await expect(page.locator('[data-testid="pane-tab-files"]')).toHaveAttribute(
      'data-active',
      'true',
    )
    // Its width becomes the tool pane's share, so the pane opens about as wide as the panel was.
    expect(Math.abs((await box(page, 'pane-p2')).width - 420)).toBeLessThanOrEqual(8)
    await expect.poll(() => layoutFile(configDir)['tiling']).toBeTruthy()
    expect(layoutFile(configDir)).not.toHaveProperty('panel_choices')
    expect(layoutFile(configDir)).not.toHaveProperty('panel_tool')
  } finally {
    await app2.close()
  }
})

test('malformed layout.json is reset with one toast', async ({ configDir }) => {
  fs.writeFileSync(path.join(configDir, 'layout.json'), '{not json')
  const app2 = await launchApp(configDir)
  try {
    const page = await app2.firstWindow()
    await expect(page.getByText('Layout was reset to defaults.')).toHaveCount(1)
  } finally {
    await app2.close()
  }
})

test.describe('tool panes hidden', () => {
  test.use({ toolPanes: false })

  test('stay hidden across page changes and a reload', async ({ shell }) => {
    const tools = shell.locator('[data-testid=pane-p2]')
    const toggle = shell.locator('[data-testid=panel-toggle]:visible').first()
    await expect(tools).toBeHidden()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await shell.locator('[data-testid=nav-dashboard]').click()
    await shell.locator('[data-testid=nav-chat]').click()
    await expect(tools).toBeHidden()
    await shell.reload()
    await shell.waitForSelector('[data-testid=rail]')
    await shell.waitForSelector('[data-pane-id=chat]', { state: 'attached' })
    await expect(tools).toBeHidden()
    await expect(shell.locator('[data-testid=panel-toggle]:visible').first()).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })
})
