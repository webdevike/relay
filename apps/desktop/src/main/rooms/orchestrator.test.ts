import { setImmediate as tick } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { ROOM_PEOPLE, type Room } from '@evaos/contract'
import type { ConvergenceState, GateState, Jev } from './jev'
import { RoomSession, type RoomSessionDeps } from './orchestrator'
import { NUDGE_TEXT } from './prompts'
import type { AgentHandle, AgentRunner } from './runner'

/** Which persona a process is, from its system prompt. */
const whoIs = (systemPrompt: string): string => {
  if (systemPrompt.startsWith('You judge')) return 'judge'
  const a = ROOM_PEOPLE.find((p) => systemPrompt.startsWith(`You are ${p.name}`))
  return a?.id ?? '?'
}

type Reply = string | ((prompt: string, turn: number) => string)

interface FakeAgent {
  id: string
  prompts: string[]
  stopped: boolean
  exit: ((reason: string) => void) | null
  aborts: string[]
}

interface PendingSend {
  id: string
  reply: string
  hooks?: Parameters<AgentHandle['send']>[1]
  resolve: (t: string) => void
  reject: (e: Error) => void
}

/**
 * Agents answer from a script by id and turn. A send waits in `pending` until the test answers
 * it (`flush`), so the test decides who has replied when; `drain` answers everything until the
 * room settles.
 */
class FakeRunner implements AgentRunner {
  agents: FakeAgent[] = []
  pending: PendingSend[] = []
  /** Starts waiting on the test (ids in `holdStart`); release with `releaseStarts`. */
  heldStarts: (() => void)[] = []
  /** Turn budgets handed to `after`, oldest first; `fireClock` resolves the oldest. */
  clocks: { ms: number; fire: () => void }[] = []
  constructor(
    private script: Record<string, Reply[] | Reply>,
    private failStart: string[] = [],
    private holdStart: string[] = [],
  ) {}

  after(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()
    this.clocks.push({ ms, fire: resolve })
    return promise
  }

  fireClock(): void {
    this.clocks.shift()?.fire()
  }

  releaseStarts(): void {
    for (const r of this.heldStarts.splice(0)) r()
  }

  byId(id: string): FakeAgent {
    return this.agents.find((a) => a.id === id)!
  }

  /** Answers the pending sends (of `ids`, or all), streaming a first chunk then the whole reply. */
  /**
   * Answers the pending sends (of `ids`, or all): thinking, a first chunk while typing, then
   * the whole reply and idle, like a real turn.
   */
  flush(ids?: string[]): void {
    const now = this.pending.filter((p) => !ids || ids.includes(p.id))
    this.pending = this.pending.filter((p) => !now.includes(p))
    for (const p of now) {
      p.hooks?.onPresence?.({ state: 'thinking' })
      if (p.reply.length > 4) {
        p.hooks?.onPresence?.({ state: 'typing' })
        p.hooks?.onPartial?.(p.reply.slice(0, 4))
      }
      p.hooks?.onPartial?.(p.reply)
      p.hooks?.onPresence?.(null)
      p.resolve(p.reply)
    }
  }

  /** Flushes until nothing is pending and `done` holds (or 200 ticks pass). */
  async drain(done: () => boolean): Promise<void> {
    for (let i = 0; i < 200; i++) {
      this.flush()
      await tick()
      if (this.pending.length === 0 && done()) return
    }
    throw new Error('room did not settle')
  }

  async start(o: { systemPrompt: string; model: string }): Promise<AgentHandle> {
    const id = whoIs(o.systemPrompt)
    if (this.failStart.includes(id)) throw new Error(`no ${id}`)
    if (this.holdStart.includes(id)) {
      const { promise, resolve } = Promise.withResolvers<void>()
      this.heldStarts.push(resolve)
      await promise
    }
    const fake: FakeAgent = { id, prompts: [], stopped: false, exit: null, aborts: [] }
    this.agents.push(fake)
    const replyFor = (prompt: string): string => {
      const turn = fake.prompts.length
      const r = this.script[id]
      const pick = Array.isArray(r) ? (r[turn - 1] ?? r[r.length - 1] ?? 'PASS') : (r ?? 'PASS')
      return typeof pick === 'function' ? pick(prompt, turn) : pick
    }
    return {
      send: (text, hooks) => {
        const { promise, resolve, reject } = Promise.withResolvers<string>()
        fake.prompts.push(text)
        this.pending.push({
          id,
          reply: replyFor(text),
          resolve,
          reject,
          ...(hooks ? { hooks } : {}),
        })
        return promise
      },
      abort: async (reason) => {
        const mine = this.pending.filter((p) => p.id === id)
        this.pending = this.pending.filter((p) => p.id !== id)
        for (const p of mine) p.reject(new Error(reason))
        fake.aborts.push(reason)
      },
      onExit: (cb) => {
        // Like the real runner: a dead process fails its in-flight turn.
        fake.exit = (reason) => {
          const mine = this.pending.filter((p) => p.id === id)
          this.pending = this.pending.filter((p) => p.id !== id)
          for (const p of mine) p.reject(new Error(reason))
          cb(reason)
        }
      },
      stop: async () => {
        fake.stopped = true
      },
    }
  }
}

interface Harness {
  s: RoomSession
  runner: FakeRunner
  saved: Room[]
  /** Runs the room to its end. */
  finish(): Promise<void>
}

function harness(
  script: Record<string, Reply[] | Reply>,
  o: Partial<RoomSessionDeps> & {
    agents?: string[]
    failStart?: string[]
    holdStart?: string[]
  } = {},
): Harness {
  const runner = new FakeRunner(script, o.failStart ?? [], o.holdStart ?? [])
  const saved: Room[] = []
  const ids = o.agents ?? ['skeptic', 'builder', 'pm']
  const agents = ROOM_PEOPLE.filter((p) => ids.includes(p.id))
  const { agents: _a, failStart: _f, holdStart: _h, ...deps } = o
  const s = new RoomSession('Should Relay auto-archive idle chats?', agents, {
    runner,
    judgeModel: 'anthropic/claude-sonnet-5-5',
    save: async (room) => {
      saved.push(JSON.parse(JSON.stringify(room)))
      return '/eva/memory/rooms/2026-10-26-should-relay.md'
    },
    onChange: () => undefined,
    log: () => undefined,
    now: () => 1_000_000,
    after: (ms) => runner.after(ms),
    ...deps,
  })
  return {
    s,
    runner,
    saved,
    finish: async () => {
      await s.start()
      await runner.drain(() => !s.live)
      await s.settled()
    },
  }
}

const CONTINUE = '{"verdict":"continue","note":"still arguing"}'
const CONVERGED = '{"verdict":"converged","note":"all agree on fold"}'

const texts = (room: Room): string[] => room.messages.map((m) => `${m.author}: ${m.text}`)

describe('RoomSession', () => {
  it('fans out round 1 to everyone, later rounds only the delta, then the judge calls it and a final-position round precedes the summary', async () => {
    const h = harness({
      skeptic: ['What breaks? 🤔', 'PASS', 'Final: fold.'],
      builder: ['Fold, not delete.', 'Fine by me.', 'AGREE'],
      pm: [
        'Sounds like fold.',
        'AGREE',
        'AGREE',
        '**Decision**\nFold.\n\n**Dissent**\nNone\n\n**Next steps**\n- Theo: fold',
      ],
      judge: [CONVERGED],
    })
    await h.finish()
    const room = h.s.room
    expect(room.phase).toBe('resolved')
    expect(room.rounds).toBe(3)
    expect(room.judge).toMatchObject({ verdict: 'converged', note: 'all agree on fold' })
    const skeptic = h.runner.byId('skeptic')
    expect(skeptic.prompts[0]).toContain(
      'Isaac asked the room:\nShould Relay auto-archive idle chats?',
    )
    // Round 2: only the other two replies are new to Mara; her own line is not a reason to send.
    expect(skeptic.prompts[1]).toContain('New messages:')
    expect(skeptic.prompts[1]).toContain('[m2] Theo: Fold, not delete.')
    expect(skeptic.prompts[1]).toContain('[m3] Jonah: Sounds like fold.')
    expect(skeptic.prompts[1]).not.toContain('Isaac asked')
    // Round 3 is everyone's final-position turn, then the summary (not marked closed early).
    for (const id of ['skeptic', 'builder', 'pm']) {
      expect(h.runner.byId(id).prompts[2]).toContain('(wrapping up')
    }
    // PASS adds nothing; AGREE is posted.
    expect(texts(room)).toEqual([
      'skeptic: What breaks? 🤔',
      'builder: Fold, not delete.',
      'pm: Sounds like fold.',
      'builder: Fine by me.',
      'pm: AGREE',
      'skeptic: Final: fold.',
      'builder: AGREE',
      'pm: AGREE',
      'pm: **Decision**\nFold.\n\n**Dissent**\nNone\n\n**Next steps**\n- Theo: fold',
    ])
    const summary = room.messages[room.messages.length - 1]!
    expect(summary.kind).toBe('summary')
    expect(summary.author).toBe('pm')
    expect(room.resolvedAt).toBe(summary.ts)
    expect(room.file).toBe('/eva/memory/rooms/2026-10-26-should-relay.md')
    expect(h.saved).toHaveLength(1)
    expect(h.saved[0]!.phase).toBe('resolved')
    // No judge call after round 1 (replies, before round 2); one after round 2; none while wrapping.
    expect(h.runner.byId('judge').prompts).toHaveLength(1)
    expect(h.runner.byId('judge').prompts[0]).toContain('Rounds: 2')
    for (const a of h.runner.agents) expect(a.stopped).toBe(true)
    expect(h.runner.byId('pm').prompts[3]).toContain('Write the pinned summary')
    expect(h.runner.byId('pm').prompts[3]).not.toContain('closed early')
    expect(room.presence).toEqual({})
  })

  it('a silent round after continue gets one nudge from the PM, then wraps if still quiet', async () => {
    const h = harness({
      skeptic: ['A.', 'PASS', 'PASS', 'PASS'],
      builder: ['B.', 'PASS', 'PASS', 'PASS'],
      pm: ['C.', 'PASS', 'PASS', 'PASS', 'summary text'],
      judge: CONTINUE,
    })
    await h.finish()
    const room = h.s.room
    const nudge = room.messages.find((m) => m.text === NUDGE_TEXT)
    expect(nudge?.author).toBe('pm')
    // Rounds: 1 replies, 2 quiet -> nudge, 3 quiet -> wrap, 4 final positions, summary.
    expect(room.rounds).toBe(4)
    expect(room.phase).toBe('resolved')
    expect(h.runner.byId('judge').prompts).toHaveLength(2)
    // The nudge was the delta of round 3; Jonah posted it, so his own line is not sent back to him.
    expect(h.runner.byId('skeptic').prompts[2]).toContain(`Jonah: ${NUDGE_TEXT}`)
    expect(h.runner.byId('skeptic').prompts[3]).toContain('(wrapping up')
    expect(h.runner.byId('pm').prompts).toHaveLength(4)
    expect(h.runner.byId('pm').prompts[2]).toContain('(wrapping up')
    expect(h.runner.byId('pm').prompts[3]).toContain('closed early')
  })

  it('parses react lines into reactions and ignores unknown ids', async () => {
    const h = harness({
      skeptic: ['First.', 'react: m1 👀\nreact: m2 🔥\nreact: m99 👍\nAgreed with Theo.', 'PASS'],
      builder: ['Second.', 'PASS', 'PASS'],
      pm: ['Third.', 'PASS', 'PASS', 'summary'],
      judge: CONVERGED,
    })
    await h.finish()
    const room = h.s.room
    expect(room.messages[0]!.reactions).toEqual([{ emoji: '👀', by: ['skeptic'] }])
    expect(room.messages[1]!.reactions).toEqual([{ emoji: '🔥', by: ['skeptic'] }])
    expect(room.messages.find((m) => m.text === 'Agreed with Theo.')).toBeTruthy()
    expect(room.messages.some((m) => m.text.includes('react:'))).toBe(false)
    expect(h.runner.byId('judge').prompts[0]).toContain('(👀 Mara)')
  })

  it('trims a long reply at 900 characters on a sentence boundary', async () => {
    const long = `${'Alpha beta gamma delta. '.repeat(40)}Then a very long tail that keeps going and going without any stop`
    expect(long.length).toBeGreaterThan(900)
    const h = harness({
      skeptic: [long, 'PASS'],
      builder: ['Ok.', 'PASS'],
      pm: ['Ok.', 'PASS', 'summary'],
      judge: CONVERGED,
    })
    await h.finish()
    const m = h.s.room.messages[0]!
    expect(m.text.length).toBeLessThanOrEqual(900)
    expect(m.text.endsWith('delta.')).toBe(true)
  })

  it("Isaac's post lands at once and is the next round's delta; his reaction toggles", async () => {
    const h = harness({
      skeptic: ['A.', (p) => (p.includes('Isaac: Ship it') ? 'On it, Isaac.' : 'PASS'), 'PASS'],
      builder: ['B.', 'PASS', 'PASS'],
      pm: ['C.', 'PASS', 'PASS', 'summary'],
      judge: [CONTINUE, CONVERGED],
    })
    await h.s.start()
    h.runner.flush(['skeptic', 'builder'])
    h.s.post('Ship it')
    expect(texts(h.s.room)).toEqual(['skeptic: A.', 'builder: B.', 'isaac: Ship it'])
    await h.runner.drain(() => !h.s.live)
    await h.s.settled()
    const room = h.s.room
    expect(texts(room)).toContain('skeptic: On it, Isaac.')
    expect(h.runner.byId('skeptic').prompts[1]).toContain('[m3] Isaac: Ship it')
    h.s.react('m1', '👍')
    expect(room.messages[0]!.reactions).toEqual([{ emoji: '👍', by: ['isaac'] }])
    h.s.react('m1', '👍')
    expect(room.messages[0]!.reactions).toEqual([])
    h.s.react('nope', '👍')
    expect(() => h.s.post('late')).toThrow()
  })

  it('the judge waits until every agent has answered a mid-round Isaac post', async () => {
    const h = harness({
      skeptic: [
        'A.',
        'B.',
        (p) => (p.includes('Isaac: Only 1 or 2 rooms') ? 'Then no, Isaac.' : 'PASS'),
        'PASS',
      ],
      builder: ['A2.', 'PASS', 'PASS', 'PASS'],
      pm: ['A3.', 'PASS', 'PASS', 'PASS', 'summary'],
      judge: CONVERGED,
    })
    await h.s.start()
    h.runner.flush()
    await tick()
    // Round 2 is in flight; Theo and Jonah have passed, Mara is still typing when Isaac posts.
    h.runner.flush(['builder', 'pm'])
    await tick()
    expect(h.s.room.rounds).toBe(2)
    h.s.post('Only 1 or 2 rooms open at a time. Does that change anything?')
    h.runner.flush(['skeptic'])
    await tick()
    // Round 2 settled with the judge ready to converge, but Isaac is unanswered: no judge call yet.
    expect(h.runner.byId('judge').prompts).toHaveLength(0)
    expect(h.s.room.rounds).toBe(3)
    await h.runner.drain(() => !h.s.live)
    await h.s.settled()
    const room = h.s.room
    expect(texts(room)).toContain('skeptic: Then no, Isaac.')
    expect(h.runner.byId('judge').prompts).toHaveLength(1)
    expect(h.runner.byId('judge').prompts[0]).toContain('Mara: Then no, Isaac.')
    expect(room.phase).toBe('resolved')
    // Everyone was shown Isaac's line before the judge spoke.
    for (const id of ['skeptic', 'builder', 'pm']) {
      expect(h.runner.byId(id).prompts.some((p) => p.includes('Isaac: Only 1 or 2 rooms'))).toBe(
        true,
      )
    }
  })

  it('round cap wraps the room: one final-position round, then the summary from what exists', async () => {
    const h = harness(
      {
        skeptic: (_p, t) => `Point ${t}.`,
        builder: (_p, t) => `Counter ${t}.`,
        pm: (p, t) => (p.includes('pinned summary') ? 'cap summary' : `Hmm ${t}.`),
        judge: CONTINUE,
      },
      { maxRounds: 4 },
    )
    await h.finish()
    // Rounds 1-4 run; the cap turns the room to wrapping and round 5 is the final-position turn.
    expect(h.s.room.rounds).toBe(5)
    expect(h.s.room.phase).toBe('resolved')
    expect(h.runner.byId('skeptic').prompts[4]).toContain('(wrapping up')
    expect(h.runner.byId('pm').prompts[5]).toContain('closed early')
    expect(h.s.room.messages[h.s.room.messages.length - 1]!.text).toBe('cap summary')
  })

  it('a dead process drops that agent; no PM means the judge summarizes', async () => {
    const h = harness(
      {
        skeptic: ['Here.', 'Still here.'],
        builder: ['Me too.'],
        judge: [CONVERGED, '**Decision**\njudge wrote it'],
      },
      { agents: ['skeptic', 'builder'] },
    )
    await h.s.start()
    h.runner.flush()
    await tick()
    h.runner.byId('builder').exit!('exit 1')
    await h.runner.drain(() => !h.s.live)
    await h.s.settled()
    const room = h.s.room
    expect(room.agents.find((a) => a.id === 'builder')?.failed).toBe(true)
    expect(
      room.messages.some((m) => m.author === 'system' && m.text.includes('Theo dropped out')),
    ).toBe(true)
    expect(room.phase).toBe('resolved')
    const summary = room.messages[room.messages.length - 1]!
    expect(summary).toMatchObject({
      kind: 'summary',
      author: 'judge',
      text: '**Decision**\njudge wrote it',
    })
    // Theo's round-2 turn died with him; the drop notice is part of the transcript the judge saw.
    expect(h.runner.byId('builder').prompts).toHaveLength(2)
    expect(h.runner.byId('judge').prompts[0]).toContain(
      'Room: Theo dropped out of the room (exit 1).',
    )
  })

  it('every agent dead fails the room', async () => {
    const dead = harness(
      { skeptic: 'x', builder: 'y', judge: CONTINUE },
      { agents: ['skeptic', 'builder'], failStart: ['skeptic', 'builder'] },
    )
    await dead.s.start()
    expect(dead.s.room.phase).toBe('failed')
    expect(dead.s.room.error).toBe('No agent could start.')
    expect(dead.s.room.messages.filter((m) => m.author === 'system')).toHaveLength(2)
    expect(dead.saved).toHaveLength(0)
    expect(dead.runner.byId('judge').stopped).toBe(true)
  })

  it('Resolve now: wrapping, one final-position turn for everyone, then the summary', async () => {
    const partials: string[] = []
    const h = harness(
      {
        skeptic: ['A long enough reply.', 'PASS', 'Final: fold.'],
        builder: ['B.', 'PASS', 'Final: fold.'],
        pm: ['C.', 'PASS', 'Final: fold.', 'stopped summary'],
        judge: CONTINUE,
      },
      {
        onChange: (room) => {
          const m = room.messages.find((x) => x.author === 'skeptic')
          if (m && partials[partials.length - 1] !== m.text) partials.push(m.text)
        },
      },
    )
    await h.s.start()
    h.runner.flush()
    await tick()
    expect(partials).toEqual(['A lo', 'A long enough reply.'])
    // Round 2 is in flight when Isaac resolves: that round finishes, round 3 is the final turn.
    expect(h.s.room.rounds).toBe(2)
    const stopping = h.s.stop()
    expect(h.s.room.phase).toBe('wrapping')
    await h.runner.drain(() => !h.s.live)
    await stopping
    const room = h.s.room
    expect(room.phase).toBe('resolved')
    expect(room.rounds).toBe(3)
    // Everyone got the wrap turn, even with nothing new to see; no judge call while wrapping.
    for (const id of ['skeptic', 'builder', 'pm']) {
      expect(h.runner.byId(id).prompts[2]).toContain('(wrapping up')
    }
    expect(h.runner.byId('judge').prompts).toHaveLength(0)
    expect(texts(room).slice(-4)).toEqual([
      'skeptic: Final: fold.',
      'builder: Final: fold.',
      'pm: Final: fold.',
      'pm: stopped summary',
    ])
    expect(h.runner.byId('pm').prompts[3]).not.toContain('closed early')
    expect(h.saved).toHaveLength(1)
  })

  it('presence follows the turn: thinking on send, frames refine it, idle when the reply lands', async () => {
    const seen: string[] = []
    const h = harness(
      {
        skeptic: ['A long enough reply.', 'PASS'],
        builder: ['B.', 'PASS'],
        pm: ['C.', 'PASS', 'summary'],
        judge: CONVERGED,
      },
      {
        onChange: (room) => {
          const p = room.presence.skeptic
          const key = p ? `${p.state}${p.detail ? `:${p.detail}` : ''}` : 'idle'
          if (seen[seen.length - 1] !== key) seen.push(key)
        },
      },
    )
    await h.s.start()
    expect(h.s.room.presence.skeptic).toMatchObject({ state: 'thinking', since: 1_000_000 })
    expect(Object.keys(h.s.room.presence).sort()).toEqual(['builder', 'pm', 'skeptic'])
    h.runner.flush()
    await tick()
    // The first change seen is the round starting (Mara still idle), then her turn's arc.
    expect(seen.slice(1, 4)).toEqual(['thinking', 'typing', 'idle'])
    await h.runner.drain(() => !h.s.live)
    await h.s.settled()
    expect(h.s.room.presence).toEqual({})
  })

  it('destroy() during start waits for the in-flight start and ends every process', async () => {
    const h = harness(
      { skeptic: 'A.', builder: 'B.', judge: CONTINUE },
      { agents: ['skeptic', 'builder'], holdStart: ['builder'] },
    )
    const starting = h.s.start()
    await tick()
    // Mara is up, Theo's process is still spawning when the app quits.
    expect(h.runner.agents.map((a) => a.id)).toEqual(['skeptic', 'judge'])
    let destroyed = false
    const destroying = h.s.destroy().then(() => {
      destroyed = true
    })
    await tick()
    // before-quit must not be told "done" while Theo's spawn is still pending.
    expect(destroyed).toBe(false)
    h.runner.releaseStarts()
    await destroying
    // At this point, with destroy() alone awaited, every process is dead.
    expect(h.runner.agents.map((a) => [a.id, a.stopped])).toEqual([
      ['skeptic', true],
      ['judge', true],
      ['builder', true],
    ])
    await starting
    expect(h.runner.pending).toEqual([])
    expect(h.s.room.rounds).toBe(0)
    for (const a of h.runner.agents) expect(a.prompts).toEqual([])
  })

  it('a seat past its turn budget is aborted, counts as PASS and the room says so', async () => {
    const h = harness(
      {
        skeptic: ['Never answers.'],
        builder: ['B.', 'PASS'],
        pm: ['C.', 'PASS', 'summary'],
        judge: CONVERGED,
      },
      { turnMs: 120_000, judgeMs: 60_000 },
    )
    await h.s.start()
    h.runner.flush(['builder', 'pm'])
    await tick()
    expect(h.s.room.presence.skeptic).toMatchObject({ state: 'thinking' })
    // Round 1 handed each seat a 120 s clock; Mara's is the first.
    expect(h.runner.clocks.map((c) => c.ms)).toEqual([120_000, 120_000, 120_000])
    h.runner.fireClock()
    await tick()
    expect(h.runner.byId('skeptic').aborts).toEqual(['no answer within 120 s'])
    expect(texts(h.s.room)).toContain('system: Mara did not answer in time and was skipped.')
    await h.runner.drain(() => !h.s.live)
    await h.s.settled()
    expect(h.s.room.phase).toBe('resolved')
    expect(h.runner.clocks.some((c) => c.ms === 60_000)).toBe(true)
  })

  it('Resolve now cannot hang: a stalled wrapping turn is skipped and the summary still lands', async () => {
    const h = harness({
      skeptic: ['A.', 'PASS', 'stalls'],
      builder: ['B.', 'PASS', 'Final: ship.'],
      pm: ['C.', 'PASS', 'Final: ship.', 'summary'],
      judge: CONTINUE,
    })
    await h.s.start()
    h.runner.flush()
    await tick()
    const stopping = h.s.stop()
    // Round 2 (in flight) settles, round 3 is the wrap turn; Mara never answers it.
    h.runner.flush()
    await tick()
    h.runner.flush(['builder', 'pm'])
    await tick()
    expect(h.s.room.rounds).toBe(3)
    expect(h.s.room.phase).toBe('wrapping')
    // Clocks of settled turns are stale no-ops; keep firing until Mara's wrap turn is aborted.
    while (h.runner.byId('skeptic').aborts.length === 0) {
      expect(h.runner.clocks.length).toBeGreaterThan(0)
      h.runner.fireClock()
      await tick()
    }
    // Stale clocks aborted nobody else.
    expect(h.runner.byId('builder').aborts).toEqual([])
    expect(h.runner.byId('pm').aborts).toEqual([])
    await h.runner.drain(() => !h.s.live)
    await stopping
    expect(h.s.room.phase).toBe('resolved')
    expect(texts(h.s.room)).toContain('system: Mara did not answer in time and was skipped.')
    expect(h.s.room.messages[h.s.room.messages.length - 1]!.text).toBe('summary')
  })

  it('Isaac @names narrow the next round to those people; the others catch up after', async () => {
    const h = harness({
      skeptic: ['A.', 'PASS', 'PASS'],
      builder: ['B.', 'PASS', (p) => (p.includes('Isaac: @Theo') ? 'Isaac: yes, fold.' : 'PASS')],
      pm: ['C.', 'PASS', 'PASS', 'summary'],
      judge: CONVERGED,
    })
    await h.s.start()
    h.runner.flush()
    await tick()
    // Round 2 is in flight; Isaac asks Theo specifically.
    h.s.post('@Theo what breaks if we fold?')
    expect(h.s.room.messages.find((m) => m.author === 'isaac')!.mentions).toEqual(['builder'])
    h.runner.flush()
    await tick()
    // Round 3 went to Theo alone.
    expect(h.s.room.rounds).toBe(3)
    expect(h.runner.pending.map((p) => p.id)).toEqual(['builder'])
    expect(h.runner.byId('builder').prompts[2]).toContain(
      '[m4] Isaac: @Theo what breaks if we fold?',
    )
    expect(h.runner.byId('skeptic').prompts).toHaveLength(2)
    // His question was for Theo, so once Theo answers the judge may speak.
    h.runner.flush()
    await tick()
    expect(h.runner.byId('judge').prompts).toHaveLength(1)
    expect(h.runner.byId('judge').prompts[0]).toContain('Theo: Isaac: yes, fold.')
    await h.runner.drain(() => !h.s.live)
    await h.s.settled()
    expect(h.s.room.phase).toBe('resolved')
  })

  it('an agent @mention forces a prompt with the mention line, but a round Isaac narrowed is exact', async () => {
    const h = harness({
      skeptic: [
        'A.',
        (p) => (p.includes('(you were mentioned by Theo)') ? 'Theo, no.' : 'PASS'),
        'PASS',
      ],
      builder: ['@Mara is this safe?', 'PASS', 'PASS'],
      pm: ['C.', 'Options: fold or archive.', 'PASS', 'summary'],
      judge: [CONTINUE, CONVERGED],
    })
    await h.s.start()
    h.runner.flush(['builder', 'pm'])
    await tick()
    expect(h.s.room.messages[0]).toMatchObject({ author: 'builder', mentions: ['skeptic'] })
    // Isaac narrows the next round to Jonah: exactly Jonah, even though Theo mentioned Mara.
    h.s.post('@Jonah summarize the options so far')
    h.runner.flush()
    await tick()
    expect(h.s.room.rounds).toBe(2)
    expect(h.runner.pending.map((p) => p.id)).toEqual(['pm'])
    // Round 3 is open again (after the judge says continue): Theo's mention of Mara now reaches
    // her, told so.
    h.runner.flush()
    await tick()
    h.runner.flush(['judge'])
    await tick()
    expect(h.s.room.rounds).toBe(3)
    expect(h.runner.pending.map((p) => p.id)).toContain('skeptic')
    const mara = h.runner.byId('skeptic').prompts[1]!
    expect(mara.startsWith('(you were mentioned by Theo)\nNew messages:')).toBe(true)
    expect(mara).toContain('[m1] Theo: @Mara is this safe?')
    await h.runner.drain(() => !h.s.live)
    await h.s.settled()
    expect(texts(h.s.room)).toContain('skeptic: Theo, no.')
  })
})

/** A scripted Jev: gate answers per round (by call order), convergence answers per call. */
class FakeJev implements Jev {
  gates: GateState[] = []
  convs: ConvergenceState[] = []
  constructor(
    private speak: (Record<string, number> | Error)[],
    private verdicts: ({ converged: number; circling: number } | Error)[],
  ) {}

  async gate(state: GateState): Promise<Record<string, number>> {
    this.gates.push(state)
    // The last scripted answer repeats, like the last reply of an agent script.
    const a = this.speak.length > 1 ? this.speak.shift()! : (this.speak[0] ?? {})
    if (a instanceof Error) throw a
    return a
  }

  async convergence(state: ConvergenceState): Promise<{ converged: number; circling: number }> {
    this.convs.push(state)
    const a = this.verdicts.shift() ?? { converged: 0, circling: 0 }
    if (a instanceof Error) throw a
    return a
  }
}

const LOW = { converged: 0.1, circling: 0.1 }

describe('RoomSession with Jev', () => {
  it('round 1 prompts everyone; later rounds prompt those at or above 0.5 plus anyone addressed', async () => {
    const jev = new FakeJev(
      [
        { skeptic: 0.8, builder: 0.2, pm: 0.5 },
        { skeptic: 0.1, builder: 0.1, pm: 0.3 },
      ],
      [LOW, { converged: 0.9, circling: 0 }],
    )
    const h = harness(
      {
        // Prompted: Mara rounds 1,2,4,5; Theo 1,3,5; Jonah 1,2,4,5 then the summary.
        skeptic: ['A.', 'A2.', 'PASS', 'Final.'],
        builder: ['B.', 'B2 @Mara?', 'Final.'],
        pm: ['C.', 'C2.', 'PASS', 'Final.', 'summary'],
      },
      { jev },
    )
    await h.s.start()
    expect(jev.gates).toHaveLength(0)
    h.runner.flush()
    await tick()
    // Round 2: Mara 0.8 and Jonah 0.5 clear the bar, Theo does not.
    expect(h.s.room.rounds).toBe(2)
    expect(h.runner.pending.map((p) => p.id).sort()).toEqual(['pm', 'skeptic'])
    expect(jev.gates[0]).toMatchObject({
      round: 2,
      mentioned: [],
      unseen: { skeptic: 3, builder: 3, pm: 3 },
    })
    expect(jev.gates[0]!.transcript.map((t) => t.author)).toEqual(['Mara', 'Theo', 'Jonah'])
    // Isaac asks Theo mid-round 2: convergence waits for Theo's answer (Isaac gate), and
    // round 3 goes to exactly Theo: no Jev gate, no floor, nobody else.
    h.s.post('@Theo your call')
    h.runner.flush()
    await tick()
    expect(jev.convs).toHaveLength(0)
    expect(h.s.room.rounds).toBe(3)
    expect(jev.gates).toHaveLength(1)
    expect(h.runner.pending.map((p) => p.id)).toEqual(['builder'])
    h.runner.flush()
    await tick()
    expect(jev.convs).toHaveLength(1)
    expect(jev.convs[0]!.lastRound.map((l) => l.text)).toEqual(['B2 @Mara?'])
    // Round 4 is gated again: Theo's @Mara from round 3 is in the batch, so Mara is in.
    expect(jev.gates[1]!.mentioned).toEqual(['skeptic'])
    expect(h.runner.pending.map((p) => p.id).sort()).toEqual(['pm', 'skeptic'])
    expect(h.s.room.judge).toMatchObject({
      verdict: 'continue',
      note: 'jev converged 0.10 / circling 0.10',
    })
    // The judge process is never asked while Jev is up. Converged -> one final-position round
    // for everyone (no gate), then the summary.
    await h.runner.drain(() => !h.s.live)
    await h.s.settled()
    expect(h.s.room.phase).toBe('resolved')
    expect(h.s.room.judge).toMatchObject({
      verdict: 'converged',
      note: 'jev converged 0.90 / circling 0.00 -> wrap',
    })
    // Gate calls for rounds 2 and 4 (round 3 was Isaac's, converged after 4); the wrap round 5 has no gate.
    expect(jev.gates).toHaveLength(2)
    expect(h.s.room.rounds).toBe(5)
    const wrapPrompt = (id: string): string =>
      h.runner
        .byId(id)
        .prompts.filter((p) => !p.includes('pinned summary'))
        .at(-1)!
    for (const id of ['skeptic', 'builder', 'pm']) expect(wrapPrompt(id)).toContain('(wrapping up')
    // Everyone answered the wrap turn (scripts fall through to their last reply), then the summary.
    const tail = texts(h.s.room).slice(-4)
    expect(
      tail
        .slice(0, 3)
        .map((t) => t.split(':')[0])
        .sort(),
    ).toEqual(['builder', 'pm', 'skeptic'])
    expect(tail.slice(0, 3).every((t) => t.endsWith(': Final.'))).toBe(true)
    expect(tail[3]).toBe('pm: summary')
    expect(h.runner.byId('judge').prompts).toHaveLength(0)
  })

  it('an agent mention overrides the gate; fewer than two clearing 0.5 fills up to two by score', async () => {
    const jev = new FakeJev(
      [
        { skeptic: 0.3, builder: 0.2, pm: 0.4 },
        { skeptic: 0.1, builder: 0.1, pm: 0.3 },
      ],
      [LOW, LOW, LOW],
    )
    const h = harness(
      {
        skeptic: ['A.', 'PASS', 'PASS'],
        builder: ['@Jonah thoughts?', 'PASS', 'PASS'],
        pm: ['C.', 'PASS', 'PASS', 'summary'],
      },
      { jev, maxRounds: 4 },
    )
    await h.s.start()
    h.runner.flush()
    await tick()
    // Round 2: nobody clears 0.5; Jonah was mentioned by Theo and is prompted, told so, and
    // the floor of two adds the next best score (Mara 0.3 over Theo 0.2).
    expect(h.runner.pending.map((p) => p.id).sort()).toEqual(['pm', 'skeptic'])
    expect(h.runner.byId('pm').prompts[1]).toContain('(you were mentioned by Theo)')
    h.runner.flush()
    await tick()
    // Round 2 was all PASS, so Jonah nudged. Round 3: still nobody clears; the floor picks
    // Jonah (0.3) and Mara (0.1, roster order), but the nudge is Jonah's own line, so only Mara
    // is actually sent.
    expect(h.s.room.rounds).toBe(3)
    expect(h.runner.pending.map((p) => p.id)).toEqual(['skeptic'])
    await h.runner.drain(() => !h.s.live)
    await h.s.settled()
    expect(h.s.room.phase).toBe('resolved')
  })

  it('two circling rounds in a row send the room to its final-position round; one does not', async () => {
    const jev = new FakeJev(
      [{ skeptic: 0.9, builder: 0.9, pm: 0.9 }],
      [
        { converged: 0.2, circling: 0.8 },
        { converged: 0.2, circling: 0.3 },
        { converged: 0.2, circling: 0.75 },
        { converged: 0.2, circling: 0.9 },
      ],
    )
    const h = harness(
      {
        skeptic: (_p, t) => `Point ${t}.`,
        builder: (_p, t) => `Counter ${t}.`,
        pm: (p, t) => (p.includes('pinned summary') ? 'summary' : `Hmm ${t}.`),
      },
      { jev },
    )
    await h.finish()
    expect(h.s.room.phase).toBe('resolved')
    // Rounds 2 (0.8), 3 (reset), 4 (0.75), 5 (0.9): the streak reaches two after round 5, which
    // triggers round 6, everyone's final position; the summary follows whatever is said there.
    expect(h.s.room.rounds).toBe(6)
    expect(jev.convs).toHaveLength(4)
    expect(h.s.room.judge).toMatchObject({
      verdict: 'converged',
      note: 'jev circling 0.75/0.90 -> wrap',
    })
    for (const id of ['skeptic', 'builder', 'pm']) {
      expect(h.runner.byId(id).prompts[5]).toContain('(wrapping up')
    }
    expect(texts(h.s.room).slice(-4, -1)).toEqual([
      'skeptic: Point 6.',
      'builder: Counter 6.',
      'pm: Hmm 6.',
    ])
    expect(h.runner.byId('pm').prompts[6]).not.toContain('closed early')
  })

  it('a Jev error falls back to the model judge and prompting everyone, with one notice', async () => {
    const jev = new FakeJev([new Error('jev 503: down')], [])
    const h = harness(
      {
        skeptic: ['A.', 'A2.', 'PASS'],
        builder: ['B.', 'B2.', 'PASS'],
        pm: ['C.', 'C2.', 'PASS', 'summary'],
        judge: [CONTINUE, CONVERGED],
      },
      { jev },
    )
    await h.s.start()
    h.runner.flush()
    await tick()
    expect(h.s.room.rounds).toBe(2)
    expect(h.runner.pending.map((p) => p.id).sort()).toEqual(['builder', 'pm', 'skeptic'])
    const notices = h.s.room.messages.filter((m) => m.author === 'system')
    expect(notices.map((m) => m.text)).toEqual(['Jev unavailable, using the model judge.'])
    await h.runner.drain(() => !h.s.live)
    await h.s.settled()
    expect(h.s.room.phase).toBe('resolved')
    expect(jev.convs).toHaveLength(0)
    expect(h.runner.byId('judge').prompts).toHaveLength(2)
    expect(h.s.room.judge).toMatchObject({ verdict: 'converged', note: 'all agree on fold' })
    expect(h.s.room.messages.filter((m) => m.author === 'system')).toHaveLength(1)
  })

  it('without Jev the room runs as before', async () => {
    const h = harness({
      skeptic: ['A.', 'PASS'],
      builder: ['B.', 'PASS'],
      pm: ['C.', 'PASS', 'summary'],
      judge: CONVERGED,
    })
    await h.finish()
    expect(h.s.room.phase).toBe('resolved')
    expect(h.s.room.messages.some((m) => m.author === 'system')).toBe(false)
  })

  it('three undecided Jev rounds (0.4..0.7) hand the call to the model judge once', async () => {
    const jev = new FakeJev(
      [{ skeptic: 0.9, builder: 0.9, pm: 0.9 }],
      [
        { converged: 0.55, circling: 0.1 },
        { converged: 0.62, circling: 0.1 },
        { converged: 0.58, circling: 0.1 },
      ],
    )
    const h = harness(
      {
        skeptic: (_p, t) => `Point ${t}.`,
        builder: (_p, t) => `Counter ${t}.`,
        pm: (p, t) => (p.includes('pinned summary') ? 'summary' : `Hmm ${t}.`),
        judge: CONVERGED,
      },
      { jev },
    )
    await h.finish()
    // Rounds 2, 3, 4 undecided -> the Sonnet judge is asked once after round 4 and says converged.
    expect(jev.convs).toHaveLength(3)
    expect(h.runner.byId('judge').prompts).toHaveLength(1)
    expect(h.s.room.judge).toMatchObject({
      verdict: 'converged',
      note: 'jev converged 0.58 / circling 0.10, undecided 3 rounds -> model judge: converged (all agree on fold)',
    })
    // Then the wrap round and the summary.
    expect(h.s.room.rounds).toBe(5)
    expect(h.s.room.phase).toBe('resolved')
  })

  it('a decided Jev round resets the undecided streak; the model judge is not consulted', async () => {
    const jev = new FakeJev(
      [{ skeptic: 0.9, builder: 0.9, pm: 0.9 }],
      [
        { converged: 0.55, circling: 0.1 },
        { converged: 0.62, circling: 0.1 },
        { converged: 0.2, circling: 0.1 },
        { converged: 0.5, circling: 0.1 },
        { converged: 0.9, circling: 0.1 },
      ],
    )
    const h = harness(
      {
        skeptic: (_p, t) => `Point ${t}.`,
        builder: (_p, t) => `Counter ${t}.`,
        pm: (p, t) => (p.includes('pinned summary') ? 'summary' : `Hmm ${t}.`),
        judge: CONVERGED,
      },
      { jev },
    )
    await h.finish()
    expect(h.runner.byId('judge').prompts).toHaveLength(0)
    expect(jev.convs).toHaveLength(5)
    expect(h.s.room.rounds).toBe(7)
  })

  it('the open phase is capped: after OPEN_ROUNDS the room wraps whatever Jev says', async () => {
    const jev = new FakeJev(
      [{ skeptic: 0.9, builder: 0.9, pm: 0.9 }],
      [{ converged: 0.2, circling: 0.1 }],
    )
    const h = harness(
      {
        skeptic: (_p, t) => `Point ${t}.`,
        builder: (_p, t) => `Counter ${t}.`,
        pm: (p, t) => (p.includes('pinned summary') ? 'summary' : `Hmm ${t}.`),
      },
      { jev, openRounds: 4 },
    )
    await h.finish()
    expect(h.s.room.phase).toBe('resolved')
    // Rounds 1-4 open, round 5 is the final-position turn.
    expect(h.s.room.rounds).toBe(5)
    expect(h.runner.byId('skeptic').prompts[4]).toContain('(wrapping up')
    expect(h.s.room.judge).toMatchObject({ verdict: 'converged', note: '4 open rounds -> wrap' })
    expect(h.runner.byId('pm').prompts[5]).toContain('closed early')
  })

  it('the summary prompt carries every final-position line verbatim and the dissent rule', async () => {
    const h = harness({
      skeptic: ['A.', 'PASS', 'Only if we fsync before the rename.'],
      builder: ['B.', 'PASS', 'AGREE'],
      pm: ['C.', 'PASS', 'AGREE', 'summary'],
      judge: CONVERGED,
    })
    await h.finish()
    const summary = h.runner.byId('pm').prompts.at(-1)!
    expect(summary).toContain('Write the pinned summary')
    expect(summary).toContain(
      'Final positions (the last thing each person said, verbatim):\n- Mara: Only if we fsync before the rename.\n- Theo: AGREE\n- Jonah: AGREE',
    )
    expect(summary).toContain(
      'one line per person whose final position is not full agreement, by name',
    )
    expect(summary).toContain('Write "None" only if every final position is AGREE or an equivalent')
  })
})
