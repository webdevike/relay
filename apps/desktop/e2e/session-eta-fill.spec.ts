import * as fs from 'node:fs'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost, type HostSession } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT } from './helpers/paths'

// Running badges show how far along they are: the host's activity items carry an estimate (`eta`),
// and the composer chips and Artifacts' Running rows draw it as a low-contrast fill behind the label.
// Solid when the host is fairly sure, soft diagonal stripes for a rough guess, amber once the run
// is past its usual time. The compact time ("12m") sits after the name where there is room, and the
// tooltip says what is left and how sure the guess is. Reduced motion keeps the fill static.
//
// PROOF_DIR=<dir> writes screenshots of the chip strip (zoomed) and the Artifacts Running group.
const PROOF_DIR = process.env.PROOF_DIR ?? ''

let fx: ChatFixture
let host: FakeRelayHost
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    const evaRoot = path.join(fx.root, 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
    fs.mkdirSync(path.join(evaRoot, '.omp/assistant'), { recursive: true })
    fs.writeFileSync(
      path.join(evaRoot, '.omp/assistant/agents.json'),
      JSON.stringify({
        agents: [{ id: 'nova', title: 'Nova', scope: 'Personal', avatar: 'astra-2' }],
      }),
    )
    host = await FakeRelayHost.start(path.join(fx.root, 'relay'))
    await use({
      ...fx.launchEnv,
      EVAOS_EVA_ROOT: evaRoot,
      EVAOS_RELAY_DIR: path.join(fx.root, 'relay'),
    })
    await host.close()
    fx.cleanup()
  },
})
test.use({ startOnChat: false, toolPanes: false, reducedMotion: 'reduce' })

const sel = (id: string): string => `[data-testid="${id}"]`
const NOVA_THREAD: HostSession = {
  id: 'nova-1',
  status: 'idle',
  kind: 'assistant',
  assistant: 'nova',
  title: 'Nova',
}

const MIN = 60_000
const now = Date.now()
const chatOf = (session: string) => ({ to: 'chat', thread: `session:${session}`, session })

/** An estimate for a 20 minute task that began `elapsed` minutes ago. */
const eta = (elapsed: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  from: now - elapsed * MIN,
  totalMs: 20 * MIN,
  lowMs: 15 * MIN,
  highMs: 30 * MIN,
  typicalMs: 18 * MIN,
  runs: 34,
  confidence: 'confident',
  overrunning: false,
  ...over,
})

const session = (id: string, title: string, elapsed: number, e: Record<string, unknown>) => ({
  id: `session:${id}`,
  kind: 'session',
  owner: 'assistant:nova',
  title,
  status: 'working',
  intent: 'Working through the plan',
  startedAt: now - elapsed * MIN,
  updatedAt: now,
  open: chatOf(id),
  eta: e,
})

const SESSION_NO_EXT = '2026-11-04T10-00-00-000Z_nova-1'

test('running badges and rows fill by estimated progress, solid, striped or amber', async ({
  shell,
}) => {
  await shell.locator(sel('nav-assistants')).click()
  await shell.locator(sel('sidebar-agent-nova')).click()
  await shell.locator(sel('start-nova')).click()
  await expect.poll(() => host.kinds()).toContain('assistant.turn')
  host.upsert(NOVA_THREAD)
  const sessionFile = path.join(fx.sessionsDir, `${SESSION_NO_EXT}.jsonl`)
  fs.writeFileSync(
    sessionFile,
    [
      { type: 'session', version: 3, id: 'nova-1', timestamp: new Date().toISOString(), cwd: '/' },
      { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'Hi Nova' } },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n',
  )
  // One helper of the thread: its transcript sits in the session's folder, so it has a chip, and
  // the host lists it as `helper:<that path>` with its own estimate.
  const helperFile = path.join(fx.sessionsDir, SESSION_NO_EXT, 'Layouts.jsonl')
  fs.mkdirSync(path.dirname(helperFile), { recursive: true })
  fs.writeFileSync(
    helperFile,
    JSON.stringify({
      type: 'message',
      id: 'h1',
      parentId: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Reading the dock store' }] },
    }) + '\n',
  )
  await expect(shell.locator(sel('chat-log'))).toContainText('Hi Nova', { timeout: 10_000 })

  host.setArtifacts('assistant:nova', [
    {
      id: `subagent:${helperFile}`,
      kind: 'subagent',
      title: 'Layouts',
      path: helperFile,
      mentions: 1,
      firstSeen: now - 6 * MIN,
      lastSeen: now,
      sources: [],
      addedBy: 'extractor',
      subagent: { state: 'running', startedAt: now - 6 * MIN, line: 'Reading the dock store' },
    },
  ])
  host.setActivity([
    session('sure', 'Isolate layouts per chat', 8, eta(8)),
    session(
      'rough',
      'Port the dock store',
      12,
      eta(12, { confidence: 'rough', runs: 0, steps: { done: 3, total: 7 } }),
    ),
    session('late', 'Rebuild the search index', 45, eta(45)),
    {
      id: `helper:${helperFile}`,
      kind: 'helper',
      owner: 'assistant:nova',
      title: 'Layouts',
      status: 'working',
      intent: 'Reading the dock store',
      startedAt: now - 6 * MIN,
      updatedAt: now,
      open: { to: 'subagent', file: helperFile, name: 'Layouts' },
      eta: eta(6, { confidence: 'rough' }),
    },
  ])

  const chip = (id: string) => shell.locator(sel(`activity-chip-session:${id}`))
  const short = (id: string) => chip(id).locator(sel('eta-short'))

  // The fill state is on the chip: solid, striped, amber; the fraction is how far along it is.
  await expect(chip('sure')).toHaveAttribute('data-eta', 'solid')
  await expect(chip('rough')).toHaveAttribute('data-eta', 'striped')
  await expect(chip('late')).toHaveAttribute('data-eta', 'overrunning')
  const fraction = async (id: string): Promise<number> =>
    Number(
      await chip(id).evaluate((e) => (e as HTMLElement).style.getPropertyValue('--eta-fraction')),
    )
  expect(await fraction('sure')).toBeCloseTo(0.4, 1)
  expect(await fraction('rough')).toBeCloseTo(0.6, 1)
  expect(await fraction('late')).toBeGreaterThan(0.9)

  // The helper's chip finds its estimate by transcript path.
  const helperChip = shell.locator(sel('subagent-chip-Layouts'))
  await expect(helperChip).toHaveAttribute('data-eta', 'striped')

  // Compact time after the name on the on-track ones, none on the one taking longer.
  await expect(short('sure')).toHaveText('12m')
  await expect(short('rough')).toHaveText('8m')
  await expect(short('late')).toHaveCount(0)

  // The fill stays inside the capsule: a pill-shaped chip clips nothing and grows no taller.
  const box = await chip('sure').boundingBox()
  expect(box?.height).toBeLessThan(40)

  // Hover: what is left, then how sure and why.
  await chip('sure').hover()
  const tip = shell.locator(sel('eta-tip-session:sure'))
  await expect(tip).toContainText('About 12 min left')
  await expect(tip).toContainText('Fairly sure · 34 similar runs')
  await chip('rough').hover()
  await expect(shell.locator(sel('eta-tip-session:rough'))).toContainText(
    'Rough guess · 3 of 7 steps done',
  )
  await chip('late').hover()
  const late = shell.locator(sel('eta-tip-session:late'))
  await expect(late).toContainText('Taking longer than usual')
  await expect(late).toContainText('Usually about 18 min, this one is at 45 min')
  await shell.mouse.move(0, 0)

  if (PROOF_DIR !== '') {
    fs.mkdirSync(PROOF_DIR, { recursive: true })
    const strip = shell.locator(sel('subagent-chips'))
    await strip.evaluate((e) => ((e as HTMLElement).style.zoom = '2'))
    await strip.screenshot({ path: path.join(PROOF_DIR, 'chip-strip.png') })
    await strip.evaluate((e) => ((e as HTMLElement).style.zoom = ''))
  }

  // Artifacts' Running rows: the same fill behind the row, and "12m left" in place of the age.
  await shell.locator(sel('artifacts-button')).click()
  await shell.locator(sel('artifacts-tab-subagents')).click()
  const running = shell.locator(sel('working-running'))
  const row = (id: string) => shell.locator(sel(`activity-row-session:${id}`))
  await expect(row('sure')).toHaveAttribute('data-eta', 'solid')
  await expect(row('rough')).toHaveAttribute('data-eta', 'striped')
  await expect(row('late')).toHaveAttribute('data-eta', 'overrunning')
  await expect(row('sure')).toContainText('12m left')
  await expect(row('rough')).toContainText('8m left')
  await expect(row('late')).not.toContainText('left')
  // The helper is one Artifacts row, with its own fill.
  const helperRow = shell.locator(sel(`artifact-row-subagent:${helperFile}`))
  await expect(helperRow).toHaveAttribute('data-eta', 'striped')
  await expect(helperRow).toContainText('left')

  if (PROOF_DIR !== '') {
    await running.screenshot({ path: path.join(PROOF_DIR, 'artifacts-running.png') })
    await shell.screenshot({ path: path.join(PROOF_DIR, 'window.png') })
  }

  // A run that ends: its chip fills up and fades instead of vanishing (static fill under reduced
  // motion, so only the removal is seen), then it is gone.
  await shell.keyboard.press('Escape')
  host.setActivity([])
  await expect(chip('sure')).toHaveCount(0, { timeout: 5_000 })
})
