import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp } from './fixtures'

type G = {
  __evaosTest: {
    win: { setContentSize(w: number, h: number): void }
    hooks: { browser: { host: { activeView(): { getVisible(): boolean } } } }
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

test('widths at 1280 and the fold vectors', async ({ app, shell }) => {
  await size(app, shell, 1280)
  expect((await box(shell, 'sidebar')).width).toBe(272)
  const panel = await box(shell, 'panel-card')
  expect(Math.abs(panel.width - 420)).toBeLessThanOrEqual(1)
  const main = await box(shell, 'main-card')
  expect(main.x).toBe(272)
  expect(Math.round(panel.x - (main.x + main.width))).toBe(8)
  expect((await box(shell, 'footer')).height).toBe(32)

  await size(app, shell, 1016)
  await expect.poll(() => state(shell)).toBe('open')
  await expect.poll(async () => (await box(shell, 'sidebar')).width).toBe(200)

  await size(app, shell, 1015)
  await expect.poll(() => state(shell)).toBe('folded')
  await expect.poll(async () => (await box(shell, 'sidebar')).width).toBe(0)
  await expect.poll(async () => (await box(shell, 'main-card')).x).toBe(8)

  for (const w of [800, 760]) {
    await size(app, shell, w)
    await expect.poll(async () => Math.round((await box(shell, 'panel-card')).width)).toBe(320)
    const p = await box(shell, 'panel-card')
    const m = await box(shell, 'main-card')
    expect(p.x + p.width).toBeLessThanOrEqual(w)
    expect(m.x + m.width).toBeLessThanOrEqual(p.x)
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
  await expect(shell.locator('[data-testid=panel-card]')).toBeHidden()
  await expect
    .poll(() =>
      app.evaluate(() =>
        (globalThis as unknown as G).__evaosTest.hooks.browser.host.activeView().getVisible(),
      ),
    )
    .toBe(false)
  await shell.keyboard.press('Meta+Shift+b')
  await expect(shell.locator('[data-testid=panel-card]')).toBeVisible()
  const actions = await shell.evaluate(() =>
    ((window as unknown as Hk).__evaosHotkeys ?? []).map((e) => e.action),
  )
  expect(actions).toContain('toggle-sidebar')
  expect(actions).toContain('toggle-panel')
})

test('grips drag, reset, occlude and keep unknown keys', async ({ app, shell, configDir }) => {
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

  const p = await box(shell, 'grip-panel')
  const px = p.x + p.width / 2
  const py = p.y + p.height / 2
  await shell.mouse.move(px, py)
  await shell.mouse.down()
  await shell.mouse.move(px - 40, py, { steps: 3 })
  await shell.mouse.move(px - 80, py, { steps: 3 })
  await expect
    .poll(() =>
      app.evaluate(() =>
        (globalThis as unknown as G).__evaosTest.hooks.browser.host.activeView().getVisible(),
      ),
    )
    .toBe(false)
  await shell.mouse.up()
  await expect.poll(async () => Math.round((await box(shell, 'panel-card')).width)).toBe(500)
  await expect.poll(() => layoutFile(configDir)['panel_width']).toBe(500)
  expect(layoutFile(configDir)['zoom']).toBe(2)
})

test('widths survive a relaunch', async ({ app, shell, configDir }) => {
  await size(app, shell, 1280)
  await drag(shell, 'grip-sidebar', 28)
  await drag(shell, 'grip-panel', -40)
  await expect.poll(() => layoutFile(configDir)['sidebar_width']).toBe(300)
  await expect.poll(() => layoutFile(configDir)['panel_width']).toBe(460)
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
    await expect.poll(async () => Math.round((await box(page, 'panel-card')).width)).toBe(460)
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
