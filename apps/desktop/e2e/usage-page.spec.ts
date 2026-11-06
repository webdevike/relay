import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { REPO_ROOT } from './helpers/paths'
import { pickScheme } from './helpers/appearance'

// Settings > Usage: the Relay Host's omp stats. The fake host answers `stats.get` with a snapshot;
// USAGE_SNAPSHOT names a real one (the host's StatsSnapshot as JSON) for proof shots.

type G = { __evaosTest: { win: { setContentSize(w: number, h: number): void } } }
type Json = Record<string, unknown>
// Real numbers go to proof/usage-page; the synthetic snapshot's shots stay out of the repo.
const PROOF = process.env.USAGE_SNAPSHOT
  ? path.join(REPO_ROOT, 'proof', 'usage-page')
  : path.join(os.tmpdir(), 'evaos-usage-page-proof')
const sel = (id: string): string => `[data-testid="${id}"]`

const DAY = 24 * 60 * 60_000
const NOW = Date.now()

const totals = (requests: number, failed: number, costUsd: number, ttft: number, tps: number) => ({
  requests,
  failed,
  costUsd,
  unpriced: 0,
  inputTokens: requests * 200,
  outputTokens: requests * 800,
  cacheReadTokens: requests * 150_000,
  cacheWriteTokens: requests * 2_000,
  cacheSavingsUsd: costUsd * 9,
  avgTtftMs: ttft,
  tokensPerSecond: tps,
})

/** A small but realistic snapshot: three models (one failing, one slow), two folders, both agent types. */
function syntheticRange(scale: number, buckets: number, bucketMs: number): Json {
  const opus = totals(2000 * scale, 2 * scale, 150 * scale, 1500, 80)
  const astra = totals(300 * scale, 12 * scale, 40 * scale, 4200, 55)
  const sol = totals(100 * scale, 0, 5 * scale, 900, 120)
  const all = totals(2400 * scale, 14 * scale, 195 * scale, 1700, 79)
  return {
    totals: all,
    series: Array.from({ length: buckets }, (_, i) => ({
      at: NOW - (buckets - 1 - i) * bucketMs,
      requests: Math.round((2400 * scale) / buckets),
      failed: i === buckets - 2 ? 14 * scale : 0,
      costUsd: (195 * scale * (1 + Math.sin(i))) / buckets,
      tokens: 1_000_000,
    })),
    byModel: [
      { model: 'claude-opus-5-5', provider: 'anthropic', ...opus },
      { model: 'gpt-6-astra', provider: 'openai-codex', ...astra },
      { model: 'gpt-6.1-sol', provider: 'openai-codex', ...sol },
    ],
    byFolder: [
      { folder: '-Eva', ...totals(1500 * scale, 4, 120 * scale, 1500, 80) },
      { folder: '-Eva-work-relay-usage-page', ...totals(900 * scale, 10, 75 * scale, 1500, 80) },
    ],
    byAgent: [
      { agent: 'helpers', label: 'Helpers', ...totals(1200 * scale, 10, 85 * scale, 1500, 80) },
      { agent: 'nova', label: 'Nova', ...totals(900 * scale, 4, 80 * scale, 1500, 80) },
      { agent: 'astra', label: 'Astra', ...totals(300 * scale, 0, 30 * scale, 1500, 80) },
    ],
    byAgentType: [
      { type: 'main', ...totals(1200 * scale, 4, 110 * scale, 1500, 80) },
      { type: 'subagent', ...totals(1200 * scale, 10, 85 * scale, 1500, 80) },
    ],
  }
}

const SNAPSHOT: Json = process.env.USAGE_SNAPSHOT
  ? (JSON.parse(fs.readFileSync(process.env.USAGE_SNAPSHOT, 'utf8')) as Json)
  : {
      updatedAt: NOW - 2 * 60_000,
      refreshing: false,
      profiles: [
        { name: 'personal', error: null },
        { name: 'work', error: null },
      ],
      ranges: {
        '24h': syntheticRange(1, 25, DAY / 24),
        '7d': syntheticRange(7, 7, DAY),
        '30d': syntheticRange(30, 30, DAY),
      },
    }

type Range = { totals: { costUsd: number }; byModel: unknown[] }
const rangeOf = (key: '24h' | '7d' | '30d'): Range =>
  (SNAPSHOT.ranges as Record<string, Range>)[key]!

function money(usd: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    ...(Math.abs(usd) >= 1000 ? { maximumFractionDigits: 0 } : {}),
  }).format(usd)
}

let host: FakeRelayHost
let root: string

const test = base.extend<{ statsFeature: boolean }>({
  statsFeature: [true, { option: true }],
  launchEnv: async ({ statsFeature }, use) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-usage-page-'))
    const relayDir = path.join(root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    if (statsFeature) host.features = ['stats']
    await use({ EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
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

async function openUsage(shell: Page): Promise<void> {
  await shell.locator(sel('nav-setting')).click()
  await shell.locator(sel('settings-item-usage')).click()
  await expect(shell.locator(sel('settings-usage'))).toBeVisible()
}

test('Usage waits for the host, then leads with spend and what to act on; ranges switch', async ({
  app,
  shell,
}) => {
  await size(app, shell, 1280, 900)
  await openUsage(shell)
  // The fake host is still adding up: the page says so instead of showing zeros.
  await expect(shell.locator(sel('stats-empty'))).toContainText('adding up usage')
  host.setStats(SNAPSHOT)

  await expect(shell.locator(sel('stats-spend'))).toHaveText(money(rangeOf('7d').totals.costUsd))
  await expect(shell.locator(sel('stats-insights')).locator('[data-insight=cost]')).toBeVisible()
  await expect(shell.locator(sel('stats-models')).locator('tbody tr')).toHaveCount(
    rangeOf('7d').byModel.length,
  )
  await expect(
    shell.locator(sel('stats-chart-spend')).locator('.recharts-bar-rectangle').first(),
  ).toBeVisible()
  await expect(shell.locator(sel('stats-projects'))).toBeVisible()
  await expect(shell.locator(sel('stats-agents')).locator('tbody tr').first()).toContainText(
    'Helpers',
  )
  await expect(shell.locator(sel('stats-insights')).locator('[data-insight=agent]')).toBeVisible()
  await expect(shell.locator(sel('stats-split'))).toBeVisible()
  // The page keeps to the shared settings column.
  const col = (await shell.locator('.eva-settings-col').boundingBox())!
  expect(col.width).toBeLessThanOrEqual(720)

  await shell.locator(sel('stats-range')).getByText('24 hours').click()
  await expect(shell.locator(sel('stats-spend'))).toHaveText(money(rangeOf('24h').totals.costUsd))
  await shell.locator(sel('stats-range')).getByText('30 days').click()
  await expect(shell.locator(sel('stats-spend'))).toHaveText(money(rangeOf('30d').totals.costUsd))
  expect(host.statsGets).toBeGreaterThanOrEqual(1)
})

for (const mode of ['dark', 'light'] as const) {
  test(`proof: each range from the top, then the tables, ${mode}`, async ({ app, shell }) => {
    host.setStats(SNAPSHOT)
    await size(app, shell, 1280, 1000)
    await pickScheme(shell, mode)
    await expect(shell.locator('html')).toHaveAttribute('data-resolved', mode)
    await openUsage(shell)
    await expect(shell.locator(sel('stats-spend'))).toHaveText(money(rangeOf('7d').totals.costUsd))
    fs.mkdirSync(PROOF, { recursive: true })
    // The page scrolls inside the window, so the tables get their own shots.
    for (const [key, label] of [
      ['7d', '7 days'],
      ['24h', '24 hours'],
      ['30d', '30 days'],
    ] as const) {
      await shell.locator(sel('stats-range')).getByText(label).click()
      await expect(shell.locator(sel('stats-spend'))).toHaveText(money(rangeOf(key).totals.costUsd))
      await shell.locator(sel('stats-range')).scrollIntoViewIfNeeded()
      // The range control's indicator slides over; shoot it settled.
      await shell.waitForTimeout(400)
      await shell.screenshot({ path: path.join(PROOF, `usage-${key}-top-${mode}.png`) })
      await shell.locator(sel('stats-source')).scrollIntoViewIfNeeded()
      await shell.screenshot({ path: path.join(PROOF, `usage-${key}-tables-${mode}.png`) })
    }
  })
}

test.describe('a host without stats', () => {
  test.use({ statsFeature: false })
  test('opens from the sidebar footer icon and says to update the Relay Host, never asking it', async ({
    shell,
  }) => {
    // The footer's chart icon is the relay://open/settings/usage link.
    await shell.locator(sel('nav-usage')).click()
    await expect(shell.locator(sel('settings-usage'))).toBeVisible()
    await expect(shell.locator(sel('settings-item-usage'))).toHaveAttribute('data-active', 'true')
    await expect(shell.locator(sel('stats-empty'))).toHaveText(
      'This Relay Host is too old to report usage. Update the Relay Host to see it.',
    )
    expect(host.statsGets).toBe(0)
  })
})
