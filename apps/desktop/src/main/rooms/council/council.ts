// A council room (effort dial): seats cast from a notch work one deliverable in parallel
// worktrees against a contract, an integrator merges, critics and a judge score, until the
// scores converge, plateau, hit the round cap or Isaac resolves. Spec: Eva
// work/relay-rooms-council/SPEC.md (Splitting the work, Routing, Notches, Roles, Protocol).
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  COUNCIL_DEFAULT_ROUTING,
  COUNCIL_IMAGE_USD,
  COUNCIL_MAX_EFFORT,
  COUNCIL_MODELS,
  COUNCIL_PARTS_4,
  COUNCIL_PAUSE_AT,
  COUNCIL_PEOPLE,
  COUNCIL_PLATEAU,
  COUNCIL_ROLE_LABEL,
  COUNCIL_SUBPARTS,
  COUNCIL_TARGET_SCORE,
  COUNCIL_WHOLE,
  councilCast,
  councilLabel,
  councilMoney,
  councilOwnerPart,
  councilSeatLine,
  councilUsageCost,
  type CouncilRole,
  type CouncilRouting,
  type CouncilSeat,
} from '@relay/protocol'
import {
  MENTION_EVERYONE,
  ROOM_ISAAC,
  ROOM_SYSTEM,
  mentionsIn,
  roomIsLive,
  type Room,
  type RoomAgent,
  type RoomCard,
  type RoomCouncilInput,
  type RoomMessage,
  type RoomRender,
  type RubricCriterion,
} from '@evaos/contract'
import { newRoomId } from '../orchestrator'
import { firstName, transcriptLines } from '../prompts'
import {
  ROLE_JOB,
  answerPrompt,
  buildPrompt,
  contractPrompt,
  critiquePrompt,
  feedText,
  finalPrompt,
  integratePrompt,
  isDissent,
  lookPrompt,
  objectPrompt,
  paintoverPrompt,
  parseBounces,
  parseFindings,
  parseRubric,
  parseScorecard,
  planPrompt,
  researchPrompt,
  rubricPrompt,
  scorePrompt,
  seatSystemPrompt,
  withoutBounces,
} from './council-prompts'
import { RoutingLog, turnKind, type TurnPurpose } from './routing-log'
import type { SeatHandle, SeatLauncher, SeatPresence, SeatTurnResult } from './seat'
import { MAIN_BRANCH, RoomWorkdir, seatBranch, type Exec } from './workdir'

export interface CouncilDeps {
  launcher: SeatLauncher
  evaRoot: string
  /** `memory/rooms/<stem>` (relative, no extension) for this room: record and routing log share it. */
  stem: (room: Room) => string
  /** Writes the record to `<stem>.md` and the journal line; resolves with the record's absolute path. */
  save: (room: Room, stem: string) => Promise<string>
  /** Writes `<stem>.routing.jsonl` (relative path) whole. */
  writeRouting: (rel: string, content: string) => Promise<void>
  onChange: (room: Room) => void
  log: (line: string) => void
  now?: () => number
  /** Where seats' outward-action asks land: `<asksRoot>/<room id>/asks` (default the OS temp dir). */
  asksRoot?: string
  /** How often the asks folder is read. */
  pollMs?: number
  exec?: Exec
}

/** Images attached to one turn, at most; the newest renders first, then the references. */
const MAX_IMAGES = 6
const ASK_POLL_MS = 1000
const ASK_ID_RE = /^[A-Za-z0-9._-]{1,64}$/
const CONTRACT_FILE = 'contract.md'

interface Seat {
  agent: RoomAgent
  handle: SeatHandle | null
  tree: string
  /** The highest message number this seat has been shown. */
  seen: number
}

interface TurnOut {
  text: string
  renders: RoomRender[]
  files: string[]
}

type Choice = 'continue' | 'wrap'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const msgNum = (id: string): number => Number(id.slice(1))
const coded = (message: string, code: string): Error => Object.assign(new Error(message), { code })
const paths = (rs: readonly RoomRender[]): string[] => rs.map((r) => r.path)
const round1 = (n: number): number => Math.round(n * 10) / 10

/** Whether a seat on part `held` covers `part` at a finer split ("Whole" covers "Head + hands", which covers "Head"). */
function partCovers(held: string, part: string): boolean {
  const subs = (p: string): string[] => COUNCIL_SUBPARTS[p] ?? []
  if (held === part || subs(held).includes(part)) return true
  return subs(part).length > 0 && subs(part).every((x) => subs(held).includes(x))
}

export class CouncilSession {
  readonly room: Room
  private readonly seats = new Map<string, Seat>()
  private readonly routing: RoutingLog
  private readonly now: () => number
  private readonly overrides: Partial<CouncilRouting>
  private readonly asksDir: string
  private wd: RoomWorkdir | null = null
  private stem = ''
  private msgSeq = 0
  private loop: Promise<void> | null = null
  private resolving = false
  private destroyed = false
  private stopRequested = false
  private delivering = false
  private readonly aborts = new Set<AbortController>()
  private readonly drafts = new Map<string, RoomMessage>()
  /** Post-turn git work (commit, diff, render copies) runs one at a time across seats. */
  private gitChain: Promise<unknown> = Promise.resolve()
  private pause: { card: RoomCard & { type: 'pause' }; resolve: (c: Choice) => void } | null = null
  private raisePending = false
  /** Isaac's posts up to this message number have been answered. */
  private isaacSeen = 0
  private askTimer: NodeJS.Timeout | null = null
  private readonly askCards = new Map<string, RoomMessage>()
  private capNoted = false
  /** The latest full render, the source's renders, part renders by part (and by branch). */
  private full: RoomRender[] = []
  private before: RoomRender[] = []
  private readonly partRenders = new Map<string, RoomRender[]>()
  private paintover: RoomRender[] = []
  /** Findings and judge fixes routed to each part for the next round; bounces from the integrator. */
  private fixes: Record<string, string[]> = {}
  private bounces: Record<string, string> = {}
  private plateauStreak = 0
  private finals: { id: string; text: string }[] = []

  constructor(
    prompt: string,
    private readonly input: RoomCouncilInput,
    private readonly deps: CouncilDeps,
  ) {
    this.now = deps.now ?? Date.now
    const now = this.now()
    const text = prompt.trim()
    const id = newRoomId(now)
    this.overrides = input.routing ?? {}
    const cast = councilCast(input.effort, this.overrides)
    this.asksDir = path.join(deps.asksRoot ?? path.join(os.tmpdir(), 'relay-rooms'), id, 'asks')
    const workdir = path.join(deps.evaRoot, 'work', 'rooms', id)
    this.room = {
      id,
      title: text.split('\n')[0] || 'Untitled room',
      prompt: text,
      agents: cast.seats.map((s) => this.agentFor(s, s.id, s.name)),
      messages: [],
      presence: {},
      phase: 'open',
      rounds: 0,
      startedAt: now,
      council: {
        effort: cast.effort,
        routing: { ...COUNCIL_DEFAULT_ROUTING, ...this.overrides },
        parts: cast.parts,
        stage: 'brief',
        round: 0,
        maxRounds: cast.notch.rounds,
        workdir,
        source: path.resolve(deps.evaRoot, input.source),
        refs: input.refs.map((r) => path.resolve(deps.evaRoot, r)),
        renderCmd: input.renderCmd ?? '',
        rubric: input.rubric ?? [],
        scores: [],
        spend: { usd: 0, estimate: cast.cost, cap: cast.cap, byAgent: {} },
        minutesEstimate: cast.minutes,
      },
    }
    this.routing = new RoutingLog(
      (content) => this.deps.writeRouting(`${this.stem}.routing.jsonl`, content),
      (line) => this.deps.log(`${this.room.id}: ${line}`),
    )
  }

  private get c(): NonNullable<Room['council']> {
    return this.room.council!
  }

  get live(): boolean {
    return roomIsLive(this.room.phase) && !this.resolving
  }

  /** Turns stop starting once Isaac resolves (except the final positions) or the app quits. */
  private get halted(): boolean {
    return this.destroyed || (this.stopRequested && !this.delivering)
  }

  private agentFor(s: CouncilSeat, id: string, name: string, joinedRound?: number): RoomAgent {
    const person = COUNCIL_PEOPLE[s.role].find((p) => p.name === name)
    return {
      id,
      name,
      title: person?.title ?? s.title,
      role: COUNCIL_ROLE_LABEL[s.role],
      brief: ROLE_JOB[s.role],
      model: COUNCIL_MODELS[s.model].omp,
      tools: 'full',
      color: person?.color ?? s.color,
      seat: {
        role: s.role,
        modelKey: s.model,
        harness: s.harness,
        thinking: s.thinking,
        ...(s.part ? { part: s.part } : {}),
        ...(s.branch ? { branch: s.branch } : {}),
        override: s.override,
        ...(joinedRound !== undefined ? { joinedRound } : {}),
      },
    }
  }

  private changed(): void {
    this.deps.onChange(this.room)
  }

  /** Copies the source into the workdir, opens every seat, then runs the room. */
  async start(): Promise<void> {
    try {
      this.wd = await RoomWorkdir.create({
        evaRoot: this.deps.evaRoot,
        roomId: this.room.id,
        source: this.input.source,
        refs: this.input.refs,
        ...(this.deps.exec ? { exec: this.deps.exec } : {}),
      })
      this.c.refs = this.wd.refs
      this.before = await this.wd.keepRenders({
        tree: this.wd.main,
        since: 0,
        extra: [],
        round: 'r0',
        seatId: 'source',
        caption: 'Before',
      })
      this.full = this.before
      this.stem = this.deps.stem(this.room)
      this.c.routingFile = path.join(this.deps.evaRoot, `${this.stem}.routing.jsonl`)
      fs.mkdirSync(this.asksDir, { recursive: true })
    } catch (e) {
      this.fail(`Could not set up the room workdir: ${errText(e)}`)
      return
    }
    await Promise.all(this.room.agents.map((a) => this.open(a)))
    if (this.destroyed) return
    if (this.liveSeats().length === 0) {
      this.fail('No seat could start.')
      return
    }
    this.askTimer = setInterval(() => this.readAsks(), this.deps.pollMs ?? ASK_POLL_MS)
    this.askTimer.unref()
    this.loop = this.run().catch((e) => this.fail(errText(e)))
  }

  /** The integrator works in main/; with no integrator nobody does (the room merges builders). */
  private async treeFor(a: RoomAgent): Promise<string> {
    const wd = this.wd!
    return a.seat?.role === 'integrator' ? wd.main : wd.addSeat(a.id)
  }

  private async open(a: RoomAgent): Promise<void> {
    const wd = this.wd!
    let tree: string
    try {
      tree = await this.treeFor(a)
    } catch (e) {
      this.markFailed(a.id, `no worktree: ${errText(e)}`)
      return
    }
    if (a.seat) a.seat.worktree = tree
    const seat: Seat = { agent: a, handle: null, tree, seen: 0 }
    this.seats.set(a.id, seat)
    const s = a.seat!
    const spend = this.c.spend
    const live = Math.max(1, this.room.agents.filter((x) => !x.failed).length)
    try {
      const h = await this.deps.launcher.start({
        roomId: this.room.id,
        seatId: a.id,
        harness: s.harness,
        model: s.modelKey,
        thinking: s.thinking,
        systemPrompt: seatSystemPrompt({
          agent: a,
          seat: s,
          agents: this.room.agents,
          prompt: this.room.prompt,
          tree,
          workdir: wd.root,
          mainDir: wd.main,
          contractPath: path.join(wd.main, CONTRACT_FILE),
          renderCmd: this.c.renderCmd,
          parts: this.c.parts,
          refs: wd.refs,
        }),
        cwd: tree,
        readDirs: [wd.root, ...wd.refs],
        workdir: wd.root,
        asksDir: this.asksDir,
        ...(s.harness === 'claude-code'
          ? { budgetUsd: Math.max(0.01, (spend.cap - spend.usd) / live) }
          : {}),
      })
      if (this.destroyed) {
        await h.stop().catch(() => undefined)
        return
      }
      seat.handle = h
      if (h.harness !== s.harness) {
        s.harness = h.harness
        this.append(
          ROOM_SYSTEM,
          `${firstName(a.name)} runs in omp instead${h.fallback ? `: ${h.fallback}` : '.'}`,
        )
      }
      h.onExit((err) => this.markFailed(a.id, err ? errText(err) : 'the process ended'))
    } catch (e) {
      this.markFailed(a.id, errText(e))
    }
  }

  private liveSeats(): Seat[] {
    return [...this.seats.values()].filter((s) => s.handle && !s.agent.failed)
  }

  private seatsIn(role: CouncilRole, opts: { part?: string; demoted?: boolean } = {}): Seat[] {
    return this.liveSeats().filter(
      (s) =>
        s.agent.seat?.role === role &&
        (opts.part === undefined || s.agent.seat.part === opts.part) &&
        (opts.demoted === undefined || Boolean(s.agent.seat.demoted) === opts.demoted),
    )
  }

  private markFailed(id: string, reason: string): void {
    const a = this.room.agents.find((x) => x.id === id)
    if (!a || a.failed) return
    a.failed = true
    const seat = this.seats.get(id)
    if (seat) seat.handle = null
    this.deps.log(`${this.room.id}: ${a.name} dropped: ${reason}`)
    if (!this.live) return
    delete this.room.presence[id]
    this.append(ROOM_SYSTEM, `${firstName(a.name)} dropped out of the room (${reason}).`)
  }

  private fail(error: string): void {
    if (!roomIsLive(this.room.phase)) return
    this.resolving = true
    this.room.phase = 'failed'
    this.room.error = error
    this.room.presence = {}
    this.changed()
    void this.stopAll()
  }

  private async stopAll(): Promise<void> {
    clearInterval(this.askTimer ?? undefined)
    this.askTimer = null
    for (const ac of this.aborts) ac.abort()
    const hs = [...this.seats.values()]
      .map((s) => s.handle)
      .filter((h): h is SeatHandle => h !== null)
    for (const s of this.seats.values()) s.handle = null
    await Promise.allSettled(hs.map((h) => h.stop()))
  }

  // ---- Isaac's side ---------------------------------------------------------------------------

  post(text: string): void {
    if (!this.live) throw new Error('The room is closed.')
    this.append(ROOM_ISAAC, text.trim())
  }

  react(messageId: string, emoji: string): void {
    const m = this.room.messages.find((x) => x.id === messageId)
    if (!m) return
    const r = m.reactions.find((x) => x.emoji === emoji)
    if (!r) m.reactions.push({ emoji, by: [ROOM_ISAAC] })
    else if (r.by.includes(ROOM_ISAAC)) {
      r.by = r.by.filter((b) => b !== ROOM_ISAAC)
      if (r.by.length === 0) m.reactions = m.reactions.filter((x) => x !== r)
    } else r.by.push(ROOM_ISAAC)
    this.changed()
  }

  /** Resolve now: running turns end, then the final positions and the deliverable. */
  async stop(): Promise<void> {
    if (!this.live) return
    this.stopRequested = true
    if (!this.delivering) for (const ac of this.aborts) ac.abort()
    this.answerPause('wrap')
    await this.settled()
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    this.resolving = true
    this.answerPause('wrap')
    await this.stopAll()
  }

  settled(): Promise<void> {
    return this.loop ?? Promise.resolve()
  }

  /** One notch up; the new seats join at the next round boundary. */
  raise(): number {
    if (!this.live || this.delivering) throw new Error('The room is closed.')
    if (this.c.effort >= COUNCIL_MAX_EFFORT)
      throw coded('The room is already at Max.', 'max-effort')
    this.c.effort += 1
    this.raisePending = true
    this.append(
      ROOM_SYSTEM,
      `Raised to ${councilLabel(this.c.effort)}. New people join at the start of the next round with the whole thread.`,
    )
    return this.c.effort
  }

  /** The answer to the cap pause; resolves with the cap in force after it. */
  budget(choice: Choice): number {
    this.answerPause(choice)
    return this.c.spend.cap
  }

  private answerPause(choice: Choice): void {
    const p = this.pause
    if (!p) return
    this.pause = null
    p.card.answered = choice
    if (choice === 'continue') this.c.spend.cap = p.card.nextCap
    this.c.paused = false
    this.changed()
    p.resolve(choice)
  }

  /** Isaac's allow / deny on a seat's outward action: the guard reads the answer file. */
  answer(askId: string, allow: boolean): void {
    const m = this.askCards.get(askId)
    if (!m || m.card?.type !== 'ask' || !ASK_ID_RE.test(askId))
      throw coded(`No ask ${askId}`, 'bad-input')
    if (m.card.answered) return
    // The asks folder is in the OS temp dir, outside the Eva root's write trap.
    fs.writeFileSync(path.join(this.asksDir, `${askId}.answer`), allow ? 'allow' : 'deny')
    m.card.answered = allow ? 'allow' : 'deny'
    this.changed()
  }

  private readAsks(): void {
    let files: string[]
    try {
      files = fs.readdirSync(this.asksDir)
    } catch {
      return
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const id = f.slice(0, -5)
      if (this.askCards.has(id) || !ASK_ID_RE.test(id)) continue
      let ask: { seatId?: unknown; action?: unknown }
      try {
        ask = JSON.parse(fs.readFileSync(path.join(this.asksDir, f), 'utf8')) as typeof ask
      } catch {
        continue // half written: next poll
      }
      const seatId = typeof ask.seatId === 'string' ? ask.seatId : 'unknown'
      const action = typeof ask.action === 'string' ? ask.action : 'an outward action'
      const who = this.room.agents.find((a) => a.id === seatId)
      const msg = this.append(
        ROOM_SYSTEM,
        `${who ? firstName(who.name) : seatId} wants to run: ${action}`,
        { kind: 'card', card: { type: 'ask', askId: id, agentId: seatId, action } },
      )
      this.askCards.set(id, msg)
    }
  }

  // ---- feed -----------------------------------------------------------------------------------

  private append(
    author: string,
    text: string,
    extra: Partial<Pick<RoomMessage, 'kind' | 'card' | 'renders' | 'part'>> = {},
  ): RoomMessage {
    const msg: RoomMessage = {
      id: `m${++this.msgSeq}`,
      author,
      text,
      ts: this.now(),
      reactions: [],
      kind: extra.kind ?? 'message',
      mentions: mentionsIn(text, this.room.agents),
      ...(extra.card ? { card: extra.card } : {}),
      ...(extra.renders && extra.renders.length > 0 ? { renders: extra.renders } : {}),
      ...(extra.part ? { part: extra.part } : {}),
    }
    this.room.messages.push(msg)
    this.changed()
    return msg
  }

  private setPresence(id: string, p: SeatPresence | null): void {
    if (p === null) {
      if (!this.room.presence[id]) return
      delete this.room.presence[id]
    } else {
      const cur = this.room.presence[id]
      if (cur && cur.state === p.state && cur.detail === p.detail) return
      this.room.presence[id] = { ...p, since: this.now() }
    }
    this.changed()
  }

  /** The reply so far, as its own message from the first chunk on. */
  private showDraft(id: string, text: string): void {
    if (text === '' || !this.live) return
    const d = this.drafts.get(id)
    if (d) {
      d.text = text
      this.changed()
    } else this.drafts.set(id, this.append(id, text))
  }

  private dropDraft(id: string): void {
    const d = this.drafts.get(id)
    if (!d) return
    this.drafts.delete(id)
    this.room.messages = this.room.messages.filter((m) => m !== d)
    this.changed()
  }

  // ---- one turn -------------------------------------------------------------------------------

  /**
   * One seat's turn: the feed it has not seen plus `task`, then the commit of its tree, the
   * renders it made, its spend and its routing entry. Null when it could not run (cap reached,
   * seat gone, room halted, turn failed).
   */
  private async turn(
    id: string,
    purpose: TurnPurpose,
    task: string,
    o: { images?: string[]; post?: boolean } = {},
  ): Promise<TurnOut | null> {
    const seat = this.seats.get(id)
    const wd = this.wd!
    const s = seat?.agent.seat
    if (!seat || !seat.handle || !s || seat.agent.failed || this.halted) return null
    const spend = this.c.spend
    if (spend.usd >= spend.cap) {
      if (!this.capNoted) {
        this.capNoted = true
        this.append(
          ROOM_SYSTEM,
          `Spend reached the ${councilMoney(spend.cap)} cap; no more turns start.`,
        )
      }
      return null
    }
    const post = o.post ?? true
    const delta = this.room.messages.filter(
      (m) => msgNum(m.id) > seat.seen && m.author !== id && m.kind !== 'summary',
    )
    seat.seen = this.msgSeq
    const feed =
      delta.length > 0 ? `New in the room:\n${transcriptLines(this.room, delta)}\n\n` : ''
    const since = this.now()
    // A read of this seat's own tree: no need to queue behind other seats' commits.
    const head0 = await wd.head(seat.tree)
    const ac = new AbortController()
    this.aborts.add(ac)
    this.setPresence(id, { state: 'thinking' })
    let r: SeatTurnResult
    try {
      r = await seat.handle.turn({
        prompt: feed + task,
        images: [...new Set(o.images ?? [])].slice(0, MAX_IMAGES),
        signal: ac.signal,
        onPresence: (p) => {
          if (this.live) this.setPresence(id, p)
        },
        ...(post
          ? { onPartial: (t: string) => this.showDraft(id, feedText(withoutBounces(t))) }
          : {}),
      })
    } catch (e) {
      this.dropDraft(id)
      this.deps.log(`${this.room.id}: ${seat.agent.name} turn failed: ${errText(e)}`)
      if (this.live && !ac.signal.aborted) {
        this.append(ROOM_SYSTEM, `${firstName(seat.agent.name)}'s turn failed (${errText(e)}).`)
      }
      return null
    } finally {
      this.aborts.delete(ac)
      this.setPresence(id, null)
    }
    const usd = councilUsageCost(s.modelKey, r.usage) + r.images.length * COUNCIL_IMAGE_USD
    spend.usd += usd
    spend.byAgent[id] = (spend.byAgent[id] ?? 0) + usd
    const round = this.c.round
    const { files, renders } = await this.git(async () => {
      const head1 = await wd.commit(
        seat.tree,
        `${firstName(seat.agent.name)}: round ${round} ${purpose}`,
      )
      return {
        files: head1 === head0 ? [] : await wd.changed(seat.tree, head0),
        renders: await wd.keepRenders({
          tree: seat.tree,
          since,
          extra: r.images,
          round: `r${round}`,
          seatId: id,
          caption: firstName(seat.agent.name),
        }),
      }
    })
    const text = feedText(withoutBounces(r.text))
    const draft = this.drafts.get(id)
    this.drafts.delete(id)
    if (post && text !== '') {
      if (draft) {
        draft.text = text
        draft.mentions = mentionsIn(text, this.room.agents)
        if (renders.length > 0) draft.renders = renders
        if (s.part) draft.part = s.part
        this.changed()
      } else this.append(id, text, { renders, ...(s.part ? { part: s.part } : {}) })
    } else if (draft) this.dropDraft(id)
    else this.changed()
    await this.routing.add({
      round,
      seat: id,
      model: s.modelKey,
      harness: s.harness,
      role: s.role,
      ...(s.part ? { part: s.part } : {}),
      kind: turnKind(s, purpose, { images: r.images.length, files }),
      files,
      tokens: r.usage,
      usd,
      ms: r.ms,
    })
    return { text: r.text, renders, files }
  }

  private git<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.gitChain.then(fn, fn)
    this.gitChain = next.catch(() => undefined)
    return next
  }

  // ---- the run --------------------------------------------------------------------------------

  /**
   * Before a phase: answer Isaac, pause at 80 % of the cap until he picks. False when the room
   * should go straight to delivering.
   */
  private async gate(stage: NonNullable<Room['council']>['stage']): Promise<boolean> {
    if (this.halted || this.stopRequested) return false
    await this.answerIsaac()
    const spend = this.c.spend
    if (spend.usd >= COUNCIL_PAUSE_AT * spend.cap) {
      const card = {
        type: 'pause' as const,
        spent: spend.usd,
        cap: spend.cap,
        nextCap: spend.cap + spend.estimate,
      }
      const { promise, resolve } = Promise.withResolvers<Choice>()
      this.pause = { card, resolve }
      this.c.paused = true
      this.append(
        ROOM_SYSTEM,
        `Over budget soon: ${councilMoney(spend.usd)} of the ${councilMoney(spend.cap)} cap spent. Continue to ${councilMoney(card.nextCap)} or wrap now?`,
        { kind: 'card', card },
      )
      if ((await promise) === 'wrap') return false
    }
    if (this.halted || this.stopRequested) return false
    this.c.stage = stage
    this.changed()
    return true
  }

  private async run(): Promise<void> {
    await this.brief()
    const split = this.c.parts.length > 1
    if (await this.gate(split ? 'contract' : 'plan')) {
      if (split) await this.contract(1)
      else await this.plan()
    }
    for (let round = 1; round <= this.c.maxRounds; round++) {
      if (!(await this.gate('build'))) break
      this.c.round = round
      this.room.rounds = round
      this.changed()
      if (this.raisePending) await this.applyRaise()
      const end = await this.round(round)
      if (end) break
    }
    await this.deliver()
  }

  private scorer(): Seat | undefined {
    return this.seatsIn('judge')[0] ?? this.seatsIn('director')[0] ?? this.seatsIn('builder')[0]
  }

  private integrator(): Seat | undefined {
    return this.seatsIn('integrator')[0]
  }

  private async brief(): Promise<void> {
    const overridden = (Object.keys(this.overrides) as CouncilRole[]).filter(
      (r) => this.overrides[r] !== undefined && this.overrides[r] !== COUNCIL_DEFAULT_ROUTING[r],
    )
    const routing =
      overridden.length === 0
        ? 'Routing: default (code, params and merges to Anthropic; images, look, critique and scoring to OpenAI).'
        : `Routing overrides: ${overridden.map((r) => `${COUNCIL_ROLE_LABEL[r]} to ${this.c.routing[r] === 'anthropic' ? 'Anthropic' : 'OpenAI'}`).join(', ')}.`
    const seats = this.room.agents
      .map((a) => {
        const s = a.seat!
        return `- ${a.name}: ${COUNCIL_ROLE_LABEL[s.role]}${s.part ? `, ${s.part}${s.branch ? ` ${s.branch}` : ''}` : ''} (${councilSeatLine({ model: s.modelKey, harness: s.harness })}, ${s.thinking})${a.failed ? ', could not start' : ''}`
      })
      .join('\n')
    this.append(
      ROOM_SYSTEM,
      `${councilLabel(this.c.effort)}: ${this.c.parts.join(', ')}, up to ${this.c.maxRounds} rounds, cap ${councilMoney(this.c.spend.cap)}.\n${routing}\n${seats}\nWorkdir: ${this.wd!.root}`,
    )
    if (this.c.rubric.length > 0) return
    const owners = [...new Set<string>([...COUNCIL_PARTS_4, ...this.c.parts, 'Integrator', 'Look'])]
    const judge = this.scorer()
    let rubric: RubricCriterion[] | null = null
    if (judge) {
      const out = await this.turn(
        judge.agent.id,
        'rubric',
        rubricPrompt(this.c.parts, this.c.refs),
        {
          images: this.c.refs,
          post: false,
        },
      )
      rubric = out ? parseRubric(out.text, owners) : null
    }
    this.c.rubric = rubric ?? [
      ...this.c.parts.map((p, i) => ({
        id: `c${i + 1}`,
        name: `${p} matches the references`,
        owner: p,
      })),
      {
        id: `c${this.c.parts.length + 1}`,
        name: 'silhouette, proportions and staging',
        owner: 'Integrator',
      },
      { id: `c${this.c.parts.length + 2}`, name: 'shading and line weight', owner: 'Look' },
    ]
    this.append(
      judge?.agent.id ?? ROOM_SYSTEM,
      `Rubric${rubric ? '' : ' (default, the drafted one was unreadable)'}:\n${this.c.rubric.map((c) => `- ${c.name} [${councilOwnerPart(c.owner, this.c.parts)}]`).join('\n')}`,
    )
  }

  private assignments(): string {
    return this.liveSeats()
      .filter(
        (s) =>
          s.agent.seat?.part && (s.agent.seat.role === 'builder' || s.agent.seat.role === 'look'),
      )
      .map(
        (s) =>
          `- ${s.agent.seat!.part}: ${s.agent.name} (${COUNCIL_ROLE_LABEL[s.agent.seat!.role]}${s.agent.seat!.branch ? ` ${s.agent.seat!.branch}` : ''}, ${seatBranch(s.agent.id)})`,
      )
      .join('\n')
  }

  /** Contract (v1 at the start, v2+ after a re-split): integrator, then one paintover, then objections. */
  private async contract(version: number): Promise<void> {
    const wd = this.wd!
    const integ = this.integrator()
    const contractPath = path.join(wd.main, CONTRACT_FILE)
    if (integ) {
      const out = await this.turn(
        integ.agent.id,
        'contract',
        contractPrompt({
          version,
          parts: this.c.parts,
          assignments: this.assignments(),
          contractPath,
        }),
        { images: [...paths(this.full), ...this.c.refs] },
      )
      if (out) {
        const fullNow = out.renders
        if (fullNow.length > 0) this.full = fullNow
        let text = ''
        try {
          text = fs.readFileSync(contractPath, 'utf8')
        } catch {
          text = feedText(out.text)
        }
        this.c.contract = { path: contractPath, version }
        this.append(integ.agent.id, `Contract v${version}`, {
          kind: 'card',
          card: { type: 'contract', version, path: contractPath, text: text.slice(0, 8000) },
        })
        await this.syncSeats()
        const others = this.liveSeats().filter(
          (s) => s !== integ && s.agent.seat?.role !== 'director' && !s.agent.seat?.demoted,
        )
        const director = version === 1 ? this.seatsIn('director')[0] : undefined
        await Promise.all([
          director
            ? this.turn(director.agent.id, 'paintover', paintoverPrompt(this.c.parts), {
                images: [...paths(this.full), ...this.c.refs],
              }).then((o) => {
                if (o && o.renders.length > 0) this.paintover = o.renders
              })
            : undefined,
          ...others.map((s) => this.turn(s.agent.id, 'object', objectPrompt(text))),
        ])
      }
    }
  }

  private async plan(): Promise<void> {
    await Promise.all(
      this.liveSeats().map((s) =>
        this.turn(s.agent.id, 'plan', planPrompt(), { images: this.c.refs }),
      ),
    )
  }

  /** Builder seats now building (losing branches excluded), in part order then branch. */
  private builders(): Seat[] {
    const rank = (s: Seat): string =>
      `${String(this.c.parts.indexOf(s.agent.seat?.part ?? '')).padStart(2, '0')}${s.agent.seat?.branch ?? ''}`
    return this.seatsIn('builder', { demoted: false }).sort((a, b) =>
      rank(a).localeCompare(rank(b)),
    )
  }

  private branched(): string[] {
    return [
      ...new Set(
        this.builders()
          .filter((s) => s.agent.seat?.branch === 'B')
          .map((s) => s.agent.seat!.part!),
      ),
    ]
  }

  /** One round. Resolves true when the room should deliver. */
  private async round(round: number): Promise<boolean> {
    const wd = this.wd!
    const split = this.c.parts.length > 1
    const fixes = this.fixes
    const bounces = this.bounces
    this.fixes = {}
    this.bounces = {}
    const builders = this.builders()
    const built = new Map<string, TurnOut | null>()
    await Promise.all(
      builders.map(async (b) => {
        const part = b.agent.seat!.part ?? COUNCIL_WHOLE
        const branch = b.agent.seat!.branch
        const out = await this.turn(
          b.agent.id,
          'build',
          buildPrompt({
            part,
            round,
            renderCmd: this.c.renderCmd,
            split,
            fixes: fixes[part] ?? [],
            ...(bounces[part] ? { bounce: bounces[part] } : {}),
            ...(branch
              ? {
                  branchNote: `You are branch ${branch}; another builder builds ${part} too and the judge keeps one after round 2.`,
                }
              : {}),
          }),
          {
            images: [
              ...paths(this.partRenders.get(part) ?? []),
              ...paths(this.paintover),
              ...this.c.refs,
            ],
          },
        )
        built.set(b.agent.id, out)
        if (out && out.renders.length > 0) {
          // Branch renders are kept apart for the pick; branch A stands for the part until then.
          if (branch) this.partRenders.set(`${part}#${branch}`, out.renders)
          if (branch !== 'B') this.partRenders.set(part, out.renders)
        }
      }),
    )
    if (this.halted) return true
    const looks = this.seatsIn('look')
    if (looks.length > 0) {
      if (!(await this.gate('look'))) return true
      await Promise.all(
        looks.map(async (l) => {
          const part = l.agent.seat!.part ?? COUNCIL_WHOLE
          await this.syncFrom(
            l,
            builders.filter((b) => b.agent.seat?.part === part && b.agent.seat.branch !== 'B'),
          )
          const out = await this.turn(
            l.agent.id,
            'look',
            lookPrompt({ part, round, renderCmd: this.c.renderCmd, fixes: fixes[part] ?? [] }),
            {
              images: [
                ...paths(this.partRenders.get(part) ?? []),
                ...paths(this.paintover),
                ...this.c.refs,
              ],
            },
          )
          if (out && out.renders.length > 0) this.partRenders.set(part, out.renders)
        }),
      )
    }
    if (!(await this.gate('integrate'))) return true
    // The branches main takes this round: every builder (branch A until the judge picks), then the look seats.
    const merging = [
      ...builders.filter((b) => b.agent.seat?.branch !== 'B' && built.get(b.agent.id)),
      ...looks,
    ]
    const integ = this.integrator()
    let bounced: Record<string, string> = {}
    if (integ) {
      const out = await this.turn(
        integ.agent.id,
        'integrate',
        integratePrompt({
          round,
          branches: merging.map((s) => ({
            branch: seatBranch(s.agent.id),
            who: firstName(s.agent.name),
            part: s.agent.seat!.part ?? COUNCIL_WHOLE,
          })),
          renderCmd: this.c.renderCmd,
          contractPath: path.join(wd.main, CONTRACT_FILE),
        }),
        {
          images: [
            ...merging.flatMap((s) => paths(this.partRenders.get(s.agent.seat!.part ?? '') ?? [])),
            ...this.c.refs,
          ],
        },
      )
      if (out) {
        bounced = parseBounces(out.text, this.c.parts)
        if (out.renders.length > 0) this.full = out.renders
      }
    } else {
      // No integrator (Solo, Pair, or it dropped): the room merges the builders' branches itself.
      for (const s of merging) {
        const ok = await this.git(() =>
          wd.git(wd.main, ['merge', '-q', '--no-edit', seatBranch(s.agent.id)]).then(
            () => true,
            async () => {
              await wd.git(wd.main, ['merge', '--abort']).catch(() => undefined)
              return false
            },
          ),
        )
        if (!ok) bounced[s.agent.seat!.part ?? COUNCIL_WHOLE] = 'did not merge cleanly into main'
      }
      const whole = builders
        .map((b) => built.get(b.agent.id)?.renders ?? [])
        .find((r) => r.length > 0)
      if (whole) this.full = whole
    }
    this.bounces = bounced
    this.append(integ?.agent.id ?? ROOM_SYSTEM, `Round ${round} parts`, {
      kind: 'card',
      card: {
        type: 'parts',
        round,
        parts: builders.map((b) => {
          const part = b.agent.seat!.part ?? COUNCIL_WHOLE
          const branch = b.agent.seat!.branch
          const out = built.get(b.agent.id)
          const render = out?.renders[0]?.path
          return {
            part,
            agentId: b.agent.id,
            ...(branch ? { branch } : {}),
            status: !out
              ? ('failed' as const)
              : bounced[part]
                ? ('bounced' as const)
                : ('ok' as const),
            ...(render ? { render } : {}),
            note: bounced[part] ?? (out ? '' : 'no turn this round'),
          }
        }),
      },
      renders: this.full,
    })
    await this.syncSeats()
    if (!(await this.gate('critique'))) return true
    const critics = [
      ...this.seatsIn('director'),
      ...this.seatsIn('critic'),
      ...this.seatsIn('builder', { demoted: true }),
    ]
    const crits = await Promise.all(
      critics.map((s) =>
        this.turn(
          s.agent.id,
          'critique',
          critiquePrompt({
            round,
            parts: this.c.parts,
            director: s.agent.seat?.role === 'director',
          }),
          {
            images: [...paths(this.full), ...this.c.refs],
          },
        ),
      ),
    )
    const unknowns: string[] = []
    for (const out of crits) {
      if (!out) continue
      for (const f of parseFindings(out.text, this.c.parts)) {
        const part = councilOwnerPart(f.part, this.c.parts)
        ;(this.fixes[part] ??= []).push(`${f.severity}: ${f.text}`)
        if (f.unknown) unknowns.push(`[${part}] ${f.text}`)
      }
    }
    const dir = this.seatsIn('director')[0]
    const dirRenders = dir ? crits[critics.indexOf(dir)]?.renders : undefined
    if (dirRenders && dirRenders.length > 0) this.paintover = dirRenders
    const researcher = this.seatsIn('researcher')[0]
    if (researcher && unknowns.length > 0) {
      await this.turn(researcher.agent.id, 'research', researchPrompt(unknowns))
    }
    if (!(await this.gate('judge'))) return true
    return this.score(round)
  }

  /** Merges `from` seats' branches into `seat`'s tree (look seats start from their builder's work). */
  private async syncFrom(seat: Seat, from: readonly Seat[]): Promise<void> {
    const wd = this.wd!
    for (const b of from) {
      await this.git(() =>
        wd.git(seat.tree, ['merge', '-q', '--no-edit', seatBranch(b.agent.id)]).catch(async () => {
          await wd.git(seat.tree, ['merge', '--abort']).catch(() => undefined)
        }),
      )
    }
  }

  /** After main moved: commit it, then merge main into every seat's worktree. */
  private async syncSeats(): Promise<void> {
    const wd = this.wd!
    await this.git(() => wd.commit(wd.main, `Room: main after round ${this.c.round}`))
    for (const s of this.seats.values()) {
      if (s.tree === wd.main) continue
      const ok = await this.git(async () => {
        await wd.commit(s.tree, `${firstName(s.agent.name)}: before sync`)
        return wd.syncFromMain(s.tree)
      })
      if (!ok) this.deps.log(`${this.room.id}: ${s.agent.id} could not merge ${MAIN_BRANCH}`)
    }
  }

  /** Who a criterion's score delta is credited to: the owner part's builders and look seat. */
  private owners(c: RubricCriterion): string[] {
    const part = councilOwnerPart(c.owner, this.c.parts)
    const all = [...this.seats.values()].filter((s) => !s.agent.seat?.demoted)
    if (part === 'Integrator')
      return all.filter((s) => s.agent.seat?.role === 'integrator').map((s) => s.agent.id)
    if (part === 'Look') {
      const look = all.filter((s) => s.agent.seat?.role === 'look')
      return (look.length > 0 ? look : all.filter((s) => s.agent.seat?.role === 'director')).map(
        (s) => s.agent.id,
      )
    }
    return all
      .filter(
        (s) =>
          (s.agent.seat?.role === 'builder' || s.agent.seat?.role === 'look') &&
          s.agent.seat.part === part,
      )
      .map((s) => s.agent.id)
  }

  /** The judge's scorecard and the convergence call. True when the room should deliver. */
  private async score(round: number): Promise<boolean> {
    const judge = this.scorer()
    const rubric = this.c.rubric
    const prev = this.c.scores.at(-1)
    const branched = round === 2 ? this.branched() : []
    const branchImages = branched.flatMap((p) => [
      ...paths(this.partRenders.get(`${p}#A`) ?? []),
      ...paths(this.partRenders.get(`${p}#B`) ?? []),
    ])
    const images = [...paths(this.full), ...branchImages, ...this.c.refs]
    let card = null
    if (judge) {
      for (const retry of [false, true]) {
        const out = await this.turn(
          judge.agent.id,
          'score',
          scorePrompt({ round, rubric, parts: this.c.parts, branched, retry }),
          { images, post: false },
        )
        if (!out) break
        card = parseScorecard(out.text, rubric, branched)
        if (card) break
      }
    }
    if (!card) {
      this.append(
        ROOM_SYSTEM,
        `No scorecard for round ${round}${judge ? ": the judge's answer was unreadable twice" : ''}.`,
      )
      return this.c.round >= this.c.maxRounds || this.stopRequested
    }
    const criteria: Record<string, number> = {}
    const deltas: Record<string, number> = {}
    for (const c of rubric) {
      criteria[c.id] = card.scores[c.id]!.score
      const before = prev?.criteria[c.id]
      if (before !== undefined) deltas[c.id] = round1(criteria[c.id]! - before)
    }
    const total = round1(
      rubric.reduce((a, c) => a + criteria[c.id]!, 0) / Math.max(1, rubric.length),
    )
    this.c.scores.push({ round, total, criteria })
    await this.routing.credit(round, deltas, rubric, (c) => this.owners(c))
    for (const f of card.fixes)
      (this.fixes[councilOwnerPart(f.part, this.c.parts)] ??= []).push(f.text)
    const gain = prev ? total - prev.total : Infinity
    this.plateauStreak = gain < COUNCIL_PLATEAU ? this.plateauStreak + 1 : 0
    const verdict = rubric.every((c) => criteria[c.id]! >= COUNCIL_TARGET_SCORE)
      ? ('converged' as const)
      : this.plateauStreak >= 2
        ? ('plateau' as const)
        : round >= this.c.maxRounds
          ? ('cap' as const)
          : this.stopRequested
            ? ('stopped' as const)
            : branched.length > 0
              ? ('branch' as const)
              : ('continue' as const)
    this.append(judge!.agent.id, card.note, {
      kind: 'card',
      card: {
        type: 'scorecard',
        round,
        criteria: rubric.map((c) => ({
          id: c.id,
          name: c.name,
          owner: councilOwnerPart(c.owner, this.c.parts),
          score: criteria[c.id]!,
          ...(deltas[c.id] !== undefined ? { delta: deltas[c.id]! } : {}),
        })),
        total,
        verdict,
        note: card.note,
        fixes: card.fixes.map((f) => ({
          part: councilOwnerPart(f.part, this.c.parts),
          text: f.text,
        })),
        log: this.routing.round(round).map((e) => ({ ...e })),
      },
    })
    if (
      branched.length > 0 &&
      verdict !== 'converged' &&
      verdict !== 'plateau' &&
      verdict !== 'cap'
    )
      this.pickBranches(card.branches, branched)
    return verdict !== 'continue' && verdict !== 'branch'
  }

  /** Max, after round 2: one builder per branched part stays; the other critiques from now on. */
  private pickBranches(picks: Record<string, 'A' | 'B'>, branched: readonly string[]): void {
    const lines: string[] = []
    for (const part of branched) {
      const keep = picks[part] ?? 'A'
      const pair = this.builders().filter((b) => b.agent.seat?.part === part)
      const winner = pair.find((b) => b.agent.seat?.branch === keep)
      for (const b of pair) {
        if (b === winner) continue
        b.agent.seat!.demoted = true
        lines.push(
          `${part}: ${firstName(winner?.agent.name ?? '?')} (branch ${keep}) stays; ${firstName(b.agent.name)} critiques from now on.`,
        )
      }
      // The winning branch is what the integrator merges from now on.
      if (winner && winner.agent.seat) delete winner.agent.seat.branch
      const won = this.partRenders.get(`${part}#${keep}`)
      if (won) this.partRenders.set(part, won)
    }
    if (lines.length > 0) this.append(ROOM_SYSTEM, lines.join('\n'))
  }

  /** Isaac's posts since the last boundary: the seats he named answer, else the integrator, else the judge. */
  private async answerIsaac(): Promise<void> {
    const posts = this.room.messages.filter(
      (m) => m.author === ROOM_ISAAC && msgNum(m.id) > this.isaacSeen,
    )
    if (posts.length === 0) return
    this.isaacSeen = this.msgSeq
    const live = this.liveSeats()
    const named = new Set<string>()
    for (const m of posts) {
      if (m.mentions.includes(MENTION_EVERYONE)) for (const s of live) named.add(s.agent.id)
      for (const id of m.mentions) if (live.some((s) => s.agent.id === id)) named.add(id)
    }
    const fallback = this.integrator() ?? this.seatsIn('judge')[0] ?? live[0]
    if (named.size === 0 && fallback) named.add(fallback.agent.id)
    await Promise.all(
      [...named].map((id) =>
        this.turn(
          id,
          this.seats.get(id)?.agent.seat?.role === 'researcher' ? 'research' : 'answer',
          answerPrompt(),
          {
            images: [...paths(this.full), ...this.c.refs],
          },
        ),
      ),
    )
  }

  /**
   * A raise lands at the round boundary: the higher notch is cast, cast seats that match a
   * seat already here (same role, same part or a part it covers) keep that seat (now on the
   * finer part), the rest join; a finer split makes the integrator re-split (contract v2).
   */
  private async applyRaise(): Promise<void> {
    this.raisePending = false
    const cast = councilCast(this.c.effort, this.overrides)
    const existing = [...this.seats.values()].map((s) => s.agent)
    const matched = new Set<string>()
    const joined: RoomAgent[] = []
    const round = this.c.round
    for (const row of cast.seats) {
      const hit = existing.find((a) => {
        const s = a.seat
        if (!s || matched.has(a.id) || s.role !== row.role) return false
        if (!row.part) return !s.part
        return s.part !== undefined && partCovers(s.part, row.part)
      })
      if (hit) {
        matched.add(hit.id)
        if (row.part) hit.seat!.part = row.part
        if (row.branch) hit.seat!.branch = row.branch
        continue
      }
      let n = 1
      while (this.room.agents.some((a) => a.id === `${row.role}-${n}`)) n++
      const person = COUNCIL_PEOPLE[row.role][n - 1] ?? COUNCIL_PEOPLE[row.role][0]!
      const agent = this.agentFor(row, `${row.role}-${n}`, person.name, round)
      this.room.agents.push(agent)
      joined.push(agent)
    }
    const resplit = cast.parts.join('|') !== this.c.parts.join('|')
    this.c.parts = cast.parts
    this.c.maxRounds = Math.max(this.c.maxRounds, cast.notch.rounds)
    this.c.spend.estimate = cast.cost
    this.c.spend.cap = Math.max(this.c.spend.cap, cast.cap)
    this.c.minutesEstimate = cast.minutes
    await Promise.all(joined.map((a) => this.open(a)))
    const came = joined.filter((a) => !a.failed)
    if (came.length > 0) {
      this.append(
        ROOM_SYSTEM,
        `Joining at round ${round}: ${came.map((a) => `${a.name} (${COUNCIL_ROLE_LABEL[a.seat!.role]}${a.seat!.part ? `, ${a.seat!.part}` : ''})`).join(', ')}.`,
      )
    }
    if (resplit) await this.contract((this.c.contract?.version ?? 1) + 1)
  }

  /** Final positions, the deliverable card, the record and the routing log. */
  private async deliver(): Promise<void> {
    if (this.destroyed || !roomIsLive(this.room.phase)) return
    this.delivering = true
    this.c.stage = 'converge'
    this.room.phase = 'wrapping'
    this.changed()
    await this.answerIsaac()
    this.c.stage = 'deliver'
    this.changed()
    const live = this.liveSeats()
    const lines = await Promise.all(live.map((s) => this.turn(s.agent.id, 'final', finalPrompt())))
    this.finals = live.flatMap((s, i) =>
      lines[i] ? [{ id: s.agent.id, text: feedText(lines[i]!.text) }] : [],
    )
    if (this.destroyed) return
    this.resolving = true
    this.room.presence = {}
    const wd = this.wd!
    await this.git(() => wd.commit(wd.main, 'Room: delivered'))
    const firstScores = this.c.scores[0]
    const last = this.c.scores.at(-1)
    const changes: string[] = []
    for (const c of this.c.rubric) {
      const a = firstScores?.criteria[c.id]
      const b = last?.criteria[c.id]
      if (a !== undefined && b !== undefined && a !== b) changes.push(`${c.name}: ${a} to ${b}`)
    }
    const files = await this.git(async () => {
      const root =
        (await wd.git(wd.main, ['rev-list', '--max-parents=0', 'HEAD'])).trim().split('\n')[0] ??
        'HEAD'
      return wd.changed(wd.main, root)
    }).catch(() => [])
    if (files.length > 0)
      changes.push(`${files.length} file${files.length === 1 ? '' : 's'} changed in main`)
    const names = new Map(this.c.rubric.map((c) => [c.id, c.name]))
    const card: RoomCard & { type: 'deliverable' } = {
      type: 'deliverable',
      ...(last ? { total: last.total } : {}),
      spent: this.c.spend.usd,
      minutes: Math.round((this.now() - this.room.startedAt) / 60_000),
      workdir: wd.root,
      ...(this.c.routingFile ? { routingFile: this.c.routingFile } : {}),
      before: this.before,
      after: this.full,
      changes,
      dissent: this.finals
        .filter((f) => isDissent(f.text))
        .map(
          (f) =>
            `${firstName(this.room.agents.find((a) => a.id === f.id)?.name ?? f.id)}: ${f.text.replace(/^\W*dissent\W*/i, '')}`,
        ),
      who: this.routing.who().map((w) => {
        const a = this.room.agents.find((x) => x.id === w.seat)
        const moved = Object.entries(w.moved)
          .filter(([, v]) => v !== 0)
          .map(([k, v]) => `${names.get(k) ?? k} ${v > 0 ? '+' : ''}${round1(v)}`)
          .join(', ')
        return {
          agentId: w.seat,
          ...(a?.seat?.part ? { part: a.seat.part } : {}),
          did: w.kinds.join(', '),
          turns: w.turns,
          usd: w.usd,
          moved: moved === '' ? '-' : moved,
        }
      }),
    }
    const msg = this.append(
      ROOM_SYSTEM,
      `Delivered: ${card.total === undefined ? 'not scored' : `${card.total}/10`} after ${this.c.round} round${this.c.round === 1 ? '' : 's'}, ${councilMoney(card.spent)} list. The work is in ${wd.root}/main; merge it by hand.`,
      { kind: 'card', card, renders: this.full },
    )
    this.room.phase = 'resolved'
    this.room.resolvedAt = msg.ts
    this.changed()
    await this.routing.settled()
    try {
      this.room.file = await this.deps.save(this.room, this.stem)
      card.record = this.room.file
    } catch (e) {
      this.append(ROOM_SYSTEM, `Could not save the room: ${errText(e)}`)
    }
    this.changed()
    await this.stopAll()
  }
}
