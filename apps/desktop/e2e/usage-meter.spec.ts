import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { FIXTURES_DIR, REPO_ROOT } from './helpers/paths'
import { pickScheme } from './helpers/appearance'

type G = { __evaosTest: { win: { setContentSize(w: number, h: number): void } } }

const PROOF = path.join(REPO_ROOT, 'proof', 'usage')
const sel = (id: string): string => `[data-testid="${id}"]`
const item = (shell: Page, key: string) => shell.locator(sel(`usage-item-${key}`))

/** A per-test copy of the fake's usage fixtures, so a test can rewrite or remove one. */
const test = base.extend<{ usageDir: string; dropWork: boolean }>({
  dropWork: [false, { option: true }],
  usageDir: async ({ dropWork }, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-usage-'))
    fs.cpSync(path.join(FIXTURES_DIR, 'fake-omp/usage'), dir, { recursive: true })
    if (dropWork) fs.rmSync(path.join(dir, 'work.json'))
    await use(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  },
  launchEnv: async ({ usageDir }, use) => {
    await use({ FAKE_OMP_USAGE_DIR: usageDir })
  },
})

test.use({ startOnChat: false, toolPanes: false })

async function size(app: ElectronApplication, shell: Page, w: number, h: number): Promise<void> {
  await app.evaluate(
    (_e, [ww, hh]) => (globalThis as unknown as G).__evaosTest.win.setContentSize(ww!, hh!),
    [w, h],
  )
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(w)
}

async function setScheme(shell: Page, mode: 'dark' | 'light'): Promise<void> {
  await pickScheme(shell, mode)
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', mode)
}

/** Rewrites one window's used fraction in the copied fixture. */
function setUsed(dir: string, profile: string, limitId: string, fraction: number): void {
  const file = path.join(dir, `${profile}.json`)
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    reports: Array<{ limits: Array<{ id: string; amount: { usedFraction: number } }> }>
  }
  for (const r of doc.reports)
    for (const l of r.limits) if (l.id === limitId) l.amount.usedFraction = fraction
  fs.writeFileSync(file, JSON.stringify(doc))
}

const EXPECTED = [
  ['personal:anthropic', '13%', 'normal'],
  ['work:anthropic', '82%', 'warn'],
  ['personal:openai-codex', '42%', 'normal'],
  ['work:openai-codex', '94%', 'danger'],
] as const

test('footer strip at 32px with each account at its most-used window', async ({ app, shell }) => {
  await size(app, shell, 1280, 800)
  const footer = (await shell.locator(sel('footer')).boundingBox())!
  expect(footer.height).toBe(32)
  expect(footer.x).toBe(0)
  expect(footer.width).toBe(1280)
  expect(footer.y + footer.height).toBe(800)
  const main = (await shell.locator(sel('main-card')).boundingBox())!
  expect(main.y + main.height).toBeLessThanOrEqual(footer.y)
  // The sidebar runs down over the strip's left end; its icon row is lifted 16px off the window edge,
  // its centre just below the main card's bottom edge.
  const sidebar = (await shell.locator(sel('sidebar')).boundingBox())!
  expect(sidebar.y + sidebar.height).toBe(footer.y + footer.height)
  const icons = (await shell.locator(sel('sidebar-icons')).boundingBox())!
  expect(icons.y + icons.height).toBe(footer.y + footer.height - 16)
  const centre = icons.y + icons.height / 2
  expect(centre - (main.y + main.height)).toBeGreaterThanOrEqual(0)
  expect(centre - (main.y + main.height)).toBeLessThanOrEqual(8)

  const items = shell.locator('[data-testid^=usage-item-]')
  await expect(items).toHaveCount(4)
  for (const [i, [key, pct, level]] of EXPECTED.entries()) {
    await expect(items.nth(i)).toHaveAttribute('data-testid', `usage-item-${key}`)
    await expect(item(shell, key).locator(sel('usage-pct'))).toHaveText(pct)
    await expect(item(shell, key)).toHaveAttribute('data-level', level)
  }
  const meter = (await shell.locator(sel('usage-meter')).boundingBox())!
  expect(meter.x + meter.width).toBeLessThanOrEqual(1280)
  expect(meter.x + meter.width).toBeGreaterThan(1280 - 16)
})

for (const mode of ['dark', 'light'] as const) {
  test(`tooltip and popover, ${mode}`, async ({ app, shell }) => {
    await size(app, shell, 1280, 800)
    await setScheme(shell, mode)
    fs.mkdirSync(PROOF, { recursive: true })
    await expect(item(shell, 'work:openai-codex').locator(sel('usage-pct'))).toHaveText('94%')
    await shell.screenshot({ path: path.join(PROOF, `footer-${mode}.png`) })

    await item(shell, 'work:anthropic').hover()
    const tip = shell.locator(sel('usage-tooltip'))
    await expect(tip).toBeVisible()
    await expect(tip).toContainText('Claude Work')
    const rows = tip.locator('.eva-usage-tip-row')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toHaveText(/^5 hours8%resets in \d+h \d+m$/)
    // Fully faded in before the proof shot.
    await expect
      .poll(() => tip.evaluate((el) => getComputedStyle(el.parentElement!).opacity))
      .toBe('1')
    await expect(rows.nth(1)).toHaveText(/^7 days82%resets [A-Z][a-z]{2} \d{1,2}:\d{2} [AP]M$/)
    await expect(rows.nth(2)).toContainText('7 days (Fable)31%')
    await shell.screenshot({ path: path.join(PROOF, `tooltip-${mode}.png`) })

    await item(shell, 'work:anthropic').click()
    const pop = shell.locator(sel('usage-popover'))
    await expect(pop).toBeVisible()
    await expect(tip).toBeHidden()
    await expect(pop.locator('[data-testid^=usage-detail-]')).toHaveCount(4)
    const personalCodex = pop.locator(sel('usage-detail-personal:openai-codex'))
    await expect(personalCodex).toContainText('Codex Personal')
    await expect(personalCodex).toContainText('personal@example.com')
    await expect(personalCodex.locator('tbody tr')).toHaveCount(1)
    await expect(personalCodex.locator('tbody tr')).toContainText('7 days')
    await expect(personalCodex.locator('tbody tr')).toContainText('42%')
    const workCodex = pop.locator(sel('usage-detail-work:openai-codex'))
    await expect(workCodex).toContainText('work@example.org')
    await expect(workCodex.locator('tbody tr')).toHaveCount(2)
    await expect(workCodex.locator('tbody tr').first()).toContainText('94%')
    await expect(workCodex.locator('[role=progressbar]')).toHaveCount(2)
    await expect(pop.locator(sel('usage-updated'))).toHaveText('Updated just now')
    await expect(pop.locator(sel('usage-refresh'))).toBeVisible()
    await shell.screenshot({ path: path.join(PROOF, `popover-${mode}.png`) })

    await shell.keyboard.press('Escape')
    await expect(pop).toBeHidden()
  })
}

test('refresh shows new numbers and keeps last good data, marked stale, on failure', async ({
  shell,
  usageDir,
}) => {
  await expect(item(shell, 'work:anthropic').locator(sel('usage-pct'))).toHaveText('82%')
  setUsed(usageDir, 'work', 'anthropic:5h', 0.91)
  await item(shell, 'work:anthropic').click()
  const pop = shell.locator(sel('usage-popover'))
  await expect(pop).toBeVisible()
  await pop.locator(sel('usage-refresh')).click()
  await expect(item(shell, 'work:anthropic').locator(sel('usage-pct'))).toHaveText('91%')
  await expect(item(shell, 'work:anthropic')).toHaveAttribute('data-level', 'danger')

  fs.rmSync(path.join(usageDir, 'personal.json'))
  await pop.locator(sel('usage-refresh')).click()
  const personal = item(shell, 'personal:anthropic')
  await expect(personal).toHaveAttribute('data-stale', 'true')
  await expect(personal.locator(sel('usage-pct'))).toHaveText('13%')
  await expect(pop.locator(sel('usage-detail-personal:anthropic'))).toContainText(
    'Last good data from just now. fake-omp: no usage for profile personal',
  )
  await expect(item(shell, 'work:anthropic')).not.toHaveAttribute('data-stale', 'true')
})

test.describe('a profile that never answered', () => {
  test.use({ dropWork: true })

  test('shows a muted dash with the reason, never numbers', async ({ shell }) => {
    await expect(item(shell, 'personal:anthropic').locator(sel('usage-pct'))).toHaveText('13%')
    for (const key of ['work:anthropic', 'work:openai-codex']) {
      await expect(item(shell, key)).toHaveAttribute('data-level', 'none')
      await expect(item(shell, key).locator(sel('usage-none'))).toBeVisible()
      await expect(item(shell, key).locator(sel('usage-pct'))).toHaveCount(0)
    }
    await item(shell, 'work:anthropic').hover()
    await expect(shell.locator(sel('usage-tooltip'))).toContainText(
      'fake-omp: no usage for profile work',
    )
  })
})
