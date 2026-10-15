import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp } from './fixtures'

test.use({ startOnChat: false, colorScheme: 'dark' })

interface Hooks {
  openPlace(page: string, newTab?: boolean, extra?: { settingsSection: string }): void
  tabs(): { active: number; list: Array<{ title: string }> }
}
type W = { __evaosShell?: Hooks }

type Section = 'Theme' | 'Chat' | 'Notifications'

async function open(page: Page, section: Section): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as W).__evaosShell))
  await page.evaluate(
    (s) =>
      (window as unknown as W).__evaosShell!.openPlace('settings', false, { settingsSection: s }),
    section,
  )
  await page.waitForSelector(`[data-testid=settings-${section.toLowerCase()}]`)
}

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

test('sections render their native content and tab titles', async ({ shell }) => {
  const cases: [Section, string | null][] = [
    ['Theme', null],
    ['Chat', "What conversations show besides Eva's replies."],
    ['Notifications', 'How the inbox tells you about new items.'],
  ]
  for (const [section, desc] of cases) {
    await open(shell, section)
    const root = shell.locator(`[data-testid=settings-${section.toLowerCase()}]`)
    if (desc) {
      await expect(root.locator('h1')).toHaveText(section)
      await expect(root).toContainText(desc)
    } else {
      await expect(root.getByTestId('theme-editor')).toBeVisible()
      await expect(root.getByRole('heading', { name: 'Preview', exact: true })).toBeVisible()
    }
    const tabs = await shell.evaluate(() => (window as unknown as W).__evaosShell!.tabs())
    expect(tabs.list[tabs.active]!.title).toBe(`Settings: ${section}`)
  }
})

test('chat switches persist, survive relaunch', async ({ app, shell, configDir }) => {
  await open(shell, 'Chat')
  const thinking = shell.locator('[data-testid=settings-show-thinking]')
  const tools = shell.locator('[data-testid=settings-show-tools]')
  await expect(thinking).not.toBeChecked()
  await expect(tools).toBeChecked()
  await shell.getByText('Show thinking', { exact: true }).click()
  await expect(thinking).toBeChecked()
  await expect(tools).toBeChecked()
  const file = path.join(configDir, 'chat.json')
  await expect
    .poll(() => {
      const d = readJson(file)
      return d ? String(d['show_thinking']) : ''
    })
    .toBe('true')
  await app.close()

  const app2 = await launchApp(configDir)
  try {
    const page = await app2.firstWindow()
    await page.waitForSelector('[data-testid=rail]', { state: 'attached' })
    await open(page, 'Chat')
    await expect(page.locator('[data-testid=settings-show-thinking]')).toBeChecked()
    await expect(page.locator('[data-testid=settings-show-tools]')).toBeChecked()
  } finally {
    await app2.close()
  }
})

test('appearance applies live from Settings and persists to theme.json', async ({
  shell,
  configDir,
}) => {
  await shell.emulateMedia({ colorScheme: 'dark' })
  await open(shell, 'Theme')
  const ctl = shell.locator('[data-testid=settings-theme] .eva-theme-mode-row')
  await expect(ctl).toBeVisible()
  await expect(ctl.getByRole('radio', { name: 'System', exact: true })).toHaveCount(0)
  await expect(shell.locator('html')).toHaveAttribute('data-appearance', 'system')
  await shell.evaluate(() => {
    ;(window as unknown as { __tag: Element | null }).__tag = document.querySelector(
      '[data-testid=settings-theme]',
    )
  })
  const html = shell.locator('html')
  const themeFile = path.join(configDir, 'theme.json')
  const appearance = () =>
    (readJson(themeFile)?.['app'] as { appearance?: string } | undefined)?.appearance

  await ctl.getByText('Light', { exact: true }).click()
  await expect(html).toHaveAttribute('data-resolved', 'light')
  await expect(html).toHaveAttribute('data-appearance', 'light')
  expect(
    await shell.evaluate(() => {
      const tag = (window as unknown as { __tag: Element }).__tag
      return tag.isConnected && tag === document.querySelector('[data-testid=settings-theme]')
    }),
  ).toBe(true)
  await expect.poll(appearance).toBe('light')

  await ctl.getByText('Dark', { exact: true }).click()
  await expect(html).toHaveAttribute('data-resolved', 'dark')
  await expect.poll(appearance).toBe('dark')

  await shell.getByTestId('appearance').getByTestId('appearance-system').click()
  await expect(html).toHaveAttribute('data-appearance', 'system')
  await expect(html).toHaveAttribute('data-resolved', 'dark')
  await expect(ctl.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked()
  await expect.poll(appearance).toBe('system')
})

test('arrow keys move the native Light and Dark edit selection', async ({ shell }) => {
  await open(shell, 'Theme')
  const html = shell.locator('html')
  const ctl = shell.locator('[data-testid=settings-theme] .eva-theme-mode-row')
  // System resolves to Dark; the editor offers the two actual mode palettes.
  await ctl.getByRole('radio', { name: 'Dark', exact: true }).focus()
  await shell.keyboard.press('ArrowLeft')
  await expect(html).toHaveAttribute('data-appearance', 'light')
  await expect(ctl.getByRole('radio', { name: 'Light', exact: true })).toBeChecked()
  await shell.keyboard.press('ArrowRight')
  await expect(html).toHaveAttribute('data-appearance', 'dark')
  await expect(ctl.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked()
})
