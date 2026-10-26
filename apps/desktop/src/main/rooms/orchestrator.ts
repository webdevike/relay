import {
  ROOM_ISAAC,
  ROOM_JUDGE,
  ROOM_SYSTEM,
  roomIsLive,
  type Room,
  type RoomAgent,
  type RoomMessage,
} from '@evaos/contract'
import {
  JUDGE_PROMPT,
  NUDGE_TEXT,
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
import type { AgentHandle, AgentRunner } from './runner'

export const SOFT_LIMIT_MS = 5 * 60_000
export const HARD_LIMIT_MS = 15 * 60_000
export const MAX_ROUNDS = 12

export interface RoomTimer {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface RoomSessionDeps {
  runner: AgentRunner
  judgeModel: string
  /** Writes the record once resolved; returns where it went. */
  save: (room: Room) => Promise<string>
  onChange: (room: Room) => void
  log: (line: string) => void
  now?: () => number
  timer?: RoomTimer
  softMs?: number
  hardMs?: number
  maxRounds?: number
}

const realTimer: RoomTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
}

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
  private hardTimer: unknown = null
  private readonly now: () => number
  private readonly timer: RoomTimer
  private readonly softMs: number
  private readonly hardMs: number
  private readonly maxRounds: number
  private loop: Promise<void> | null = null

  constructor(
    prompt: string,
    agents: readonly RoomAgent[],
    private readonly deps: RoomSessionDeps,
  ) {
    this.now = deps.now ?? Date.now
    this.timer = deps.timer ?? realTimer
    this.softMs = deps.softMs ?? SOFT_LIMIT_MS
    this.hardMs = deps.hardMs ?? HARD_LIMIT_MS
    this.maxRounds = deps.maxRounds ?? MAX_ROUNDS
    const now = this.now()
    const text = prompt.trim()
    this.room = {
      id: newRoomId(now),
      title: text.split('\n')[0] || 'Untitled room',
      prompt: text,
      agents: agents.map((a) => ({ ...a })),
      messages: [],
      typing: [],
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
        })
        h.onExit((reason) => this.markFailed(a.id, reason))
        this.handles.set(a.id, h)
      } catch (e) {
        this.markFailed(a.id, errText(e))
      }
    })
    const judge = (async () => {
      try {
        this.judge = await this.deps.runner.start({
          systemPrompt: JUDGE_PROMPT,
          model: this.deps.judgeModel,
        })
        this.judge.onExit((reason) => {
          this.judge = null
          this.deps.log(`${this.room.id}: judge died: ${reason}`)
        })
      } catch (e) {
        this.deps.log(`${this.room.id}: judge failed to start: ${errText(e)}`)
      }
    })()
    await Promise.all([...starts, judge])
    this.started = true
    if (this.liveAgents().length === 0) {
      if (roomIsLive(this.room.phase)) this.fail('No agent could start.')
      return
    }
    this.hardTimer = this.timer.set(() => void this.resolve(true), this.hardMs)
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

  /** Resolve now: the summary from what exists. */
  stop(): Promise<void> {
    return this.resolve(true)
  }

  /** The app is quitting: end every process; nothing is saved. */
  async destroy(): Promise<void> {
    this.resolving = true
    if (this.hardTimer !== null) this.timer.clear(this.hardTimer)
    await this.stopAll()
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
    }
    this.room.messages.push(msg)
    this.changed()
    return msg
  }

  private setTyping(id: string, on: boolean): void {
    const has = this.room.typing.includes(id)
    if (has === on) return
    this.room.typing = on ? [...this.room.typing, id] : this.room.typing.filter((t) => t !== id)
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
    this.room.typing = this.room.typing.filter((t) => t !== a.id)
    this.append(ROOM_SYSTEM, `${firstName(a.name)} dropped out of the room (${reason}).`)
    if (this.started && this.liveAgents().length === 0 && !this.resolving) {
      this.fail('Every agent dropped out.')
    }
  }

  private fail(error: string): void {
    this.resolving = true
    if (this.hardTimer !== null) this.timer.clear(this.hardTimer)
    this.room.phase = 'failed'
    this.room.error = error
    this.room.typing = []
    this.changed()
    void this.stopAll()
  }

  private async stopAll(): Promise<void> {
    const all = [...this.handles.values(), ...(this.judge ? [this.judge] : [])]
    this.handles.clear()
    this.judge = null
    await Promise.allSettled(all.map((h) => h.stop()))
  }

  /** One turn on one process, after whatever turn is already queued on it. */
  private sendSerial(
    key: string,
    handle: AgentHandle,
    text: string,
    onPartial?: (t: string) => void,
  ): Promise<string> {
    const prev = this.chains.get(key) ?? Promise.resolve()
    const next = prev.then(
      () => handle.send(text, onPartial),
      () => handle.send(text, onPartial),
    )
    this.chains.set(
      key,
      next.catch(() => undefined),
    )
    return next
  }

  private async run(): Promise<void> {
    let nudged = false
    while (this.live) {
      if (this.room.rounds >= this.maxRounds) {
        await this.resolve(true)
        return
      }
      const elapsed = this.now() - this.room.startedAt
      if (elapsed >= this.softMs && this.room.phase === 'open') {
        this.room.phase = 'wrapping'
        this.changed()
      }
      const before = this.msgSeq
      const anyNew = (): boolean => this.room.messages.some((m) => msgNum(m.id) > before)
      this.room.rounds += 1
      this.changed()
      await this.round()
      if (!this.live) return
      // Isaac's post lands mid-round: the next round answers him before the judge may speak.
      const awaitingIsaac = this.isaacUnseen()
      if (!awaitingIsaac && (this.room.rounds >= 2 || !anyNew())) {
        const v = await this.judgeRound()
        if (!this.live) return
        if (v === 'converged' && this.room.rounds >= 2) {
          await this.resolve(false)
          return
        }
      }
      // A reply or an Isaac post since the round began is the next delta; silence gets one nudge.
      if (anyNew()) {
        nudged = false
        continue
      }
      if (nudged) {
        await this.resolve(true)
        return
      }
      nudged = true
      this.append(this.pm()?.id ?? ROOM_JUDGE, NUDGE_TEXT)
    }
  }

  /** Some live agent has not yet been shown a message from Isaac. */
  private isaacUnseen(): boolean {
    return this.liveAgents().some((a) => {
      const seen = this.seen.get(a.id) ?? 0
      return this.room.messages.some((m) => m.author === ROOM_ISAAC && msgNum(m.id) > seen)
    })
  }

  private async round(): Promise<void> {
    const wrapping = this.room.phase === 'wrapping'
    const sends = this.liveAgents().map(async (a) => {
      const handle = this.handles.get(a.id)
      if (!handle) return
      const first = !this.seen.has(a.id)
      const from = this.seen.get(a.id) ?? 0
      const delta = this.room.messages.filter((m) => msgNum(m.id) > from)
      if (!first && !delta.some((m) => m.author !== a.id)) return
      // What others post during this turn has a higher number and is the next delta.
      this.seen.set(a.id, this.msgSeq)
      const prompt = first
        ? openingPrompt(this.room) +
          (wrapping ? '\n(wrapping up: state your final position in one line)' : '')
        : deltaPrompt(this.room, delta, wrapping)
      this.setTyping(a.id, true)
      try {
        const raw = await this.sendSerial(a.id, handle, prompt, (partial) => {
          const p = parseReply(partial)
          // A reply that starts like PASS stays hidden until the turn ends.
          if (p.text === '' || /^\**\s*pass/i.test(p.text)) return
          this.showDraft(a.id, trimReply(p.text))
        })
        if (!this.live) return
        const p = parseReply(raw)
        for (const r of p.reactions) this.toggleReaction(r.messageId, r.emoji, a.id)
        if (p.pass || p.text === '') this.dropDraft(a.id)
        else this.showDraft(a.id, p.text)
      } catch (e) {
        this.dropDraft(a.id)
        this.deps.log(`${this.room.id}: ${a.name} turn failed: ${errText(e)}`)
      } finally {
        this.drafts.delete(a.id)
        if (this.live) this.setTyping(a.id, false)
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
      this.changed()
      return
    }
    this.drafts.set(agentId, this.append(agentId, text))
    this.setTyping(agentId, false)
  }

  private dropDraft(agentId: string): void {
    const draft = this.drafts.get(agentId)
    if (!draft) return
    this.drafts.delete(agentId)
    this.room.messages = this.room.messages.filter((m) => m !== draft)
    this.changed()
  }

  private async judgeRound(): Promise<'continue' | 'converged'> {
    if (!this.judge) return 'continue'
    const elapsed = this.now() - this.room.startedAt
    try {
      const raw = await this.sendSerial(
        ROOM_JUDGE,
        this.judge,
        judgePrompt(this.room, elapsed, elapsed >= this.softMs),
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
    if (this.hardTimer !== null) this.timer.clear(this.hardTimer)
    this.room.typing = []
    this.changed()
    const prompt = summaryPrompt(this.room, forced)
    const pm = this.pm()
    let author = ROOM_JUDGE
    let text: string | null = null
    const pmHandle = pm ? this.handles.get(pm.id) : undefined
    if (pm && pmHandle) {
      try {
        text = dedash((await this.sendSerial(pm.id, pmHandle, prompt)).trim())
        author = pm.id
      } catch (e) {
        this.deps.log(`${this.room.id}: PM summary failed: ${errText(e)}`)
      }
    }
    if (text === null && this.judge) {
      try {
        text = dedash((await this.sendSerial(ROOM_JUDGE, this.judge, prompt)).trim())
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
