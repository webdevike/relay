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

test('sections render with titles, descriptions and tab titles', async ({ shell }) => {
  const cases: [Section, string][] = [
    ['Theme', 'Colors, fonts and shape for the whole app.'],
    ['Chat', "What conversations show besides Eva's replies."],
    ['Notifications', 'How the inbox tells you about new items.'],
  ]
  for (const [section, desc] of cases) {
    await open(shell, section)
    const root = shell.locator(`[data-testid=settings-${section.toLowerCase()}]`)
    await expect(root.locator('h1')).toHaveText(section)
    await expect(root).toContainText(desc)
    const tabs = await shell.evaluate(() => (window as unknown as W).__evaosShell!.tabs())
    expect(tabs.list[tabs.active]!.title).toBe(`Settings: ${section}`)
  }
})

test('chat switches persist, survive relaunch', async ({ app, shell, configDir }) => {
  await open(shell, 'Chat')
  const thinking = shell.locator('[data-testid=settings-show-thinking]')
  const tools = shell.locator('[data-testid=settings-show-tools]')
  await expect(thinking).toBeChecked()
  await expect(tools).toBeChecked()
  await shell.getByText('Show thinking', { exact: true }).click()
  await expect(thinking).not.toBeChecked()
  await expect(tools).toBeChecked()
  const file = path.join(configDir, 'settings.json')
  await expect
    .poll(() => {
      const d = readJson(file)
      return d ? `${d['show_thinking']}|${d['show_tools']}` : ''
    })
    .toBe('false|true')
  await app.close()

  const app2 = await launchApp(configDir)
  try {
    const page = await app2.firstWindow()
    await page.waitForSelector('[data-testid=rail]', { state: 'attached' })
    await open(page, 'Chat')
    await expect(page.locator('[data-testid=settings-show-thinking]')).not.toBeChecked()
    await expect(page.locator('[data-testid=settings-show-tools]')).toBeChecked()
  } finally {
    await app2.close()
  }
})

test('appearance applies live from Settings and persists to theme.json', async ({
  shell,
  configDir,
}) => {
  await open(shell, 'Theme')
  const ctl = shell.locator('[data-testid=appearance-settings]')
  await expect(ctl).toBeVisible()
  await expect(ctl.locator('[data-testid=appearance-system]')).toHaveAttribute(
    'data-active',
    'true',
  )
  await shell.evaluate(() => {
    ;(window as unknown as { __tag: Element | null }).__tag = document.querySelector(
      '[data-testid=settings-theme]',
    )
  })
  const html = shell.locator('html')
  const themeFile = path.join(configDir, 'theme.json')
  const appearance = () =>
    (readJson(themeFile)?.['app'] as { appearance?: string } | undefined)?.appearance

  await ctl.locator('[data-testid=appearance-light]').click()
  await expect(html).toHaveAttribute('data-resolved', 'light')
  await expect(html).toHaveAttribute('data-appearance', 'light')
  expect(
    await shell.evaluate(() => {
      const tag = (window as unknown as { __tag: Element }).__tag
      return tag.isConnected && tag === document.querySelector('[data-testid=settings-theme]')
    }),
  ).toBe(true)
  await expect.poll(appearance).toBe('light')

  await ctl.locator('[data-testid=appearance-dark]').click()
  await expect(html).toHaveAttribute('data-resolved', 'dark')
  await expect.poll(appearance).toBe('dark')
})

test('arrow keys move the appearance selection', async ({ shell }) => {
  await open(shell, 'Theme')
  const html = shell.locator('html')
  await shell.locator('[data-testid=appearance-settings] input:checked').focus()
  // Selection starts on System (last); ArrowLeft moves to Dark.
  await shell.keyboard.press('ArrowLeft')
  await expect(html).toHaveAttribute('data-appearance', 'dark')
  await shell.keyboard.press('ArrowLeft')
  await expect(html).toHaveAttribute('data-appearance', 'light')
})
