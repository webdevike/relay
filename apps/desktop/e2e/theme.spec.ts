import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

// Playwright's emulateMedia drives the renderer's prefers-color-scheme (nativeTheme does not
// reach the renderer under test).
async function pinOs(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme })
}

const countVars = () => {
  const style = document.documentElement.style
  let n = 0
  for (let i = 0; i < style.length; i++) if (style.item(i).startsWith('--eva-c-')) n++
  return n
}

test('default launch follows the OS with 139 variables and motion off', async ({ shell }) => {
  await pinOs(shell, 'dark')
  const html = shell.locator('html')
  await expect(html).toHaveAttribute('data-appearance', 'system')
  await expect(html).toHaveAttribute('data-resolved', 'dark')
  await expect(html).toHaveAttribute('data-eva-motion', 'off')
  expect(await shell.evaluate(countVars)).toBe(139)
})

test('switching appearance never remounts and reports the background', async ({
  app,
  shell,
  configDir,
}) => {
  await pinOs(shell, 'dark')
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', 'dark')
  await shell.evaluate(() => {
    ;(window as unknown as { __tag: Element | null }).__tag =
      document.querySelector('[data-testid=rail]')
  })
  const bodyBefore = await shell.evaluate(() => getComputedStyle(document.body).backgroundColor)
  await shell.evaluate(() =>
    (
      window as unknown as { __evaosShell: { setAppearance(a: string): void } }
    ).__evaosShell.setAppearance('light'),
  )

  const html = shell.locator('html')
  await expect(html).toHaveAttribute('data-resolved', 'light')
  expect(
    await shell.evaluate(() => {
      const tag = (window as unknown as { __tag: Element }).__tag
      return tag.isConnected && tag === document.querySelector('[data-testid=rail]')
    }),
  ).toBe(true)
  expect(
    await shell.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--eva-c-background').trim(),
    ),
  ).toBe('#f3f3f1')
  expect(await shell.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(
    bodyBefore,
  )
  expect(await shell.evaluate(countVars)).toBe(139)

  const themeFile = path.join(configDir, 'theme.json')
  await expect
    .poll(() => {
      try {
        const doc = JSON.parse(fs.readFileSync(themeFile, 'utf8')) as {
          app?: { appearance?: string; lastBackground?: string }
        }
        return `${doc.app?.appearance}|${doc.app?.lastBackground?.toLowerCase()}`
      } catch {
        return ''
      }
    })
    .toBe('light|#eeeeeb')

  const bg = await app.evaluate(({ BaseWindow }) =>
    BaseWindow.getAllWindows()[0]!.getBackgroundColor(),
  )
  expect(bg.toLowerCase()).toMatch(/^#(ff)?eeeeeb$|^#eeeeeb(ff)?$/)
})

test('system follows the OS scheme live', async ({ shell }) => {
  const html = shell.locator('html')
  await pinOs(shell, 'dark')
  await expect(html).toHaveAttribute('data-resolved', 'dark')
  await pinOs(shell, 'light')
  await expect(html).toHaveAttribute('data-resolved', 'light')
  await expect(html).toHaveAttribute('data-appearance', 'system')
  await pinOs(shell, 'dark')
  await expect(html).toHaveAttribute('data-resolved', 'dark')
})
