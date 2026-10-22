// Chat list accessibility: axe (color-contrast, target-size and the ARIA structure rules) on the
// chat sidebar in light and dark, with an active row. Violations inside the chat list fail;
// violations anywhere else in the window are attached to the report and logged, not failed.
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   pnpm -C apps/desktop exec playwright test e2e/chat-list-a11y.spec.ts
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'

/** The whole chat list: agent tabs, folders, rows and folds. */
const LIST = '[data-testid=chat-list]'
const RULES = [
  'color-contrast',
  'target-size',
  'aria-allowed-attr',
  'aria-allowed-role',
  'aria-required-children',
  'aria-required-parent',
  'aria-valid-attr-value',
  'button-name',
  'link-name',
  'nested-interactive',
]

let fx: ChatFixture
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    await use(fx.launchEnv)
    fx.cleanup()
  },
})
test.use({ reducedMotion: 'reduce' })

async function scheme(shell: Page, s: 'light' | 'dark'): Promise<void> {
  const button = shell.locator(`[data-testid=appearance-${s}]`)
  if (!(await button.isVisible())) await shell.locator('[data-testid=sidebar-back]').click()
  await button.click()
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', s)
}

interface Violation {
  id: string
  nodes: { target: unknown[]; any: { data?: unknown }[] }[]
}
/** One line per failing node; contrast failures name their colors and ratio. */
const summary = (vs: Violation[]): string[] =>
  vs.flatMap((v) =>
    v.nodes.map((n) => {
      const d = n.any[0]?.data as
        { fgColor?: string; bgColor?: string; contrastRatio?: number } | undefined
      const why = d?.contrastRatio ? ` (${d.fgColor} on ${d.bgColor}: ${d.contrastRatio})` : ''
      return `${v.id}: ${n.target.join(' ')}${why}`
    }),
  )

for (const s of ['light', 'dark'] as const) {
  test(`chat sidebar passes axe (${s})`, async ({ shell }, info) => {
    await scheme(shell, s)
    await shell.getByTestId('nav-chat').click()
    await shell.waitForSelector(LIST)
    await shell.getByTestId('chat-row-p4-ecard').click()
    await expect(shell.getByTestId('chat-row-p4-ecard')).toHaveAttribute('data-active', 'true')
    // Rest the pointer off the list, so no hover card covers rows.
    await shell.mouse.move(900, 400)

    // Legacy mode runs in the page itself: Electron cannot open the blank page axe would use.
    const axe = (): AxeBuilder => new AxeBuilder({ page: shell }).setLegacyMode(true)
    const list = await axe().include(LIST).withRules(RULES).analyze()
    const everywhere = await axe().exclude(LIST).analyze()
    const elsewhere = summary(everywhere.violations)
    await info.attach(`axe-elsewhere-${s}.json`, {
      body: JSON.stringify(everywhere.violations, null, 2),
      contentType: 'application/json',
    })
    if (elsewhere.length)
      console.log(`axe outside the chat list (${s}):\n  ${elsewhere.join('\n  ')}`)
    expect(summary(list.violations), `axe in the chat list (${s})`).toEqual([])
  })
}
