// The Board with synced tickets, against a stand-in Relay host that has `tickets` and
// `tickets.writes` (fixtures in e2e/fixtures/tickets) plus a ledger work item: synced ticket and
// agent cards on one board, Done hidden until shown, the Waiting on you filter, Mark as handled
// (Relay-only: a `handled` frame, never a write), a drag that writes the state through the host's
// gate and one the gate refuses (rolled back with a toast), and a run card that opens its own
// target. No network: Linear and GitHub only exist as the fake host's fixtures.
//
//   pnpm build && pnpm e2e:run e2e/board-tickets.spec.ts --retries 0 --max-failures 1
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { TICKETS_FEATURE, TICKETS_WRITES_FEATURE } from '@relay/protocol'
import { test as base, expect } from './fixtures'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { makeEvaFixture } from './helpers/eva-fixture'
import { pickScheme } from './helpers/appearance'

const SHOTS = path.join(__dirname, '..', 'test-results', 'board-shots')

let host: FakeRelayHost

const ledger = (key: string, title: string, extra = ''): string =>
  `---\nkey: ${key}\ntitle: ${title}\nworkspace: ecardsystems\nstage: 5 Build\nmove: agent\nnext: Agent: build\nupdated: ${new Date().toISOString().slice(0, 10)}\n${extra}---\n\n## Context\n`

const test = base.extend({
  launchEnv: async ({}, use) => {
    const fx = makeEvaFixture()
    const items = path.join(fx.root, 'work/items')
    fs.mkdirSync(items, { recursive: true })
    fs.writeFileSync(
      path.join(items, 'ENG-9001.md'),
      ledger(
        'ENG-9001',
        'Sample synced ticket',
        'linear: https://linear.example.test/issue/ENG-9001\n',
      ),
    )
    fs.writeFileSync(path.join(items, 'relay-demo.md'), ledger('relay-demo', 'Relay demo item'))
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-board-tickets-'))
    const relayDir = path.join(root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    host.features = ['render.report', TICKETS_FEATURE, TICKETS_WRITES_FEATURE]
    await use({ ...fx.env, EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
    fx.cleanup()
  },
})

test.use({ startOnChat: false })

const sel = (id: string): string => `[data-testid="${id}"]`
type Shell = { __evaosShell: { openPlace(page: string): void } }
type Op = { kind: string; undo?: boolean; target?: Record<string, unknown> }
const ops = (): Op[] => host.ticketFrames.map((f) => f.op as Op)
const handledOps = (): Op[] => ops().filter((o) => o.kind === 'handled')
const mutations = (): Array<{ kind: string; mutation?: { kind: string } }> =>
  host.mutations.map((m) => m.cmd as { kind: string; mutation?: { kind: string } })

/** Drags a card by the mouse (past the sensor's start distance) and drops it on `target`. */
async function drag(shell: Page, card: Locator, target: Locator): Promise<void> {
  const from = (await card.boundingBox())!
  const to = (await target.boundingBox())!
  await shell.mouse.move(from.x + from.width / 2, from.y + 12)
  await shell.mouse.down()
  await shell.mouse.move(from.x + from.width / 2 + 10, from.y + 20, { steps: 4 })
  await shell.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 12 })
  await shell.mouse.up()
}

const col = (shell: Page, column: string): Locator =>
  shell.locator(`section.eva-ab-col[data-column="${column}"]`)

test('the board shows synced tickets beside agent work; hide, filter, handle, move', async ({
  app,
  shell,
}) => {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1440, 900))
  // Linear's board is dark: the screenshots compare against the prototype's.
  await pickScheme(shell, 'dark')
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('board'))
  const board = shell.locator(sel('agents-board'))
  await expect(board).toBeVisible()

  // One card per key: the ledger item and its synced ticket are one; the pure ticket and the
  // ledger-only item sit beside it.
  const eng1 = shell.locator(sel('agents-card-ENG-9001'))
  const eng2 = shell.locator(sel('agents-card-ENG-9002'))
  await expect(eng1).toBeVisible({ timeout: 30_000 })
  await expect(eng2).toBeVisible()
  await expect(shell.locator(sel('agents-card-relay-demo'))).toBeVisible()
  await expect(shell.locator('[data-testid="agents-card-ENG-9001"]')).toHaveCount(1)
  await expect(eng1).toContainText('Waiting on you')
  await expect(eng1).toContainText('#42')
  await expect(eng2).toContainText(/Created \w{3} \d+/)
  await expect(shell.locator(sel('agents-freshness'))).toContainText('Synced')
  fs.mkdirSync(SHOTS, { recursive: true })
  await shell.screenshot({ path: path.join(SHOTS, 'board.png') })

  // Done is hidden by default; a completed ticket counts there and Show column brings it back.
  await expect(col(shell, 'done')).toHaveCount(0)
  const done = JSON.parse(JSON.stringify(host.tickets.board.tickets[1])) as Record<string, unknown>
  Object.assign(done, {
    key: 'ENG-9003',
    id: 'issue-9003',
    title: 'Finished sample ticket',
    state: { id: 'state-done', name: 'Done', type: 'completed', color: '#5e6ad2' },
    updatedAt: Date.now(),
  })
  host.pushDelta({ upserts: [done] })
  const hiddenDone = shell.locator(sel('agents-hidden-done'))
  await expect(hiddenDone.locator('.eva-ab-count')).toHaveText('1')
  await hiddenDone.locator('.eva-ab-hopen').click()
  const pop = shell.locator(sel('agents-hidden-pop-done'))
  await expect(shell.locator(sel('agents-hidden-card-ENG-9003'))).toBeVisible()
  await shell.screenshot({ path: path.join(SHOTS, 'hidden-columns.png') })
  await shell.keyboard.press('Escape')
  await expect(pop).toHaveCount(0)
  await hiddenDone.hover()
  await shell.locator(sel('agents-show-done')).click()
  await expect(col(shell, 'done').locator(sel('agents-card-ENG-9003'))).toBeVisible()
  await col(shell, 'done').hover()
  await shell.locator(sel('agents-colmenu-done')).click()
  await shell.locator(sel('agents-hide-done')).click()
  await expect(col(shell, 'done')).toHaveCount(0)

  // Waiting on you: the waiting ticket only.
  await expect(shell.locator(sel('agents-waiting-count'))).toHaveText('1')
  await board.evaluate((el) => el.scrollTo({ left: 0 }))
  await shell.locator(sel('agents-waiting')).click()
  await expect(eng1).toBeVisible()
  await expect(eng2).toHaveCount(0)
  await shell.screenshot({ path: path.join(SHOTS, 'waiting-filter.png') })
  await shell.locator(sel('agents-waiting')).click()
  await expect(eng2).toBeVisible()

  // Mark as handled: a Relay-only `handled` frame, no write; Undo sends it back.
  await eng1.hover()
  await eng1.locator(sel('agents-wait-handled')).click()
  await expect(eng1.locator(sel('agents-wait'))).toHaveCount(0)
  await expect.poll(() => handledOps().length).toBe(1)
  expect(handledOps()[0]).toMatchObject({
    target: {
      kind: 'mention',
      provider: 'linear',
      itemId: 'ENG-9001',
      throughCommentId: 'comment-1',
    },
    undo: false,
  })
  await expect(shell.locator(sel('agents-side'))).toHaveCount(0)
  await shell.locator(sel('agents-handled-undo')).click()
  await expect.poll(() => handledOps().length).toBe(2)
  expect(handledOps()[1]).toMatchObject({ undo: true })
  await expect(eng1.locator(sel('agents-wait'))).toBeVisible()
  expect(host.mutations).toEqual([])

  // Drag the Todo ticket to Working: the host's gate gets the state write; no card opened.
  await drag(shell, eng2, col(shell, 'working'))
  await expect(col(shell, 'working').locator(sel('agents-card-ENG-9002'))).toBeVisible()
  await expect
    .poll(() =>
      mutations()
        .filter((m) => m.kind === 'commit')
        .map((m) => m.mutation?.kind),
    )
    .toEqual(['setState'])
  await expect(shell.locator(sel('agents-side'))).toHaveCount(0)
  await expect(shell.locator(sel('agents-move-undo'))).toBeVisible()
  // The host's next board has it in progress, as Linear would.
  const moved = host.tickets.board.tickets.find((t) => t.key === 'ENG-9002')!
  host.pushDelta({
    upserts: [
      {
        ...moved,
        state: { id: 'state-in-progress', name: 'In Progress', type: 'started', color: '#f2c94c' },
        updatedAt: Date.now(),
      },
    ],
  })

  // The gate refuses the next one: the card goes back and a toast says why.
  const before = host.mutations.length
  host.refuseNext('conflict')
  await drag(
    shell,
    col(shell, 'working').locator(sel('agents-card-ENG-9002')),
    col(shell, 'review'),
  )
  await expect.poll(() => host.mutations.length).toBeGreaterThan(before)
  await expect(shell.getByText('Refused: conflict')).toBeVisible()
  await expect(col(shell, 'working').locator(sel('agents-card-ENG-9002'))).toBeVisible()
  await expect(col(shell, 'review').locator(sel('agents-card-ENG-9002'))).toHaveCount(0)
  await expect(shell.locator(sel('agents-side'))).toHaveCount(0)

  // A run of its own (no key) opens its target directly, not the side panel.
  host.setActivity([
    {
      id: 'helper:board-proto',
      kind: 'helper',
      owner: 'assistant:nova',
      title: 'BoardProto',
      status: 'working',
      intent: 'Reading the board',
      startedAt: Date.now() - 60_000,
      updatedAt: Date.now(),
      model: 'claude-opus-5-5',
      open: { to: 'chat', thread: 'assistant:nova' },
    },
  ])
  const run = shell.locator('[data-testid^="agents-card-run:"]')
  await expect(run).toHaveCount(1)
  await expect(run).toContainText('BoardProto')
  await run.click()
  await expect(shell.locator(sel('page-board'))).toBeHidden()
  await expect(shell.locator(sel('agents-side'))).toHaveCount(0)
})
