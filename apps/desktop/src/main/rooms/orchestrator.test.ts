import { setImmediate as tick } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { ROOM_PEOPLE, type Room } from '@evaos/contract'
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
  it('fans out round 1 to everyone, later rounds only the delta, then the judge resolves it', async () => {
    const h = harness({
      skeptic: ['What breaks? 🤔', 'PASS'],
      builder: ['Fold, not delete.', 'Fine by me.'],
      pm: [
        'Sounds like fold.',
        'AGREE',
        '**Decision**\nFold.\n\n**Dissent**\nNone\n\n**Next steps**\n- Theo: fold',
      ],
      judge: [CONVERGED],
    })
    await h.finish()
    const room = h.s.room
    expect(room.phase).toBe('resolved')
    expect(room.rounds).toBe(2)
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
    // PASS adds nothing; AGREE is posted.
    expect(texts(room)).toEqual([
      'skeptic: What breaks? 🤔',
      'builder: Fold, not delete.',
      'pm: Sounds like fold.',
      'builder: Fine by me.',
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
    // No judge call after round 1 (replies, before round 2); one after round 2.
    expect(h.runner.byId('judge').prompts).toHaveLength(1)
    expect(h.runner.byId('judge').prompts[0]).toContain('Rounds: 2')
    for (const a of h.runner.agents) expect(a.stopped).toBe(true)
    expect(h.runner.byId('pm').prompts[2]).toContain('Write the pinned summary')
    expect(room.presence).toEqual({})
  })

  it('a silent round after continue gets one nudge from the PM, then resolves if still quiet', async () => {
    const h = harness({
      skeptic: ['A.', 'PASS', 'PASS'],
      builder: ['B.', 'PASS', 'PASS'],
      pm: ['C.', 'PASS', 'PASS', 'summary text'],
      judge: CONTINUE,
    })
    await h.finish()
    const room = h.s.room
    const nudge = room.messages.find((m) => m.text === NUDGE_TEXT)
    expect(nudge?.author).toBe('pm')
    expect(room.rounds).toBe(3)
    expect(room.phase).toBe('resolved')
    expect(h.runner.byId('judge').prompts).toHaveLength(2)
    // The nudge was the delta of round 3; Jonah posted it, so his own line is not sent back to him.
    expect(h.runner.byId('skeptic').prompts[2]).toContain(`Jonah: ${NUDGE_TEXT}`)
    expect(h.runner.byId('pm').prompts).toHaveLength(3)
    expect(h.runner.byId('pm').prompts[2]).toContain('closed early')
  })

  it('parses react lines into reactions and ignores unknown ids', async () => {
    const h = harness({
      skeptic: ['First.', 'react: m1 👀\nreact: m2 🔥\nreact: m99 👍\nAgreed with Theo.'],
      builder: ['Second.', 'PASS'],
      pm: ['Third.', 'PASS', 'summary'],
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

  it('round cap resolves the room', async () => {
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
    expect(h.s.room.rounds).toBe(4)
    expect(h.s.room.phase).toBe('resolved')
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
    await h.finish()
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
})
