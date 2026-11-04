import type { ElectronApplication, Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test as base, expect, launchApp } from './fixtures'
import { pickScheme } from './helpers/appearance'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { APP_DIR } from './helpers/paths'

// One tmp copy of the agent-p4 fixture per test, so a favorited chat is a real fixture chat.
let fx: ChatFixture
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    await use(fx.launchEnv)
    fx.cleanup()
  },
})

const SHOTS = path.join(APP_DIR, 'test-results', 'sidebar-customize')
const sel = (id: string): string => `[data-testid="${id}"]`

async function open(configDir: string, env: Record<string, string>) {
  const app = await launchApp(configDir, env)
  const shell = await app.firstWindow()
  await shell.waitForSelector(sel('rail'))
  await shell.waitForFunction(() =>
    Boolean((window as unknown as { __evaosShell?: unknown }).__evaosShell),
  )
  return { app, shell }
}

const saved = (configDir: string): Record<string, unknown> => {
  const layout = JSON.parse(fs.readFileSync(path.join(configDir, 'layout.json'), 'utf8')) as {
    sidebar: Record<string, unknown>
  }
  return layout.sidebar
}

async function chooseVisibility(shell: Page, id: string, label: string): Promise<void> {
  await shell.locator(sel(`cz-visibility-${id}`)).click()
  await shell.getByRole('option', { name: label, exact: true }).click()
}

test('customize the sidebar: menu, dialog, hidden rows, favorites and relaunch', async ({
  configDir,
  launchEnv,
}) => {
  fs.mkdirSync(SHOTS, { recursive: true })
  const first = await open(configDir, launchEnv)
  let app: ElectronApplication = first.app
  let shell = first.shell
  try {
    await shell.setViewportSize({ width: 1280, height: 1000 })
    await pickScheme(shell, 'dark')
    await expect(shell.locator(sel('nav-habits'))).toBeVisible()

    // Right click: Visibility submenu, Customize sidebar, Copy link, Open in new tab.
    await shell.locator(sel('nav-habits')).click({ button: 'right' })
    const menu = shell.locator(sel('sidebar-menu'))
    await expect(menu.locator(sel('sidebar-menu-customize'))).toBeVisible()
    await expect(menu.locator(sel('sidebar-menu-copy'))).toBeVisible()
    await expect(menu.locator(sel('sidebar-menu-newtab'))).toBeVisible()
    await menu.locator(sel('sidebar-menu-visibility')).hover()
    await expect(shell.locator(sel('sidebar-menu-vis-badged'))).toBeVisible()
    await shell.screenshot({ path: path.join(SHOTS, 'menu.png') })

    // Show when badged: Habits has no badge, so it leaves the sidebar.
    await shell.locator(sel('sidebar-menu-vis-badged')).click()
    await expect(shell.locator(sel('nav-habits'))).toHaveCount(0)
    // The menu on a section header carries the same Visibility submenu.
    await shell.locator(sel('sidebar-dashboards-head')).click({ button: 'right' })
    await expect(shell.locator(sel('sidebar-menu-visibility'))).toBeVisible()
    await shell.keyboard.press('Escape')

    // Customize sidebar: hide Test Bench, badged Jobs, and move Meetings to the top.
    await shell.locator(sel('nav-jobs')).click({ button: 'right' })
    await shell.locator(sel('sidebar-menu-customize')).click()
    const dialog = shell.locator(sel('customize-sidebar'))
    await expect(dialog.locator(sel('cz-group-main'))).toBeVisible()
    await expect(dialog.locator(sel('cz-group-dashboards'))).toBeVisible()
    await chooseVisibility(shell, 'test-bench', "Don't show")
    await expect(shell.locator(sel('nav-test-bench'))).toHaveCount(0)
    await expect(dialog.locator(sel('cz-row-test-bench'))).toHaveAttribute('data-hidden', 'true')
    await chooseVisibility(shell, 'habits', 'Always show')
    await expect(shell.locator(sel('nav-habits'))).toBeVisible()
    await shell.locator(sel('cz-badge-style')).click()
    await shell.getByRole('option', { name: 'Dot', exact: true }).click()
    await expect(shell.locator(sel('count-jobs'))).toHaveClass(/eva-sb-dot/)
    await shell.locator(sel('cz-badge-style')).click()
    await shell.getByRole('option', { name: 'Count', exact: true }).click()

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
      .poll(async () =>
        shell.$$eval('[data-testid^="cz-row-"]', (els) =>
          els.slice(0, 2).map((e) => e.getAttribute('data-testid')),
        ),
      )
      .toEqual(['cz-row-meetings', 'cz-row-assistants'])
    await shell.screenshot({ path: path.join(SHOTS, 'customize-dark.png') })
    await pickScheme(shell, 'light')
    // Colors ease between schemes; shoot once they have settled.
    await shell.waitForTimeout(600)
    await shell.screenshot({ path: path.join(SHOTS, 'customize-light.png') })
    await pickScheme(shell, 'dark')
    await shell.waitForTimeout(600)
    await shell.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(shell.locator(sel('nav-test-bench'))).toHaveCount(0)
    const ids = await shell.$$eval('[data-testid=sidebar-main] [data-testid^="nav-"]', (els) =>
      els.map((e) => e.getAttribute('data-testid')),
    )
    expect(ids.slice(0, 2)).toEqual(['nav-meetings', 'nav-assistants'])
    await shell.locator(sel('sidebar')).screenshot({ path: path.join(SHOTS, 'hidden-item.png') })

    // Favorites: a page, a chat, and a folder holding one of them.
    await shell.locator(sel('nav-jobs')).click({ button: 'right' })
    await shell.locator(sel('sidebar-menu-favorite')).click()
    await shell.locator(sel('nav-meetings')).click({ button: 'right' })
    await shell.locator(sel('sidebar-menu-favorite')).click()
    await shell.locator(sel('nav-chat')).click()
    await shell.waitForSelector(sel('chat-tree'))
    await shell.locator('[data-testid^="chat-row-"]').first().click({ button: 'right' })
    await shell.locator(sel('sidebar-menu-favorite')).click()
    await shell.locator(sel('sidebar-back')).click()
    await expect(shell.locator(sel('fav-item'))).toHaveCount(3)
    await shell.locator(sel('favorites-new-folder')).click()
    await shell.locator(sel('fav-rename')).fill('Work')
    await shell.locator(sel('fav-rename')).press('Enter')
    await expect(shell.locator(sel('fav-folder'))).toHaveAttribute('data-title', 'Work')

    const jobs = shell.locator(sel('fav-item')).filter({ hasText: 'Jobs' })
    const folder = shell.locator(sel('fav-folder'))
    const j = (await jobs.boundingBox())!
    const f = (await folder.boundingBox())!
    await shell.mouse.move(j.x + 40, j.y + j.height / 2)
    await shell.mouse.down()
    await shell.mouse.move(j.x + 44, j.y + 10, { steps: 4 })
    await shell.mouse.move(f.x + 40, f.y + f.height / 2, { steps: 12 })
    await shell.mouse.up()
    await expect(shell.locator(sel('fav-item'))).toHaveCount(3)
    await expect(folder.locator('..').locator('.eva-sb-fav-nested')).toHaveCount(1)
    const indent = await shell
      .locator('.eva-sb-fav-nested')
      .evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))
    const flat = await shell
      .locator('.eva-sb-fav:not(.eva-sb-fav-nested)')
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))
    expect(indent).toBeGreaterThan(flat + 8)
    await shell.locator(sel('sidebar')).screenshot({ path: path.join(SHOTS, 'favorites.png') })

    // Persisted in layout.json, and applied again after a relaunch.
    await expect.poll(() => JSON.stringify(saved(configDir))).toContain('"Work"')
    const sidebar = saved(configDir) as {
      badgeStyle: string
      visibility: Record<string, string>
      order: Record<string, string[]>
      favorites: Array<{ kind: string; items?: unknown[] }>
    }
    expect(sidebar.badgeStyle).toBe('count')
    expect(sidebar.visibility).toMatchObject({ 'test-bench': 'never' })
    expect(sidebar.order['main']?.[0]).toBe('meetings')
    expect(sidebar.favorites.map((n) => n.kind)).toEqual(['item', 'item', 'folder'])

    await app.close()
    ;({ app, shell } = await open(configDir, launchEnv))
    await expect(shell.locator(sel('nav-meetings'))).toBeVisible()
    await expect(shell.locator(sel('nav-test-bench'))).toHaveCount(0)
    await expect(shell.locator(sel('fav-folder'))).toHaveAttribute('data-title', 'Work')
    await expect(shell.locator(sel('fav-item'))).toHaveCount(3)
    const after = await shell.$$eval('[data-testid=sidebar-main] [data-testid^="nav-"]', (els) =>
      els.map((e) => e.getAttribute('data-testid')),
    )
    expect(after.slice(0, 2)).toEqual(['nav-meetings', 'nav-assistants'])
    // A favorited page opens from its row.
    await shell.locator(sel('fav-item')).filter({ hasText: 'Meetings' }).click()
    await expect(shell.locator(sel('sidebar'))).toHaveAttribute('data-sidebar-level', 'root')
  } finally {
    await app.close().catch(() => {})
  }
})
