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

type Section = 'Theme' | 'Chat'

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

test(
  'sections render their native content and tab titles',
  { tag: '@smoke' },
  async ({ shell }) => {
    const cases: [Section, string | null][] = [
      ['Theme', null],
      ['Chat', "What conversations show besides Eva's replies."],
    ]
    for (const [section, desc] of cases) {
      await open(shell, section)
      const root = shell.locator(`[data-testid=settings-${section.toLowerCase()}]`)
      if (desc) {
        await expect(root.locator('h1')).toHaveText(section)
        await expect(root).toContainText(desc)
      } else {
        await expect(root.getByTestId('theme-editor')).toBeVisible()
        await expect(root.getByRole('heading', { name: 'Buttons', exact: true })).toBeVisible()
      }
      const tabs = await shell.evaluate(() => (window as unknown as W).__evaosShell!.tabs())
      expect(tabs.list[tabs.active]!.title).toBe(`Settings: ${section}`)
    }
  },
)

test('chat switches persist, survive relaunch', async ({ app, shell, configDir }) => {
  await open(shell, 'Chat')
  const thinking = shell.locator('[data-testid=settings-show-thinking]')
  const tools = shell.locator('[data-testid=settings-show-tools]')
  await expect(thinking).not.toBeChecked()
  await expect(tools).not.toBeChecked()
  await shell.getByText('Show thinking', { exact: true }).click()
  await expect(thinking).toBeChecked()
  await expect(tools).not.toBeChecked()
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
    await expect(page.locator('[data-testid=settings-show-tools]')).not.toBeChecked()
  } finally {
    await app2.close()
  }
})
