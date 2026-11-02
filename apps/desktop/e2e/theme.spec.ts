import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { z } from 'zod'
import { test, expect, launchApp } from './fixtures'

test.use({ startOnChat: false })

declare global {
  interface Window {
    __themeTag?: Element | null
    __evaosShell?: {
      openPlace(page: string, newTab: boolean, extra: { settingsSection: string }): void
    }
  }
}

const ThemeFile = z.object({
  config: z.object({}).passthrough().optional(),
  colorScheme: z.string().optional(),
  preset: z.string().optional(),
  app: z.object({ lastBackground: z.string() }).partial().optional(),
})

const readTheme = (file: string): z.infer<typeof ThemeFile> => {
  try {
    return ThemeFile.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return {}
  }
}

async function openTheme(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean(window.__evaosShell))
  await page.evaluate(() =>
    window.__evaosShell!.openPlace('settings', false, { settingsSection: 'Theme' }),
  )
  await expect(page.getByTestId('theme-editor')).toBeVisible()
}

const cssVar = (page: Page, name: string) =>
  page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim().toLowerCase(),
    name,
  )

test('first launch is the Default preset in light, with motion off', async ({ shell }) => {
  const html = shell.locator('html')
  await expect(html).toHaveAttribute('data-resolved', 'light')
  await expect(html).toHaveAttribute('data-mantine-color-scheme', 'light')
  await expect(html).toHaveAttribute('data-eva-motion', 'off')
  expect(await cssVar(shell, '--mantine-color-body')).toBe('#ffffff')
  expect(await cssVar(shell, '--mantine-primary-color-filled')).toBe('#228be6')
})

test('switching the scheme never remounts and saves the scheme and window background', async ({
  app,
  shell,
  configDir,
}) => {
  await shell.evaluate(() => {
    window.__themeTag = document.querySelector('[data-testid=rail]')
  })
  await shell.locator('[data-testid=appearance-dark]').click()
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', 'dark')
  expect(
    await shell.evaluate(() => {
      const tag = window.__themeTag
      return Boolean(tag?.isConnected) && tag === document.querySelector('[data-testid=rail]')
    }),
  ).toBe(true)
  expect(await cssVar(shell, '--mantine-color-body')).toBe('#1a1b1e')

  const file = path.join(configDir, 'theme.json')
  await expect
    .poll(() => {
      const t = readTheme(file)
      return `${t.colorScheme}|${t.preset}|${t.app?.lastBackground}`
    })
    .toBe('dark|default|#1a1b1e')
  const bg = await app.evaluate(({ BaseWindow }) =>
    BaseWindow.getAllWindows()[0]!.getBackgroundColor(),
  )
  expect(bg.toLowerCase().replace(/^#ff(?=[0-9a-f]{6}$)/, '#')).toBe('#1a1b1e')
})

test('a preset applies live, is saved by name, and survives relaunch', async ({
  app,
  shell,
  configDir,
}) => {
  await openTheme(shell)
  await shell.getByTestId('theme-preset-picker').click()
  await shell.getByRole('option', { name: 'Forest' }).click()
  await expect.poll(() => cssVar(shell, '--mantine-color-body')).toBe('#fbfdfb')
  const file = path.join(configDir, 'theme.json')
  await expect.poll(() => readTheme(file).preset).toBe('forest')
  await shell.screenshot({ path: path.join('..', '..', 'proof', 'texo-theme', 'theme-forest.png') })
  await app.close()

  const second = await launchApp(configDir)
  try {
    const page = await second.firstWindow()
    await openTheme(page)
    await expect(page.getByTestId('theme-preset-picker')).toContainText('Forest')
    expect(await cssVar(page, '--mantine-color-body')).toBe('#fbfdfb')
  } finally {
    await second.close()
  }
})

test.describe('focus ring never', () => {
  test.use({
    configDir: async ({ configDir }, use) => {
      fs.writeFileSync(
        path.join(configDir, 'theme.json'),
        JSON.stringify({ preset: 'default', colorScheme: 'light', config: { focusRing: 'never' } }),
      )
      await use(configDir)
    },
  })

  test("removes the keyboard focus outline from the app's own controls too", async ({ shell }) => {
    await shell.locator('[data-testid=nav-chat]').focus()
    await shell.keyboard.press('Shift+Tab')
    await shell.keyboard.press('Tab')
    const focused = await shell.evaluate(() => {
      const el = document.activeElement as HTMLElement
      return { visible: el.matches(':focus-visible'), outline: getComputedStyle(el).outlineStyle }
    })
    expect(focused).toEqual({ visible: true, outline: 'none' })
  })
})

for (const [name, saved] of [
  ['a fresh config', null],
  ["an older file saved with 'auto'", { preset: 'default', config: { focusRing: 'auto' } }],
] as const) {
  test.describe(`focus ring default: ${name}`, () => {
    test.use({
      configDir: async ({ configDir }, use) => {
        if (saved) fs.writeFileSync(path.join(configDir, 'theme.json'), JSON.stringify(saved))
        await use(configDir)
      },
    })

    test('starts off: no outline on a keyboard-focused control', async ({ shell }) => {
      await shell.locator('[data-testid=nav-chat]').focus()
      await shell.keyboard.press('Shift+Tab')
      await shell.keyboard.press('Tab')
      await expect(shell.locator('html')).toHaveAttribute('data-focus-ring', 'never')
      const focused = await shell.evaluate(() => {
        const el = document.activeElement as HTMLElement
        return { visible: el.matches(':focus-visible'), outline: getComputedStyle(el).outlineStyle }
      })
      expect(focused).toEqual({ visible: true, outline: 'none' })
      await shell.screenshot({
        path: path.join(
          '..',
          '..',
          'proof',
          'texo-theme',
          `focus-ring-default-${saved ? 'migrated' : 'fresh'}.png`,
        ),
      })
    })
  })
}
