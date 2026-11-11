import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { z } from 'zod'
import { launchApp, test, expect } from './fixtures'

// Opt-in live spec: a real Pair council room (every seat in real omp on a cheap model,
// EVAOS_ROOMS_SEAT_MODEL) is paused from the Rooms page after round 1, the app quits, a new app
// run lists the room as Paused from its room.json, and Resume runs round 2 to the end with the
// same seats on their own omp sessions. The window stays hidden (EVAOS_HIDDEN_WINDOW).
// EVAOS_ROOMS_SHOTS=<dir> keeps the screenshots there.
test.skip(process.env.EVAOS_LIVE !== '1', 'a real council room is opt-in (EVAOS_LIVE=1)')
test.use({ startOnChat: false, toolPanes: false })
test.setTimeout(1_800_000)

const sel = (id: string): string => `[data-testid="${id}"]`
/** The open room's phase pill (the rail rows carry one each too). */
const phase = (id: string): string => `${sel(`room-${id}`)} ${sel('room-phase')}`
const SHOTS = process.env.EVAOS_ROOMS_SHOTS ?? path.join(__dirname, '../test-results/rooms-resume')
const MODEL = process.env.EVAOS_ROOMS_SEAT_MODEL ?? 'anthropic/claude-haiku-4-5'

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

const WireRoom = z.object({
  id: z.string(),
  phase: z.string(),
  rounds: z.number(),
  file: z.string().optional(),
  messages: z.array(
    z.object({
      author: z.string(),
      text: z.string(),
      card: z.object({ type: z.string(), round: z.number().optional() }).optional(),
    }),
  ),
  council: z
    .object({
      round: z.number(),
      workdir: z.string(),
      paused: z.boolean().optional(),
      spend: z.object({ usd: z.number(), cap: z.number() }),
    })
    .optional(),
})
type WireRoom = z.infer<typeof WireRoom>
const Result = z.object({
  ok: z.boolean(),
  value: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
})
const RoomState = z.object({
  progress: z.object({ nextRound: z.number() }),
  seats: z.record(
    z.string(),
    z.object({ session: z.object({ harness: z.string(), file: z.string() }).optional() }),
  ),
})

/** The test hooks and IPC the e2e build puts on window. */
interface E2eWindow {
  eva: { invoke(c: string, i: unknown): Promise<unknown> }
  __evaosShell?: { openPlace(k: string, n: boolean): void }
}

const invoke = async (page: Page, channel: string, input: unknown): Promise<z.infer<typeof Result>> =>
  Result.parse(
    await page.evaluate(([c, i]) => {
      const w = window as unknown as E2eWindow // the preload's bridge, typed in the app, not here
      return w.eva.invoke(c, i)
    }, [channel, input] as const),
  )

async function room(page: Page, id: string): Promise<WireRoom> {
  const r = await invoke(page, 'rooms.list', {})
  const found = z.object({ rooms: z.array(WireRoom) }).parse(r.value).rooms.find((x) => x.id === id)
  if (!found) throw new Error(`room ${id} is not listed`)
  return found
}

/** Answers the 80 % cap pause with Continue whenever it shows up (list prices of a cheap model). */
async function waitFor(page: Page, id: string, ok: (r: WireRoom) => boolean, what: string, ms: number): Promise<WireRoom> {
  const end = Date.now() + ms
  for (;;) {
    const r = await room(page, id)
    if (ok(r)) return r
    if (r.phase === 'failed' || r.phase === 'resolved')
      throw new Error(`room ${r.phase} while waiting for ${what} (round ${r.council?.round})`)
    if (r.council?.paused) await invoke(page, 'rooms.budget', { roomId: id, choice: 'continue' })
    if (Date.now() > end) throw new Error(`timed out waiting for ${what} (phase ${r.phase}, round ${r.council?.round})`)
    await page.waitForTimeout(2000)
  }
}

async function openRooms(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as E2eWindow // e2e hooks (EVAOS_E2E)
    w.__evaosShell?.openPlace('rooms', false)
  })
  await page.waitForSelector(sel('rooms-page'))
}

async function shellOf(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid=rail]')
  await page.waitForFunction(() => {
    const w = window as unknown as E2eWindow // e2e hooks (EVAOS_E2E)
    return w.__evaosShell !== undefined
  })
  return page
}

// The Eva root lives outside any repo (no AGENTS.md or .omp above the seats); its journal tool is a no-op.
const evaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-resume-eva-'))
fs.mkdirSync(path.join(evaRoot, 'work/src'), { recursive: true })
fs.mkdirSync(path.join(evaRoot, 'memory/rooms'), { recursive: true })
fs.mkdirSync(path.join(evaRoot, '.omp/tools'), { recursive: true })
fs.writeFileSync(path.join(evaRoot, '.omp/tools/journal-add.ts'), '// test: the journal is not kept\n')
fs.writeFileSync(
  path.join(evaRoot, 'work/src/poem.md'),
  '# Lighthouse\n\nThe light goes round.\nThe sea is wide.\n',
)
test.afterAll(() => fs.rmSync(evaRoot, { recursive: true, force: true }))

const env = {
  EVAOS_EVA_ROOT: evaRoot,
  EVAOS_OMP_BIN: process.env.EVAOS_OMP_BIN ?? path.join(os.homedir(), '.local/bin/omp'),
  EVAOS_ROOMS_SEAT_MODEL: MODEL,
}
test.use({ launchEnv: env })

test('a council room paused after round 1 survives a quit and resumes to the end on the same seats', async ({ app, shell, configDir }) => {
  await openRooms(shell)
  const made = await invoke(shell, 'rooms.create', {
    prompt: 'Make poem.md a four-line poem about a lighthouse with an AABB rhyme. Keep it short.',
    council: {
      effort: 2,
      source: 'work/src',
      refs: [],
      routing: {},
      // A criterion round 1 cannot meet, so the judge does not call it converged before the pause.
      rubric: [
        { id: 'c1', name: 'Rhyme: four lines, AABB', owner: 'Whole' },
        {
          id: 'c2',
          name: 'Revised: score 2 while the poem has had one build round, 9 once a second round revised it',
          owner: 'Whole',
        },
      ],
    },
  })
  const id = z.object({ roomId: z.string() }).parse(made.value).roomId
  await shell.click(sel(`rooms-rail-${id}`))
  await expect(shell.locator(phase(id))).toHaveText('Live')

  // Pause once round 1 runs: the room stops at the end of it.
  await waitFor(shell, id, (r) => (r.council?.round ?? 0) >= 1, 'round 1', 900_000)
  await shell.click(sel('room-pause'))
  await expect(shell.locator(sel('room-pause'))).toHaveText('Pausing after this round')
  await shot(shell, '1-pausing')
  const paused = await waitFor(shell, id, (r) => r.phase === 'paused', 'the pause', 900_000)
  expect(paused.messages.filter((m) => m.card?.type === 'scorecard').map((m) => m.card!.round)).toEqual([1])
  await expect(shell.locator(phase(id))).toHaveText('Paused')
  await expect(shell.locator(sel('room-resume'))).toBeVisible()
  await shot(shell, '2-paused')
  const workdir = paused.council!.workdir
  const state = RoomState.parse(JSON.parse(fs.readFileSync(path.join(workdir, 'room.json'), 'utf8')))
  expect(state.progress.nextRound).toBe(2)
  const sessions = Object.fromEntries(Object.entries(state.seats).map(([seat, s]) => [seat, s.session?.file]))
  for (const file of Object.values(sessions)) expect(file && fs.existsSync(file)).toBe(true)
  const spentAtPause = paused.council!.spend.usd

  // Quit; a new app run finds the room on disk.
  await app.close()
  const again = await launchApp(configDir, env)
  try {
    const page = await shellOf(again)
    await openRooms(page)
    await page.click(sel(`rooms-rail-${id}`))
    await expect(page.locator(phase(id))).toHaveText('Paused')
    await shot(page, '3-reopened')
    await page.click(sel('room-resume'))
    await expect(page.locator(phase(id))).toHaveText('Live')
    const done = await waitFor(page, id, (r) => r.phase === 'resolved', 'the delivery', 1_200_000)
    await shot(page, '4-resolved')
    // Round 1 ran once, round 2 after the resume; then the delivery.
    const rounds = done.messages.filter((m) => m.card?.type === 'scorecard').map((m) => m.card!.round)
    expect(rounds[0]).toBe(1)
    expect(rounds.filter((r) => r === 1)).toHaveLength(1)
    expect(done.council!.round).toBeGreaterThanOrEqual(2)
    expect(done.messages.some((m) => m.card?.type === 'deliverable')).toBe(true)
    expect(done.council!.spend.usd).toBeGreaterThan(spentAtPause)
    expect(done.council!.spend.usd).toBeLessThanOrEqual(done.council!.spend.cap + 1e-9)
    // Every seat went on in its own omp session: one session file per seat, the one saved at the pause.
    for (const [seat, file] of Object.entries(sessions)) {
      const dir = path.dirname(file!)
      expect(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')), seat).toEqual([path.basename(file!)])
    }
    const record = fs.readFileSync(done.file!, 'utf8')
    expect(record).toMatch(/, \d+ rounds?\b/)
    expect(record).not.toContain('1 rounds')
    // No seat left files in the system temp dir: their scratch is the room's tmp/.
    expect(fs.existsSync(path.join(workdir, 'tmp'))).toBe(true)
  } finally {
    await again.close()
  }
})
