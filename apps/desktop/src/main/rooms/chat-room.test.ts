import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelInfo } from '@evaos/chat-core/launch'
import type { ChatRoomMember, ChatRoomSetup, Room } from '@evaos/contract'
import { ChatRoom, type ChatRoomDeps, type RoomAssistant } from './chat-room'
import { readRoomStates, type ChatRoomState } from './council/state'
import type { SeatHandle, SeatLauncher, SeatSpec, SeatTurnInput } from './council/seat'

const OPUS = 'anthropic/claude-opus-5-5'

const SETUP: ChatRoomSetup = {
  template: 'debate',
  members: [
    { id: 'nova', assistant: 'nova', name: 'Nova', model: OPUS, thinking: 'high', role: 'Judge' },
    {
      id: 'builder',
      name: 'Builder',
      model: 'openai-codex/gpt-6-sol',
      thinking: 'medium',
      role: 'Argue for',
    },
  ],
  effort: 3,
  budget: 3,
  folder: 'work/src',
  refs: ['/tmp/ref.png'],
  draft: 'Start with the weapons.',
}

const member = (id: string, role: string): ChatRoomMember => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  model: OPUS,
  thinking: 'medium',
  role,
})

/** $0.02 a turn at this price: 1000 tokens in at $10/M, 100 out at $100/M. A first turn is guessed at $0.16. */
const CATALOG: ModelInfo[] = [
  {
    provider: 'anthropic',
    id: 'claude-opus-5-5',
    name: 'Opus 5.5',
    contextWindow: 200000,
    images: true,
    levels: ['off', 'low', 'medium', 'high'],
    price: { input: 10, output: 100, cached: 1 },
  },
]

const abortError = (): Error => Object.assign(new Error('turn aborted'), { name: 'AbortError' })

/** Seats that answer from a script; `hold(seat)` keeps that seat's turns waiting until `release()`. */
class FakeLauncher implements SeatLauncher {
  specs: SeatSpec[] = []
  turns: { seat: string; prompt: string }[] = []
  stopped: string[] = []
  script: Record<string, string[]> = {}
  private gate: { seat: string; done: PromiseWithResolvers<void> } | null = null

  hold(seat: string): void {
    this.gate = { seat, done: Promise.withResolvers<void>() }
  }

  release(): void {
    this.gate?.done.resolve()
    this.gate = null
  }

  async start(spec: SeatSpec): Promise<SeatHandle> {
    this.specs.push(spec)
    fs.mkdirSync(spec.sessionDir, { recursive: true })
    const file = path.join(spec.sessionDir, `${spec.seatId}.jsonl`)
    const resumed = spec.resume?.harness === 'omp' && fs.existsSync(spec.resume.file)
    let ran = resumed
    return {
      harness: 'omp',
      resumed,
      session: () => (ran ? { harness: 'omp', file } : null),
      turn: async (input: SeatTurnInput) => {
        this.turns.push({ seat: spec.seatId, prompt: input.prompt })
        input.onPartial?.('…')
        const gate = this.gate
        if (gate?.seat === spec.seatId) {
          await new Promise<void>((resolve, reject) => {
            input.signal?.addEventListener('abort', () => reject(abortError()), { once: true })
            void gate.done.promise.then(resolve)
          })
        }
        fs.writeFileSync(file, '{}\n')
        ran = true
        const said = this.turns.filter((t) => t.seat === spec.seatId).length
        const text = this.script[spec.seatId]?.[said - 1] ?? `${spec.seatId} says ${said}`
        return {
          text,
          usage: { input: 1000, output: 100, cached: 0 },
          images: [],
          toolCalls: 0,
          ms: 1,
        }
      },
      stop: async () => {
        this.stopped.push(spec.seatId)
      },
      onExit: () => undefined,
    }
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

interface TestDeps extends ChatRoomDeps {
  changes: Room[]
  launcher: FakeLauncher
  roomsDir: string
}

function deps(assistants: RoomAssistant[] = []): TestDeps {
  const evaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-rooms-'))
  dirs.push(evaRoot)
  fs.mkdirSync(path.join(evaRoot, 'work', 'src'), { recursive: true })
  fs.writeFileSync(path.join(evaRoot, 'work', 'src', 'notes.md'), 'hi\n')
  const changes: Room[] = []
  const launcher = new FakeLauncher()
  const d: ChatRoomDeps = {
    evaRoot,
    onChange: (r: Room) => changes.push(r),
    log: () => undefined,
    launcher,
    catalog: async () => CATALOG,
    assistants: () => assistants,
    asksRoot: path.join(evaRoot, 'asks'),
  }
  return { ...d, changes, launcher, roomsDir: path.join(evaRoot, 'work', 'rooms') }
}

const states = (roomsDir: string): ChatRoomState[] =>
  readRoomStates(roomsDir, () => undefined).filter((s): s is ChatRoomState => 'kind' in s)

/** What a new app run lists from disk. */
const reload = (d: TestDeps): ChatRoom[] =>
  states(d.roomsDir).map((s) => ChatRoom.restore(s, { ...d, onChange: () => undefined }))

const said = (room: Room): string[][] =>
  room.messages.filter((m) => m.author !== 'isaac').map((m) => [m.author, m.text])

describe('ChatRoom', () => {
  it('is saved idle at once and comes back after a restart with the same setup', () => {
    const d = deps()
    const r = ChatRoom.create('room-a', SETUP, 1000, d)
    expect(r.room).toMatchObject({ kind: 'chat', phase: 'idle', title: 'New room', messages: [] })
    const [back] = reload(d)
    expect(back!.room).toMatchObject({ id: 'room-a', kind: 'chat', phase: 'idle', startedAt: 1000 })
    expect(back!.room.chat).toEqual({ setup: SETUP, rev: 0, spend: { usd: 0, byMember: {} } })
    expect(back!.room.agents.map((a) => [a.id, a.model, a.role])).toEqual([
      ['nova', OPUS, 'Judge'],
      ['builder', 'openai-codex/gpt-6-sol', 'Argue for'],
    ])
  })

  it("Isaac's first message is kept and names the room", async () => {
    const d = deps()
    const r = ChatRoom.create('room-b', SETUP, 1000, d)
    r.post('Should @Nova pick Postgres?\nDetails follow.')
    expect(r.room.title).toBe('Should @Nova pick Postgres?')
    expect(r.room.messages.map((m) => [m.id, m.author, m.mentions])).toEqual([
      ['m1', 'isaac', ['nova']],
    ])
    await vi.waitFor(() => expect(r.room.phase).toBe('idle'))
    const [back] = reload(d)
    expect(back!.room.chat!.setup.title).toBe('Should @Nova pick Postgres?')
    await r.destroy()
  })

  it('rename and update are saved; members are replaced whole and null clears a field', () => {
    const d = deps()
    const r = ChatRoom.create('room-c', SETUP, 1000, d)
    r.rename('Boxhead weapons')
    const rev = r.update({ members: [SETUP.members[1]!], folder: null, budget: 5 })
    expect(rev).toBe(1)
    const [back] = reload(d)
    expect(back!.room.title).toBe('Boxhead weapons')
    expect(back!.room.chat!.rev).toBe(1)
    expect(back!.room.chat!.setup.members.map((m) => m.id)).toEqual(['builder'])
    expect(back!.room.chat!.setup.folder).toBeUndefined()
    expect(back!.room.chat!.setup.budget).toBe(5)
    expect(back!.room.agents.map((a) => a.id)).toEqual(['builder'])
    expect(() => r.update({ members: [] })).toThrow()
    expect(d.changes.length).toBeGreaterThanOrEqual(2)
  })

  it('runs a burst: the mentioned member first, a handoff by @, the judge last, bounded by effort', async () => {
    const d = deps()
    const setup: ChatRoomSetup = {
      ...SETUP,
      members: [
        member('astra', 'Argue for'),
        member('polaris', 'Argue against'),
        member('nova', 'Judge'),
      ],
      effort: 1,
    }
    d.launcher.script = {
      polaris: ['Counterpoint: one Mac. @Astra what is the write rate?'],
      astra: ['About 40 writes a second.'],
      nova: ['Calling it: SQLite now.'],
    }
    const r = ChatRoom.create('room-d', setup, 1000, d)
    r.post('@Polaris should we move to Postgres?')
    await vi.waitFor(() => expect(said(r.room)).toHaveLength(3))
    await vi.waitFor(() => expect(r.room.phase).toBe('idle'))
    expect(said(r.room)).toEqual([
      ['polaris', 'Counterpoint: one Mac. @Astra what is the write rate?'],
      ['astra', 'About 40 writes a second.'],
      ['nova', 'Calling it: SQLite now.'],
    ])
    // Each seat sees what it has not seen: the judge gets the whole thread, Astra Polaris's handoff.
    const prompt = (seat: string): string => d.launcher.turns.find((t) => t.seat === seat)!.prompt
    expect(prompt('astra')).toContain('Polaris: Counterpoint')
    expect(prompt('nova')).toContain('Astra: About 40')
    // Exact model and thinking, cwd = the room's main/ with the folder copied in.
    const spec = d.launcher.specs.find((s) => s.seatId === 'astra')!
    expect(spec).toMatchObject({ harness: 'omp', model: { omp: OPUS }, thinking: 'medium' })
    expect(spec.cwd).toBe(path.join(d.roomsDir, 'room-d', 'main'))
    expect(fs.readFileSync(path.join(spec.cwd, 'notes.md'), 'utf8')).toBe('hi\n')
    expect(spec.systemPrompt).toContain('- Polaris (Argue against)')
    expect(spec.systemPrompt).toContain("The room's question: @Polaris should we move to Postgres?")
    // $0.02 a turn, per member and in total, on disk.
    const spend = states(d.roomsDir)[0]!.room.chat!.spend
    expect(spend.usd).toBeCloseTo(0.06)
    expect(spend.byMember.astra).toBeCloseTo(0.02)
    await r.destroy()
  })

  it('never starts a turn whose estimate would cross the budget; Resume goes on once it is raised', async () => {
    const d = deps()
    // First turn guessed at $0.16, costs $0.02: Astra fits $0.17, Polaris's first turn does not.
    const setup: ChatRoomSetup = {
      ...SETUP,
      members: [member('astra', 'Argue for'), member('polaris', 'Argue against')],
      effort: 1,
      budget: 0.17,
    }
    const r = ChatRoom.create('room-e', setup, 1000, d)
    r.post('Go.')
    await vi.waitFor(() => expect(r.room.phase).toBe('paused'))
    expect(said(r.room).map(([a]) => a)).toEqual(['astra', 'system'])
    expect(r.room.messages.at(-1)!.text).toContain("Paused before Polaris's turn")
    expect(r.room.chat!.spend.usd).toBeCloseTo(0.02)
    expect(d.launcher.turns.map((t) => t.seat)).toEqual(['astra'])
    await expect(r.resume()).rejects.toThrow(/Raise it in Members/)
    r.update({ budget: 1 })
    await r.resume()
    await vi.waitFor(() => expect(r.room.phase).toBe('idle'))
    expect(d.launcher.turns.map((t) => t.seat)).toEqual(['astra', 'polaris'])
    await r.destroy()
  })

  it('pause stops the turn now; after a restart the room is paused and Resume picks the seat session up', async () => {
    const d = deps()
    const setup: ChatRoomSetup = {
      ...SETUP,
      members: [member('astra', 'Argue for'), member('polaris', 'Argue against')],
      effort: 1,
    }
    const r = ChatRoom.create('room-f', setup, 1000, d)
    d.launcher.hold('polaris')
    r.post('Go.')
    await vi.waitFor(() => expect(d.launcher.turns).toHaveLength(2))
    expect(said(r.room).map(([a]) => a)).toEqual(['astra', 'polaris'])
    expect(r.room.presence.polaris?.state).toBe('typing')
    r.pause()
    await vi.waitFor(() => expect(d.launcher.stopped).toContain('astra'))
    expect(r.room.phase).toBe('paused')
    // The dropped turn left nothing behind; Polaris is still up next.
    await vi.waitFor(() => expect(said(r.room).map(([a]) => a)).toEqual(['astra', 'system']))
    await r.destroy()
    d.launcher.release()

    const saved = states(d.roomsDir)[0]!
    expect(saved.room.phase).toBe('paused')
    expect(saved.burst?.queue).toEqual(['polaris'])
    expect(saved.seats.astra?.session).toEqual({
      harness: 'omp',
      file: path.join(d.roomsDir, 'room-f', 'sessions', 'astra', 'astra.jsonl'),
    })

    // A new app run: nothing runs until Resume.
    const launcher2 = new FakeLauncher()
    const [back] = states(d.roomsDir).map((s) => ChatRoom.restore(s, { ...d, launcher: launcher2 }))
    expect(back!.room.phase).toBe('paused')
    expect(launcher2.specs).toHaveLength(0)
    await back!.resume()
    await vi.waitFor(() => expect(back!.room.phase).toBe('idle'))
    expect(launcher2.turns.map((t) => t.seat)).toEqual(['polaris'])
    await back!.destroy()

    // A room saved mid-burst (Relay was killed) comes back paused too, with a quiet line.
    const killed = { ...states(d.roomsDir)[0]!, burst: { queue: ['astra'], left: 1, last: null } }
    killed.room = { ...killed.room, phase: 'open' }
    const again = ChatRoom.restore(killed, { ...d, launcher: launcher2 })
    expect(again.room.phase).toBe('paused')
    expect(again.room.messages.at(-1)!.text).toContain('Paused when Relay quit')
    // Astra's saved session is resumed when she runs again.
    await again.resume()
    await vi.waitFor(() => expect(again.room.phase).toBe('idle'))
    const astra = launcher2.specs.find((s) => s.seatId === 'astra')!
    expect(astra.resume).toEqual(saved.seats.astra!.session)
    await again.destroy()
  })

  it('an @mentioned assistant who is not in the room joins as a guest and answers first', async () => {
    const d = deps([
      { id: 'nova', title: 'Nova', scope: 'Chief of staff' },
      { id: 'penny', title: 'Penny', scope: 'Errands', model: `${OPUS}:low` },
    ])
    const setup: ChatRoomSetup = { ...SETUP, members: [SETUP.members[0]!], effort: 1 }
    const r = ChatRoom.create('room-g', setup, 1000, d)
    r.post('@Penny find a 2TB SSD under $200')
    await vi.waitFor(() => expect(said(r.room)).toHaveLength(3))
    await vi.waitFor(() => expect(r.room.phase).toBe('idle'))
    const penny = r.setup.members.find((m) => m.assistant === 'penny')
    expect(penny).toMatchObject({
      id: 'penny',
      name: 'Penny',
      model: OPUS,
      thinking: 'low',
      guest: true,
    })
    expect(r.room.chat!.rev).toBe(1)
    expect(r.room.messages.map((m) => [m.author, m.text.split(' ')[0]])).toEqual([
      ['isaac', '@Penny'],
      ['system', 'Penny'],
      ['penny', 'penny'],
      ['nova', 'nova'],
    ])
    expect(r.room.messages[1]!.text).toBe('Penny joined as a guest')
    expect(r.room.messages[0]!.mentions).toEqual(['penny'])
    // Nova's persona comes from the registry.
    const nova = d.launcher.specs.find((s) => s.seatId === 'nova')!
    expect(nova.systemPrompt).toContain("Isaac's assistant Nova (Chief of staff)")
    await r.destroy()
  })

  it('turns markers into decision cards: a poll later votes tally, an ask ends the burst', async () => {
    const d = deps()
    const setup: ChatRoomSetup = {
      ...SETUP,
      members: [member('astra', 'Argue for'), member('polaris', 'Argue against'), member('nova', 'Judge')],
      effort: 2,
    }
    d.launcher.script = {
      astra: [
        'Postgres wins on concurrency \u2014 six writers. @Polaris\n[[poll: Which store \u2014 next 6 months? | SQLite now, Postgres later | Stay on SQLite | Move to Postgres now]]\n[[vote: 3]]',
        'Agreed on backups. @Polaris\n[[cons: Staying on SQLite | One writer at a time]]\n[[dispute: Zero ops]]',
      ],
      polaris: [
        'SQLite. The write rate settles it. @Astra\n[[vote: Stay on SQLite]]\n[[pros: Staying on SQLite | Zero ops \u2013 no daemon | Litestream covers backups]]',
        '@Isaac one thing only you know.\n[[ask-isaac: Is a second host coming this quarter? | Yes | No | Not sure | note: Yes flips this]]',
      ],
    }
    const r = ChatRoom.create('room-dec', setup, 1000, d)
    r.post('Should Relay Host move from SQLite to Postgres?')
    await vi.waitFor(() => expect(r.room.messages.some((m) => m.card?.type === 'question')).toBe(true))
    await vi.waitFor(() => expect(r.room.phase).toBe('idle'))
    const cards = r.room.messages.filter((m) => m.card).map((m) => [m.id, m.author, m.card!.type])
    expect(cards).toEqual([
      ['m2', 'astra', 'poll'],
      ['m3', 'polaris', 'proscons'],
      ['m5', 'polaris', 'question'],
    ])
    // The question stopped the burst before the judge's closing turn.
    expect(d.launcher.turns.map((t) => t.seat)).toEqual(['astra', 'polaris', 'astra', 'polaris'])
    const poll = r.room.messages[1]!.card!
    expect(poll).toMatchObject({
      question: 'Which store, next 6 months?',
      votes: { astra: 'o3', polaris: 'o2' },
      state: 'open',
    })
    expect(r.room.messages[1]!.text).toBe('Postgres wins on concurrency, six writers. @Polaris')
    const pc = r.room.messages[2]!.card!
    expect(pc).toMatchObject({
      pros: [
        { text: 'Zero ops, no daemon', by: ['polaris'], state: 'disputed', against: ['astra'] },
        { text: 'Litestream covers backups', state: 'agreed' },
      ],
      cons: [{ text: 'One writer at a time', by: ['astra'] }],
    })
    // No em dash and no marker reaches the room, the cards or room.json.
    const disk = fs.readFileSync(path.join(r.workdir, 'room.json'), 'utf8')
    expect(disk).not.toMatch(/[\u2014\u2013]|\[\[/)
    expect(JSON.stringify(r.room.messages)).not.toMatch(/[\u2014\u2013]|\[\[/)
    // The next turn's prompt says where the cards stand.
    expect(d.launcher.turns[3]!.prompt).toContain('Where the room stands:')
    expect(d.launcher.turns[3]!.prompt).toContain('2) Stay on SQLite: Polaris')
    const [back] = reload(d)
    expect(back!.room.messages[4]!.card).toMatchObject({ type: 'question', answers: ['Yes', 'No', 'Not sure'] })
    await r.destroy()
  })

  it("Isaac's votes rewrite one line, his answer is a post the asker answers first, his call is recorded", async () => {
    const d = deps()
    const setup: ChatRoomSetup = {
      ...SETUP,
      members: [member('astra', 'Argue for'), member('polaris', 'Argue against'), member('nova', 'Judge')],
      effort: 1,
    }
    d.launcher.script = {
      astra: ['Voting.\n[[poll: Which store? | SQLite | Postgres]]\n[[vote: Postgres]]', '[[vote: SQLite]]'],
      polaris: ['[[ask-isaac: Second host this quarter? | Yes | No]]', 'Then SQLite holds.'],
      nova: [
        'Calling it.\n[[decision: SQLite | One Mac, 40 writes a second | Polaris: add Litestream]]',
      ],
    }
    const r = ChatRoom.create('room-isaac', setup, 1000, d)
    r.post('Postgres or SQLite?')
    await vi.waitFor(() => expect(r.room.messages.some((m) => m.card?.type === 'question')).toBe(true))
    await vi.waitFor(() => expect(r.room.phase).toBe('idle'))
    const poll = r.room.messages.find((m) => m.card?.type === 'poll')!
    const ask = r.room.messages.find((m) => m.card?.type === 'question')!
    r.vote(poll.id, 'o1')
    r.vote(poll.id, 'o2')
    const lines = r.room.messages.filter((m) => m.author === 'system').map((m) => m.text)
    expect(lines).toEqual(['Isaac voted Postgres'])
    expect(() => r.answerAsk(ask.id, 'Maybe')).toThrow(/Not one/)
    r.answerAsk(ask.id, 'No')
    expect(ask.card).toMatchObject({ answered: 'No' })
    await vi.waitFor(() => expect(r.room.messages.some((m) => m.card?.type === 'decision')).toBe(true))
    await vi.waitFor(() => expect(r.room.phase).toBe('idle'))
    const isaac = r.room.messages.filter((m) => m.author === 'isaac').map((m) => m.text)
    expect(isaac).toEqual(['Postgres or SQLite?', 'Second host this quarter? No'])
    // Polaris asked, so Polaris answers first; the judge closes with the call.
    expect(d.launcher.turns.map((t) => t.seat).slice(2)).toEqual(['polaris', 'astra', 'nova'])
    // Astra's second reply only voted: no message, her vote moved.
    expect(said(r.room).filter(([a]) => a === 'astra')).toHaveLength(1)
    const dec = r.room.messages.find((m) => m.card?.type === 'decision')!
    expect(dec.card).toMatchObject({
      title: 'SQLite',
      option: 'o1',
      agree: ['nova', 'astra'],
      dissent: [{ by: 'isaac', note: 'Voted Postgres' }],
      next: { who: 'polaris', text: 'add Litestream' },
      state: 'proposed',
    })
    r.decide(dec.id, 'override', 'o2')
    expect(dec.card).toMatchObject({ state: 'overridden', title: 'Postgres', previous: 'SQLite' })
    expect(r.room.messages.at(-1)!.text).toBe('Isaac overrode the call (SQLite): Postgres')
    r.reopenPoll(poll.id)
    expect(dec.card).toMatchObject({ state: 'reopened' })
    expect(r.room.messages.at(-1)!.text).toBe('Isaac reopened the vote: Which store?')
    expect(() => r.decide('m999', 'accept')).toThrow(/not in the room/)
    const [back] = reload(d)
    expect(back!.room.messages.find((m) => m.id === dec.id)!.card).toMatchObject({
      state: 'reopened',
    })
    await r.destroy()
  })
})
