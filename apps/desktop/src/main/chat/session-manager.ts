import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseFrame } from '@evaos/chat-core/frames'
import { cmd } from '@evaos/chat-core/frames'
import { LiveReducer, promptRow } from '@evaos/chat-core/reducer'
import {
  answerSummary,
  dialogResponse,
  dialogStatus,
  type DialogAnswer,
} from '@evaos/chat-core/dialogs'
import { SeqBatcher, type AwayView, type Batch, type Snapshot } from '@evaos/chat-core/batcher'
import { makeMessage, type ChatMessage, type SessionMeta } from '@evaos/chat-core/message'
import { parseSession, type ParsedSession } from '@evaos/chat-core/session'
import { sessionId } from '@evaos/chat-core/session-id'
import { tagged } from '@evaos/chat-core/tagged'
import { isRecentlyActive } from '@evaos/chat-core/chat-groups'
import type { ChatTransport, PromptImage, TransportExit } from '@evaos/chat-core/transport'
import {
  claudeArgs,
  goalCommand,
  isHandoff,
  ompArgs,
  type Approval,
  type GoalOp,
  type Harness,
  type Launch,
  type ModelInfo,
  type Profile,
} from '@evaos/chat-core/launch'
import type { LaunchPatch, LaunchState } from '@evaos/contract'
import type { RelayLink, RelaySessionEvent } from '../relay/client'
import { configureCommand, relayImages, replyCommand, type RelayImage } from '../relay/commands'
import type { RelaySession } from '../relay/feed'
import {
  answerFor,
  blockerDialog,
  dialogRowId,
  promptCount,
  remoteRows,
  type Blocker,
  type SentPrompt,
  type Stream,
  MINI_STARTING_TEXT,
  STARTING_TEXT,
} from './remote'
import type { Mini } from '../relay/mini'
import { windowFromShare } from './context-window'

export class CodedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export const ALREADY_OWNED =
  'This session is already open in another Relay window or pane. Close it there first.'
export const OWNED_ELSEWHERE =
  'Another pane is writing to this chat. Sending from here may interleave messages.'
export const MAYBE_RUNNING_ELSEWHERE =
  'This chat was written to in the last 10 minutes and another omp may still be running it. Sending from here may interleave messages.'
export const STILL_CLOSING =
  'The previous omp process for this session is still running. Wait for it to exit before sending again.'

export const BUSY_ACCESS = 'Wait for the reply to finish, then change access.'
export const NOT_UNSENT = 'The account can only be chosen before the first message.'
export const CANT_REACH =
  'This chat is running outside this app and Relay cannot reach it. Sending from here starts a second omp on it and may interleave messages.'
export const AWAY_SETTING =
  'This chat runs outside this app. Change its access and fast mode where it runs.'
export const MINI_CANT_REACH =
  "This chat runs on the Mini and Relay can't reach it. Reply to it where it runs."
export const MINI_DOWN =
  "Relay isn't connected to the Mini. Wait for it to reconnect, then send again."
export const MINI_GOAL = 'Start a /goal chat on the Mini: this laptop does not run omp itself.'
export const APPROVE_ON_PHONE =
  'This is a destructive command. Approve it on your phone or on the Mini.'

/** What the user chose in the composer toolbar for one pane; applied live or at the next start. */
interface PaneLaunch {
  approval?: Approval
  profile: Profile | null
  model?: readonly [string, string]
  thinking?: string
  fast?: boolean
}

export interface SessionManagerDeps {
  createTransport: () => ChatTransport
  emit: (batch: Batch) => void
  cwd: string
  machineLabel: string
  /** What follows `Relay Desktop` in the surface tag: the build and the host version (`surfaceDetail`). */
  surfaceDetail?: () => string
  intervalMs?: number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  realpath?: (file: string) => string
  /** mtime of a session file in ms (null when unreadable); injectable for tests. */
  stat?: (file: string) => number | null
  now?: () => number
  /** Default launch flags for a new chat (approval from omp config); extended per pane later. */
  launchArgs?: (harness: 'omp' | 'claude') => string[]
  /** The approval mode a harness starts with when the user chose none. */
  defaultApproval?: (harness: Harness) => Approval
  /** The harness a new process would use (Settings), for panes with no process yet. */
  harness?: () => Harness
  /** The already loaded model catalog, or null; never starts a process. */
  models?: () => readonly ModelInfo[] | null
  /** Relay: the sessions omp runs outside this app, and the way to drive them. Absent: never up. */
  relay?: RelayLink
  /** Reads and parses a session file: an outside chat's transcript as its file grows. */
  readSession?: (file: string) => ParsedSession | null
  /**
   * Starts omp for a new chat in herdr with these flags and returns the session file it will
   * write. Absent when herdr is not available: a new chat starts a local omp child.
   */
  herdr?: (launch: { args: string[]; profile: Profile | null }) => Promise<string>
  /** Where the reason a new chat did not start in herdr goes. */
  log?: (line: string) => void
  /**
   * Remote mode: omp runs only on the Mini. Every send goes through Relay; a new or past chat is
   * started there, and nothing here starts omp or herdr.
   */
  mini?: Pick<Mini, 'start'>
}

/** A new herdr chat's prompt, held until its omp joins Relay (native FirstPrompt). */
interface FirstPrompt {
  session: string
  /** Surface-tagged. */
  text: string
  images: RelayImage[]
  /** Its row in the pane that sent it, taken back if Relay refuses it. */
  prompt: SentPrompt
}

/**
 * A pane showing a session omp runs outside this app (native Activity::Away), or a new chat herdr
 * is starting: the file's transcript plus what only Relay has said yet.
 */
interface Remote {
  /** Relay's id for the session; null while herdr starts omp for a new chat. */
  session: string | null
  history: ChatMessage[]
  prompts: SentPrompt[]
  notes: ChatMessage[]
  /** Relay lists it live and nothing here runs it: replies, stops and answers go through Relay. */
  away: RelaySession | null
  /** What the renderer was last told. */
  view: AwayView | null
  connected: boolean
}

/** What the chat list, writers and rename need to know about a file this app owns. */
export interface LiveStatus {
  paneId: string
  working: boolean
  dialog: 'confirm' | 'other' | null
}

interface Pane {
  paneId: string
  /** Null for a draft until omp reports the session file it created. */
  file: string | null
  key: string | null
  reducer: LiveReducer
  batcher: SeqBatcher
  transport: ChatTransport | null
  /** In-flight startTransport(); a second send during spawn awaits it instead of writing early. */
  starting: Promise<void> | null
  unsubscribe: (() => void) | null
  timer: unknown
  framesIn: number
  batches: number
  launch: PaneLaunch
  /** A new chat (opened as a draft). */
  draft: boolean
  /** A prompt has been sent from this pane. */
  prompted: boolean
  remote: Remote | null
  /** omp's name for the session as its file has it (the last `title` record), else null. */
  named: string | null
  /** The title the renderer was last given through a batch; null: the one it opened with. */
  title: string | null
}

/**
 * The omp process writing one session file (single writer, D-17). Held from spawn until the
 * process has exited: a close() in flight keeps it, so a send during the grace window waits
 * instead of starting a second writer on the same file.
 */
interface Owner {
  pane: Pane
  transport: ChatTransport
  closing: Promise<TransportExit | null> | null
}

/** Per-pane live sessions: applies omp frames in order and emits seq-stamped 16 ms batches. */
export class SessionManager {
  private panes = new Map<string, Pane>()
  /** realpath of a session file -> the process that owns it. */
  private owners = new Map<string, Owner>()
  private setIv: (fn: () => void, ms: number) => unknown
  private clearIv: (h: unknown) => void
  private real: (f: string) => string
  private statusListeners = new Set<(file: string) => void>()
  /**
   * Confirmed shared writes: realpath -> the pane that owned the file when the user chose
   * `Send anyway`, or 'external' when no pane here owned it. Dropped when the owner changes.
   */
  private remembered = new Map<string, string>()
  // Relay's side of the sessions this app reads but does not run (native RelayFeed).
  private subscribed = new Set<string>()
  private streams = new Map<string, Stream>()
  /** The question or approval each subscribed session is blocked on. */
  private blockers = new Map<string, Blocker>()
  /** Cards answered here whose answer Relay has not confirmed yet, with what their row says after. */
  private answering = new Map<string, string>()
  private firsts: FirstPrompt[] = []
  private remoteSeq = 0

  constructor(private deps: SessionManagerDeps) {
    this.setIv = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
    this.clearIv = deps.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout))
    this.real =
      deps.realpath ??
      ((f) => {
        try {
          return fs.realpathSync(f)
        } catch {
          return f
        }
      })
    deps.relay?.onChange(() => this.onRelayChange())
    deps.relay?.onEvent((e) => this.onRelayEvent(e))
  }

  open(
    paneId: string,
    file: string,
    history: ChatMessage[],
    meta: SessionMeta,
    named: string | null = null,
  ): void {
    const key = this.real(file)
    const existing = this.panes.get(paneId)
    if (existing?.transport) {
      // A live session keeps its reducer when the same file is opened again.
      if (existing.key === key) return
      void this.release(existing)
    }
    if (existing) this.dropRemote(existing)
    const pane: Pane = {
      paneId,
      file,
      key,
      reducer: new LiveReducer(history, meta),
      batcher: new SeqBatcher(paneId),
      transport: null,
      starting: null,
      unsubscribe: null,
      timer: null,
      framesIn: 0,
      batches: 0,
      launch: { profile: null },
      draft: false,
      prompted: false,
      remote: null,
      named,
      title: null,
    }
    this.panes.set(paneId, pane)
    // A chat omp runs elsewhere shows through Relay from here on; its first batch goes out on the
    // pane's flush timer, after `chat.open` has answered.
    this.syncRemote(pane)
    this.syncSubscriptions()
  }

  /** A new chat: no file yet. The first send starts omp without --resume and binds on get_state. */
  openDraft(paneId: string, meta: SessionMeta): void {
    const existing = this.panes.get(paneId)
    if (existing?.transport) void this.release(existing)
    if (existing) this.dropRemote(existing)
    this.panes.set(paneId, {
      paneId,
      file: null,
      key: null,
      reducer: new LiveReducer([], meta),
      batcher: new SeqBatcher(paneId),
      transport: null,
      starting: null,
      unsubscribe: null,
      timer: null,
      framesIn: 0,
      batches: 0,
      launch: { profile: null },
      draft: true,
      prompted: false,
      remote: null,
      named: null,
      title: null,
    })
    this.syncSubscriptions()
  }

  /** The pane whose omp owns this session file, else null. */
  ownerOf(file: string): string | null {
    return this.owners.get(this.real(file))?.pane.paneId ?? null
  }

  /** Realpaths of every session file with a live owner. */
  liveFiles(): ReadonlySet<string> {
    return new Set(this.owners.keys())
  }

  /** Panes bound to a session file; `live` while this app holds an omp process for the pane. */
  paneFiles(): Array<{ paneId: string; file: string; live: boolean }> {
    const out: Array<{ paneId: string; file: string; live: boolean }> = []
    for (const p of this.panes.values()) {
      if (p.file !== null) out.push({ paneId: p.paneId, file: p.file, live: p.transport !== null })
    }
    return out
  }

  /** Whether a pane with an omp process this app holds is mid-reply. */
  anyWorking(): boolean {
    for (const p of this.panes.values()) if (p.transport !== null && p.reducer.running) return true
    return false
  }

  liveStatus(file: string): LiveStatus | null {
    const owner = this.owners.get(this.real(file))
    if (!owner) return null
    const d = owner.pane.reducer.dialog
    return {
      paneId: owner.pane.paneId,
      working: owner.pane.reducer.running,
      dialog: d ? dialogStatus(d) : null,
    }
  }

  /** Fires with the owned file's realpath on owner add or remove, working toggle and bind. */
  onStatusChange(cb: (file: string) => void): () => void {
    this.statusListeners.add(cb)
    return () => {
      this.statusListeners.delete(cb)
    }
  }

  private notify(key: string | null): void {
    if (key === null) return
    const mem = this.remembered.get(key)
    if (mem !== undefined) {
      const current = this.owners.get(key)?.pane.paneId ?? null
      if (current !== (mem === 'external' ? null : mem)) this.remembered.delete(key)
    }
    for (const cb of [...this.statusListeners]) {
      try {
        cb(key)
      } catch {
        // a listener must not break frame handling
      }
    }
  }

  /** Renames through the owning process (single writer): false when this app does not own it. */
  async renameOwned(file: string, name: string): Promise<boolean> {
    const owner = this.owners.get(this.real(file))
    if (!owner) return false
    await owner.transport.write({ type: 'set_session_name', name })
    return true
  }

  has(file: string): boolean {
    return this.owners.has(this.real(file))
  }

  private pane(paneId: string): Pane {
    const p = this.panes.get(paneId)
    if (!p) throw new CodedError('no-session', 'Open a session before sending a message.')
    return p
  }

  private statMtime(file: string): number | null {
    if (this.deps.stat) return this.deps.stat(file)
    try {
      return fs.statSync(file).mtimeMs
    } catch {
      return null
    }
  }

  /**
   * Single-writer guard for a pane that does not run omp itself. Returns the owning process
   * when a confirmed send must go through it, null when this pane may start its own, and
   * throws `owned-elsewhere` while the user has not confirmed.
   */
  private writerFor(pane: Pane, force: boolean): Owner | null {
    if (pane.transport || pane.starting || pane.key === null) return null
    const key = pane.key
    const owner = this.owners.get(key)
    if (owner && owner.pane.paneId !== pane.paneId && !owner.closing) {
      if (this.remembered.get(key) !== owner.pane.paneId) {
        if (!force) throw new CodedError('owned-elsewhere', OWNED_ELSEWHERE)
        this.remembered.set(key, owner.pane.paneId)
      }
      // Never a second process for a file this app already runs (T-04-54).
      if (owner.pane.transport !== owner.transport) {
        throw new CodedError('already-owned', ALREADY_OWNED)
      }
      return owner
    }
    // A file written in the last minutes may be open in an omp elsewhere; with Relay up, a session
    // Relay does not list runs nowhere it can hear (native blocked()).
    if (!owner && !this.remembered.has(key) && !this.relayUp()) {
      const mtime = this.statMtime(pane.file ?? key)
      const now = (this.deps.now ?? Date.now)()
      if (mtime !== null && isRecentlyActive(mtime, now)) {
        if (!force) throw new CodedError('owned-elsewhere', MAYBE_RUNNING_ELSEWHERE)
        this.remembered.set(key, 'external')
      }
    } else if (!owner && force) {
      this.remembered.set(key, 'external')
    }
    return null
  }

  async send(
    paneId: string,
    text: string,
    opts: { images?: ReadonlyArray<{ mimeType: string; data: string }>; force?: boolean } = {},
  ): Promise<void> {
    const pane = this.pane(paneId)
    const goal = !opts.images?.length && goalCommand(text) !== null
    const route = this.remoteRoute(pane, opts.force === true, goal)
    if (route === 'relay') return this.replyAway(pane, text, opts.images)
    if (route === 'queue') return this.queueFirst(pane, text, opts.images)
    if (route === 'herdr') return this.startInHerdr(pane, text, opts.images)
    if (route === 'mini') return this.startOnMini(pane, text, opts.images, null)
    if (route === 'resume') return this.startOnMini(pane, text, opts.images, sessionId(pane.file!))
    const routed = this.writerFor(pane, opts.force === true)
    if (routed) {
      await this.deliver(routed.pane, routed.transport, text, opts.images)
      return
    }
    const live = pane.transport
    if (live && !pane.starting) {
      await this.deliver(pane, live, text, opts.images)
      return
    }
    // omp is not up yet (a new chat, or a stopped one): show the prompt now, not after the spawn
    // and handshake. No flush timer runs before the process does, so this batch goes out at once.
    const row = this.echo(pane, text, opts.images)
    this.flush(pane)
    let transport: ChatTransport | null
    try {
      if (pane.starting) await pane.starting
      else {
        pane.starting = this.startTransport(pane).finally(() => {
          pane.starting = null
        })
        await pane.starting
      }
      // The pane may have been closed, replaced or lost its process while the start was awaited.
      transport = pane.transport
      if (!transport) throw new CodedError('session-closed', 'The session is not running.')
    } catch (e) {
      this.takeBack(pane, row.id)
      throw e
    }
    await this.writePrompt(pane, transport, row.id, text, opts.images)
  }

  // Sessions omp runs outside this app, read from their files and driven through Relay.

  private relayUp(): boolean {
    return (this.deps.relay?.sessions() ?? null) !== null
  }

  /** Session `id` as Relay lists it, unless it ended. */
  private liveSession(id: string): RelaySession | null {
    const s = this.deps.relay?.sessions()?.get(id)
    return s && s.status !== 'ended' ? s : null
  }

  /** The omp running this pane's file outside this app, as Relay hears it (native `away`). */
  private awayOf(pane: Pane): RelaySession | null {
    // A new Mini chat is known by its session id until its mirrored file shows up.
    const id = pane.file !== null ? sessionId(pane.file) : pane.remote?.session
    if (!id || pane.transport || pane.starting) return null
    if (pane.key !== null && this.owners.has(pane.key)) return null
    return this.liveSession(id)
  }

  /** A new herdr chat still waiting to send a prompt. */
  private firstPending(session: string | null): boolean {
    return session !== null && this.firsts.some((f) => f.session === session)
  }

  /**
   * Where a send from a pane with no omp of its own goes: into the session running elsewhere
   * through Relay, behind a new herdr chat's first prompt, or into a new herdr chat. Null: a local
   * omp (today's path), including the takeover when Relay can't reach the session and Isaac
   * chose to continue anyway (native blocked() and force_continue). A new chat opened with
   * `/goal` starts locally: only omp's RPC can set a goal, and a herdr chat is reached by prompt.
   */
  private remoteRoute(
    pane: Pane,
    force: boolean,
    goal: boolean,
  ): 'relay' | 'queue' | 'herdr' | 'mini' | 'resume' | null {
    if (pane.transport || pane.starting) return null
    const r = pane.remote
    // Remote mode never falls back to a local omp: a past chat is resumed on the Mini.
    if (this.deps.mini) {
      if (r?.away) {
        if (r.away.canRespond) return 'relay'
        throw new CodedError('owned-elsewhere', MINI_CANT_REACH)
      }
      if (r) return 'queue'
      if (pane.key === null && goal) throw new CodedError('mini-goal', MINI_GOAL)
      if (!this.relayUp()) throw new CodedError('relay-failed', MINI_DOWN)
      return pane.key === null ? 'mini' : 'resume'
    }
    if (r?.away) {
      if (r.away.canRespond) return 'relay'
      if (!force) throw new CodedError('owned-elsewhere', CANT_REACH)
      this.leaveRemote(pane)
      return null
    }
    if (r) return 'queue'
    const local =
      pane.key !== null || !pane.draft || pane.prompted || goal || this.harnessOf(pane) !== 'omp'
    if (local) return null
    const why = !this.deps.herdr
      ? "herdr isn't available"
      : !this.relayUp()
        ? "Relay isn't connected"
        : null
    if (why === null) return 'herdr'
    this.deps.log?.(`New chat starts as a local omp: ${why}.`)
    return null
  }

  /** Sends text and images into a session omp runs elsewhere (native reply_away). */
  private async replyAway(
    pane: Pane,
    text: string,
    images: ReadonlyArray<{ mimeType: string; data: string }> | undefined,
  ): Promise<void> {
    const session = pane.remote!.away!.id
    const sending = relayImagesOrThrow(images)
    const sent = this.addPrompt(pane, text, images)
    try {
      await this.deps.relay!.command(
        replyCommand(
          session,
          tagged(text, this.deps.machineLabel, this.deps.surfaceDetail?.()),
          sending,
        ),
      )
    } catch (e) {
      this.dropPrompt(pane, sent)
      throw relayFailure(e)
    }
    pane.prompted = true
  }

  /** A send while herdr starts a new chat's omp waits behind its first prompt. */
  private async queueFirst(
    pane: Pane,
    text: string,
    images: ReadonlyArray<{ mimeType: string; data: string }> | undefined,
  ): Promise<void> {
    const r = pane.remote!
    const queued = {
      text: tagged(text, this.deps.machineLabel, this.deps.surfaceDetail?.()),
      images: relayImagesOrThrow(images),
    }
    if (r.session === null) {
      this.addPrompt(pane, text, images, queued)
      return
    }
    const prompt = this.addPrompt(pane, text, images)
    this.firsts.push({ session: r.session, prompt, ...queued })
    await this.flushFirsts()
  }

  /**
   * Starts a new chat in its own herdr workspace, then sends its prompt through Relay once its omp
   * joins (native start_in_herdr). Meanwhile the pane shows the prompt and `Starting omp in herdr`.
   */
  private async startInHerdr(
    pane: Pane,
    text: string,
    images: ReadonlyArray<{ mimeType: string; data: string }> | undefined,
  ): Promise<void> {
    const queued = {
      text: tagged(text, this.deps.machineLabel, this.deps.surfaceDetail?.()),
      images: relayImagesOrThrow(images),
    }
    const args = this.startArgs(pane, 'omp') ?? []
    const r = this.enterRemote(pane, null)
    this.addPrompt(pane, text, images, queued)
    pane.prompted = true
    let file: string
    try {
      file = await this.deps.herdr!({ args, profile: pane.launch.profile })
      if (!path.isAbsolute(file) || !file.endsWith('.jsonl')) {
        throw new Error(`herdr reported an unexpected session file: ${file}`)
      }
    } catch (e) {
      // The prompt goes back to the composer, and the reason shows under it.
      if (pane.remote === r) {
        pane.prompted = false
        this.leaveRemote(pane)
      }
      const said = e instanceof Error ? e.message : String(e)
      throw new CodedError('herdr-failed', `Couldn't start omp in herdr: ${said}`)
    }
    const session = sessionId(file)
    // Its prompts go out once omp joins Relay, even if Isaac moved on meanwhile.
    for (const prompt of r.prompts) {
      if (prompt.queued === undefined) continue
      this.firsts.push({ session, prompt, ...prompt.queued })
      delete prompt.queued
    }
    if (this.panes.get(pane.paneId) === pane && pane.remote === r) {
      r.session = session
      pane.file = file
      pane.key = this.realNew(file)
      pane.batcher.markMeta({ sessionFile: file })
    }
    this.onRelayChange()
  }

  /**
   * Starts omp on the Mini for a new chat, or with `resume` reopens that past chat there, then
   * sends the prompt through Relay once it joins. A new chat's file arrives through the mirror.
   */
  private async startOnMini(
    pane: Pane,
    text: string,
    images: ReadonlyArray<{ mimeType: string; data: string }> | undefined,
    resume: string | null,
  ): Promise<void> {
    const queued = {
      text: tagged(text, this.deps.machineLabel, this.deps.surfaceDetail?.()),
      images: relayImagesOrThrow(images),
    }
    const prompted = pane.prompted
    const r = this.enterRemote(pane, null)
    this.addPrompt(pane, text, images, queued)
    pane.prompted = true
    let session: string
    try {
      session = await this.deps.mini!.start({
        ...(resume !== null ? { resume } : {}),
        profile: pane.launch.profile,
        ...(pane.launch.thinking !== undefined ? { thinking: pane.launch.thinking } : {}),
      })
    } catch (e) {
      if (pane.remote === r) {
        pane.prompted = prompted
        this.leaveRemote(pane)
      }
      const said = e instanceof Error ? e.message : String(e)
      throw new CodedError('mini-failed', `Couldn't start omp on the Mini: ${said}`)
    }
    for (const prompt of r.prompts) {
      if (prompt.queued === undefined) continue
      this.firsts.push({ session, prompt, ...prompt.queued })
      delete prompt.queued
    }
    if (this.panes.get(pane.paneId) === pane && pane.remote === r) r.session = session
    this.onRelayChange()
  }

  /** Shows a prompt sent through Relay (or waiting to be) until the session file has it. */
  private addPrompt(
    pane: Pane,
    text: string,
    images: ReadonlyArray<{ mimeType: string; data: string }> | undefined,
    queued?: SentPrompt['queued'],
  ): SentPrompt {
    const r = pane.remote!
    this.remoteSeq += 1
    const sent: SentPrompt = {
      row: promptRow(`sent-relay-${this.remoteSeq}`, text, images),
      baseline: promptCount(r.history, text),
      ...(queued ? { queued } : {}),
    }
    r.prompts.push(sent)
    if (pane.reducer.error !== null) {
      pane.reducer.error = null
      pane.batcher.markMeta({ error: null })
    }
    this.render(pane)
    this.flush(pane)
    return sent
  }

  /** Takes back a prompt Relay never took. */
  private dropPrompt(pane: Pane, sent: SentPrompt): void {
    if (!pane.remote) return
    pane.remote.prompts = pane.remote.prompts.filter((p) => p !== sent)
    this.render(pane)
    this.flush(pane)
  }

  private enterRemote(pane: Pane, session: string | null): Remote {
    const r: Remote = {
      session,
      history: pane.reducer.messages().slice(),
      prompts: [],
      notes: [],
      away: null,
      view: null,
      connected: false,
    }
    pane.remote = r
    if (pane.timer === null) {
      pane.timer = this.setIv(() => this.flush(pane), this.deps.intervalMs ?? 16)
    }
    return r
  }

  /** The pane shows a saved session again: Relay's rows go, the file's stay. */
  private leaveRemote(pane: Pane): void {
    const r = pane.remote
    if (!r) return
    pane.remote = null
    this.applyRows(pane, [...r.history, ...r.notes])
    if (pane.reducer.working) {
      pane.reducer.working = false
      pane.batcher.markMeta({ running: false })
    }
    if (pane.reducer.dialog) {
      pane.reducer.dialog = null
      pane.batcher.markMeta({ dialog: null })
    }
    if (r.view !== null) pane.batcher.markMeta({ away: null })
    if (r.connected) pane.batcher.markMeta({ connected: false })
    this.flush(pane)
    if (!pane.transport && pane.timer !== null) {
      this.clearIv(pane.timer)
      pane.timer = null
    }
  }

  /** A pane being replaced: its flush timer stops and nothing more goes out under its seq. */
  private dropRemote(pane: Pane): void {
    if (!pane.remote) return
    pane.remote = null
    if (!pane.transport && pane.timer !== null) {
      this.clearIv(pane.timer)
      pane.timer = null
    }
  }

  private applyRows(pane: Pane, rows: ChatMessage[]): void {
    const res = pane.reducer.replaceRows(rows)
    for (const id of res.removed) pane.batcher.markRemove(id)
    if (res.dirty.length === 0) return
    const at = new Map(rows.map((r, i) => [r.id, i]))
    for (const id of res.dirty) {
      const ix = at.get(id)!
      pane.batcher.markUpsert(rows[ix]!, ix)
    }
  }

  /** Shows the pane's outside session as its file and Relay have it now. */
  private render(pane: Pane): void {
    const r = pane.remote
    if (!r) return
    const live = r.away ? r.away.id : null
    const blocker = live === null ? undefined : this.blockers.get(live)
    const dialog = blocker ? blockerDialog(blocker) : null
    const starting =
      r.session === null || this.firstPending(r.session)
        ? this.deps.mini
          ? MINI_STARTING_TEXT
          : STARTING_TEXT
        : null
    this.applyRows(
      pane,
      remoteRows({
        history: r.history,
        notes: r.notes,
        dialog,
        prompts: r.prompts,
        starting,
        stream: live === null ? null : (this.streams.get(live) ?? null),
      }),
    )
    const running = r.away?.status === 'working'
    if (pane.reducer.working !== running) {
      pane.reducer.working = running
      pane.batcher.markMeta({ running })
    }
    if (pane.reducer.dialog?.id !== dialog?.id) {
      pane.reducer.dialog = dialog
      pane.batcher.markMeta({ dialog })
    }
    const view: AwayView | null = r.away
      ? { job: r.away.kind === 'job' }
      : starting
        ? { job: false }
        : null
    if (view?.job !== r.view?.job || (view === null) !== (r.view === null)) {
      r.view = view
      pane.batcher.markMeta({ away: view })
    }
    // The session's name: omp's own in its file, else what Relay calls it (native look::title).
    const title = pane.named ?? (r.away?.title || null)
    if (title !== null && title !== pane.title) {
      pane.title = title
      pane.batcher.markMeta({ title })
    }
    const connected = r.away !== null
    if (connected !== r.connected) {
      r.connected = connected
      pane.batcher.markMeta({ connected })
    }
  }

  /** Puts the pane in or out of Relay's hands as Relay and this app's own processes change. */
  private syncRemote(pane: Pane): void {
    const away = this.awayOf(pane)
    const r = pane.remote
    if (!r) {
      if (away === null) return
      this.enterRemote(pane, away.id).away = away
    } else {
      if (away === null && r.session !== null && !this.firstPending(r.session)) {
        this.leaveRemote(pane)
        return
      }
      r.away = away
    }
    this.render(pane)
  }

  /** One subscription per session a pane shows through Relay (native sync_relay). */
  private syncSubscriptions(): void {
    const relay = this.deps.relay
    if (!relay) return
    const want = new Set<string>()
    for (const p of this.panes.values()) if (p.remote?.away) want.add(p.remote.away.id)
    for (const id of this.subscribed) {
      if (want.has(id)) continue
      relay.unsubscribe(id)
      this.streams.delete(id)
      this.blockers.delete(id)
    }
    for (const id of want) if (!this.subscribed.has(id)) relay.subscribe(id)
    this.subscribed = want
  }

  private onRelayChange(): void {
    if (!this.relayUp()) {
      // Down: what Relay said about streams, questions and approvals no longer holds.
      this.streams.clear()
      this.blockers.clear()
    }
    for (const pane of this.panes.values()) this.syncRemote(pane)
    this.syncSubscriptions()
    void this.flushFirsts()
  }

  private onRelayEvent(e: RelaySessionEvent): void {
    if (!this.subscribed.has(e.session)) return
    switch (e.kind) {
      case 'stream':
        this.streams.set(e.session, { id: e.id, text: e.text, streaming: e.streaming })
        break
      case 'ask':
        this.blockers.set(e.session, { kind: 'ask', ask: e.ask })
        break
      case 'approval':
        this.blockers.set(e.session, { kind: 'approval', approval: e.approval })
        break
      case 'askResolved':
        this.settle(e.session, `ask:${e.id}`)
        break
      case 'approvalResolved':
        this.settle(e.session, `approval:${e.id}`)
        break
    }
    this.renderSession(e.session)
  }

  /** Card `dialogId` closed, here or elsewhere; one answered here leaves its answer in the log. */
  private settle(session: string, dialogId: string): void {
    const b = this.blockers.get(session)
    if (b && blockerDialog(b).id === dialogId) this.blockers.delete(session)
    const summary = this.answering.get(dialogId)
    if (summary === undefined) return
    this.answering.delete(dialogId)
    const note = makeMessage(dialogRowId(dialogId), 'notice', `Answered: ${summary}`)
    for (const pane of this.panes.values()) {
      const r = pane.remote
      if (r?.session === session) r.notes = [...r.notes.filter((n) => n.id !== note.id), note]
    }
  }

  private renderSession(session: string): void {
    for (const pane of this.panes.values()) {
      if (pane.remote?.session === session) this.render(pane)
    }
  }

  /** Sends each herdr chat's queued prompts once its omp has joined Relay (native flush_firsts). */
  private async flushFirsts(): Promise<void> {
    const relay = this.deps.relay
    const sessions = relay?.sessions()
    if (!relay || !sessions) return
    const ready = this.firsts.filter((f) => sessions.get(f.session)?.canRespond === true)
    if (ready.length === 0) return
    this.firsts = this.firsts.filter((f) => !ready.includes(f))
    for (const f of ready) this.renderSession(f.session)
    for (const f of ready) {
      try {
        await relay.command(replyCommand(f.session, f.text, f.images))
      } catch (e) {
        const error = relayFailure(e).message
        for (const pane of this.panes.values()) {
          const r = pane.remote
          if (r?.session !== f.session) continue
          r.prompts = r.prompts.filter((p) => p !== f.prompt)
          pane.reducer.error = error
          pane.batcher.markMeta({ error })
          this.render(pane)
        }
      }
    }
  }

  /** Re-reads the files outside chats show as they grow (native apply_changes). */
  filesChanged(files: readonly string[]): void {
    const changed = new Set(files.map((f) => this.real(f)))
    for (const pane of this.panes.values()) {
      const r = pane.remote
      if (!r) continue
      // A new Mini chat binds to its file once the mirror has it.
      const bound = pane.file === null ? files.find((f) => sessionId(f) === r.session) : undefined
      if (bound !== undefined && r.session !== null) {
        pane.file = bound
        pane.key = this.real(bound)
        pane.batcher.markMeta({ sessionFile: bound })
      }
      if (pane.file === null || pane.key === null || !changed.has(pane.key)) continue
      const parsed = (this.deps.readSession ?? readSessionFile)(pane.file)
      if (parsed) this.reread(pane, r, parsed)
    }
  }

  private reread(pane: Pane, r: Remote, parsed: ParsedSession): void {
    // A rename only appends a title record: the name follows without a new message.
    pane.named = parsed.named
    if (JSON.stringify(parsed.messages) !== JSON.stringify(r.history)) {
      r.history = parsed.messages
      r.notes = []
      // A prompt sent from here shows until the file has one more of it than when it was sent.
      r.prompts = r.prompts.filter((p) => promptCount(r.history, p.row.text) <= p.baseline)
      // The file has the streamed reply now (native drops a finished stream on reread).
      if (r.session !== null && this.streams.get(r.session)?.streaming === false) {
        this.streams.delete(r.session)
      }
    }
    const meta = pane.reducer.setMeta({
      model: parsed.meta.model,
      thinking: parsed.meta.thinking,
      contextTokens: parsed.meta.contextTokens,
      // A session on the Mini reports a share of its window, not the window; the file has the tokens.
      contextWindow: windowFromShare(
        parsed.meta.contextTokens,
        r.session !== null ? this.liveSession(r.session)?.contextUsed : null,
      ),
    })
    if (Object.keys(meta).length > 0) pane.batcher.markMeta(meta)
    // A model or thinking level sent through Relay shows until the file records it.
    const m = pane.launch.model
    if (m && parsed.meta.model?.[0] === m[0] && parsed.meta.model[1] === m[1]) {
      delete pane.launch.model
    }
    if (pane.launch.thinking !== undefined && parsed.meta.thinking === pane.launch.thinking) {
      delete pane.launch.thinking
    }
    this.render(pane)
  }

  /** Renames a session running outside this app through Relay; false when Relay can't reach it. */
  async renameAway(file: string, name: string): Promise<boolean> {
    const relay = this.deps.relay
    if (!relay || this.owners.has(this.real(file))) return false
    const s = this.liveSession(sessionId(file))
    if (!s?.canRespond) return false
    await relay.command(configureCommand(s.id, { title: name })).catch((e: unknown) => {
      throw relayFailure(e)
    })
    return true
  }

  /** Switches a session running elsewhere; its file shows the change (native configure_away). */
  private async configureAway(
    pane: Pane,
    session: string,
    patch: LaunchPatch,
  ): Promise<LaunchState> {
    if (patch.profile !== undefined && patch.profile !== pane.launch.profile) {
      throw new CodedError('not-unsent', NOT_UNSENT)
    }
    if (patch.approval !== undefined || patch.fast !== undefined) {
      throw new CodedError('away-setting', AWAY_SETTING)
    }
    const model =
      patch.model !== undefined ? ([patch.model.provider, patch.model.modelId] as const) : undefined
    if (model !== undefined || patch.thinking !== undefined) {
      await this.deps
        .relay!.command(
          configureCommand(session, {
            ...(model !== undefined ? { model } : {}),
            ...(patch.thinking !== undefined ? { thinking: patch.thinking } : {}),
          }),
        )
        .catch((e: unknown) => {
          throw relayFailure(e)
        })
      if (model !== undefined) pane.launch.model = model
      if (patch.thinking !== undefined) pane.launch.thinking = patch.thinking
    }
    return this.launchState(pane.paneId)
  }

  /** Stops a session running elsewhere; a question or approval it waits on is cancelled first. */
  private async abortAway(pane: Pane, session: string): Promise<boolean> {
    const relay = this.deps.relay!
    const b = this.blockers.get(session)
    const cancel = b ? answerFor(session, b, { kind: 'cancel' }) : null
    if (b && cancel) {
      const cancelled = await relay.command(cancel.cmd).then(
        () => true,
        () => false,
      )
      if (cancelled) {
        this.settle(session, blockerDialog(b).id)
        this.renderSession(session)
      }
    }
    try {
      await relay.command({ kind: 'agent.abort', sessionId: session })
    } catch (e) {
      pane.reducer.error = relayFailure(e, 'stop it').message
      pane.batcher.markMeta({ error: pane.reducer.error })
      this.flush(pane)
      return false
    }
    return true
  }

  /** Answers the card of a session running elsewhere through Relay. */
  private async answerAway(session: string, id: string, answer: DialogAnswer): Promise<boolean> {
    const b = this.blockers.get(session)
    if (!b || blockerDialog(b).id !== id) return false
    const plan = answerFor(session, b, answer)
    if (!plan) return false
    // Q6: the laptop never vouches for a destructive call; the phone or the Mini approves it.
    if (this.deps.mini && plan.cmd.kind === 'agent.approve') {
      if (b.kind === 'approval' && b.approval.destructive !== null) {
        throw new CodedError('approve-on-phone', APPROVE_ON_PHONE)
      }
      delete plan.cmd.confirmed
    }
    this.answering.set(id, plan.summary)
    try {
      await this.deps.relay!.command(plan.cmd)
    } catch (e) {
      this.answering.delete(id)
      throw relayFailure(e)
    }
    // Carried out; Relay's resolved frame may still be on its way.
    this.settle(session, id)
    this.renderSession(session)
    return true
  }

  /** Echoes the prompt row into `pane` and writes it to `transport`. */
  private async deliver(
    pane: Pane,
    transport: ChatTransport,
    text: string,
    images: ReadonlyArray<{ mimeType: string; data: string }> | undefined,
  ): Promise<void> {
    const row = this.echo(pane, text, images)
    await this.writePrompt(pane, transport, row.id, text, images)
  }

  /** Shows the prompt as an unconfirmed row; omp's echo of it replaces the row in place. */
  private echo(
    pane: Pane,
    text: string,
    images: ReadonlyArray<{ mimeType: string; data: string }> | undefined,
  ): ChatMessage {
    // sendPrompt() runs outside apply(), so its meta changes (clearing an EOF error, a `/handoff`
    // starting) are diffed here.
    const hadError = pane.reducer.error !== null
    const wasWorking = pane.reducer.running
    const wasHandingOff = pane.reducer.handingOff
    const row = pane.reducer.sendPrompt(text, images)
    if (pane.reducer.running !== wasWorking) this.notify(pane.key)
    if (hadError) pane.batcher.markMeta({ error: null })
    if (pane.reducer.handingOff !== wasHandingOff) pane.batcher.markMeta({ handingOff: true })
    pane.batcher.markUpsert(row, pane.reducer.indexOf(row.id))
    return row
  }

  /**
   * Writes an echoed prompt to omp. omp's RPC `prompt` does not run `/goal`, so a `/goal` without
   * images goes as the RPC `goal` command instead (native chat.rs goal_command); omp's response
   * takes the row back.
   */
  private async writePrompt(
    pane: Pane,
    transport: ChatTransport,
    rowId: string,
    text: string,
    images: ReadonlyArray<{ mimeType: string; data: string }> | undefined,
  ): Promise<void> {
    pane.prompted = true
    try {
      const goal = transport.kind !== 'claude' && !images?.length ? goalCommand(text) : null
      if (goal) {
        await transport.write(goal)
        return
      }
      const promptImages: PromptImage[] | undefined =
        images && images.length > 0
          ? images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }))
          : undefined
      await transport.send(
        tagged(text, this.deps.machineLabel, this.deps.surfaceDetail?.()),
        promptImages,
      )
    } catch (e) {
      // omp never received the prompt (EPIPE after exit, for example).
      this.takeBack(pane, rowId)
      throw e
    }
  }

  /**
   * Takes back a prompt omp never received, so it does not sit there unconfirmed forever; the
   * caller's rejection gives the text back to the composer with the error banner. Without a
   * flush timer (the start failed, or omp already exited) the removal is sent at once. A pane
   * replaced meanwhile stays inert: its seq is ahead of the new pane's.
   */
  private takeBack(pane: Pane, id: string): void {
    const row = pane.reducer.messages()[pane.reducer.indexOf(id)]
    if (pane.reducer.dropUnconfirmedRow(id)) {
      pane.batcher.markRemove(id)
      if (pane.reducer.handingOff && row && isHandoff(row.text)) {
        pane.reducer.handingOff = false
        pane.batcher.markMeta({ handingOff: false })
      }
    }
    if (pane.timer === null && this.panes.get(pane.paneId) === pane) this.flush(pane)
  }

  /**
   * Waits for a previous process on the same file to finish closing, then claims the file for a
   * new transport. The free check and the claim run in one synchronous step (no await between
   * them), so two panes released by the same close cannot both find the file free: the second
   * is refused with `already-owned` (another pane's live process, or one whose close timed out
   * and is still running). A pane replaced while it waited never claims.
   */
  private async acquire(pane: Pane): Promise<ChatTransport> {
    if (pane.key === null) {
      // An unbound draft has no file to collide on: the owner is registered when omp reports it.
      if (this.panes.get(pane.paneId) !== pane) {
        throw new CodedError('session-closed', 'The session was closed before omp started.')
      }
      return this.deps.createTransport()
    }
    const key = pane.key
    for (;;) {
      const owner = this.owners.get(key)
      if (owner?.closing) {
        await owner.closing
        continue
      }
      if (this.panes.get(pane.paneId) !== pane) {
        throw new CodedError('session-closed', 'The session was closed before omp started.')
      }
      if (owner) {
        // By paneId, not pane object: open() replaces the Pane, but the same pane's own omp
        // still exiting after a timed-out close is "still closing", not "another pane".
        throw new CodedError(
          'already-owned',
          owner.pane.paneId === pane.paneId ? STILL_CLOSING : ALREADY_OWNED,
        )
      }
      const transport = this.deps.createTransport()
      this.owners.set(key, { pane, transport, closing: null })
      this.notify(key)
      return transport
    }
  }

  private disown(key: string | null, transport: ChatTransport): void {
    if (key === null) return
    if (this.owners.get(key)?.transport === transport) {
      this.owners.delete(key)
      this.notify(key)
    }
  }

  /** Realpath of a file omp is about to create: its directory is resolved when the file is not there yet. */
  private realNew(file: string): string {
    const direct = this.real(file)
    if (direct !== file) return direct
    return path.join(this.real(path.dirname(file)), path.basename(file))
  }

  /**
   * A draft's `get_state` reports the session file omp created. Bind the pane to it and register
   * the owner. Only an absolute `.jsonl` path is accepted (T-04-31). When another pane already
   * owns that file the draft keeps running unregistered: no second owner, no second process.
   */
  private bindDraft(pane: Pane, transport: ChatTransport, raw: Record<string, unknown>): void {
    if (pane.key !== null || raw.type !== 'response' || raw.command !== 'get_state') return
    if (raw.success === false) return
    const data = raw.data
    const file =
      typeof data === 'object' && data !== null
        ? (data as Record<string, unknown>).sessionFile
        : undefined
    if (typeof file !== 'string' || !path.isAbsolute(file) || !file.endsWith('.jsonl')) return
    const key = this.realNew(file)
    if (this.owners.has(key)) return
    pane.file = file
    pane.key = key
    this.owners.set(key, { pane, transport, closing: null })
    pane.batcher.markMeta({ sessionFile: file })
    this.notify(key)
  }

  /**
   * Flags for the next start. Nothing chosen: a resumed chat keeps the session's own choices and
   * a new chat gets the configured defaults. Anything chosen: the full Launch, in omp's order.
   */
  private startArgs(pane: Pane, harness: Harness): string[] | undefined {
    const l = pane.launch
    const chosen =
      l.approval !== undefined ||
      l.model !== undefined ||
      l.thinking !== undefined ||
      l.profile !== null
    if (!chosen) return pane.key === null ? this.deps.launchArgs?.(harness) : undefined
    const launch: Launch = {
      approval: l.approval ?? this.deps.defaultApproval?.(harness) ?? 'yolo',
      profile: l.profile,
      ...(l.model !== undefined ? { model: l.model } : {}),
      ...(l.thinking !== undefined ? { thinking: l.thinking } : {}),
    }
    return harness === 'claude' ? claudeArgs(launch) : ompArgs(launch)
  }

  private harnessOf(pane: Pane): Harness {
    if (pane.transport) return pane.transport.kind === 'claude' ? 'claude' : 'omp'
    // Relay and herdr only carry omp sessions.
    if (pane.remote) return 'omp'
    return this.deps.harness?.() ?? 'omp'
  }

  /** The toolbar's view of one pane: what is chosen, whether the account can still be picked. */
  launchState(paneId: string): LaunchState {
    const pane = this.pane(paneId)
    const harness = this.harnessOf(pane)
    const meta = pane.reducer.meta()
    // With a live process omp's confirmed values win; without one the user's pending choice does.
    const live = pane.transport !== null
    const model =
      (live ? (meta.model ?? pane.launch.model) : (pane.launch.model ?? meta.model)) ?? null
    const known = model
      ? this.deps.models?.()?.find((m) => m.provider === model[0] && m.id === model[1])
      : undefined
    return {
      approval: pane.launch.approval ?? this.deps.defaultApproval?.(harness) ?? 'yolo',
      profile: pane.launch.profile,
      model: model ? [model[0], model[1]] : null,
      thinking:
        (live
          ? (meta.thinking ?? pane.launch.thinking)
          : (pane.launch.thinking ?? meta.thinking)) ?? null,
      fast: pane.launch.fast ?? false,
      unsent: pane.draft && !pane.prompted,
      harness,
      imagesAllowed: known ? known.images : true,
    }
  }

  /**
   * Applies a toolbar choice: live model, thinking and fast go to omp as commands; access
   * restarts an idle omp on the same file (stdin closed, never signalled); the account is only
   * for a new chat before its first prompt. With no process the choice is kept for the next start.
   */
  async setLaunch(paneId: string, patch: LaunchPatch): Promise<LaunchState> {
    const pane = this.pane(paneId)
    if (pane.remote?.away) return this.configureAway(pane, pane.remote.away.id, patch)
    if (patch.profile !== undefined && patch.profile !== pane.launch.profile) {
      if (!(pane.draft && !pane.prompted) || this.harnessOf(pane) !== 'omp') {
        throw new CodedError('not-unsent', NOT_UNSENT)
      }
    }
    const current = this.launchState(paneId).approval
    const restart =
      patch.approval !== undefined && patch.approval !== current && pane.transport !== null
    if (restart && (pane.reducer.running || pane.starting)) {
      throw new CodedError('busy', BUSY_ACCESS)
    }
    if (patch.profile !== undefined) pane.launch.profile = patch.profile
    if (patch.model !== undefined) pane.launch.model = [patch.model.provider, patch.model.modelId]
    if (patch.thinking !== undefined) pane.launch.thinking = patch.thinking
    if (patch.fast !== undefined) pane.launch.fast = patch.fast
    if (patch.approval !== undefined) pane.launch.approval = patch.approval

    const live = pane.transport
    if (live && !restart) {
      if (patch.model !== undefined) {
        await live.write({
          type: 'set_model',
          provider: patch.model.provider,
          modelId: patch.model.modelId,
        })
      }
      if (patch.thinking !== undefined) {
        await live.write({ type: 'set_thinking_level', level: patch.thinking })
      }
      if (patch.fast !== undefined) {
        await live.write({ type: 'set_fast_mode', enabled: patch.fast })
      }
    }
    if (restart) {
      await this.release(pane)
      if (this.panes.get(pane.paneId) === pane && !pane.transport) {
        pane.starting = this.startTransport(pane).finally(() => {
          pane.starting = null
        })
        await pane.starting
      }
    }
    return this.launchState(paneId)
  }

  private async startTransport(pane: Pane): Promise<void> {
    const transport = await this.acquire(pane)
    pane.transport = transport
    pane.unsubscribe = transport.onFrame((f) => this.onFrame(pane, transport, f))
    try {
      const harness = transport.kind === 'claude' ? 'claude' : 'omp'
      const args = this.startArgs(pane, harness)
      await transport.start({
        sessionFile: pane.key,
        cwd: this.deps.cwd,
        ...(args ? { args } : {}),
      })
    } catch (e) {
      pane.unsubscribe?.()
      pane.unsubscribe = null
      pane.transport = null
      this.disown(pane.key, transport)
      throw new CodedError(
        'spawn-failed',
        `Could not start omp: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    // `open()` on another file, `close()` or an early `_eof` may have detached this pane while
    // the spawn was awaited. The detach already handed the process to close() (or it is gone),
    // so the only thing left is to not install a timer or write a handshake on its behalf.
    const stillMine = (): boolean =>
      pane.transport === transport && this.panes.get(pane.paneId) === pane
    if (!stillMine()) {
      throw new CodedError('session-closed', 'The session was closed before omp started.')
    }
    pane.timer = this.setIv(() => this.flush(pane), this.deps.intervalMs ?? 16)
    pane.batcher.markMeta({ connected: true })
    await transport.write(cmd.setAskDialog('evaos-ask')).catch(() => undefined)
    await transport.write(cmd.getState('evaos-state')).catch(() => undefined)
    // Fast mode has no launch flag: apply the choice made before this process existed.
    if (pane.launch.fast !== undefined) {
      await transport
        .write({ type: 'set_fast_mode', enabled: pane.launch.fast })
        .catch(() => undefined)
    }
    if (!stillMine()) {
      throw new CodedError('session-closed', 'The session ended while it was starting.')
    }
  }

  /** Applied synchronously, one frame at a time: there is no await between reading and applying. */
  private onFrame(
    pane: Pane,
    transport: ChatTransport,
    raw: Record<string, unknown> & { type: string },
  ): void {
    pane.framesIn += 1
    const parsed = parseFrame(raw)
    const frame =
      parsed.type === 'unknown' ? raw : (parsed as Record<string, unknown> & { type: string })
    const wasWorking = pane.reducer.running
    const hadDialog = pane.reducer.dialog
    const res = pane.reducer.apply(frame)
    for (const id of res.dirty) {
      const ix = pane.reducer.indexOf(id)
      if (ix >= 0) pane.batcher.markUpsert(pane.reducer.messages()[ix]!, ix)
    }
    for (const id of res.removed) pane.batcher.markRemove(id)
    if (res.meta) pane.batcher.markMeta(res.meta)
    this.bindDraft(pane, transport, frame)
    if (pane.reducer.running !== wasWorking || pane.reducer.dialog !== hadDialog) {
      this.notify(pane.key)
    }
    if (res.effect) void pane.transport?.write(res.effect).catch(() => undefined)
    if (frame.type === '_eof') {
      // omp is already gone: nothing to close() and no second `_eof` to apply.
      pane.batcher.markMeta({ connected: false, running: false })
      this.flush(pane)
      this.disown(pane.key, transport)
      this.detach(pane)
    }
  }

  /**
   * Stops the flush timer and forgets the transport; never touches the process itself and
   * leaves file ownership alone (the process may still be writing until it exits).
   */
  private detach(pane: Pane): void {
    if (pane.timer !== null) this.clearIv(pane.timer)
    pane.timer = null
    pane.unsubscribe?.()
    pane.unsubscribe = null
    pane.transport = null
  }

  private flush(pane: Pane): void {
    const batch = pane.batcher.flush()
    if (!batch) return
    pane.batches += 1
    this.deps.emit(batch)
  }

  /**
   * Ends stdin and waits for omp to exit. Never signals (D-17). A timeout leaves the process
   * alone. The pane keeps its history and the next send starts a new process, but only once
   * this one has exited: the file stays owned through the close and, after a timeout, until
   * the process reports its `_eof`.
   */
  private async release(pane: Pane, timeoutMs = 2000): Promise<TransportExit | null> {
    const t = pane.transport
    if (!t) return null
    this.detach(pane)
    const current = pane.key === null ? undefined : this.owners.get(pane.key)
    const held = current?.transport === t ? current : null
    const done = t
      .close({ timeoutMs })
      .then(
        (e): TransportExit | null => e,
        (): TransportExit | null => null,
      )
      .then((exit) => {
        if (held) {
          held.closing = null
          if (exit && !exit.timedOut) this.disown(pane.key, t)
          else {
            // Still running (or unknown): keep the file until the process itself ends.
            const off = t.onFrame((f) => {
              if (f.type !== '_eof') return
              off()
              this.disown(pane.key, t)
            })
          }
        }
        return exit
      })
    if (held) held.closing = done
    const exit = await done
    // Only the pane still registered under this id may apply `_eof` and emit. A pane replaced
    // by `open()` on another file while omp was live must stay inert: its batcher's seq is
    // ahead of the new one and a late batch under the same paneId would strand the renderer.
    if (this.panes.get(pane.paneId) !== pane) return exit
    if (exit && !exit.timedOut) {
      // Our own unsubscribe means no `_eof` frame reached the reducer: apply it here.
      const res = pane.reducer.apply({
        type: '_eof',
        code: exit.code,
        signal: exit.signal,
        expected: true,
      })
      for (const id of res.dirty) {
        const ix = pane.reducer.indexOf(id)
        if (ix >= 0) pane.batcher.markUpsert(pane.reducer.messages()[ix]!, ix)
      }
      for (const id of res.removed) pane.batcher.markRemove(id)
      if (res.meta) pane.batcher.markMeta(res.meta)
      pane.batcher.markMeta({ connected: false, running: false })
      this.flush(pane)
    }
    return exit
  }

  /** `chat.close`: ends stdin and waits up to `timeoutMs` for exit (CHAT-07). */
  async close(paneId: string, timeoutMs = 10_000): Promise<TransportExit | null> {
    const pane = this.panes.get(paneId)
    if (!pane?.transport) return null
    return this.release(pane, timeoutMs)
  }

  /**
   * `chat.drop`: the pane went away (a tool pane's chat tab closed). Nothing more goes out under
   * its id, Relay stops being followed for it unless another pane still shows that session, and
   * an omp it ran has stdin closed like any pane leaving its chat.
   */
  async drop(paneId: string): Promise<void> {
    const pane = this.panes.get(paneId)
    if (!pane) return
    this.panes.delete(paneId)
    this.dropRemote(pane)
    this.syncSubscriptions()
    await this.release(pane)
  }

  /** Returns whether an abort command was written (false for unknown panes or stopped sessions). */
  async abort(paneId: string): Promise<boolean> {
    const pane = this.panes.get(paneId)
    if (pane?.remote?.away) return this.abortAway(pane, pane.remote.away.id)
    const t = pane?.transport
    if (!pane || !t) return false
    // omp must never stay blocked on a question the abort made moot: cancel it first.
    const d = pane.reducer.dialog
    if (d) {
      await t.write(dialogResponse(d.id, { kind: 'cancel' })).catch(() => undefined)
      this.applyDialogChange(pane, pane.reducer.cancelPending('abort'))
    }
    await t.abort().catch(() => undefined)
    return true
  }

  private applyDialogChange(
    pane: Pane,
    res: { dirty: string[]; meta?: import('@evaos/chat-core/batcher').MetaPatch },
  ): void {
    for (const id of res.dirty) {
      const ix = pane.reducer.indexOf(id)
      if (ix >= 0) pane.batcher.markUpsert(pane.reducer.messages()[ix]!, ix)
    }
    if (res.meta) pane.batcher.markMeta(res.meta)
    this.notify(pane.key)
  }

  /**
   * Answers the pane's pending dialog. False (and nothing written) when there is no pending
   * dialog with this id, so a stale or forged id can never answer a different question (T-04-40).
   */
  async answerUi(paneId: string, id: string, answer: DialogAnswer): Promise<boolean> {
    const pane = this.panes.get(paneId)
    if (pane?.remote?.away) return this.answerAway(pane.remote.away.id, id, answer)
    const t = pane?.transport
    const d = pane?.reducer.dialog
    if (!pane || !t || !d || d.id !== id) return false
    await t.write(dialogResponse(id, answer))
    // The write awaited: only the same dialog may be marked answered.
    if (pane.reducer.dialog?.id !== id) return true
    this.applyDialogChange(pane, pane.reducer.answer(id, answerSummary(answer)))
    return true
  }

  /** The goal strip's Pause, Resume and Drop: the RPC `goal` command. False without a local omp. */
  async goal(paneId: string, op: Extract<GoalOp, 'pause' | 'resume' | 'drop'>): Promise<boolean> {
    const t = this.panes.get(paneId)?.transport
    if (!t || t.kind === 'claude') return false
    await t.write({ type: 'goal', op })
    return true
  }

  snapshot(paneId: string): Snapshot {
    const p = this.pane(paneId)
    return p.batcher.snapshot(
      p.reducer.messages().slice(),
      { ...p.reducer.meta() },
      {
        running: p.reducer.running,
        connected: p.transport !== null || p.remote?.connected === true,
        error: p.reducer.error,
        dialog: p.reducer.dialog,
        goal: p.reducer.goal,
        handingOff: p.reducer.handingOff,
        away: p.remote?.view ?? null,
        ...(p.title !== null ? { title: p.title } : {}),
      },
    )
  }

  stats(paneId: string): { batches: number; lastSeq: number; framesIn: number } {
    const p = this.pane(paneId)
    return { batches: p.batches, lastSeq: p.batcher.currentSeq, framesIn: p.framesIn }
  }

  /** The pane's transport, for e2e stats. */
  transportOf(paneId: string): ChatTransport | null {
    return this.panes.get(paneId)?.transport ?? null
  }

  /** Quit hook: ends stdin on every live omp this app started. Never signals (D-17). */
  async closeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.panes.values()].filter((p) => p.transport).map((p) => this.release(p, 10_000)),
    )
  }
}

/** Why Relay didn't take a reply, a stop or an answer, as the banner says it. */
function relayFailure(e: unknown, what = 'send that'): CodedError {
  const said = e instanceof Error ? e.message : String(e)
  return new CodedError('relay-failed', `Relay couldn't ${what}. ${said}`)
}

/** A prompt's images as Relay takes them; a refusal says why before anything is sent. */
function relayImagesOrThrow(
  images: ReadonlyArray<{ mimeType: string; data: string }> | undefined,
): RelayImage[] {
  const out = relayImages(images ?? [])
  if (typeof out === 'string') throw new CodedError('relay-image', out)
  return out
}

function readSessionFile(file: string): ParsedSession | null {
  try {
    return parseSession(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
