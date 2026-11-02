import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'

interface Hooks {
  openPlace(page: string, newTab?: boolean, extra?: { settingsSection: string }): void
}
type W = { __evaosShell?: Hooks }
type G = { __evaosTest: { hooks: { linkLaunches: unknown[] } } }

const REPLY =
  'See [the ticket](https://linear.app/ecard/issue/ENG-1/x), [the docs](https://docs.example.com/a/b) and [an article](https://example.com/post).'

let fx: ChatFixture
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    const lines = [
      { type: 'title', v: 1, title: 'Links chat', updatedAt: Date.now() },
      {
        type: 'session',
        version: 3,
        id: 'links',
        timestamp: new Date().toISOString(),
        cwd: '/fixture/eva-root',
      },
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        message: { role: 'user', content: 'Where are the docs?' },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: REPLY }],
          stopReason: 'stop',
        },
      },
    ]
    fs.writeFileSync(
      path.join(fx.sessionsDir, '2026-10-03T09-00-00-000Z_links.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    )
    await use(fx.launchEnv)
    fx.cleanup()
  },
})
test.use({ startOnChat: true, colorScheme: 'dark' })

async function openLinks(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as W).__evaosShell!.openPlace('settings', false, {
      settingsSection: 'Links',
    }),
  )
  await page.waitForSelector('[data-testid=settings-links]')
}

const launches = (app: { evaluate: <T>(fn: () => T) => Promise<T> }) =>
  app.evaluate(() => (globalThis as unknown as G).__evaosTest.hooks.linkLaunches)

const shots = process.env.EVAOS_LINKS_SHOTS

test('Settings > Links routes clicked chat links by site, saved in links.json', async ({
  app,
  shell,
  configDir,
}) => {
  await openLinks(shell)
  const rules = shell.getByTestId('links-rules')
  for (const p of ['linear.app', 'slack.com', '*.slack.com', 'github.com'])
    await expect(rules.getByTestId(`links-rule-${p}`)).toBeVisible()
  await expect(shell.getByTestId('links-opener-fallback')).toHaveValue('Relay browser')
  if (shots) await shell.screenshot({ path: path.join(shots, 'links-settings.png') })

  // A rule added in the UI: docs.example.com goes to the default browser.
  await shell.getByTestId('links-add-input').fill('docs.example.com')
  await shell.getByTestId('links-add').click()
  await shell.getByTestId('links-opener-docs.example.com').click()
  await shell.getByRole('option', { name: 'Default browser' }).click()
  await expect
    .poll(() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(configDir, 'links.json'), 'utf8')) as unknown
      } catch {
        return null
      }
    })
    .toMatchObject({
      rules: expect.arrayContaining([{ pattern: 'docs.example.com', opener: { kind: 'system' } }]),
    })
  await expect(shell.getByTestId('links-opener-docs.example.com')).toHaveValue('Default browser')
  if (shots) await shell.screenshot({ path: path.join(shots, 'links-settings-added.png') })

  // Links in a chat reply follow the rules. Test instances record launches instead of making them.
  await shell.getByTestId('nav-chat').click()
  await shell
    .getByTestId('chat-tree')
    .getByRole('link', { name: /^Links chat/ })
    .click()
  const log = shell.getByTestId('chat-log')
  await expect(log).toContainText('See the ticket')
  const linear = fs.existsSync('/Applications/Linear.app')

  await log.getByRole('link', { name: 'the ticket' }).click()
  await log.getByRole('link', { name: 'the docs' }).click()
  const expected = [
    ...(linear ? [{ to: 'app', app: 'Linear', url: 'linear://ecard/issue/ENG-1/x' }] : []),
    { to: 'system', url: 'https://docs.example.com/a/b' },
  ]
  await expect.poll(() => launches(app)).toEqual(expected)

  // No rule matches: a tab in Relay's browser, nothing launched.
  await log.getByRole('link', { name: 'an article' }).click()
  await expect(shell.locator('[data-pane-kind=tool]').first()).toBeVisible()
  await expect(shell.getByTestId('address-input').first()).toHaveValue(/example\.com\/post/, {
    timeout: 15_000,
  })
  expect(await launches(app)).toEqual(expected)
  if (shots) await shell.screenshot({ path: path.join(shots, 'links-chat.png') })
})
