import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeEvaFixture, type EvaFixture } from './helpers/eva-fixture'

// The Agents board's side panel sits beside the board (which shrinks and stays clickable), resizes
// from its edge, folds to a strip and closes on Esc; a window too narrow for both gets the drawer.
// No network: Linear and GitHub are off in test instances, so the ticket view shows its card's own
// facts (the ledger's PR as a tab) and says what it could not read.

const ledger = (key: string, title: string, extra = ''): string =>
  `---\nkey: ${key}\ntitle: ${title}\nworkspace: ecardsystems\nstage: 9 PR (draft)\nmove: isaac\nnext: Isaac: review\nupdated: ${new Date().toISOString().slice(0, 10)}\n${extra}---\n\n## Context\n`

const test = base.extend<{ evaFx: EvaFixture }>({
  evaFx: async ({}, use) => {
    const fx = makeEvaFixture()
    const items = path.join(fx.root, 'work/items')
    fs.mkdirSync(items, { recursive: true })
    fs.writeFileSync(
      path.join(items, 'ENG-9001.md'),
      ledger(
        'ENG-9001',
        'Versions for deleted assets',
        'linear: https://linear.app/acme/issue/ENG-9001/versions\npr: https://github.com/acme/app/pull/12\n',
      ),
    )
    fs.writeFileSync(path.join(items, 'relay-demo.md'), ledger('relay-demo', 'Relay demo item'))
    await use(fx)
    fx.cleanup()
  },
  launchEnv: async ({ evaFx }, use) => {
    await use(evaFx.env)
  },
})

test.use({ startOnChat: false })

const sel = (id: string): string => `[data-testid="${id}"]`
type Shell = { __evaosShell: { openPlace(page: string): void } }
const width = (shell: Page, css: string): Promise<number> =>
  shell.locator(css).evaluate((el) => el.getBoundingClientRect().width)

test('a card opens its ticket view beside the live board; resize, fold, Esc, narrow drawer', async ({
  app,
  shell,
}) => {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1600, 1000))
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('agents'))
  await expect(shell.locator(sel('agents-board'))).toBeVisible()
  const boardBefore = await width(shell, '.eva-ab-main')

  await shell.locator(sel('agents-card-ENG-9001')).click()
  const side = shell.locator(sel('agents-side'))
  await expect(side).toBeVisible()
  await expect(side.locator(sel('ticket-agent'))).toBeVisible()
  // The board shrank to make room, nothing covers it.
  const sideWidth = await width(shell, sel('agents-side'))
  expect(await width(shell, '.eva-ab-main')).toBeLessThan(boardBefore - sideWidth + 2)
  // Ticket view: the card's own PR is a tab even with GitHub off.
  await expect(side.locator(sel('ticket-agent'))).toContainText('Needs')
  await expect(side.locator(sel('ticket-pr-tab-app-12'))).toBeVisible()
  await expect(side.locator(sel('ticket-pr-loading'))).toContainText("Couldn't load acme/app#12")

  // The board stays live: another card swaps the panel.
  await shell.locator(sel('agents-card-relay-demo')).click()
  await expect(side.locator('.eva-ab-tv-head')).toContainText('relay-demo')
  await expect(side.locator(sel('ticket-prs'))).toContainText('No linked pull requests.')

  // Resize from the edge (keyboard on the sash), 3 steps of 16 px wider.
  const before = await width(shell, sel('agents-side'))
  await shell.locator(sel('agents-panel-sash')).focus()
  for (let i = 0; i < 3; i++) await shell.keyboard.press('ArrowLeft')
  await expect.poll(() => width(shell, sel('agents-side'))).toBe(before + 48)

  // Fold to a strip, the board gets the room back; opening a card unfolds it.
  await side.locator(sel('agents-panel-collapse')).click()
  await expect(shell.locator(sel('agents-panel-strip'))).toBeVisible()
  await expect(side).toHaveCount(0)
  await shell.locator(sel('agents-panel-expand')).click()
  await expect(side).toBeVisible()

  // Esc closes it.
  await shell.locator(sel('agents-board')).click({ position: { x: 4, y: 4 } })
  await shell.keyboard.press('Escape')
  await expect(side).toHaveCount(0)

  // Too narrow for both: the drawer.
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(820, 900))
  await shell.locator(sel('agents-card-ENG-9001')).click()
  await expect(shell.locator(`${sel('agents-drawer')} ${sel('agents-panel')}`)).toBeVisible()
  await expect(shell.locator(sel('agents-side'))).toHaveCount(0)
})
