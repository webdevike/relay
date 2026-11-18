import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, FrameLocator, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { APP_DIR, EVA_FIXTURE_ROOT } from './helpers/paths'

// The design canvas: Nova (a scripted agent on the agent control API) designs a component live on
// a board. She adds a component card in Relay's own design system, edits it three times by patch
// (each edit redraws in place, without reloading its page, within a second of landing in the
// file), breaks it once (the card says why and keeps the last good render), then lays three
// variants beside it; Isaac taps Pick on one and the pick comes into Nova's thread as a comment.
// Screenshots go to EVAOS_DESIGN_PROOF (default test-results/canvas-design).

let fx: ChatFixture
let host: FakeRelayHost
const line = (o: unknown): string => JSON.stringify(o)

const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    const evaRoot = path.join(fx.root, 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
    fs.mkdirSync(path.join(evaRoot, '.omp/assistant'), { recursive: true })
    fs.writeFileSync(
      path.join(evaRoot, '.omp/assistant/agents.json'),
      JSON.stringify({
        agents: [{ id: 'nova', title: 'Nova', scope: 'Personal', avatar: 'nova-1' }],
      }),
    )
    fs.writeFileSync(
      path.join(fx.sessionsDir, '2026-11-18T09-00-00-000Z_nova-1.jsonl'),
      [
        line({
          type: 'session',
          version: 3,
          id: 'nova-1',
          timestamp: new Date().toISOString(),
          cwd: evaRoot,
        }),
        line({
          type: 'message',
          id: 'u1',
          parentId: null,
          message: { role: 'user', content: 'Can we design the session badges live?' },
        }),
      ].join('\n') + '\n',
    )
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    host.upsert({
      id: 'nova-1',
      status: 'idle',
      kind: 'assistant',
      assistant: 'nova',
      title: 'Nova',
    })
    await use({
      ...fx.launchEnv,
      EVAOS_EVA_ROOT: evaRoot,
      EVAOS_RELAY_DIR: relayDir,
      EVAOS_AGENT_CONTROL: '1',
    })
    await host.close()
    fx.cleanup()
  },
})
test.use({ startOnChat: false })

const sel = (id: string): string => `[data-testid="${id}"]`
type G = { __evaosTest: { win: { setContentSize(w: number, h: number): void } } }
type Shell = { __evaosShell: { openPlace(page: string): void } }
type Answer = { ok: boolean; value?: Record<string, unknown>; code?: string; message?: string }

async function size(app: ElectronApplication, shell: Page, w: number, h: number): Promise<void> {
  await app.evaluate(
    (_e, [ww, hh]) => (globalThis as unknown as G).__evaosTest.win.setContentSize(ww!, hh!),
    [w, h],
  )
  await expect.poll(() => shell.evaluate(() => window.innerWidth)).toBe(w)
}

/** The badge strip the agent designs: Relay's real chips and assistant portrait, in a Stack. */
const STRIP = `<Stack gap="sm" p="md">
  <ChipStrip>
    <SessionChip label="Fix login" state="running" />
    <SpecialistChip label="Web researcher" state="running" clock="0:12" />
    <SpecialistChip label="Design critic" state="done" />
  </ChipStrip>
  <Group gap="xs"><AssistantAvatar face="nova-1" size="sm" /><Text size="sm">Nova</Text></Group>
  <Text size="xs" c="dimmed">Round 0</Text>
</Stack>`

test('an agent designs a component live: patches redraw in place, errors keep the last render, variants get picked', async ({
  app,
  shell,
  configDir,
}) => {
  test.setTimeout(150_000)
  const proof = process.env.EVAOS_DESIGN_PROOF ?? path.join(APP_DIR, 'test-results/canvas-design')
  fs.rmSync(proof, { recursive: true, force: true })
  fs.mkdirSync(proof, { recursive: true })
  const file = path.join(configDir, 'agent-control.json')
  await expect.poll(() => fs.existsSync(file), { timeout: 15_000 }).toBe(true)
  const { port, token } = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    port: number
    token: string
  }
  const run = async (action: string, params: Record<string, unknown>): Promise<Answer> => {
    const res = await fetch(`http://127.0.0.1:${port}/actions/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ params, scope: 'agent:nova' }),
    })
    return (await res.json()) as Answer
  }
  const ok = async (action: string, params: Record<string, unknown>) => {
    const r = await run(action, params)
    expect(r.ok, `${action}: ${r.code} ${r.message}`).toBe(true)
    return r.value!
  }

  await size(app, shell, 2400, 1300)
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('agent:nova'))
  await expect(shell.locator(sel('chat-log'))).toContainText('session badges', { timeout: 15_000 })

  // 1. Nova opens a new board and adds a component card in Relay's design system.
  const opened = await ok('canvas.open', { title: 'Session badges', caption: 'Designing badges' })
  const slug = String(opened['slug'])
  const board = shell.locator(`${sel('canvas-board')}[data-slug="${slug}"]`)
  await expect(board).toBeVisible()
  const added = await ok('canvas.add', {
    slug,
    type: 'proto',
    title: 'Badge strip',
    body: STRIP,
    data: { viewport: 'pane' },
    caption: 'Drafting the badge strip',
  })
  expect(added).toMatchObject({ compile: 'ok' })
  const id = String(added['id'])
  const page = shell.locator(sel(`canvas-proto-${id}`))
  const inFrame: FrameLocator = page.frameLocator('iframe')
  await expect(page).toHaveAttribute('data-phase', 'live', { timeout: 20_000 })
  await expect(inFrame.getByText('Round 0')).toBeVisible()
  // The real Relay components, with the app's classes, drawn in the frame.
  await expect(inFrame.locator('.eva-chip[data-kind="specialist"]').first()).toBeVisible()
  await expect(inFrame.locator('.eva-pm .eva-as-avatar').first()).toBeVisible()
  const card = board.locator(`.react-flow__node[data-id="${id}"]`)
  // The card at 100% so the screenshots show it at its real size.
  await ok('canvas.zoom', { slug, node: id, zoom: 1 })
  await shell.waitForTimeout(600)
  await card.screenshot({ path: path.join(proof, '01-added.png') })
  const boot = await page.getAttribute('data-boot')

  // 2. Three patches: each redraws in place (same page, no reload) within a second of landing.
  const rounds = [
    { find: 'Round 0', replace: 'Round 1', also: { find: 'gap="sm"', replace: 'gap="md"' } },
    {
      find: 'Round 1',
      replace: 'Round 2',
      also: { find: 'size="sm" />', replace: 'size="md" />' },
    },
    {
      find: 'Round 2',
      replace: 'Round 3',
      also: {
        find: 'label="Design critic" state="done"',
        replace: 'label="Design critic" state="failed"',
      },
    },
  ]
  const timings: Array<{ round: number; callMs: number; redrawMs: number }> = []
  for (const [i, r] of rounds.entries()) {
    const start = Date.now()
    const edited = await ok('canvas.edit', {
      slug,
      node: id,
      edits: [{ find: r.find, replace: r.replace }, r.also],
      caption: `Round ${i + 1}`,
    })
    const landed = Date.now()
    expect(edited).toEqual({ id, compile: 'ok' })
    await expect(inFrame.getByText(r.replace)).toBeVisible({ timeout: 1_000 })
    await expect(page).toHaveAttribute('data-phase', 'live', { timeout: 1_000 })
    const redrawMs = Date.now() - landed
    timings.push({ round: i + 1, callMs: landed - start, redrawMs })
    expect(redrawMs).toBeLessThan(1_000)
    expect(await page.getAttribute('data-boot')).toBe(boot)
    await card.screenshot({ path: path.join(proof, `0${i + 2}-edit-${i + 1}.png`) })
  }

  // 3. A patch that breaks the code: the answer says why, the card shows it over the last good
  // render, and the next good patch clears it.
  const broken = await ok('canvas.edit', {
    slug,
    node: id,
    edits: [{ find: '</Stack>', replace: '' }],
    caption: 'Trying a looser layout',
  })
  expect(String(broken['compile'])).toMatch(/does not compile/)
  await expect(page).toHaveAttribute('data-phase', 'error', { timeout: 2_000 })
  await expect(shell.locator(sel(`canvas-proto-error-${id}`))).toContainText(
    'Showing the last good render',
  )
  await expect(inFrame.getByText('Round 3')).toBeVisible()
  await card.screenshot({ path: path.join(proof, '05-compile-error-keeps-last-render.png') })
  await ok('canvas.edit', {
    slug,
    node: id,
    edits: [{ find: '</Text>\n', replace: '</Text>\n</Stack>' }],
  })
  await expect(page).toHaveAttribute('data-phase', 'live', { timeout: 2_000 })
  await expect(shell.locator(sel(`canvas-proto-error-${id}`))).toHaveCount(0)

  // 4. Three variants side by side from the card, each its own patch, lettered.
  const set = await ok('canvas.add', {
    slug,
    copy: id,
    variants: [
      { title: 'Quiet', edits: [{ find: 'Round 3', replace: 'Quiet: dots only' }] },
      { title: 'Labeled', edits: [{ find: 'Round 3', replace: 'Labeled: name and clock' }] },
      {
        title: 'Compact',
        edits: [
          { find: 'Round 3', replace: 'Compact: one row' },
          { find: 'gap="md"', replace: 'gap={4}' },
        ],
      },
    ],
    caption: 'Three directions for the strip',
  })
  const ids = set['ids'] as string[]
  expect(set['labels']).toEqual(['B', 'C', 'D'])
  expect(Object.values(set['compile'] as Record<string, string>)).toEqual(['ok', 'ok', 'ok'])
  for (const v of ids) {
    await expect(shell.locator(sel(`canvas-proto-${v}`))).toHaveAttribute('data-phase', 'live', {
      timeout: 20_000,
    })
  }
  await expect(shell.locator(sel(`canvas-proto-label-${id}`))).toHaveText('A')
  await ok('canvas.zoom', { slug, fit: true })
  await shell.waitForTimeout(700)
  await board.screenshot({ path: path.join(proof, '06-variants.png') })
  await shell.screenshot({ path: path.join(proof, '06b-variants-window.png') })
  // Each variant at 100%, with its letter and Pick button.
  const labels = set['labels'] as string[]
  for (const [i, v] of ids.entries()) {
    await ok('canvas.zoom', { slug, node: v, zoom: 1 })
    await shell.waitForTimeout(600)
    await board
      .locator(`.react-flow__node[data-id="${v}"]`)
      .screenshot({ path: path.join(proof, `06-variant-${labels[i]!}.png`) })
  }
  await ok('canvas.zoom', { slug, fit: true })
  await shell.waitForTimeout(700)

  // 5. Isaac picks C with a tap: the pick lands in Nova's thread as his comment on that card.
  await shell.locator(sel(`canvas-proto-pick-${ids[1]!}`)).click()
  await expect
    .poll(
      () =>
        host.commands.find(
          (c) => c.cmd.kind === 'assistant.turn' && String(c.cmd.text).includes('Picked variant C'),
        )?.cmd,
      { timeout: 10_000 },
    )
    .toMatchObject({ agent: 'nova' })
  const pick = host.commands.find(
    (c) => c.cmd.kind === 'assistant.turn' && String(c.cmd.text).includes('Picked variant C'),
  )!
  expect(String(pick.cmd.text)).toContain(`(${ids[1]!})`)
  expect(String(pick.cmd.text)).toContain('of 4')
  await board.screenshot({ path: path.join(proof, '07-picked.png') })
  // The comment thread on the card says the pick went to Nova.
  await shell.screenshot({ path: path.join(proof, '08-pick-sent-window.png') })

  fs.writeFileSync(path.join(proof, 'timings.json'), JSON.stringify({ timings }, null, 2))
})
