import {
  MENTION_EVERYONE,
  ROOM_ISAAC,
  ROOM_JUDGE,
  ROOM_SYSTEM,
  mentionsIn,
  roomIsLive,
  type Room,
  type RoomAgent,
  type RoomMessage,
} from '@evaos/contract'
import {
  JUDGE_PROMPT,
  NUDGE_TEXT,
  authorName,
  deltaPrompt,
  firstName,
  judgePrompt,
  openingPrompt,
  parseReply,
  parseVerdict,
  personaPrompt,
  summaryPrompt,
  dedash,
  trimReply,
} from './prompts'
import { convergenceState, gateState, type Jev } from './jev'
import type { AgentHandle, AgentRunner, Presence } from './runner'

/** The open phase ends here and the room wraps, whatever the judge says. */
export const OPEN_ROUNDS = 8
/** The absolute backstop on rounds of any phase. */
export const MAX_ROUNDS = 30

export interface RoomSessionDeps {
  runner: AgentRunner
  judgeModel: string
  /** Writes the record once resolved; returns where it went. */
  save: (room: Room) => Promise<string>
  onChange: (room: Room) => void
  log: (line: string) => void
  now?: () => number
  maxRounds?: number
  openRounds?: number
  /** A seat's turn budget; past it the turn is aborted and counts as PASS. */
  turnMs?: number
  /** The judge's and the summary's turn budget. */
  judgeMs?: number
  /** Resolves after `ms` (test seam; the default is a real, unref'd timer). */
  after?: (ms: number) => Promise<void>
  /** Jev for the speaker gate and convergence; absent or failing -> prompt everyone + model judge. */
  jev?: Jev
}

/** Jev's speak probability at or above which an agent is prompted. */
export const GATE_THRESHOLD = 0.5
/** At least this many seats speak each gated round, so a dissenter can answer a rebuttal. */
export const GATE_FLOOR = 2
/** Jev's `converged` at or above which the room is done. */
export const CONVERGED_THRESHOLD = 0.7
/** Jev's `circling` at or above which a round counts as repetition... */
export const CIRCLING_THRESHOLD = 0.7
/** ...and this many such rounds in a row send the room to its final-position round. */
export const CIRCLING_ROUNDS = 2
/** Jev `converged` in [UNDECIDED_LOW, CONVERGED_THRESHOLD) is on the fence... */
export const UNDECIDED_LOW = 0.4
/** ...and this many fence rounds in a row hand the call to the model judge once. */
export const UNDECIDED_ROUNDS = 3

export const TURN_MS = 120_000
export const JUDGE_MS = 60_000

const realAfter = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms).unref()
  return promise
}

export class TurnTimeout extends Error {}

let roomSeq = 0
export const newRoomId = (now: number): string => `room-${now.toString(36)}-${++roomSeq}`

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
/** Message ids are `m<n>` in post order; the number is the cursor agents are shown up to. */
const msgNum = (id: string): number => Number(id.slice(1))

/**
 * One live room: a throwaway omp process per person plus a judge. Rounds are free-for-all with
 * a relevance gate: every idle agent gets the delta since it last saw the room and answers or
 * passes. The judge calls convergence after each round from round 2; a soft clock turns the room
 * to wrapping, a hard clock and a round cap force the summary from what exists.
 */
export class RoomSession {
  readonly room: Room
  private readonly handles = new Map<string, AgentHandle>()
  /** Per-agent send chain: one turn at a time on one process. */
  private readonly chains = new Map<string, Promise<unknown>>()
  /** The highest message number each agent has been shown. */
  private readonly seen = new Map<string, number>()
  /** The message an agent's streaming reply is landing in, while its turn runs. */
  private readonly drafts = new Map<string, RoomMessage>()
  private judge: AgentHandle | null = null
  private msgSeq = 0
  private resolving = false
  /** Every process start has settled; from here a last agent dying fails the room. */
  private started = false
  /** Isaac pressed Resolve now: the round it was (or will be) sent as the final-position turn. */
  private wrapRound: number | null = null
  /** The message number the previous round started at: what came since is this round's batch. */
  private lastRoundSeq = 0
  /** Rounds in a row Jev called circling, and every circling score so far (for the note). */
  private circlingStreak = 0
  private readonly circlingSeen: number[] = []
  /** Rounds in a row Jev's `converged` sat between UNDECIDED_LOW and the threshold. */
  private undecidedStreak = 0
  /** What wrap() decided the summary should say: closed early (true) or settled (false). */
  private forcedSummary = false
  /** The wrap round's replies, handed to the summary as everyone's final position. */
  private finalLines: RoomMessage[] = []
  /** Jev errored once in this room; the model judge takes over for good. */
  private jevFailed = false
  /** destroy() ran: starts that land later end their process instead of registering it. */
  private destroyed = false
  /** Every process start of start(), settled; destroy() waits on it. */
  private starting: Promise<void> = Promise.resolve()
  private readonly now: () => number
  private readonly maxRounds: number
  private readonly openRounds: number
  private readonly turnMs: number
  private readonly judgeMs: number
  private readonly after: (ms: number) => Promise<void>
  private loop: Promise<void> | null = null

  constructor(
    prompt: string,
    agents: readonly RoomAgent[],
    private readonly deps: RoomSessionDeps,
  ) {
    this.now = deps.now ?? Date.now
    this.maxRounds = deps.maxRounds ?? MAX_ROUNDS
    this.openRounds = deps.openRounds ?? OPEN_ROUNDS
    this.turnMs = deps.turnMs ?? TURN_MS
    this.judgeMs = deps.judgeMs ?? JUDGE_MS
    this.after = deps.after ?? realAfter
    const now = this.now()
    const text = prompt.trim()
    this.room = {
      id: newRoomId(now),
      title: text.split('\n')[0] || 'Untitled room',
      prompt: text,
      agents: agents.map((a) => ({ ...a })),
      messages: [],
      presence: {},
      phase: 'open',
      rounds: 0,
      startedAt: now,
    }
  }

  get live(): boolean {
    return roomIsLive(this.room.phase) && !this.resolving
  }

  private changed(): void {
    this.deps.onChange(this.room)
  }

  private liveAgents(): RoomAgent[] {
    return this.room.agents.filter((a) => !a.failed && this.handles.has(a.id))
  }

  private pm(): RoomAgent | null {
    return this.liveAgents().find((a) => a.role === 'PM') ?? null
  }

  /** Starts every process, then the round loop. Resolves once the processes are up. */
  async start(): Promise<void> {
    const starts = this.room.agents.map(async (a) => {
      // Marked by the caller: the model is not in omp's catalog, so there is nothing to start.
      if (a.failed) {
        this.dropped(a, 'their model is not in omp')
        return
      }
      try {
        const h = await this.deps.runner.start({
          systemPrompt: personaPrompt(a, this.room.agents),
          model: a.model,
          tools: a.tools,
          thinking: 'high',
        })
        // The room was torn down while this process was starting: it is nobody's, end it now.
        if (this.destroyed) {
          await h.stop().catch(() => undefined)
          return
        }
        h.onExit((reason) => this.markFailed(a.id, reason))
        this.handles.set(a.id, h)
      } catch (e) {
        this.markFailed(a.id, errText(e))
      }
    })
    const judge = (async () => {
      try {
        const h = await this.deps.runner.start({
          systemPrompt: JUDGE_PROMPT,
          model: this.deps.judgeModel,
          tools: 'none',
          thinking: 'medium',
        })
        if (this.destroyed) {
          await h.stop().catch(() => undefined)
          return
        }
        this.judge = h
        h.onExit((reason) => {
          this.judge = null
          this.deps.log(`${this.room.id}: judge died: ${reason}`)
        })
      } catch (e) {
        this.deps.log(`${this.room.id}: judge failed to start: ${errText(e)}`)
      }
    })()
    this.starting = Promise.all([...starts, judge]).then(() => undefined)
    await this.starting
    if (this.destroyed) return
    this.started = true
    if (this.liveAgents().length === 0) {
      if (roomIsLive(this.room.phase)) this.fail('No agent could start.')
      return
    }
    this.loop = this.run().catch((e) => this.fail(errText(e)))
  }

  /** Isaac posts; the text joins the next round's delta. */
  post(text: string): void {
    if (!this.live) throw new Error('The room is closed.')
    this.append(ROOM_ISAAC, text.trim())
  }

  /** Isaac toggles a reaction. */
  react(messageId: string, emoji: string): void {
    this.toggleReaction(messageId, emoji, ROOM_ISAAC)
  }

  /**
   * Resolve now: the room turns to wrapping, every agent gets one final-position turn, then the
   * summary. Resolves once the room is resolved.
   */
  async stop(): Promise<void> {
    if (!this.live) return
    this.wrap(false)
    await this.settled()
  }

  /**
   * The app is quitting: end every process and resolve once each has exited, including those
   * whose start is still in flight (start() stops a late handle itself; this waits for it).
   * Nothing is saved.
   */
  async destroy(): Promise<void> {
    this.destroyed = true
    this.resolving = true
    await Promise.all([this.stopAll(), this.starting])
  }

  /** The round loop settles once the room is resolved or failed. */
  settled(): Promise<void> {
    return this.loop ?? Promise.resolve()
  }

  private append(author: string, text: string, kind: RoomMessage['kind'] = 'message'): RoomMessage {
    const msg: RoomMessage = {
      id: `m${++this.msgSeq}`,
      author,
      text,
      ts: this.now(),
      reactions: [],
      kind,
      mentions: mentionsIn(text, this.room.agents),
    }
    this.room.messages.push(msg)
    this.changed()
    return msg
  }

  /** Whether `m` singles out `agentId` (or everyone). */
  private mentions(m: RoomMessage, agentId: string): boolean {
    return m.mentions.includes(MENTION_EVERYONE) || m.mentions.includes(agentId)
  }

  /** What an agent is doing now; null clears it. Only a change is emitted. */
  private setPresence(id: string, p: Presence): void {
    const cur = this.room.presence[id]
    if (p === null) {
      if (!cur) return
      delete this.room.presence[id]
    } else {
      if (cur && cur.state === p.state && cur.detail === p.detail) return
      this.room.presence[id] = { ...p, since: this.now() }
    }
    this.changed()
  }

  private toggleReaction(messageId: string, emoji: string, by: string): void {
    const m = this.room.messages.find((x) => x.id === messageId)
    if (!m) return
    const r = m.reactions.find((x) => x.emoji === emoji)
    if (!r) m.reactions.push({ emoji, by: [by] })
    else if (r.by.includes(by)) {
      r.by = r.by.filter((b) => b !== by)
      if (r.by.length === 0) m.reactions = m.reactions.filter((x) => x !== r)
    } else r.by.push(by)
    this.changed()
  }

  private markFailed(agentId: string, reason: string): void {
    const a = this.room.agents.find((x) => x.id === agentId)
    if (!a || a.failed) return
    a.failed = true
    this.handles.delete(agentId)
    this.dropped(a, reason)
  }

  private dropped(a: RoomAgent, reason: string): void {
    this.deps.log(`${this.room.id}: ${a.name} dropped: ${reason}`)
    if (!roomIsLive(this.room.phase)) return
    delete this.room.presence[a.id]
    this.append(ROOM_SYSTEM, `${firstName(a.name)} dropped out of the room (${reason}).`)
    if (this.started && this.liveAgents().length === 0 && !this.resolving) {
      this.fail('Every agent dropped out.')
    }
  }

  private fail(error: string): void {
    this.resolving = true
    this.room.phase = 'failed'
    this.room.error = error
    this.room.presence = {}
    this.changed()
    void this.stopAll()
  }

  private async stopAll(): Promise<void> {
    const all = [...this.handles.values(), ...(this.judge ? [this.judge] : [])]
    this.handles.clear()
    this.judge = null
    await Promise.allSettled(all.map((h) => h.stop()))
  }

  /**
   * One turn on one process, after whatever turn is already queued on it, within `budgetMs`:
   * past that the turn is aborted and the send rejects with TurnTimeout.
   */
  private sendSerial(
    key: string,
    handle: AgentHandle,
    text: string,
    budgetMs: number,
    hooks?: Parameters<AgentHandle['send']>[1],
  ): Promise<string> {
    const prev = this.chains.get(key) ?? Promise.resolve()
    const turn = async (): Promise<string> => {
      let timedOut = false
      let settled = false
      // A clock that fires after the turn settled is stale: it must not abort a later turn.
      const clock = this.after(budgetMs).then(() => {
        if (settled) return
        timedOut = true
        return handle.abort(`no answer within ${Math.round(budgetMs / 1000)} s`)
      })
      try {
        return await handle.send(text, hooks)
      } catch (e) {
        throw timedOut ? new TurnTimeout(errText(e)) : e
      } finally {
        settled = true
        void clock.catch(() => undefined)
      }
    }
    const next = prev.then(turn, turn)
    this.chains.set(
      key,
      next.catch(() => undefined),
    )
    return next
  }

  private async run(): Promise<void> {
    let nudged = false
    while (this.live) {
      // The open phase ends after OPEN_ROUNDS whatever Jev says; MAX_ROUNDS is the backstop.
      if (this.room.rounds >= this.openRounds && this.room.phase === 'open') {
        this.room.judge = {
          verdict: 'converged',
          note: `${this.openRounds} open rounds -> wrap`,
          at: this.now(),
        }
        this.wrap(true)
      }
      if (this.room.rounds >= this.maxRounds && this.room.phase === 'open') this.wrap(true)
      const before = this.msgSeq
      const anyNew = (): boolean => this.room.messages.some((m) => msgNum(m.id) > before)
      // Isaac's new posts with @names narrow this round to the people he asked.
      const batch = this.room.messages.filter((m) => msgNum(m.id) > this.lastRoundSeq)
      this.lastRoundSeq = this.msgSeq
      const asked = new Set<string>()
      let narrowed = false
      for (const m of batch) {
        if (m.author !== ROOM_ISAAC || m.mentions.length === 0) continue
        if (m.mentions.includes(MENTION_EVERYONE)) {
          narrowed = false
          break
        }
        narrowed = true
        for (const id of m.mentions) asked.add(id)
      }
      this.room.rounds += 1
      const wrapping = this.room.phase === 'wrapping'
      if (wrapping && this.wrapRound === null) this.wrapRound = this.room.rounds
      this.changed()
      const only = narrowed && !wrapping ? asked : null
      const mentionedInBatch = [...new Set(batch.flatMap((m) => m.mentions))]
      // Round 1 and the wrap turn go to everyone; a round Isaac narrowed goes to exactly the
      // people he named; otherwise Jev picks who has something to add.
      const gated =
        this.room.rounds > 1 && !wrapping && !only ? await this.jevGate(mentionedInBatch) : null
      if (!this.live) return
      const roundStart = this.msgSeq
      await this.round(wrapping, gated ?? only, only !== null)
      if (!this.live) return
      const lastRound = this.room.messages.filter((m) => msgNum(m.id) > roundStart)
      // The final-position round is done: summarize, as the trigger decided (Resolve now or a
      // convergence call -> plain; round cap or a quiet room -> from what exists).
      if (this.wrapRound === this.room.rounds) {
        // PASS-less final lines only: a seat that passed or timed out has nothing verbatim.
        this.finalLines = lastRound.filter((m) => this.room.agents.some((a) => a.id === m.author))
        await this.resolve(this.forcedSummary)
        return
      }
      if (this.room.phase === 'wrapping') continue
      // Isaac's post lands mid-round: the next round answers him before the judge may speak.
      const awaitingIsaac = this.isaacUnseen()
      if (!awaitingIsaac && (this.room.rounds >= 2 || !anyNew())) {
        const v = await this.verdict(lastRound)
        if (!this.live) return
        if (v === 'converged' && this.room.rounds >= 2) {
          this.wrap(false)
          continue
        }
      }
      // A reply or an Isaac post since the round began is the next delta; silence gets one nudge.
      if (anyNew()) {
        nudged = false
        continue
      }
      if (nudged) {
        this.wrap(true)
        continue
      }
      nudged = true
      this.append(this.pm()?.id ?? ROOM_JUDGE, NUDGE_TEXT)
    }
  }

  /**
   * Turns the room to wrapping: the next round is everyone's final-position turn, then the
   * summary. Every end of a room but a failure passes through here, Resolve now included.
   */
  private wrap(forced: boolean): void {
    if (this.room.phase !== 'open') return
    this.forcedSummary = forced
    this.room.phase = 'wrapping'
    this.changed()
  }

  /**
   * Some live agent has not yet been shown a message from Isaac that was for them: everyone
   * for a plain post, only the people he named when he used @names.
   */
  private isaacUnseen(): boolean {
    return this.liveAgents().some((a) => {
      const seen = this.seen.get(a.id) ?? 0
      return this.room.messages.some(
        (m) =>
          m.author === ROOM_ISAAC &&
          msgNum(m.id) > seen &&
          (m.mentions.length === 0 || this.mentions(m, a.id)),
      )
    })
  }

  /**
   * Every live agent with something unseen gets it (everyone, when wrapping); replies land as
   * they arrive. `only` keeps the round to those people. When Isaac narrowed the round
   * (`exact`) that set is final; otherwise an agent another agent mentioned is always prompted,
   * told so.
   */
  private async round(
    wrapping: boolean,
    only: ReadonlySet<string> | null,
    exact = false,
  ): Promise<void> {
    const sends = this.liveAgents().map(async (a) => {
      const handle = this.handles.get(a.id)
      if (!handle) return
      const first = !this.seen.has(a.id)
      const from = this.seen.get(a.id) ?? 0
      const delta = this.room.messages.filter((m) => msgNum(m.id) > from)
      const mentionedBy = exact
        ? []
        : delta
            .filter((m) => m.author !== a.id && m.author !== ROOM_ISAAC && this.mentions(m, a.id))
            .map((m) => authorName(this.room, m.author))
      if (mentionedBy.length === 0) {
        if (only && !only.has(a.id)) return
        if (!first && !wrapping && !delta.some((m) => m.author !== a.id)) return
      }
      // What others post during this turn has a higher number and is the next delta.
      this.seen.set(a.id, this.msgSeq)
      const mentionLine =
        mentionedBy.length > 0
          ? `(you were mentioned by ${[...new Set(mentionedBy)].join(', ')})\n`
          : ''
      const prompt = first
        ? openingPrompt(this.room) +
          (wrapping ? '\n(wrapping up: state your final position in one line)' : '')
        : mentionLine + deltaPrompt(this.room, delta, wrapping)
      // The model is thinking from the moment the prompt goes out; frames refine it from there.
      this.setPresence(a.id, { state: 'thinking' })
      try {
        const raw = await this.sendSerial(a.id, handle, prompt, this.turnMs, {
          onPartial: (partial) => {
            const p = parseReply(partial)
            // A reply that starts like PASS stays hidden until the turn ends.
            if (p.text === '' || /^\**\s*pass/i.test(p.text)) return
            this.showDraft(a.id, trimReply(p.text))
          },
          onPresence: (p) => {
            if (this.live && this.handles.has(a.id)) this.setPresence(a.id, p)
          },
        })
        if (!this.live) return
        const p = parseReply(raw)
        for (const r of p.reactions) this.toggleReaction(r.messageId, r.emoji, a.id)
        if (p.pass || p.text === '') this.dropDraft(a.id)
        else this.showDraft(a.id, p.text)
      } catch (e) {
        this.dropDraft(a.id)
        this.deps.log(`${this.room.id}: ${a.name} turn failed: ${errText(e)}`)
        // A stalled seat counts as PASS; the room says so rather than waiting on it.
        if (e instanceof TurnTimeout && this.live) {
          this.append(ROOM_SYSTEM, `${firstName(a.name)} did not answer in time and was skipped.`)
        }
      } finally {
        this.drafts.delete(a.id)
        if (this.live) this.setPresence(a.id, null)
      }
    })
    await Promise.all(sends)
  }

  /** The reply so far, as its own message from the first visible chunk on. */
  private showDraft(agentId: string, text: string): void {
    if (!this.live) return
    const draft = this.drafts.get(agentId)
    if (draft) {
      draft.text = text
      draft.mentions = mentionsIn(text, this.room.agents)
      this.changed()
      return
    }
    this.drafts.set(agentId, this.append(agentId, text))
  }

  private dropDraft(agentId: string): void {
    const draft = this.drafts.get(agentId)
    if (!draft) return
    this.drafts.delete(agentId)
    this.room.messages = this.room.messages.filter((m) => m !== draft)
    this.changed()
  }

  /**
   * Jev's speaker gate for a round Isaac did not narrow: everyone an agent @mentioned in the
   * batch is in regardless; otherwise those Jev puts at or above 0.5, floored at the top two by
   * score so a dissenter still gets to answer. Null when Jev is off or failed: everyone.
   */
  private async jevGate(mentioned: readonly string[]): Promise<ReadonlySet<string> | null> {
    const jev = this.jev()
    if (!jev) return null
    const agents = this.liveAgents()
    try {
      const p = await jev.gate(gateState(this.room, agents, this.seen, mentioned), agents)
      const pick = new Set<string>()
      if (mentioned.includes(MENTION_EVERYONE)) for (const a of agents) pick.add(a.id)
      for (const id of mentioned) if (agents.some((a) => a.id === id)) pick.add(id)
      for (const a of agents) if ((p[a.id] ?? 0) >= GATE_THRESHOLD) pick.add(a.id)
      if (pick.size < GATE_FLOOR) {
        const byScore = [...agents].sort((a, b) => (p[b.id] ?? 0) - (p[a.id] ?? 0))
        for (const a of byScore) {
          if (pick.size >= GATE_FLOOR) break
          pick.add(a.id)
        }
      }
      this.deps.log(
        `${this.room.id}: jev gate ${agents.map((a) => `${a.id}=${(p[a.id] ?? 0).toFixed(2)}`).join(' ')} -> ${[...pick].join(',')}`,
      )
      return pick
    } catch (e) {
      this.jevDown(e)
      return null
    }
  }

  /** Convergence by Jev when it is up, else the model judge. */
  private async verdict(lastRound: readonly RoomMessage[]): Promise<'continue' | 'converged'> {
    const jev = this.jev()
    if (!jev) return this.judgeRound()
    try {
      const { converged, circling } = await jev.convergence(convergenceState(this.room, lastRound))
      this.circlingStreak = circling >= CIRCLING_THRESHOLD ? this.circlingStreak + 1 : 0
      this.circlingSeen.push(circling)
      const undecided = converged >= UNDECIDED_LOW && converged < CONVERGED_THRESHOLD
      this.undecidedStreak = undecided ? this.undecidedStreak + 1 : 0
      const byConverged = converged >= CONVERGED_THRESHOLD
      const byCircling = this.circlingStreak >= CIRCLING_ROUNDS
      const scores = `jev converged ${converged.toFixed(2)} / circling ${circling.toFixed(2)}`
      let note = byConverged
        ? `${scores} -> wrap`
        : byCircling
          ? `jev circling ${this.circlingSeen
              .slice(-CIRCLING_ROUNDS)
              .map((c) => c.toFixed(2))
              .join('/')} -> wrap`
          : scores
      let verdict: 'continue' | 'converged' = byConverged || byCircling ? 'converged' : 'continue'
      // Jev sitting on the fence for three rounds: the model judge breaks the tie this once.
      if (verdict === 'continue' && this.undecidedStreak >= UNDECIDED_ROUNDS) {
        this.undecidedStreak = 0
        const tie = await this.judgeRound()
        if (!this.live) return 'continue'
        verdict = tie
        note = `${scores}, undecided ${UNDECIDED_ROUNDS} rounds -> model judge: ${tie}${this.room.judge ? ` (${this.room.judge.note})` : ''}`
      }
      this.room.judge = { verdict, note, at: this.now() }
      this.changed()
      return verdict
    } catch (e) {
      this.jevDown(e)
      return this.judgeRound()
    }
  }

  /** Jev, unless it is unavailable for this room. */
  private jev(): Jev | null {
    return this.jevFailed ? null : (this.deps.jev ?? null)
  }

  /** Jev failed once: this room stays on the model judge, and says so one time. */
  private jevDown(e: unknown): void {
    this.deps.log(`${this.room.id}: jev failed: ${errText(e)}`)
    if (this.jevFailed) return
    this.jevFailed = true
    if (this.live) this.append(ROOM_SYSTEM, 'Jev unavailable, using the model judge.')
  }

  private async judgeRound(): Promise<'continue' | 'converged'> {
    if (!this.judge) return 'continue'
    const elapsed = this.now() - this.room.startedAt
    try {
      const raw = await this.sendSerial(
        ROOM_JUDGE,
        this.judge,
        judgePrompt(this.room, elapsed),
        this.judgeMs,
      )
      const v = parseVerdict(raw)
      this.room.judge = { ...v, at: this.now() }
      this.changed()
      return v.verdict
    } catch (e) {
      this.deps.log(`${this.room.id}: judge turn failed: ${errText(e)}`)
      return 'continue'
    }
  }

  /** The pinned summary, by the PM when one is in the room, else the judge; then the record. */
  private async resolve(forced: boolean): Promise<void> {
    if (this.resolving || !roomIsLive(this.room.phase)) return
    this.resolving = true
    this.room.presence = {}
    this.changed()
    const prompt = summaryPrompt(this.room, forced, this.finalLines)
    const pm = this.pm()
    let author = ROOM_JUDGE
    let text: string | null = null
    const pmHandle = pm ? this.handles.get(pm.id) : undefined
    if (pm && pmHandle) {
      try {
        text = dedash((await this.sendSerial(pm.id, pmHandle, prompt, this.judgeMs)).trim())
        author = pm.id
      } catch (e) {
        this.deps.log(`${this.room.id}: PM summary failed: ${errText(e)}`)
      }
    }
    if (text === null && this.judge) {
      try {
        text = dedash((await this.sendSerial(ROOM_JUDGE, this.judge, prompt, this.judgeMs)).trim())
      } catch (e) {
        this.deps.log(`${this.room.id}: judge summary failed: ${errText(e)}`)
      }
    }
    if (text === null || text === '') {
      text = `**Decision**\nNo summary could be written; the thread above is the record.\n\n**Dissent**\nUnknown\n\n**Next steps**\n- Isaac: read the thread and decide`
    }
    const summary = this.append(author, text, 'summary')
    this.room.phase = 'resolved'
    this.room.resolvedAt = summary.ts
    this.changed()
    try {
      this.room.file = await this.deps.save(this.room)
    } catch (e) {
      this.append(ROOM_SYSTEM, `Could not save the room: ${errText(e)}`)
    }
    this.changed()
    await this.stopAll()
  }
}
