import { attachResult, messagesFrom, oneLine } from './session'
import { makeMessage, type ChatMessage, type Goal, type SessionMeta } from './message'
import type { MetaPatch } from './batcher'
import { parseDialog, UNREADABLE_ASK_NOTICE, type Dialog } from './dialogs'
import { goalCommand, isHandoff } from './launch'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

const SENT = 'sent-'
const STDERR_LINES = 20
const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor', 'ask', 'cancel'])
export const DEAD_DIALOG_TEXT = 'This question can no longer be answered.'
export const EOF_ERROR =
  'The session ended unexpectedly. Output so far is kept. Resume the session to continue.'

export interface ApplyResult {
  dirty: string[]
  removed: string[]
  meta?: MetaPatch
  /** A command to write back to omp (a `type` without `id` gets one from the transport). */
  effect?: Json
}

/** A prompt shown before the session has it: unconfirmed, with its images inline. */
export function promptRow(
  id: string,
  text: string,
  images?: ReadonlyArray<{ mimeType: string; data: string }>,
): ChatMessage {
  return makeMessage(id, 'user', text, {
    unconfirmed: true,
    images: (images ?? []).map((img, i) => ({
      label: `Image ${i + 1}`,
      src: `data:${img.mimeType};base64,${img.data}`,
      mimeType: img.mimeType,
    })),
  })
}
const unconfirmed = (m: ChatMessage): boolean => m.role === 'user' && m.id.startsWith(SENT)

function assistantContextTokens(message: Json): number | null {
  const snap = message.contextSnapshot
  if (isObj(snap) && typeof snap.promptTokens === 'number') return snap.promptTokens
  const usage = message.usage
  if (isObj(usage) && typeof usage.input === 'number') {
    const n = (v: unknown): number => (typeof v === 'number' ? v : 0)
    return usage.input + n(usage.cacheRead) + n(usage.cacheWrite)
  }
  return null
}

/** A usable context window: omp reports 0 when it does not know one. */
function windowOf(v: unknown): number | null {
  return typeof v === 'number' && v > 0 ? v : null
}

/** omp's goal while active or paused; null once completed, dropped or absent. */
function goalOf(v: unknown): Goal | null {
  if (!isObj(v) || typeof v.objective !== 'string') return null
  if (v.status !== 'active' && v.status !== 'paused') return null
  const tokensUsed = typeof v.tokensUsed === 'number' ? v.tokensUsed : 0
  return { objective: v.objective, paused: v.status === 'paused', tokensUsed }
}

function resultText(frame: Json): string | null {
  const r = frame.result
  if (typeof r === 'string') return r
  if (isObj(r) && Array.isArray(r.content)) {
    return r.content
      .filter(isObj)
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n\n')
  }
  return null
}

function dialogTitle(d: Dialog): string {
  if (d.kind === 'ask') return d.questions.map((q) => q.question).join(' / ')
  return d.title
}

/**
 * Port of Rust `Live::apply` (chat.rs). `message_update` carries the full message snapshot in
 * `message.content`; the per-event delta is ignored (D-16). `message_end` is
 * authoritative. Frames are applied synchronously, one at a time.
 */
export class LiveReducer {
  private msgs: ChatMessage[]
  /** Monotonic so a notice id is never reused after `dropUnconfirmed` shrinks the list. */
  private noticeSeq = 0
  private metaState: SessionMeta
  private sent = 0
  private stderr: string[] = []
  private owned = new Map<string, string[]>()
  working = false
  error: string | null = null
  /** The blocking question omp waits on, if any. Held until answered, cancelled or omp exits. */
  dialog: Dialog | null = null
  /** omp's goal while active or paused, for the strip over the composer. */
  goal: Goal | null = null
  /** A `/handoff` is generating; omp sends no progress frames, only its final output. */
  handingOff = false

  constructor(history: ChatMessage[], meta: SessionMeta) {
    this.msgs = [...history]
    this.metaState = { ...meta }
  }

  get running(): boolean {
    return this.working
  }

  messages(): ChatMessage[] {
    return this.msgs
  }

  meta(): SessionMeta {
    return this.metaState
  }

  indexOf(id: string): number {
    return this.msgs.findIndex((m) => m.id === id)
  }

  stderrLines(): string[] {
    return this.stderr
  }

  /** Shows a prompt at once; omp echoes it later. A new prompt supersedes a previous EOF error. */
  sendPrompt(
    text: string,
    images?: ReadonlyArray<{ mimeType: string; data: string }>,
  ): ChatMessage {
    this.error = null
    if (isHandoff(text)) this.handingOff = true
    this.sent += 1
    const m = promptRow(`${SENT}${this.sent}`, text, images)
    this.msgs.push(m)
    return m
  }

  /** Takes back one prompt omp never received (the write failed). Only unconfirmed rows qualify. */
  dropUnconfirmedRow(id: string): boolean {
    const ix = this.msgs.findIndex((m) => m.id === id && unconfirmed(m))
    if (ix < 0) return false
    this.msgs.splice(ix, 1)
    return true
  }

  /**
   * Replaces every row with `rows`: a session this app reads but does not run, its file plus what
   * only shows here. Rows keep their ids; a row whose order among the kept ones changed is removed
   * and inserted again, since the renderer updates a known id in place.
   */
  replaceRows(rows: readonly ChatMessage[]): { dirty: string[]; removed: string[] } {
    const before = new Map(this.msgs.map((m) => [m.id, m]))
    const next = new Set(rows.map((r) => r.id))
    const removed = this.msgs.filter((m) => !next.has(m.id)).map((m) => m.id)
    const keptBefore = this.msgs.filter((m) => next.has(m.id)).map((m) => m.id)
    const moved = new Set<string>()
    let j = 0
    for (const r of rows) {
      if (!before.has(r.id)) continue
      while (j < keptBefore.length && moved.has(keptBefore[j]!)) j++
      if (keptBefore[j] === r.id) j++
      else moved.add(r.id)
    }
    const dirty = rows
      .filter((r) => {
        const old = before.get(r.id)
        return !old || moved.has(r.id) || JSON.stringify(old) !== JSON.stringify(r)
      })
      .map((r) => r.id)
    this.msgs = [...rows]
    return { dirty, removed: [...removed, ...moved] }
  }

  /** Takes what the session file or Relay says about the model and thinking level. */
  setMeta(
    patch: Pick<Partial<SessionMeta>, 'model' | 'thinking' | 'contextTokens' | 'contextWindow'>,
  ): MetaPatch {
    const out: MetaPatch = {}
    const m = this.metaState
    if (patch.model !== undefined && JSON.stringify(patch.model) !== JSON.stringify(m.model)) {
      m.model = patch.model
      out.model = patch.model
    }
    if (patch.thinking !== undefined && patch.thinking !== m.thinking) {
      m.thinking = patch.thinking
      out.thinking = patch.thinking
    }
    if (patch.contextTokens !== undefined && patch.contextTokens !== m.contextTokens) {
      m.contextTokens = patch.contextTokens
      out.contextTokens = patch.contextTokens
    }
    if (
      patch.contextWindow !== undefined &&
      patch.contextWindow !== null &&
      patch.contextWindow !== m.contextWindow
    ) {
      m.contextWindow = patch.contextWindow
      out.contextWindow = patch.contextWindow
    }
    return out
  }

  apply(frame: Json & { type?: unknown }): ApplyResult {
    const dirty = new Set<string>()
    const removed = new Set<string>()
    const before = this.snapshotMeta()
    const effect = this.step(frame, dirty, removed)
    const patch = this.diffMeta(before)
    const out: ApplyResult = {
      dirty: [...dirty].filter((id) => !removed.has(id)),
      removed: [...removed],
    }
    if (patch) out.meta = patch
    if (effect) out.effect = effect
    return out
  }

  private snapshotMeta() {
    return {
      running: this.working,
      error: this.error,
      dialog: this.dialog,
      goal: this.goal,
      handingOff: this.handingOff,
      model: this.metaState.model,
      contextTokens: this.metaState.contextTokens,
      contextWindow: this.metaState.contextWindow ?? null,
      thinking: this.metaState.thinking,
    }
  }

  private diffMeta(b: ReturnType<LiveReducer['snapshotMeta']>): MetaPatch | undefined {
    const p: MetaPatch = {}
    if (b.running !== this.working) p.running = this.working
    if (b.error !== this.error) p.error = this.error
    if (b.dialog !== this.dialog) p.dialog = this.dialog
    if (JSON.stringify(b.goal) !== JSON.stringify(this.goal)) p.goal = this.goal
    if (b.handingOff !== this.handingOff) p.handingOff = this.handingOff
    if (b.model !== this.metaState.model) p.model = this.metaState.model
    if (b.contextTokens !== this.metaState.contextTokens)
      p.contextTokens = this.metaState.contextTokens
    if (b.contextWindow !== (this.metaState.contextWindow ?? null))
      p.contextWindow = this.metaState.contextWindow ?? null
    if (b.thinking !== this.metaState.thinking) p.thinking = this.metaState.thinking
    return Object.keys(p).length > 0 ? p : undefined
  }

  private step(frame: Json, dirty: Set<string>, removed: Set<string>): Json | undefined {
    switch (str(frame.type)) {
      case 'response':
        return this.response(frame, dirty, removed)
      case 'model_changed':
      case 'thinking_level_changed':
        return { type: 'get_state' }
      case 'agent_start':
        this.working = true
        return
      case 'agent_end':
        if (frame.yielded !== false) this.working = false
        return
      case 'session_settled':
        this.working = false
        return
      case 'prompt_result': {
        if (frame.status === 'error') {
          const e = frame.error
          const message = isObj(e) && typeof e.message === 'string' ? e.message : 'unknown error'
          this.dropUnconfirmed(removed)
          this.notice(`Error: ${oneLine(message, 240)}`, dirty)
        } else if (frame.status === 'aborted') {
          this.notice('Stopped.', dirty)
        }
        return
      }
      case 'message_start':
      case 'message_update': {
        const message = frame.message
        if (!isObj(message) || message.role !== 'assistant') return
        const id = str(frame.messageId)
        if (id === undefined) return
        this.syncAssistant(id, message, true, dirty, removed)
        return
      }
      case 'message_end':
        this.messageEnd(frame, dirty, removed)
        return
      case 'tool_execution_end':
        this.toolEnd(frame, dirty)
        return
      case 'extension_ui_request': {
        const method = str(frame.method)
        if (method === undefined || !DIALOG_METHODS.has(method)) return
        return this.dialogRequest(frame, dirty)
      }
      case 'goal_updated':
        this.goal = goalOf(frame.goal)
        return
      case 'command_output': {
        // `/handoff` reports here once it finishes or fails.
        this.handingOff = false
        const text = str(frame.text)
        if (text) this.notice(oneLine(text, 400), dirty)
        return
      }
      case 'notice': {
        const text = str(frame.message)
        if (text) this.notice(text, dirty)
        return
      }
      case '_stderr': {
        const line = str(frame.line)
        if (line !== undefined) {
          this.stderr.push(line)
          if (this.stderr.length > STDERR_LINES) this.stderr.shift()
        }
        return
      }
      case '_eof':
        this.working = false
        this.handingOff = false
        this.killDialog(dirty)
        this.dropUnconfirmed(removed)
        if (frame.expected !== true) this.error = EOF_ERROR
        return
      default:
        return
    }
  }

  private response(frame: Json, dirty: Set<string>, removed: Set<string>): Json | undefined {
    if (frame.success === false) {
      if (frame.command === 'prompt') {
        this.dropUnconfirmed(removed)
        this.handingOff = false
      }
      if (frame.command === 'goal') this.dropGoalRows(removed)
      this.notice(`Error: ${oneLine(str(frame.error) ?? 'command failed', 240)}`, dirty)
      return
    }
    const data = isObj(frame.data) ? frame.data : {}
    switch (str(frame.command)) {
      case 'get_state': {
        if ('goal' in data) this.goal = isObj(data.goal) ? goalOf(data.goal.goal) : null
        const model = data.model
        if (isObj(model) && str(model.provider) && str(model.id)) {
          const next: [string, string] = [model.provider as string, model.id as string]
          const old = this.metaState.model
          if (!old || old[0] !== next[0] || old[1] !== next[1]) this.metaState.model = next
        }
        if (typeof data.thinkingLevel === 'string') this.metaState.thinking = data.thinkingLevel
        const usage = data.contextUsage
        if (isObj(usage) && typeof usage.tokens === 'number')
          this.metaState.contextTokens = usage.tokens
        if (isObj(usage)) {
          const w = windowOf(usage.contextWindow)
          if (w !== null) this.metaState.contextWindow = w
        }
        return
      }
      case 'set_model':
      case 'set_thinking_level':
      case 'set_fast_mode':
        return { type: 'get_state' }
      // A builtin slash command (e.g. `/handoff`) that ran without an agent turn: its prompt
      // never echoes back, so the copy shown on send goes.
      case 'prompt':
        if (data.agentInvoked === false) {
          this.dropUnconfirmed(removed)
          this.handingOff = false
        }
        return
      case 'goal':
        this.dropGoalRows(removed)
        this.goal = goalOf(data.goal)
        if (this.goal === null) this.notice('No goal.', dirty)
        return
      default:
        return
    }
  }

  private dialogRequest(frame: Json, dirty: Set<string>): Json | undefined {
    const parsed = parseDialog(frame)
    if (parsed === null) return
    if ('cancelTarget' in parsed) {
      if (this.dialog?.id === parsed.cancelTarget) this.killDialog(dirty)
      return
    }
    if ('unreadable' in parsed) {
      this.notice(UNREADABLE_ASK_NOTICE, dirty)
      // omp must never stay blocked on a question nobody can read.
      return { type: 'extension_ui_response', id: parsed.unreadable.id, cancelled: true }
    }
    if (this.dialog) this.killDialog(dirty)
    this.dialog = parsed.dialog
    this.insert(
      [makeMessage(`dialog-${parsed.dialog.id}`, 'notice', dialogTitle(parsed.dialog))],
      dirty,
    )
    return
  }

  /** The pending question can never be answered: its row says so and the dialog is dropped. */
  private killDialog(dirty: Set<string>): void {
    const d = this.dialog
    if (!d) return
    this.dialog = null
    this.setDialogRow(d.id, DEAD_DIALOG_TEXT, dirty)
  }

  private setDialogRow(id: string, text: string, dirty: Set<string>): void {
    const ix = this.indexOf(`dialog-${id}`)
    if (ix < 0) return
    this.msgs[ix] = { ...this.msgs[ix]!, text }
    dirty.add(`dialog-${id}`)
  }

  /** The user answered the pending dialog `id`; the row now reads `Answered: {summary}`. */
  answer(id: string, summary: string): { dirty: string[]; meta?: MetaPatch } {
    if (this.dialog?.id !== id) return { dirty: [] }
    const dirty = new Set<string>()
    this.dialog = null
    this.setDialogRow(id, `Answered: ${summary}`, dirty)
    return { dirty: [...dirty], meta: { dialog: null } }
  }

  /** Drops the pending dialog when omp exited or the turn was aborted. */
  cancelPending(_reason: 'eof' | 'abort'): { dirty: string[]; meta?: MetaPatch } {
    if (!this.dialog) return { dirty: [] }
    const dirty = new Set<string>()
    this.killDialog(dirty)
    return { dirty: [...dirty], meta: { dialog: null } }
  }

  private notice(text: string, dirty: Set<string>): void {
    let id: string
    do id = `notice-${++this.noticeSeq}`
    while (this.indexOf(id) >= 0)
    this.insert([makeMessage(id, 'notice', text)], dirty)
  }

  private dropUnconfirmed(removed: Set<string>): void {
    for (const m of this.msgs) if (unconfirmed(m)) removed.add(m.id)
    this.msgs = this.msgs.filter((m) => !unconfirmed(m))
  }

  /** `/goal` prompts shown on send: omp answers them with a `goal` response, never an echo. */
  private dropGoalRows(removed: Set<string>): void {
    const goalRow = (m: ChatMessage): boolean => unconfirmed(m) && goalCommand(m.text) !== null
    for (const m of this.msgs) if (goalRow(m)) removed.add(m.id)
    this.msgs = this.msgs.filter((m) => !goalRow(m))
  }

  /** Adds rows before any prompts still waiting for omp, which stay last. */
  private insert(rows: ChatMessage[], dirty: Set<string>): void {
    let at = 0
    for (let i = this.msgs.length - 1; i >= 0; i--) {
      if (!unconfirmed(this.msgs[i]!)) {
        at = i + 1
        break
      }
    }
    this.msgs.splice(at, 0, ...rows)
    for (const r of rows) dirty.add(r.id)
  }

  private sameRow(a: ChatMessage, b: ChatMessage): boolean {
    return (
      a.text === b.text &&
      a.detail === b.detail &&
      a.streaming === b.streaming &&
      a.role === b.role &&
      a.at === b.at &&
      JSON.stringify(a.tool) === JSON.stringify(b.tool)
    )
  }

  /** Rebuilds the rows one assistant message shows from its full content snapshot. */
  private syncAssistant(
    id: string,
    message: Json,
    streaming: boolean,
    dirty: Set<string>,
    removed: Set<string>,
  ): void {
    const rows = messagesFrom(message, id).map((r) =>
      r.role === 'assistant' && streaming ? { ...r, streaming: true } : r,
    )
    const nextIds: string[] = []
    for (const row of rows) {
      nextIds.push(row.id)
      const ix = this.indexOf(row.id)
      if (ix < 0) {
        this.insert([row], dirty)
        continue
      }
      const old = this.msgs[ix]!
      // A tool row that already has its result keeps it while the call block is rebuilt.
      const merged =
        old.tool && old.tool.status !== 'running' && row.tool ? { ...row, tool: old.tool } : row
      if (!this.sameRow(old, merged)) {
        this.msgs[ix] = merged
        dirty.add(row.id)
      }
    }
    for (const oldId of this.owned.get(id) ?? []) {
      if (!nextIds.includes(oldId)) {
        const ix = this.indexOf(oldId)
        if (ix >= 0) this.msgs.splice(ix, 1)
        removed.add(oldId)
      }
    }
    this.owned.set(id, nextIds)
    const ctx = streaming ? null : assistantContextTokens(message)
    if (ctx !== null) this.metaState.contextTokens = ctx
    if (!streaming && isObj(message.usage)) {
      const w = windowOf(message.usage.contextWindow)
      if (w !== null) this.metaState.contextWindow = w
    }
    if (!streaming) {
      const provider = str(message.provider)
      const model = str(message.model)
      if (provider && model) this.metaState.model = [provider, model]
    }
  }

  private messageEnd(frame: Json, dirty: Set<string>, removed: Set<string>): void {
    const message = frame.message
    if (!isObj(message)) return
    const id = str(frame.messageId) ?? ''
    if (message.role === 'assistant') {
      this.syncAssistant(id, message, false, dirty, removed)
      return
    }
    if (message.role === 'toolResult') {
      const call = str(message.toolCallId)
      const ix = call === undefined ? -1 : this.msgs.findLastIndex((m) => m.tool?.call === call)
      if (ix >= 0) {
        const clone = { ...this.msgs[ix]! }
        if (attachResult([clone], message)) {
          this.msgs[ix] = clone
          dirty.add(clone.id)
        }
      }
      return
    }
    const arrived = messagesFrom(message, id)
    for (const prompt of arrived.filter((m) => m.role === 'user')) {
      const norm = prompt.text.trim()
      const shown = this.msgs.findIndex((m) => unconfirmed(m) && m.text.trim() === norm)
      const ix = shown >= 0 ? shown : this.msgs.findIndex(unconfirmed)
      if (ix >= 0) {
        // omp may echo the prompt without its image data: keep what the user attached.
        const shownImages = this.msgs[ix]!.images
        if (prompt.images.length === 0 && shownImages.length > 0) prompt.images = shownImages
        removed.add(this.msgs[ix]!.id)
        this.msgs.splice(ix, 1)
      }
    }
    for (const row of arrived) {
      const ix = this.indexOf(row.id)
      if (ix >= 0) {
        this.msgs[ix] = row
        dirty.add(row.id)
      } else this.insert([row], dirty)
    }
  }

  private toolEnd(frame: Json, dirty: Set<string>): void {
    const call = str(frame.toolCallId)
    if (call === undefined) return
    const ix = this.msgs.findLastIndex((m) => m.tool?.call === call)
    if (ix < 0) return
    const row = this.msgs[ix]!
    const isError = frame.isError === true
    const result = resultText(frame) ?? row.tool!.result
    this.msgs[ix] = {
      ...row,
      tool: { ...row.tool!, result, isError, status: isError ? 'failed' : 'done' },
    }
    dirty.add(row.id)
  }
}
