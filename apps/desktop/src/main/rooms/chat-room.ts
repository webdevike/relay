// A chat room (Assistants > Rooms): its setup, its messages, its members' seats and its file.
// Created idle and saved at once to `<eva>/work/rooms/<id>/room.json` (the folder council rooms
// use), rewritten after every message and change, and listed again at the next launch.
//
// Each of Isaac's messages starts a burst (chat-turns.ts): members take turns, one at a time, each
// an omp seat on its exact model and thinking level with its own session file (resumed after a
// restart), scratch dir and the outward-action guard, working in the room's `main/` (the setup's
// folder copied in). A turn is priced from its usage; the room pauses itself before a turn whose
// estimate would cross the budget. Pause stops the turn now; Resume goes on with it. A room that
// was running when Relay quit comes back paused and never runs by itself.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ModelInfo } from '@evaos/chat-core/launch'
import {
  ChatRoomSetupSchema,
  OmpThinkingSchema,
  ROOM_ISAAC,
  ROOM_MAX_MEMBERS,
  ROOM_SYSTEM,
  UNTITLED_ROOM,
  autoTitle,
  fitThinking,
  levelsFor,
  memberIdFor,
  mentionsIn,
  type ChatRoomMember,
  type ChatRoomSetup,
  type ChatRoomSetupPatch,
  type Room,
  type RoomAgent,
  type RoomChat,
  type RoomMessage,
} from '@evaos/contract'
import { councilMoney, councilPriceOf, usageCost, type ModelPrice } from '@relay/protocol'
import { afterTurn, burstFor, nextSpeaker, type Burst } from './chat-turns'
import type { SeatHandle, SeatLauncher } from './council/seat'
import { ROOM_STATE_VERSION, writeRoomState, type ChatRoomState } from './council/state'
import { RoomWorkdir } from './council/workdir'
import { dedash, transcriptLines, trimReply } from './prompts'

/** Mantine colors members cycle through, so mentions and avatars stay apart. */
const COLORS = ['blue', 'orange', 'teal', 'violet', 'green', 'pink', 'cyan', 'grape'] as const

/** Seats left running after a burst stop after this long without a new one. */
const SEAT_IDLE_MS = 5 * 60_000

/** What a member's first turn is assumed to use before it has a cost of its own. */
const FIRST_TURN_TOKENS = { input: 8000, output: 800, cached: 0 }
/** A member's next turn is assumed to cost this much more than its last (its context grows). */
const TURN_GROWTH = 1.25

/** The members as the room's agents: what the feed, mentions and the phone read. */
export const chatAgents = (setup: ChatRoomSetup): RoomAgent[] =>
  setup.members.map((m, i) => ({
    id: m.id,
    name: m.name,
    title: m.role,
    role: m.role,
    brief: m.instructions ?? '',
    model: m.model,
    tools: 'full',
    color: COLORS[i % COLORS.length]!,
  }))

/** A registry assistant as a room reads it: its persona and the model it runs on. */
export interface RoomAssistant {
  id: string
  title: string
  scope: string
  /** `provider/id`, maybe `:thinking`. */
  model?: string
}

export interface ChatRoomDeps {
  /** The Eva root: rooms live in `<evaRoot>/work/rooms/<id>`. */
  evaRoot: string
  onChange: (room: Room) => void
  log: (line: string) => void
  launcher: SeatLauncher
  /** omp's catalog: thinking levels for guests, list prices for the spend. */
  catalog: () => Promise<readonly ModelInfo[]>
  /** The registry's assistants: members' personas, and who an @mention can pull in. */
  assistants: () => readonly RoomAssistant[]
  /** Where each room's guard asks go (`<asksRoot>/<id>/asks`); the OS temp dir by default. */
  asksRoot?: string
  seatIdleMs?: number
}

const errText = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 200)

const failure = (message: string): Error => Object.assign(new Error(message), { code: 'bad-input' })

const isAbort = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError'

const NEW_SPEND = (): RoomChat['spend'] => ({ usd: 0, byMember: {} })

interface LiveSeat {
  handle: SeatHandle
  /** What the seat was started with; a member whose setup changed gets a new seat. */
  key: string
}

const seatKey = (m: ChatRoomMember): string =>
  [m.model, m.thinking, m.role, m.instructions ?? '', m.guest ? 'guest' : ''].join('|')

export class ChatRoom {
  readonly room: Room
  private msgSeq: number
  private seats: ChatRoomState['seats']
  private burst: Burst | null
  private readonly live = new Map<string, LiveSeat>()
  private wd: RoomWorkdir | null = null
  private running: Promise<void> | null = null
  private planning: Promise<void> = Promise.resolve()
  private abort: AbortController | null = null
  /** Isaac posted while a turn ran: the next turn comes from his new message's burst. */
  private redirect = false
  /** The message a turn is streaming into; kept out of room.json until the turn ends. */
  private streaming: string | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private destroyed = false

  private constructor(
    room: Room,
    private readonly deps: ChatRoomDeps,
    seats: ChatRoomState['seats'] = {},
    burst: Burst | null = null,
  ) {
    this.room = room
    this.msgSeq = room.messages.length
    this.seats = seats
    this.burst = burst
  }

  /** A new idle room, on disk before this returns. */
  static create(id: string, setup: ChatRoomSetup, now: number, deps: ChatRoomDeps): ChatRoom {
    const room = new ChatRoom(
      {
        id,
        kind: 'chat',
        title: setup.title ?? UNTITLED_ROOM,
        prompt: '',
        agents: chatAgents(setup),
        messages: [],
        presence: {},
        phase: 'idle',
        rounds: 0,
        startedAt: now,
        chat: { setup, rev: 0, spend: NEW_SPEND() },
      },
      deps,
    )
    fs.mkdirSync(room.workdir, { recursive: true })
    room.save()
    return room
  }

  /**
   * A room an earlier run of the app saved. One that was mid-burst (Relay quit or crashed) comes
   * back paused: its seats resume their sessions only once Isaac resumes it.
   */
  static restore(state: ChatRoomState, deps: ChatRoomDeps): ChatRoom {
    const room = new ChatRoom(
      structuredClone(state.room),
      deps,
      structuredClone(state.seats),
      state.burst ? structuredClone(state.burst) : null,
    )
    if (room.room.phase === 'open') {
      room.room.phase = 'paused'
      room.append(ROOM_SYSTEM, 'Paused when Relay quit. Resume goes on from the turn it was in.')
      room.save()
    }
    return room
  }

  /** `<eva>/work/rooms/<id>`: room.json, and the members' workdir once they run. */
  get workdir(): string {
    return path.join(this.deps.evaRoot, 'work', 'rooms', this.room.id)
  }

  get setup(): ChatRoomSetup {
    return this.room.chat!.setup
  }

  private get spend(): RoomChat['spend'] {
    return this.room.chat!.spend
  }

  /** Applies `patch` (members replace the list, null clears a field); answers the new revision. */
  update(patch: ChatRoomSetupPatch): number {
    const merged: Record<string, unknown> = { ...this.setup }
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete merged[k]
      else if (v !== undefined) merged[k] = v
    }
    const rev = this.setSetup(ChatRoomSetupSchema.parse(merged))
    // A member who left stops; one whose model or role changed gets a new seat at its next turn.
    for (const id of [...this.live.keys()])
      if (!this.setup.members.some((m) => m.id === id)) void this.stopSeat(id)
    this.changed()
    return rev
  }

  rename(title: string): void {
    this.room.chat = { ...this.room.chat!, setup: { ...this.setup, title } }
    this.room.title = title
    this.changed()
  }

  /**
   * Isaac posts: the message is kept (an unnamed room takes its title from it) and starts a burst.
   * An assistant he @mentions who is not in the room joins as a guest and is first to answer.
   * While a turn runs, the next one comes from this message; a paused room waits for Resume.
   */
  post(text: string): void {
    const body = text.trim()
    const msg = this.append(ROOM_ISAAC, body)
    if (this.room.prompt === '') this.room.prompt = body
    if (this.setup.title === undefined) {
      const title = autoTitle(body)
      this.room.chat = { ...this.room.chat!, setup: { ...this.setup, title } }
      this.room.title = title
    }
    this.changed()
    // Posts are planned in order, each after the guests the one before pulled in.
    this.planning = this.planning
      .then(() => this.plan(msg))
      .catch((e: unknown) =>
        this.deps.log(`${this.room.id}: could not plan a burst: ${errText(e)}`),
      )
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

  /** Stops the burst now: the turn in flight is dropped and runs again on Resume; seats end. */
  pause(): void {
    if (this.room.phase !== 'open') throw failure('The room is not running.')
    this.room.phase = 'paused'
    this.append(ROOM_SYSTEM, 'Paused. Resume goes on from the turn it stopped at.')
    this.stopTurn()
    this.changed()
    void this.stopSeats()
  }

  /**
   * Goes on with the burst a pause stopped (nothing left: the room is idle again). Refuses while
   * the next turn would still cross the budget. Resolves with the budget.
   */
  async resume(): Promise<number> {
    if (this.room.phase !== 'paused') throw failure('The room is not paused.')
    const next = this.burst ? nextSpeaker(this.burst, this.setup.members) : null
    if (next === null) {
      this.burst = null
      this.room.phase = 'idle'
      this.changed()
      return this.setup.budget
    }
    const member = this.setup.members.find((m) => m.id === next)!
    const est = this.estimate(member, await this.priceOf(member.model))
    if (this.spend.usd + est > this.setup.budget) {
      throw failure(
        `${member.name}'s next turn would pass the ${councilMoney(this.setup.budget)} budget. Raise it in Members first.`,
      )
    }
    this.room.phase = 'open'
    this.changed()
    this.kick()
    return this.setup.budget
  }

  /**
   * The app quits or the room is deleted: a running burst is saved paused (Resume goes on from the
   * turn it was in), the turn in flight stops and every seat ends.
   */
  async destroy(): Promise<void> {
    if (this.room.phase === 'open') {
      this.room.phase = 'paused'
      this.append(ROOM_SYSTEM, 'Paused when Relay quit. Resume goes on from the turn it was in.')
    }
    this.save()
    this.destroyed = true
    this.stopTurn()
    clearTimeout(this.idleTimer ?? undefined)
    await this.stopSeats()
    await this.running
  }

  // ---- the engine -------------------------------------------------------------------------------

  /** The burst `msg` starts, after the guests it mentions joined; runs it unless the room is paused. */
  private async plan(msg: RoomMessage): Promise<void> {
    await this.addGuests(msg.text)
    if (this.destroyed) return
    msg.mentions = mentionsIn(msg.text, this.room.agents)
    this.burst = burstFor(this.setup.members, msg.mentions, this.setup.effort)
    // A turn in flight finishes; the turn after it comes from this burst.
    if (this.abort !== null && this.room.phase === 'open') this.redirect = true
    if (this.room.phase !== 'paused') this.room.phase = 'open'
    this.changed()
    if (this.room.phase === 'open') this.kick()
  }

  /** Registry assistants `text` @mentions who are not in the room join as guests (a quiet line each). */
  private async addGuests(text: string): Promise<void> {
    const words = [...text.matchAll(/(?:^|\s)@([A-Za-z][\w-]*)/g)].map((m) => m[1]!.toLowerCase())
    if (words.length === 0) return
    const members = this.setup.members
    const first = (name: string): string => name.toLowerCase().split(/\s+/)[0]!
    const joining: RoomAssistant[] = []
    for (const a of this.deps.assistants()) {
      const named = words.includes(first(a.title)) || words.includes(a.id)
      const present = members.some((m) => m.assistant === a.id || first(m.name) === first(a.title))
      if (named && !present) joining.push(a)
    }
    if (joining.length === 0) return
    const catalog = await this.deps.catalog().catch(() => [] as readonly ModelInfo[])
    const taken = new Set(members.map((m) => m.id))
    const guests: ChatRoomMember[] = []
    for (const a of joining) {
      if (members.length + guests.length >= ROOM_MAX_MEMBERS) {
        this.append(ROOM_SYSTEM, `${a.title} could not join: the room is full.`)
        continue
      }
      const [spec = '', level] = (a.model ?? '').split(':')
      const known = catalog.find((c) => `${c.provider}/${c.id}` === spec)
      const model = known ? spec : members[0]!.model
      const want = OmpThinkingSchema.safeParse(level)
      const id = memberIdFor(a.title, taken)
      taken.add(id)
      guests.push({
        id,
        assistant: a.id,
        name: a.title,
        model,
        thinking: fitThinking(
          want.success ? want.data : 'medium',
          levelsFor(catalog.find((c) => `${c.provider}/${c.id}` === model)),
        ),
        role: 'Guest',
        guest: true,
      })
    }
    if (guests.length === 0) return
    this.setSetup(ChatRoomSetupSchema.parse({ ...this.setup, members: [...members, ...guests] }))
    for (const g of guests) this.append(ROOM_SYSTEM, `${g.name} joined as a guest`)
  }

  private kick(): void {
    if (this.destroyed) return
    if (this.running) {
      // A loop on its way out has not seen the new burst: look again once it is done.
      void this.running.then(() => this.kick())
      return
    }
    clearTimeout(this.idleTimer ?? undefined)
    this.idleTimer = null
    this.running = this.loop()
      .catch((e: unknown) => this.deps.log(`${this.room.id}: burst failed: ${errText(e)}`))
      .finally(() => {
        this.running = null
      })
  }

  private async loop(): Promise<void> {
    while (!this.destroyed && this.room.phase === 'open' && this.burst) {
      const id = nextSpeaker(this.burst, this.setup.members)
      if (id === null) {
        this.burst = null
        this.room.phase = 'idle'
        this.changed()
        this.idleTimer = setTimeout(
          () => void this.stopSeats(),
          this.deps.seatIdleMs ?? SEAT_IDLE_MS,
        )
        this.idleTimer.unref?.()
        return
      }
      const member = this.setup.members.find((m) => m.id === id)!
      const price = await this.priceOf(member.model)
      const est = this.estimate(member, price)
      if (this.spend.usd + est > this.setup.budget) {
        this.room.phase = 'paused'
        this.append(
          ROOM_SYSTEM,
          `Paused before ${member.name}'s turn: it would pass the ${councilMoney(this.setup.budget)} budget (${councilMoney(this.spend.usd)} spent). Raise the budget in Members, then Resume.`,
        )
        this.changed()
        void this.stopSeats()
        return
      }
      await this.turn(member, price)
    }
  }

  /** One member's turn: what it has not seen yet, its reply streamed into the room, its cost. */
  private async turn(member: ChatRoomMember, price: ModelPrice | null): Promise<void> {
    let seat: LiveSeat
    try {
      seat = await this.seatFor(member)
    } catch (e) {
      if (this.destroyed || this.room.phase !== 'open') return
      this.append(ROOM_SYSTEM, `${member.name} could not start (${errText(e)}).`)
      this.burst = afterTurn(this.burst!, member.id, [], false)
      this.changed()
      return
    }
    if (this.destroyed || this.room.phase !== 'open') return
    const seen = this.seats[member.id]?.seen ?? 0
    const delta = this.room.messages.slice(seen).filter((m) => m.author !== member.id)
    const prompt = `${transcriptLines(this.room, delta)}\n\nYour turn, ${member.name}. Write your message to the room.`
    const ac = new AbortController()
    this.abort = ac
    this.room.presence[member.id] = { state: 'thinking', since: Date.now() }
    this.emit()
    let msg: RoomMessage | null = null
    const drop = (): void => {
      if (msg) this.room.messages = this.room.messages.filter((m) => m !== msg)
      this.streaming = null
    }
    try {
      const r = await seat.handle.turn({
        prompt,
        signal: ac.signal,
        onPresence: (p) => {
          if (ac.signal.aborted) return
          this.room.presence[member.id] = { ...p, since: Date.now() }
          this.emit()
        },
        onPartial: (t) => {
          if (ac.signal.aborted) return
          if (msg) msg.text = dedash(t)
          else {
            msg = this.append(member.id, dedash(t))
            this.streaming = msg.id
          }
          this.room.presence[member.id] = { state: 'typing', since: Date.now() }
          this.emit()
        },
      })
      delete this.room.presence[member.id]
      const text = trimReply(dedash(r.text.trim()))
      if (text === '') drop()
      else {
        msg ??= this.append(member.id, text)
        msg.text = text
        msg.mentions = mentionsIn(text, this.room.agents)
        this.streaming = null
      }
      const cost = price ? usageCost(price, r.usage) : 0
      this.spend.usd += cost
      this.spend.byMember[member.id] = (this.spend.byMember[member.id] ?? 0) + cost
      const session = seat.handle.session() ?? this.seats[member.id]?.session
      this.seats[member.id] = {
        seen: this.room.messages.length,
        ...(session ? { session } : {}),
        lastCost: cost,
      }
      if (this.redirect) this.redirect = false
      else
        this.burst = afterTurn(
          this.burst!,
          member.id,
          msg?.mentions ?? [],
          /(^|\s)@isaac\b/i.test(text),
        )
      this.changed()
    } catch (e) {
      delete this.room.presence[member.id]
      drop()
      // Paused or deleted: the burst keeps this turn for Resume.
      if (isAbort(e) || this.destroyed || this.room.phase !== 'open') {
        this.emit()
        return
      }
      this.append(ROOM_SYSTEM, `${member.name} could not answer (${errText(e)}).`)
      void this.stopSeat(member.id)
      this.burst = afterTurn(this.burst!, member.id, [], false)
      this.changed()
    } finally {
      if (this.abort === ac) this.abort = null
    }
  }

  /** The member's running seat, started (its saved session resumed) when it has none or changed. */
  private async seatFor(member: ChatRoomMember): Promise<LiveSeat> {
    const key = seatKey(member)
    const have = this.live.get(member.id)
    if (have?.key === key) return have
    if (have) await this.stopSeat(member.id)
    const wd = await this.roomWorkdir()
    const saved = this.seats[member.id]
    const asksDir = path.join(
      this.deps.asksRoot ?? path.join(os.tmpdir(), 'relay-rooms'),
      this.room.id,
      'asks',
    )
    fs.mkdirSync(asksDir, { recursive: true })
    const handle = await this.deps.launcher.start({
      roomId: this.room.id,
      seatId: member.id,
      harness: 'omp',
      model: { omp: member.model },
      thinking: member.thinking,
      systemPrompt: this.systemPrompt(member, wd),
      cwd: wd.main,
      readDirs: [wd.root],
      workdir: wd.root,
      asksDir,
      scratch: path.join(wd.root, 'tmp', member.id),
      sessionDir: path.join(wd.root, 'sessions', member.id),
      ...(saved?.session ? { resume: saved.session } : {}),
    })
    if (this.destroyed) {
      await handle.stop().catch(() => undefined)
      throw failure('the room closed')
    }
    if (!handle.resumed) {
      // A fresh session has seen nothing: its first turn gets the whole thread.
      if (saved?.session)
        this.append(
          ROOM_SYSTEM,
          `${member.name} could not pick up the earlier session and starts fresh with the whole thread.`,
        )
      this.seats[member.id] = { ...saved, seen: 0 }
    }
    const seat = { handle, key }
    this.live.set(member.id, seat)
    handle.onExit((err) => {
      if (this.live.get(member.id) !== seat) return
      this.live.delete(member.id)
      this.deps.log(
        `${this.room.id}: ${member.name}'s seat ended: ${err ? errText(err) : 'exited'}`,
      )
    })
    return seat
  }

  /** `main/` with the setup's folder copied in, refs under `refs/`; made once, opened after. */
  private async roomWorkdir(): Promise<RoomWorkdir> {
    if (this.wd) return this.wd
    const root = this.workdir
    this.wd = fs.existsSync(path.join(root, 'main'))
      ? RoomWorkdir.open({ root, refs: [] })
      : await RoomWorkdir.create({
          evaRoot: this.deps.evaRoot,
          roomId: this.room.id,
          ...(this.setup.folder ? { source: this.setup.folder } : {}),
          refs: this.setup.refs.filter((r) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(r)),
        })
    return this.wd
  }

  private systemPrompt(member: ChatRoomMember, wd: RoomWorkdir): string {
    const others = this.setup.members.filter((m) => m.id !== member.id)
    const persona = member.assistant
      ? this.deps.assistants().find((a) => a.id === member.assistant)
      : undefined
    const urls = this.setup.refs.filter((r) => /^[a-z][a-z0-9+.-]*:\/\//i.test(r))
    return [
      `You are ${member.name}, a member of a Relay room: a group chat between Isaac and ${others.length === 0 ? 'you' : `${others.length} other AI member${others.length === 1 ? '' : 's'}`}.`,
      persona
        ? `You are also Isaac's assistant ${persona.title}${persona.scope ? ` (${persona.scope})` : ''}. Bring that view; this room is not your own thread.`
        : '',
      member.role ? `Your role in this room: ${member.role}.` : '',
      member.instructions ? `Your instructions: ${member.instructions}` : '',
      member.guest
        ? 'You joined as a guest because Isaac @mentioned you: answer what he asked you, then leave the room to its members.'
        : '',
      others.length > 0
        ? `The other members:\n${others.map((m) => `- ${m.name}${m.role ? ` (${m.role})` : ''}${m.guest ? ', a guest' : ''}`).join('\n')}`
        : '',
      `The room's question: ${this.room.prompt}`,
      `Your working folder is ${wd.main}${this.setup.folder ? ` (a copy of ${this.setup.folder})` : ''}; everything under ${wd.root} (references in refs/) is yours to read.${urls.length > 0 ? ` Links Isaac gave: ${urls.join(', ')}.` : ''}`,
      'Outward actions are blocked: git push, deploys, publishing, sending mail or messages, purchases, and deleting or writing outside the room folder. Do the work locally.',
      `Chat rules:
- Each turn you are shown what was said since your last turn, as \`[id] Name: text\` lines, then asked for your message.
- Your message is plain text: 1 to 4 short sentences, no headings, no name prefix, no em dashes.
- Talk to the others by name. Writing @Name hands the next turn to that member.
- Write @Isaac only when only Isaac can answer, and then stop.
- Build on what was said, disagree with evidence, never repeat someone.`,
    ]
      .filter((l) => l !== '')
      .join('\n\n')
  }

  /** The list price of `model`: omp's catalog, else the council's table; null when unknown. */
  private async priceOf(model: string): Promise<ModelPrice | null> {
    const catalog = await this.deps.catalog().catch(() => [] as readonly ModelInfo[])
    return catalog.find((c) => `${c.provider}/${c.id}` === model)?.price ?? councilPriceOf(model)
  }

  /** What `member`'s next turn should cost: a bit more than its last, else a first turn's guess. */
  private estimate(member: ChatRoomMember, price: ModelPrice | null): number {
    const last = this.seats[member.id]?.lastCost
    if (last !== undefined) return last * TURN_GROWTH
    return price ? usageCost(price, FIRST_TURN_TOKENS) : 0
  }

  private stopTurn(): void {
    this.abort?.abort('stopped')
    this.abort = null
    this.redirect = false
    this.room.presence = {}
  }

  private async stopSeat(id: string): Promise<void> {
    const seat = this.live.get(id)
    if (!seat) return
    this.live.delete(id)
    const session = seat.handle.session()
    if (session) this.seats[id] = { ...this.seats[id], seen: this.seats[id]?.seen ?? 0, session }
    await seat.handle.stop().catch(() => undefined)
  }

  /** Every seat ends; their sessions are kept for the next turn or Resume. */
  private async stopSeats(): Promise<void> {
    await Promise.allSettled([...this.live.keys()].map((id) => this.stopSeat(id)))
    if (!this.destroyed) this.save()
  }

  private setSetup(setup: ChatRoomSetup): number {
    const rev = this.room.chat!.rev + 1
    this.room.chat = { ...this.room.chat!, setup, rev }
    this.room.title = setup.title ?? UNTITLED_ROOM
    this.room.agents = chatAgents(setup)
    return rev
  }

  private append(author: string, text: string): RoomMessage {
    const msg: RoomMessage = {
      id: `m${++this.msgSeq}`,
      author,
      text,
      ts: Date.now(),
      reactions: [],
      kind: 'message',
      mentions: author === ROOM_SYSTEM ? [] : mentionsIn(text, this.room.agents),
    }
    this.room.messages.push(msg)
    return msg
  }

  /** Streaming text and presence: to the renderer, not to disk. */
  private emit(): void {
    if (!this.destroyed) this.deps.onChange(this.room)
  }

  private changed(): void {
    if (this.destroyed) return
    this.save()
    this.deps.onChange(this.room)
  }

  /** The room as it is now, on disk; a failed write is logged, never fatal. */
  private save(): void {
    const state: ChatRoomState = {
      version: ROOM_STATE_VERSION,
      kind: 'chat',
      room: {
        ...this.room,
        presence: {},
        messages: this.room.messages.filter((m) => m.id !== this.streaming),
      },
      seats: this.seats,
      ...(this.burst ? { burst: this.burst } : {}),
    }
    try {
      writeRoomState(this.workdir, state)
    } catch (e) {
      this.deps.log(`${this.room.id}: could not save the room: ${errText(e)}`)
    }
  }
}
