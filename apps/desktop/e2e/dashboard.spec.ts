import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect, launchApp } from './fixtures'
import { makeEvaFixture, EXPECT_P3, type EvaFixture } from './helpers/eva-fixture'
import { proofShot } from './helpers/proofShot'
import { pickScheme } from './helpers/appearance'

type G = { __evaosTest: { win: { setContentSize(w: number, h: number): void } } }
type Snap = {
  active: number
  list: Array<{ id: number; page: string; pinned: boolean; title: string }>
}
type Shell = {
  __evaosShell: { tabs(): Snap; openPlace(p: string, n?: boolean): void }
}

const test = base.extend<{ evaFx: EvaFixture }>({
  evaFx: async ({}, use) => {
    const fx = makeEvaFixture()
    await use(fx)
    fx.cleanup()
  },
  launchEnv: async ({ evaFx }, use) => {
    await use(evaFx.env)
  },
})

test.use({ startOnChat: false, colorScheme: 'dark' })

const PHASE = { phase: 'phase-3' }
const sel = (id: string): string => `[data-testid=${id}]`
const tabs = (shell: Page): Promise<Snap> =>
  shell.evaluate(() => (window as unknown as Shell).__evaosShell.tabs())

async function size(app: ElectronApplication, shell: Page, w: number, h: number): Promise<void> {
  await app.evaluate(
    (_e, [ww, hh]) => (globalThis as unknown as G).__evaosTest.win.setContentSize(ww!, hh!),
    [w, h],
  )
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(w)
  await expect(shell.locator(sel('dash-hero'))).toBeVisible()
  // Layout settled: the page root stops changing width.
  let last = -1
  await expect
    .poll(
      async () => {
        const w2 = (await shell.locator(sel('page-dashboard')).boundingBox())?.width ?? 0
        const same = w2 === last
        last = w2
        return same
      },
      { intervals: [150] },
    )
    .toBe(true)
}

async function setScheme(shell: Page, mode: 'dark' | 'light'): Promise<void> {
  await pickScheme(shell, mode)
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', mode)
}

test.beforeEach(async ({ shell }) => {
  await expect(shell.locator(sel('dash-hero'))).toBeVisible()
})

const WIDE = [1800, 900] as const

test('wide dark: summary, filters, charts, grid, todos and hatch', async ({ app, shell }) => {
  await size(app, shell, ...WIDE)
  await setScheme(shell, 'dark')
  await expect(shell.locator(sel('page-dashboard'))).toHaveAttribute('data-compact', 'false')
  await expect(shell.locator(sel('dash-summary'))).toHaveText(
    `${EXPECT_P3.workspaces} workspaces, ${EXPECT_P3.openTodos} open todos, ${EXPECT_P3.updatesThisWeek} updates this week`,
  )
  await expect(shell.locator(sel('dash-hero'))).toContainText('WELCOME BACK')
  const f = EXPECT_P3.filters
  await expect(shell.locator(sel('filter-all'))).toHaveText(`All ${f.all}`)
  await expect(shell.locator(sel('filter-active'))).toHaveText(`Active ${f.active}`)
  await expect(shell.locator(sel('filter-todos'))).toHaveText(`Has Todos ${f.todos}`)
  await expect(shell.locator(sel('filter-quiet'))).toHaveText(`Quiet ${f.quiet}`)

  const cards = shell.locator(sel('dash-chart-card'))
  await expect(cards).toHaveCount(2)
  await expect(cards.nth(0).locator('.eva-dash-name-link')).toHaveText('Eva')
  await expect(cards.nth(1).locator('.eva-dash-name-link')).toHaveText('Flo')

  for (const id of ['relay', 'goodops', 'bambee', 'texo', 'personal']) {
    await expect(shell.locator(sel(`ws-card-${id}`))).toBeVisible()
  }
  await expect(shell.locator('[data-testid^=ws-card-]')).toHaveCount(5)
  await expect(shell.locator('[data-testid^=dash-todo-]')).toHaveCount(5)
  await expect(shell.locator('#eva-hatch').first()).toBeAttached()

  await shell.locator(sel('range-30')).click()
  await expect(cards.nth(0).locator('tbody tr')).toHaveCount(30)
  await shell.locator(sel('range-7')).click()
  await expect(cards.nth(0).locator('tbody tr')).toHaveCount(7)
  // Tooltip regression: hovering a chart must render the Mantine tooltip without a page error.
  await cards
    .nth(0)
    .locator('.recharts-wrapper')
    .hover({ position: { x: 300, y: 80 } })
  await expect(shell.locator('.mantine-ChartTooltip-tooltip').first()).toBeVisible()
  await shell.mouse.move(5, 5)
  await proofShot(app, shell, 'dashboard-wide-dark', PHASE)
})

test('each filter changes the grid and the footer', async ({ app, shell }) => {
  await size(app, shell, ...WIDE)
  const grid = shell.locator('[data-testid^=ws-card-]')
  await shell.locator(sel('filter-active')).click()
  await expect(grid).toHaveCount(3)
  await proofShot(app, shell, 'dashboard-filter-active', PHASE)
  await shell.locator(sel('filter-todos')).click()
  await expect(grid).toHaveCount(2)
  await proofShot(app, shell, 'dashboard-filter-todos', PHASE)
  await shell.locator(sel('filter-quiet')).click()
  await expect(grid).toHaveCount(0)
  await expect(shell.getByText('Every matching workspace is shown above.')).toBeVisible()
  await expect(shell.locator(sel('dash-chart-card'))).toHaveCount(2)
  await proofShot(app, shell, 'dashboard-filter-quiet', PHASE)
  await shell.locator(sel('filter-quiet')).press('ArrowLeft')
  await expect(shell.locator(sel('filter-todos'))).toHaveAttribute('aria-checked', 'true')
  await shell.locator(sel('filter-all')).click()
  await expect(grid).toHaveCount(5)
})

test('wide light', async ({ app, shell }) => {
  await size(app, shell, ...WIDE)
  await setScheme(shell, 'light')
  await expect(shell.locator(sel('dash-hero'))).toBeVisible()
  await proofShot(app, shell, 'dashboard-wide-light', PHASE)
})

for (const mode of ['dark', 'light'] as const) {
  test(`compact ${mode}`, async ({ app, shell }) => {
    await setScheme(shell, mode)
    await size(app, shell, 800, 900)
    await expect(shell.locator(sel('page-dashboard'))).toHaveAttribute('data-compact', 'true')
    const cards = shell.locator(sel('dash-chart-card'))
    const a = (await cards.nth(0).boundingBox())!
    const b = (await cards.nth(1).boundingBox())!
    expect(b.y).toBeGreaterThan(a.y + a.height - 1)
    await proofShot(app, shell, `dashboard-compact-${mode}`, PHASE)
  })
}

test('reload triggers: Cmd+R, window focus and the refresh button', async ({
  app,
  shell,
  evaFx,
}) => {
  await size(app, shell, ...WIDE)
  const file = path.join(evaFx.root, 'memory/todos.md')
  const addRow = (id: string): void => {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    const at = lines.findIndex((l) => l.includes(' T11 '))
    lines.splice(at + 1, 0, `- [ ] ${id} [relay] Fresh row ${id}`)
    fs.writeFileSync(file, lines.join('\n'))
  }
  const summary = shell.locator(sel('dash-summary'))
  await expect(summary).toContainText('5 open todos')

  addRow('T20')
  await shell.locator(sel('dash-hero')).click()
  await shell.keyboard.press('Meta+r')
  await expect(summary).toContainText('6 open todos')

  addRow('T21')
  await shell.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(summary).toContainText('7 open todos')

  addRow('T22')
  await shell.locator(sel('dash-refresh')).click()
  await expect(summary).toContainText('8 open todos')
  await expect(shell.locator(sel('dash-refresh'))).toHaveAttribute('aria-busy', 'false')
  await expect(shell.locator(sel('dash-updated'))).toContainText('Updated')
})

test('workspace cards navigate, cmd-click opens beside', async ({ app, shell }) => {
  await size(app, shell, ...WIDE)
  const count = async (): Promise<number> => (await tabs(shell)).list.length
  const n = await count()
  await shell.locator(sel('ws-card-relay')).click()
  await expect(shell.locator(sel('page-workspace'))).toBeVisible()
  const snap = await tabs(shell)
  expect(snap.list).toHaveLength(n)
  expect(snap.list[snap.active]!.page).toBe('workspace:relay')

  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('dashboard'))
  await expect(shell.locator(sel('ws-card-goodops'))).toBeVisible()
  // Cmd opens the workspace page in the background as a page tab beside the dashboard.
  await shell.locator(sel('ws-card-goodops')).click({ modifiers: ['Meta'] })
  // In the background: a tab in the tool pane's strip, not in front.
  const beside = shell.locator('[data-pane-kind=tool]').getByRole('tab', { name: 'GoodOps' })
  await expect(beside).toHaveCount(1)
  await expect(beside).toHaveAttribute('aria-selected', 'false')
  expect(await count()).toBe(n)
  await expect(shell.locator(sel('ws-card-goodops'))).toBeVisible()
})

test('motion off: exactly one banner is visible', async ({ shell }) => {
  const opacities = await shell
    .locator('.eva-dash-banner')
    .evaluateAll((els) => els.map((e) => getComputedStyle(e).opacity))
  expect(opacities).toHaveLength(4)
  expect(opacities.filter((o) => o === '1')).toHaveLength(1)
})

test('motion on: hero fades in from transparent within 2 s', async ({ evaFx }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-dash-motion-'))
  const app = await launchApp(dir, { ...evaFx.env, EVAOS_E2E: '0' })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('[data-testid=dash-hero]')
    await expect(page.locator('html')).toHaveAttribute('data-eva-motion', 'on')
    const probe = await page.evaluate(() => {
      const el = document.querySelector('[data-testid=dash-hero]') as HTMLElement
      const a = el.getAnimations().find((x) => (x as CSSAnimation).animationName === 'eva-cue')
      if (!a) return null
      a.pause()
      a.currentTime = 0
      const at0 = Number(getComputedStyle(el).opacity)
      a.play()
      return { at0 }
    })
    if (probe) expect(probe.at0).toBeLessThan(1)
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              getComputedStyle(document.querySelector('[data-testid=dash-hero]') as HTMLElement)
                .opacity,
          ),
        { timeout: 2000 },
      )
      .toBe('1')
    expect(probe, 'hero carries the eva-cue animation on first launch').not.toBeNull()
  } finally {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
