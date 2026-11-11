import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { COUNCIL_PAUSE_AT, councilCast } from '@relay/protocol'
import type { Room, RoomCard, RoomCouncilInput, RoutingEntry } from '@evaos/contract'
import { createEvaFs } from '@evaos/eva-core'
import { roomStem, saveRoom } from '../save'
import { CouncilSession, type CouncilDeps } from './council'
import { readRoomStates } from './state'
import type { SeatHandle, SeatLauncher, SeatSpec, SeatTurnInput, SeatTurnResult } from './seat'

interface TurnCtx {
  spec: SeatSpec
  prompt: string
  input: SeatTurnInput
  /** This seat's turn number, from 1. */
  n: number
}
interface Scripted {
  text: string
  /** Files to write in the seat's tree, relative. */
  files?: Record<string, string>
  /** Images the seat "generated" (written to a temp file, returned in `images`). */
  generate?: number
  usage?: SeatTurnResult['usage']
}
type Script = (t: TurnCtx) => Scripted | string | Promise<Scripted | string>

const slug = (part: string): string => part.toLowerCase().replace(/[^a-z]+/g, '-')
/** The round of the task itself ("Round 2, build."), not of a "Round 1 parts" card in the feed above it. */
const roundOf = (prompt: string): number =>
  Number([...prompt.matchAll(/Round (\d+), /g)].at(-1)?.[1] ?? 0)
const gitIn = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd }).toString()

/** What a seat does by default, by role: real files, real merges, scripted judge JSON. */
const defaults = (
  scores: (round: number) => number | Record<string, number>,
): Record<string, Script> => ({
  integrator: ({ prompt, spec }): Scripted | string => {
    if (prompt.includes('Contract phase')) {
      return {
        text: 'Contract written: parts cut, seams at neck and waist.',
        files: {
          'contract.md': `# Contract\n${prompt.includes('contract v2') ? 'v2' : 'v1'}\n`,
          'renders/full.png': 'full0',
        },
      }
    }
    if (prompt.includes('integrate.')) {
      for (const m of prompt.matchAll(/^- (seat\/\S+)/gm))
        gitIn(spec.cwd, ['merge', '-q', '--no-edit', m[1]!])
      return {
        text: 'Merged, checks pass, full render attached.',
        files: { 'renders/full.png': `full${roundOf(prompt)}` },
      }
    }
    return 'AGREE'
  },
  builder: ({ prompt, spec }) => {
    const part = /Work on (.+?) only/.exec(prompt)?.[1]
    if (!part) return prompt.includes('critique') ? '1. [Head] minor: chin reads soft' : 'AGREE'
    const r = roundOf(prompt)
    return {
      text: `Built ${part} for round ${r}.`,
      files: {
        [`parts/${slug(part)}/build.py`]: `# ${part} r${r} by ${spec.seatId}\n`,
        [`renders/${slug(part)}.png`]: `${part}${r}`,
      },
    }
  },
  look: ({ prompt }) => {
    const part = /Tune (.+?)'s params/.exec(prompt)?.[1] ?? 'x'
    return {
      text: `Params for ${part} tuned.`,
      files: { [`parts/${slug(part)}/params.json`]: `{"r":${roundOf(prompt)}}\n` },
    }
  },
  director: ({ prompt }) =>
    prompt.includes('paintover image')
      ? { text: 'Paintover posted.', generate: 1 }
      : prompt.includes('critique')
        ? '1. [Head] major: horns too short\n2. [Body] minor: stripes flat'
        : 'AGREE',
  critic: () => '1. [Hands] major: wraps missing, unknown technique',
  researcher: () => 'Found a tutorial on wrap shading.',
  judge: ({ prompt }) => {
    if (prompt.includes('Draft the rubric')) {
      return JSON.stringify([
        { name: 'face', owner: 'Head' },
        { name: 'stripes', owner: 'Body' },
        { name: 'wraps', owner: 'Hands' },
        { name: 'silhouette', owner: 'Integrator' },
      ])
    }
    if (prompt.includes(', score.')) {
      const r = roundOf(prompt)
      const s = scores(r)
      const by = (id: string): number => (typeof s === 'number' ? s : (s[id] ?? 7))
      const branches = /"branches"/.test(prompt)
        ? { branches: { Head: 'B', 'Legs + pants': 'A' } }
        : {}
      return JSON.stringify({
        scores: Object.fromEntries(
          ['c1', 'c2', 'c3', 'c4'].map((id) => [id, { score: by(id), note: 'ok' }]),
        ),
        verdict: 'continue',
        note: `round ${r} scored`,
        fixes: [{ part: 'Head', text: 'horn length off' }],
        ...branches,
      })
    }
    return 'AGREE'
  },
})

/** Seats answer from a script by role (or by seat id); every turn is recorded with its prompt. */
class FakeLauncher implements SeatLauncher {
  specs: SeatSpec[] = []
  turns: { seat: string; prompt: string; images: string[] }[] = []
  inflight = 0
  maxBuilders = 0
  private building = 0
  constructor(
    private readonly script: Record<string, Script>,
    private readonly tmp: string,
  ) {}

  prompts(seat: string): string[] {
    return this.turns.filter((t) => t.seat === seat).map((t) => t.prompt)
  }

  async start(spec: SeatSpec): Promise<SeatHandle> {
    this.specs.push(spec)
    const role = spec.seatId.replace(/-\d+$/, '')
    const script = this.script[spec.seatId] ?? this.script[role] ?? (() => 'AGREE')
    let n = 0
    return {
      harness: spec.harness,
      // Every seat "resumes" what it is handed; its session is a file in its session dir.
      resumed: spec.resume !== undefined,
      session: () => ({ harness: 'omp', file: path.join(spec.sessionDir, 'session.jsonl') }),
      onExit: () => undefined,
      stop: async () => undefined,
      turn: async (input) => {
        n += 1
        this.turns.push({ seat: spec.seatId, prompt: input.prompt, images: input.images ?? [] })
        const isBuild = role === 'builder' && /Work on .+ only/.test(input.prompt)
        if (isBuild) this.maxBuilders = Math.max(this.maxBuilders, ++this.building)
        try {
          // Build turns last long enough for parallel builders to overlap.
          await sleep(isBuild ? 40 : 2)
          if (input.signal?.aborted) throw new Error('aborted')
          const raw = await script({ spec, prompt: input.prompt, input, n })
          const out: Scripted = typeof raw === 'string' ? { text: raw } : raw
          for (const [rel, body] of Object.entries(out.files ?? {})) {
            fs.mkdirSync(path.dirname(path.join(spec.cwd, rel)), { recursive: true })
            fs.writeFileSync(path.join(spec.cwd, rel), body)
          }
          const images: string[] = []
          for (let i = 0; i < (out.generate ?? 0); i++) {
            const p = path.join(this.tmp, `${spec.seatId}-${n}-${i}.png`)
            fs.writeFileSync(p, 'img')
            images.push(p)
          }
          return {
            text: out.text,
            usage: out.usage ?? { input: 1000, output: 100, cached: 0 },
            images,
            toolCalls: 0,
            ms: 5,
          }
        } finally {
          if (isBuild) this.building--
        }
      },
    }
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const until = async (ok: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 2000; i++) {
    if (ok()) return
    await sleep(5)
  }
  throw new Error(`timed out waiting for ${what}`)
}

function setup(
  effort: number,
  script: Partial<Record<string, Script>> = {},
  scores: (round: number) => number | Record<string, number> = () => 9,
  extra: Partial<RoomCouncilInput> = {},
) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'council-')))
  dirs.push(root)
  const evaRoot = path.join(root, 'eva')
  const src = path.join(evaRoot, 'work/src')
  fs.mkdirSync(path.join(src, 'renders'), { recursive: true })
  fs.writeFileSync(path.join(src, 'build.py'), 'print("maul")\n')
  fs.writeFileSync(path.join(src, 'renders/before.png'), 'before')
  fs.mkdirSync(path.join(evaRoot, 'refs'))
  fs.writeFileSync(path.join(evaRoot, 'refs/target.png'), 'target')
  const tmp = path.join(root, 'tmp')
  fs.mkdirSync(tmp)
  const launcher = new FakeLauncher(
    { ...defaults(scores), ...script } as Record<string, Script>,
    tmp,
  )
  const evaFs = createEvaFs({ root: evaRoot })
  const journal: string[][] = []
  const deps: CouncilDeps = {
    launcher,
    evaRoot,
    stem: (room) => roomStem(evaRoot, room),
    save: (room, stem) =>
      saveRoom(
        room,
        { evaRoot, evaFs, journal: async (h, b) => void journal.push([h, ...b]) },
        stem,
      ),
    writeRouting: (rel, content) => evaFs.write('room-routing', rel, content),
    onChange: () => undefined,
    log: (line) => (process.env.COUNCIL_DEBUG ? console.error(line) : undefined),
    asksRoot: tmp,
    pollMs: 5,
  }
  const s = new CouncilSession(
    'Make the Maul render match the target.',
    {
      effort,
      source: 'work/src',
      refs: ['refs/target.png'],
      renderCmd: 'blender -b --python build.py --',
      ...extra,
    },
    deps,
  )
  return { s, launcher, evaRoot, src, journal, deps, room: s.room }
}

const cards = <T extends RoomCard['type']>(room: Room, type: T): (RoomCard & { type: T })[] =>
  room.messages.flatMap((m) => (m.card?.type === type ? [m.card as RoomCard & { type: T }] : []))

const routingLines = (room: Room): RoutingEntry[] =>
  fs
    .readFileSync(room.council!.routingFile!, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as RoutingEntry)

describe('CouncilSession', () => {
  it('Team: contract, parallel builders, integrate, critique, judge, converge, deliver', async () => {
    const { s, launcher, room, src, journal } = setup(3, {}, (r) => (r === 1 ? 6 : 9))
    await s.start()
    await s.settled()
    const c = room.council!
    expect(room.phase).toBe('resolved')
    expect(c.stage).toBe('deliver')
    // Seats cast from the notch: integrator, two builders on the two parts, director, judge.
    expect(room.agents.map((a) => `${a.id}:${a.seat!.part ?? ''}`)).toEqual([
      'integrator-1:',
      'builder-1:Head + hands',
      'builder-2:Body + legs',
      'director-1:',
      'judge-1:',
    ])
    expect(room.agents.every((a) => a.tools === 'full' && a.model.includes('/'))).toBe(true)
    // The judge drafted the rubric (4 criteria, owners on the parts in play).
    expect(c.rubric.map((r) => r.owner)).toEqual(['Head', 'Body', 'Hands', 'Integrator'])
    expect(cards(room, 'contract')).toHaveLength(1)
    expect(cards(room, 'contract')[0]!.text).toContain('# Contract')
    // Builders ran at the same time, each on its own part in its own worktree.
    expect(launcher.maxBuilders).toBe(2)
    const parts = cards(room, 'parts')
    expect(parts.map((p) => p.parts.map((x) => `${x.part}:${x.status}`))).toEqual([
      ['Head + hands:ok', 'Body + legs:ok'],
      ['Head + hands:ok', 'Body + legs:ok'],
    ])
    // Two scorecards: 6 then 9 everywhere, converged at round 2 with deltas and the round's log.
    const sc = cards(room, 'scorecard')
    expect(sc.map((x) => [x.round, x.total, x.verdict])).toEqual([
      [1, 6, 'continue'],
      [2, 9, 'converged'],
    ])
    expect(sc[1]!.criteria[0]).toMatchObject({
      id: 'c1',
      owner: 'Head + hands',
      score: 9,
      delta: 3,
    })
    expect(sc[1]!.log.some((e) => e.kind === 'merge' && e.round === 2)).toBe(true)
    // The integrated tree has both parts; the merge went back into every seat's worktree.
    const main = path.join(c.workdir, 'main')
    expect(fs.readFileSync(path.join(main, 'parts/head-hands/build.py'), 'utf8')).toContain(
      'r2 by builder-1',
    )
    expect(fs.readFileSync(path.join(main, 'parts/body-legs/build.py'), 'utf8')).toContain(
      'r2 by builder-2',
    )
    expect(fs.existsSync(path.join(c.workdir, 'seats/builder-1/parts/body-legs/build.py'))).toBe(
      true,
    )
    // The source is never edited.
    expect(fs.readdirSync(src).sort()).toEqual(['build.py', 'renders'])
    // Renders are kept per round and seat; the paintover is an image the director made.
    expect(fs.existsSync(path.join(c.workdir, 'rounds/r1/builder-1/head-hands.png'))).toBe(true)
    expect(fs.existsSync(path.join(c.workdir, 'rounds/r2/integrator-1/full.png'))).toBe(true)
    // Images to seats: builders get their part render and the refs; the judge the full render.
    const judgeTurn = launcher.turns.find(
      (t) => t.seat === 'judge-1' && t.prompt.includes('Round 2, score'),
    )!
    expect(judgeTurn.images[0]).toBe(path.join(c.workdir, 'rounds/r2/integrator-1/full.png'))
    expect(judgeTurn.images).toContain(path.join(c.workdir, 'refs/target.png'))
    const build2 = launcher.turns.find(
      (t) => t.seat === 'builder-1' && t.prompt.includes('Round 2, build'),
    )!
    expect(build2.images[0]).toBe(path.join(c.workdir, 'rounds/r1/builder-1/head-hands.png'))
    expect(build2.images).toContain(path.join(c.workdir, 'refs/target.png'))
    // Spend: list price of every turn plus the one generated image.
    expect(c.spend.usd).toBeGreaterThan(0.17)
    expect(Object.keys(c.spend.byAgent).sort()).toEqual([
      'builder-1',
      'builder-2',
      'director-1',
      'integrator-1',
      'judge-1',
    ])
    // Routing log: one line per turn, kinds by role and deed, deltas credited to the owners.
    const log = routingLines(room)
    const kinds = new Set(log.map((e) => `${e.seat}:${e.kind}`))
    for (const k of [
      'builder-1:code',
      'integrator-1:merge',
      'director-1:image',
      'director-1:critique',
      'judge-1:score',
    ])
      expect(kinds).toContain(k)
    expect(log.find((e) => e.seat === 'builder-1' && e.kind === 'code')!.files).toEqual([
      'parts/head-hands/build.py',
    ])
    // Deltas land on the round's turn before the scorecard (the build, the merge), not the final-position turn.
    const r2b1 = log.find((e) => e.round === 2 && e.seat === 'builder-1' && e.kind === 'code')!
    expect(r2b1.criteria).toEqual({ c1: 3, c3: 3 })
    expect(
      log.find((e) => e.round === 2 && e.seat === 'integrator-1' && e.kind === 'merge')!.criteria,
    ).toEqual({ c4: 3 })
    // The deliverable: before/after, total, who did what; saved with a journal line.
    const d = cards(room, 'deliverable')[0]!
    expect(d.total).toBe(9)
    expect(d.before[0]!.path).toBe(path.join(c.workdir, 'rounds/r0/source/before.png'))
    expect(d.after[0]!.path).toBe(path.join(c.workdir, 'rounds/r2/integrator-1/full.png'))
    // Kinds in first-seen order: the contract objection (talk) came before the first build.
    expect(d.who.find((w) => w.agentId === 'builder-1')).toMatchObject({
      did: 'talk, code',
      moved: 'face +3, wraps +3',
    })
    expect(d.changes).toContain('face: 6 to 9')
    expect(d.record).toBe(room.file)
    expect(fs.readFileSync(room.file!, 'utf8')).toContain('## Council')
    expect(path.basename(room.council!.routingFile!)).toBe(
      path.basename(room.file!).replace(/\.md$/, '.routing.jsonl'),
    )
    expect(journal[0]![1]).toMatch(/^Delivered: 9\/10 at Team/)
  }, 60_000)

  it('ends on a plateau: total gain under 0.5 two rounds running', async () => {
    let bad = true
    const plateau = (r: number): number => [0, 6, 6.2, 6.3][r] ?? 6.3
    const { s, room } = setup(
      4,
      {
        // One unreadable scorecard: the judge is asked once more.
        judge: (t) => {
          if (t.prompt.includes(', score.') && bad) {
            bad = false
            return 'scores look fine'
          }
          return defaults(plateau).judge!(t)
        },
      },
      plateau,
    )
    await s.start()
    await s.settled()
    const sc = cards(room, 'scorecard')
    expect(sc.map((x) => [x.round, x.total, x.verdict])).toEqual([
      [1, 6, 'continue'],
      [2, 6.2, 'continue'],
      [3, 6.3, 'plateau'],
    ])
    expect(room.council!.maxRounds).toBe(4)
    // Critic findings routed to the hands builder; an unknown one brought no researcher (none at Council).
    expect(room.messages.some((m) => m.author === 'critic-1' && m.text.includes('[Hands]'))).toBe(
      true,
    )
  }, 60_000)

  it('ends at the round cap', async () => {
    const { s, room } = setup(3, {}, (r) => 4 + r)
    await s.start()
    await s.settled()
    expect(cards(room, 'scorecard').map((x) => x.verdict)).toEqual(['continue', 'continue', 'cap'])
    expect(room.council!.round).toBe(3)
    expect(room.phase).toBe('resolved')
  }, 60_000)

  it('pauses at 80 % of the cap; continue raises the cap and the room goes on', async () => {
    const cap = councilCast(3).cap
    // One integrate turn costs 85 % of the cap (Opus output at $20 per million).
    const big = { input: 0, cached: 0, output: Math.ceil((cap * 0.85) / 20e-6) }
    const { s, room } = setup(3, {
      integrator: (t) => {
        const out = defaults(() => 9).integrator!(t) as Scripted
        return t.prompt.includes('integrate.') && roundOf(t.prompt) === 1
          ? { ...out, usage: big }
          : out
      },
    })
    await s.start()
    await until(() => room.council!.paused === true, 'the pause')
    const pause = cards(room, 'pause')[0]!
    expect(pause.spent).toBeGreaterThanOrEqual(COUNCIL_PAUSE_AT * cap)
    expect(pause.nextCap).toBeCloseTo(cap + room.council!.spend.estimate)
    // Paused before the critique: nobody critiqued round 1 yet.
    expect(room.messages.some((m) => m.author === 'director-1' && m.text.includes('[Head]'))).toBe(
      false,
    )
    expect(s.budget('continue')).toBeCloseTo(pause.nextCap)
    await s.settled()
    expect(pause.answered).toBe('continue')
    expect(room.council!.paused).toBe(false)
    expect(cards(room, 'scorecard')).toHaveLength(1)
    expect(cards(room, 'deliverable')).toHaveLength(1)
  }, 60_000)

  it('pauses at 80 % of the cap; wrap delivers at once', async () => {
    const cap = councilCast(3).cap
    const big = { input: 0, cached: 0, output: Math.ceil((cap * 0.85) / 20e-6) }
    const { s, room } = setup(3, {
      integrator: (t) => {
        const out = defaults(() => 9).integrator!(t) as Scripted
        return t.prompt.includes('integrate.') ? { ...out, usage: big } : out
      },
    })
    await s.start()
    await until(() => room.council!.paused === true, 'the pause')
    s.budget('wrap')
    await s.settled()
    expect(cards(room, 'pause')[0]!.answered).toBe('wrap')
    expect(cards(room, 'scorecard')).toHaveLength(0)
    expect(cards(room, 'deliverable')).toHaveLength(1)
    // No scorecard ran: the delivery says so instead of claiming 0/10.
    expect(cards(room, 'deliverable')[0]!.total).toBeUndefined()
    expect(room.messages.at(-1)!.text).toMatch(/^Delivered: not scored after 1 round/)
    expect(room.council!.spend.cap).toBeCloseTo(cap)
    expect(room.phase).toBe('resolved')
  }, 60_000)

  it('turns starting together hold their spend first: the final positions cannot pass the cap', async () => {
    const cap = councilCast(3).cap
    // Every turn costs up to 12 % of the cap (at Opus prices): the room runs into the cap mid-round
    // and the final positions all start at once.
    const turn = { input: 0, cached: 0, output: Math.ceil((cap * 0.12) / 20e-6) }
    const { s, room } = setup(
      3,
      Object.fromEntries(
        Object.entries(defaults((r) => (r === 1 ? 6 : 9))).map(([role, script]) => [
          role,
          async (t: TurnCtx) => {
            const raw = await script(t)
            const out: Scripted = typeof raw === 'string' ? { text: raw } : raw
            return { ...out, usage: turn }
          },
        ]),
      ),
      (r) => (r === 1 ? 6 : 9),
    )
    await s.start()
    await until(() => room.council!.paused === true || room.phase === 'resolved', 'the pause')
    if (room.council!.paused) s.budget('wrap')
    await s.settled()
    const c = room.council!
    expect(room.phase).toBe('resolved')
    // Not every seat got its final position in: those that could pass the cap were skipped.
    expect(
      room.messages.some((m) => m.text.includes('turns that could pass the cap are skipped')),
    ).toBe(true)
    expect(c.spend.usd).toBeLessThanOrEqual(c.spend.cap + 1e-9)
    expect(c.spend.cap).toBeCloseTo(cap)
  }, 60_000)

  it('pause after round 1: saved on disk, reopened from the state, resumed to the end with the same seat sessions', async () => {
    const ref = {} as { s: CouncilSession }
    let paused = false
    const base = defaults((r) => (r === 1 ? 6 : 9))
    const out = setup(
      3,
      {
        builder: (t) => {
          if (!paused && roundOf(t.prompt) === 1 && /Work on/.test(t.prompt)) {
            paused = true
            ref.s.pause()
          }
          return base.builder!(t)
        },
      },
      (r) => (r === 1 ? 6 : 9),
    )
    ref.s = out.s
    const { s, room, launcher, evaRoot, deps } = out
    await s.start()
    await s.settled()
    // Round 1 finished (its scorecard is in), then the room stopped.
    expect(room.phase).toBe('paused')
    expect(cards(room, 'scorecard').map((x) => x.round)).toEqual([1])
    expect(cards(room, 'deliverable')).toHaveLength(0)
    expect(s.resumable).toBe(true)
    expect(() => s.pause()).toThrow('not running')
    // Isaac's post while paused is kept for the next round.
    s.post('Keep the stripes thin.')
    await s.destroy() // the app quits

    // A new app run finds the room on disk, exactly where it stopped.
    const states = readRoomStates(path.join(evaRoot, 'work', 'rooms'), () => undefined)
    expect(states).toHaveLength(1)
    const state = states[0]!
    expect(state.room.phase).toBe('paused')
    expect(state.progress).toEqual({ briefed: true, planned: true, nextRound: 2 })
    expect(state.room.messages.at(-1)!.text).toBe('Keep the stripes thin.')
    const seatIds = room.agents.map((a) => a.id)
    expect(Object.keys(state.seats).sort()).toEqual([...seatIds].sort())
    for (const id of seatIds) expect(state.seats[id]!.session).toMatchObject({ harness: 'omp' })

    const started = launcher.specs.length
    const turnsBefore = launcher.turns.length
    const again = new CouncilSession('', state.input, deps, state)
    expect(again.room.phase).toBe('paused')
    expect(again.resumable).toBe(true)
    expect(await again.resume()).toBeCloseTo(state.room.council!.spend.cap)
    await again.settled()
    const r = again.room
    expect(r.phase).toBe('resolved')
    // Round 2 ran, round 1 did not run again; it converged and delivered.
    expect(cards(r, 'scorecard').map((x) => [x.round, x.total, x.verdict])).toEqual([
      [1, 6, 'continue'],
      [2, 9, 'converged'],
    ])
    const after = launcher.turns.slice(turnsBefore)
    expect(after.some((t) => /Round 1, /.test(t.prompt))).toBe(false)
    expect(after.some((t) => /Round 2, build/.test(t.prompt))).toBe(true)
    expect(cards(r, 'deliverable')).toHaveLength(1)
    // Every seat came back on its own harness session.
    const resumed = launcher.specs.slice(started)
    expect(resumed.map((x) => x.seatId).sort()).toEqual([...seatIds].sort())
    for (const spec of resumed) expect(spec.resume).toEqual(state.seats[spec.seatId]!.session)
    // The resumed seats saw Isaac's post from the pause.
    expect(after.some((t) => t.prompt.includes('Keep the stripes thin.'))).toBe(true)
    // The record counts both rounds.
    expect(fs.readFileSync(r.file!, 'utf8')).toContain(', 2 rounds')
  }, 60_000)

  it('raise mid-run: new seats join at the next round with the thread, the integrator re-splits 2 -> 4', async () => {
    let raised = false
    const ref = {} as { s: CouncilSession }
    const base = defaults((r) => (r === 1 ? 6 : 9))
    const setupOut = setup(
      3,
      {
        builder: (t) => {
          if (!raised && roundOf(t.prompt) === 1 && /Work on/.test(t.prompt)) {
            raised = true
            expect(ref.s.raise()).toBe(4)
          }
          return base.builder!(t)
        },
      },
      (r) => (r === 1 ? 6 : 9),
    )
    ref.s = setupOut.s
    const { s, room, launcher } = setupOut
    await s.start()
    await s.settled()
    const c = room.council!
    expect(c.effort).toBe(4)
    expect(c.parts).toEqual(['Head', 'Body', 'Hands', 'Legs + pants'])
    const joined = room.agents.filter((a) => a.seat?.joinedRound !== undefined)
    expect(joined.map((a) => `${a.id}:${a.seat!.part ?? ''}:${a.seat!.joinedRound}`)).toEqual([
      'builder-3:Hands:2',
      'builder-4:Legs + pants:2',
      'critic-1::2',
    ])
    // The builders already here moved to the finer parts they covered.
    expect(room.agents.find((a) => a.id === 'builder-1')!.seat!.part).toBe('Head')
    expect(room.agents.find((a) => a.id === 'builder-2')!.seat!.part).toBe('Body')
    // Contract v2 came from the integrator at the boundary.
    expect(cards(room, 'contract').map((x) => x.version)).toEqual([1, 2])
    expect(launcher.prompts('integrator-1').some((p) => p.includes('contract v2'))).toBe(true)
    // A new seat's first prompt is the whole thread so far.
    const first = launcher.prompts('builder-3')[0]!
    expect(first).toContain('Raised to Council')
    expect(first).toContain('Built Head + hands for round 1.')
    // Round 2 built four parts.
    expect(cards(room, 'parts')[1]!.parts.map((p) => p.part)).toEqual([
      'Head',
      'Body',
      'Hands',
      'Legs + pants',
    ])
    expect(() => s.raise()).toThrow('closed')
  }, 60_000)

  it('Max: the judge keeps one builder per branched part after round 2; the loser critiques', async () => {
    const { s, room, launcher } = setup(6, {}, (r) => (r < 3 ? 5 + r : 9))
    await s.start()
    await s.settled()
    const sc = cards(room, 'scorecard')
    expect(sc.map((x) => x.verdict)).toEqual(['continue', 'branch', 'converged'])
    const seat = (id: string) => room.agents.find((a) => a.id === id)!.seat!
    // Head: B (builder-2) kept, A (builder-1) demoted; Legs + pants: A (builder-5) kept, B (builder-6) demoted.
    expect([
      seat('builder-1').demoted,
      seat('builder-2').demoted,
      seat('builder-5').demoted,
      seat('builder-6').demoted,
    ]).toEqual([true, undefined, undefined, true])
    const integ = launcher.prompts('integrator-1').filter((p) => p.includes('integrate.'))
    expect(integ[0]).toContain('seat/builder-1')
    expect(integ[0]).not.toContain('seat/builder-2')
    expect(integ[2]).toContain('seat/builder-2')
    expect(integ[2]).not.toContain('seat/builder-1')
    // Round 3: the losers critique instead of building.
    const r3 = (id: string) => launcher.prompts(id).filter((p) => p.includes('Round 3'))
    expect(r3('builder-1').every((p) => p.includes('critique'))).toBe(true)
    expect(r3('builder-2').some((p) => p.includes('Work on Head only'))).toBe(true)
    // The judge saw both branches' Head renders in round 2.
    const j2 = launcher.turns.find(
      (t) => t.seat === 'judge-1' && t.prompt.includes('Round 2, score'),
    )!
    expect(j2.images.some((p) => p.includes('rounds/r2/builder-1/head.png'))).toBe(true)
    expect(j2.images.some((p) => p.includes('rounds/r2/builder-2/head.png'))).toBe(true)
  }, 120_000)

  it("turns a seat's outward action into an ask card and writes Isaac's answer for the guard", async () => {
    let answer = ''
    const base = defaults(() => 9)
    const { s, room } = setup(3, {
      builder: async (t) => {
        if (t.spec.seatId === 'builder-1' && roundOf(t.prompt) === 1 && /Work on/.test(t.prompt)) {
          fs.writeFileSync(
            path.join(t.spec.asksDir, 'ask-1.json'),
            JSON.stringify({
              id: 'ask-1',
              seatId: 'builder-1',
              action: 'git push origin main',
              at: 1,
            }),
          )
          const file = path.join(t.spec.asksDir, 'ask-1.answer')
          await until(() => fs.existsSync(file), 'the answer file')
          answer = fs.readFileSync(file, 'utf8')
        }
        return base.builder!(t)
      },
    })
    await s.start()
    await until(() => cards(room, 'ask').length > 0, 'the ask card')
    const ask = cards(room, 'ask')[0]!
    expect(ask).toMatchObject({
      askId: 'ask-1',
      agentId: 'builder-1',
      action: 'git push origin main',
    })
    expect(() => s.answer('../x', true)).toThrow()
    s.answer('ask-1', false)
    await s.settled()
    expect(answer).toBe('deny')
    expect(ask.answered).toBe('deny')
  }, 60_000)

  it('answers Isaac at the next boundary: the seat he named, else the integrator', async () => {
    let posted = false
    const ref = {} as { s: CouncilSession }
    const base = defaults(() => 9)
    const out = setup(3, {
      builder: (t) => {
        if (!posted && /Work on/.test(t.prompt)) {
          posted = true
          ref.s.post('@Jonah how strict is the face criterion?')
          ref.s.post('Keep the stripes thin.')
        }
        return base.builder!(t)
      },
    })
    const s = (ref.s = out.s)
    await s.start()
    await s.settled()
    const answers = out.launcher.turns.filter((t) => t.prompt.includes('Isaac posted'))
    expect(answers.map((t) => t.seat)).toEqual(['judge-1'])
    expect(answers[0]!.prompt).toContain('Isaac: Keep the stripes thin.')
  }, 60_000)

  it('Resolve now ends running turns and still delivers', async () => {
    const ref = {} as { s: CouncilSession }
    const out = setup(3, {
      builder: async (t) => {
        if (/Work on/.test(t.prompt)) {
          void ref.s.stop()
          await until(() => t.input.signal?.aborted === true, 'the abort')
          throw new Error('aborted')
        }
        return 'AGREE'
      },
    })
    const s = (ref.s = out.s)
    await s.start()
    await s.settled()
    expect(out.room.phase).toBe('resolved')
    expect(cards(out.room, 'scorecard')).toHaveLength(0)
    expect(cards(out.room, 'deliverable')).toHaveLength(1)
    expect(out.launcher.turns.some((t) => t.prompt.includes('final position'))).toBe(true)
  }, 60_000)
})
