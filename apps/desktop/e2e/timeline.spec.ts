// The Board's Timeline view against a stand-in Relay host with `tickets` and `tickets.writes`
// (fixtures in e2e/fixtures/tickets: timeline-board.json, replan-proposal.json): the Board |
// Timeline switch survives a reload, zoom buttons (the Today and milestone labels sit in the
// scale's own band, clear of every tick and date), a bar opens its ticket page, and Ask Astra to
// re-plan brings the host's proposal (with its baseline and account) into the draft; Apply lists
// every change and writes it, Relay start included, as exactly one `applyPlan` prepare + commit
// through the gate, Discard writes nothing. No network: Linear and Astra only exist as the fake
// host's fixtures.
//
//   pnpm build && pnpm e2e:run e2e/timeline.spec.ts --retries 0 --max-failures 1
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { TICKETS_FEATURE, TICKETS_WRITES_FEATURE } from '@relay/protocol'
import { test as base, expect } from './fixtures'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { makeEvaFixture } from './helpers/eva-fixture'
import { pickScheme } from './helpers/appearance'
import { hostProposal, hostViewerId } from './helpers/timeline-proposal'

const SHOTS = path.join(__dirname, '..', 'test-results', 'timeline-shots')
const DAY_MS = 86_400_000

let host: FakeRelayHost

/** A local calendar day `days` from today (`YYYY-MM-DD`). */
function dayFromNow(days: number): string {
  const d = new Date(Date.now() + days * DAY_MS)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** "+N" in the fixture is N days from today, so the bars sit in the opening week view. */
const relative = (v: unknown): unknown =>
  typeof v === 'string' && /^\+\d+$/.test(v) ? dayFromNow(Number(v.slice(1))) : v

function timelineTickets(): Record<string, unknown>[] {
  const file = path.join(__dirname, 'fixtures', 'tickets', 'timeline-board.json')
  const { tickets } = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    tickets: Record<string, unknown>[]
  }
  return tickets.map((t) => {
    const milestone = t.milestone as Record<string, unknown>
    return {
      ...t,
      dueDate: relative(t.dueDate),
      startedAt: t.dueDate === null ? null : Date.now() - 3 * DAY_MS,
      milestone: { ...milestone, targetDate: relative(milestone.targetDate) },
    }
  })
}

const test = base.extend({
  launchEnv: async ({}, use) => {
    const fx = makeEvaFixture()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-timeline-'))
    const relayDir = path.join(root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    host.features = ['render.report', TICKETS_FEATURE, TICKETS_WRITES_FEATURE]
    host.tickets.board.tickets = timelineTickets()
    // ENG-9001 also gets a Relay start: a mixed row.
    host.replanProposal = hostProposal(
      host.tickets.board.tickets,
      hostViewerId(host.tickets.status),
      { 'ENG-9001': dayFromNow(1) },
    )
    await use({ ...fx.env, EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
    fx.cleanup()
  },
})

test.use({ startOnChat: false })

const sel = (id: string): string => `[data-testid="${id}"]`
type Shell = { __evaosShell: { openPlace(page: string): void } }
type Mutation = {
  kind: string
  mutation?: { kind: string; rows?: { key: string; plannedStart?: string | null }[] }
}
const mutations = (): Mutation[] => host.mutations.map((m) => m.cmd as Mutation)
const ops = (kind: string): unknown[] =>
  host.ticketFrames.map((f) => f.op as { kind: string }).filter((o) => o.kind === kind)

/**
 * Every date-line label sits in the scale's last row (the empty band, which draws no ticks), below
 * every tick and date.
 */
async function labelsClearOfScale(shell: Page): Promise<void> {
  const at = await shell.evaluate(() => {
    const scale = document.querySelector('[data-testid="timeline"] .wx-chart .wx-scale')
    const rows = [...(scale?.querySelectorAll(':scope > .wx-row') ?? [])]
    const box = (e: Element) => e.getBoundingClientRect()
    const bandCells = [...(rows.at(-1)?.querySelectorAll('.wx-cell') ?? [])]
    return {
      dates: Math.max(...rows.slice(0, -1).map((r) => box(r).bottom)),
      band: rows.length > 0 ? box(rows.at(-1)!).bottom : 0,
      bandTicks: bandCells.filter(
        (c) => getComputedStyle(c).borderRightColor !== 'rgba(0, 0, 0, 0)',
      ).length,
      labels: [...(scale?.querySelectorAll('[data-line-label]') ?? [])].map((l) => ({
        top: box(l).top,
        bottom: box(l).bottom,
      })),
    }
  })
  expect(at.labels.length).toBeGreaterThan(0)
  expect(at.bandTicks).toBe(0)
  for (const l of at.labels) {
    expect(l.top).toBeGreaterThanOrEqual(at.dates)
    expect(l.bottom).toBeLessThanOrEqual(at.band)
  }
}

/**
 * Where a date line crosses a bar, the bar (and its label) is on top. The lines take no pointer
 * events, so for the hit test only they are made hittable: whatever is topmost at the crossing
 * must be the bar, not the line.
 */
async function linesUnderBars(shell: Page): Promise<number> {
  const misses = await shell.evaluate(() => {
    const lines = [
      ...document.querySelectorAll<HTMLElement>('[data-testid="timeline"] [data-line]'),
    ]
    const bars = [...document.querySelectorAll('[data-testid="timeline"] .wx-bar')]
    const out: string[] = []
    let crossings = 0
    for (const line of lines) {
      line.style.pointerEvents = 'auto'
      const x = line.getBoundingClientRect().left + 1
      for (const bar of bars) {
        const b = bar.getBoundingClientRect()
        if (x <= b.left || x >= b.right) continue
        crossings += 1
        const top = document.elementFromPoint(x, b.top + b.height / 2)
        if (top?.closest('.wx-bar') !== bar)
          out.push(`${line.dataset.line} over ${bar.getAttribute('data-id')}`)
      }
      line.style.pointerEvents = ''
    }
    return { out, crossings }
  })
  expect(misses.out).toEqual([])
  return misses.crossings
}

async function openBoard(shell: Page): Promise<void> {
  await shell.waitForFunction(() => '__evaosShell' in window)
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('board'))
}

test('the Timeline: switch, zoom, open a ticket, re-plan with Astra, apply and discard', async ({
  app,
  shell,
}) => {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1440, 900))
  await pickScheme(shell, 'dark')
  await openBoard(shell)
  await expect(shell.locator(sel('agents-board'))).toBeVisible({ timeout: 30_000 })

  // Board | Timeline, kept across a renderer reload.
  await shell.locator(sel('agents-view-timeline')).click()
  const timeline = shell.locator(sel('timeline'))
  await expect(timeline).toBeVisible()
  await expect(shell.locator(sel('agents-board'))).toHaveCount(0)
  const bar = shell.locator('.wx-bar[data-id=":ENG-9001"]')
  await expect(bar).toBeVisible({ timeout: 30_000 })
  await expect(shell.locator(sel('timeline-nodate'))).toContainText('ENG-9004')
  await shell.waitForTimeout(600) // the pref's save debounce
  await shell.reload()
  await openBoard(shell)
  await expect(timeline).toBeVisible({ timeout: 30_000 })
  await expect(bar).toBeVisible({ timeout: 30_000 })

  // Zoom buttons; at every zoom the date-line labels stay clear of the scale's ticks and dates.
  await expect(timeline).toHaveAttribute('data-zoom', 'week')
  await labelsClearOfScale(shell)
  // Today crosses ENG-9001 and the summary bars in this view; each bar stays on top of it.
  expect(await linesUnderBars(shell)).toBeGreaterThan(0)
  const zoomBar = shell.locator('.rb-timeline-bar')
  await zoomBar.getByText('Month', { exact: true }).click()
  await expect(timeline).toHaveAttribute('data-zoom', 'month')
  await labelsClearOfScale(shell)
  await zoomBar.getByText('Quarter', { exact: true }).click()
  await expect(timeline).toHaveAttribute('data-zoom', 'quarter')
  await labelsClearOfScale(shell)
  await zoomBar.getByText('Week', { exact: true }).click()
  await expect(timeline).toHaveAttribute('data-zoom', 'week')
  fs.mkdirSync(SHOTS, { recursive: true })
  await shell.screenshot({ path: path.join(SHOTS, 'timeline.png') })

  // A bar opens its ticket page; the breadcrumb comes back to the Timeline.
  await bar.click()
  const crumbs = shell.locator(sel('ticket-crumbs'))
  await expect(crumbs).toContainText('ENG-9001', { timeout: 30_000 })
  await shell.locator(sel('ticket-crumb-board')).click()
  await expect(timeline).toBeVisible({ timeout: 30_000 })

  // Ask Astra to re-plan the milestone: her proposal becomes the draft.
  await timeline
    .getByText(/^Beta \(/)
    .first()
    .click()
  const ask = shell.getByRole('button', { name: 'Ask Astra to re-plan' })
  await expect(ask).toBeEnabled()
  await ask.click()
  const panel = shell.locator(sel('plan-panel'))
  await expect(panel).toHaveAttribute('data-plan', 'reviewingProposal', { timeout: 30_000 })
  await expect(panel).toContainText('Land Beta by its target date')
  await expect(panel.locator('[data-plan-row="ENG-9001"]')).toContainText('2027-01-08')
  await expect(panel.locator('[data-plan-row="ENG-9002"]')).toContainText('Blocks the Beta release')
  expect(ops('replan')).toEqual([
    { kind: 'replan', projectId: 'project-board', milestoneId: 'ms-beta' },
  ])
  expect(host.mutations).toEqual([])
  await shell.screenshot({ path: path.join(SHOTS, 'proposal.png') })

  // Apply: the confirm lists every change; one prepare + one commit of `applyPlan`.
  await panel.getByRole('button', { name: 'Apply' }).click()
  const confirm = shell.getByRole('dialog', { name: 'Apply this plan?' })
  await expect(confirm).toBeVisible()
  await expect(confirm).toContainText('ENG-9001')
  await expect(confirm).toContainText('2027-01-08')
  await expect(confirm).toContainText('ENG-9002')
  await shell.screenshot({ path: path.join(SHOTS, 'apply-confirm.png') })
  await shell.locator(sel('plan-confirm-apply')).click()
  await expect(panel).toHaveAttribute('data-plan', 'applied', { timeout: 30_000 })
  expect(mutations().map((m) => [m.kind, m.mutation?.kind])).toEqual([
    ['prepare', 'applyPlan'],
    ['commit', 'applyPlan'],
  ])
  expect(
    mutations()[1]
      ?.mutation?.rows?.map((r) => r.key)
      .sort(),
  ).toEqual(['ENG-9001', 'ENG-9002'])
  // ENG-9001's Relay start rides in the same approved applyPlan, with the start it was made from.
  expect(mutations()[1]?.mutation?.rows?.find((r) => r.key === 'ENG-9001')).toMatchObject({
    plannedStart: dayFromNow(1),
    basePlannedStart: null,
  })
  expect(ops('plan')).toEqual([])
  await panel.getByRole('button', { name: 'OK' }).click()
  await expect(panel).toHaveCount(0)

  // Another proposal, discarded: nothing more is written.
  await ask.click()
  await expect(panel).toHaveAttribute('data-plan', 'reviewingProposal', { timeout: 30_000 })
  await panel.getByRole('button', { name: 'Discard' }).click()
  await expect(panel).toHaveCount(0)
  expect(ops('replan')).toHaveLength(2)
  expect(host.mutations).toHaveLength(2)
})
