import { makeMessage, type ChatMessage } from '@evaos/chat-core/message'
import type { AgentResult, RunIO } from './agent'
import { HELP_TEXT, parseComputer, type ComputerMode } from './command'
import type { RouteDecision } from './route'

/** One `@computer` run as the chat sees it. */
export interface RunSpec {
  id: string
  paneId: string
  mode: ComputerMode
  task: string
  route: RouteDecision
}

/** What a walkthrough hears from the chat while it runs. */
export type WalkControl = 'next' | 'skip'

export interface RunsDeps {
  /** The pane's rows changed (the full list for that pane). */
  emit(paneId: string, file: string | null, rows: ChatMessage[]): void
  /** The pane's session file, null for a draft. */
  fileOf(paneId: string): string | null
  /** The assistant whose thread `file` is, else null. */
  chatAgentOf(file: string | null): string | null
  route(task: string, chatAgent: string | null): RouteDecision
  /** Runs the agent; resolves with how it ended. Walk runs hear next/skip through `control`. */
  launch(spec: RunSpec, io: RunIO, control: (cb: (c: WalkControl) => void) => void): Promise<AgentResult>
  /** A thin client (MacBook): `@computer` runs on the Mini only. */
  remote: boolean
  now?: () => number
  /** How long an ask waits for Isaac before it counts as Cancel. */
  askTimeoutMs?: number
  log?: (line: string) => void
}

interface Ask {
  rowId: string
  options: string[]
  resolve: (answer: string) => void
}

interface Run {
  spec: RunSpec
  file: string | null
  abort: AbortController
  lines: string[]
  images: Array<{ file: string; caption: string }>
  asks: number
  pending: Ask | null
  walk: ((c: WalkControl) => void) | null
  done: boolean
}

const ASK_TIMEOUT_MS = 10 * 60_000
const MODE_LABEL: Record<ComputerMode, string> = { headless: 'in the background', live: 'live', walk: 'walkthrough' }

/** A markdown image line for a local PNG (the chat serves absolute paths through relay-media). */
const imageLine = (file: string, caption: string): string => `![${caption.replace(/[[\]]/g, '')}](<${file}>)`

/**
 * `@computer` in the chat: catches the command in `chat.send`, keeps every pane's run rows, asks
 * Isaac through reply chips and runs one agent at a time on this Mac.
 */
export class ComputerRuns {
  private rows = new Map<string, ChatMessage[]>()
  private files = new Map<string, string | null>()
  private active: Run | null = null
  private seq = 0

  constructor(private deps: RunsDeps) {}

  /** The pane's rows, or the rows of runs from the same session file (the chat reopened). */
  rowsFor(paneId: string, file: string | null): ChatMessage[] {
    const own = this.rows.get(paneId)
    if (own && own.length > 0) return own
    if (file === null) return []
    for (const [pane, f] of this.files) if (f === file) return this.rows.get(pane) ?? []
    return []
  }

  /** True when `text` was `@computer` business (or a reply to a pending ask) and must not reach the agent. */
  intercept(paneId: string, text: string): boolean {
    const run = this.active
    const pending = run?.pending
    if (run && pending && run.spec.paneId === paneId) {
      const pick = pending.options.find((o) => o.toLowerCase() === text.trim().toLowerCase())
      if (pick) {
        this.answer(run, pick)
        return true
      }
    }
    const cmd = parseComputer(text)
    if (!cmd) return false
    const file = this.deps.fileOf(paneId)
    this.files.set(paneId, file)
    const user = makeMessage(`computer:${String(++this.seq)}:cmd`, 'user', text.trim(), { at: this.now() })
    if (cmd.kind === 'help') {
      this.post(paneId, user)
      this.post(paneId, makeMessage(`computer:${String(this.seq)}:help`, 'assistant', HELP_TEXT))
      return true
    }
    if (cmd.kind === 'control') {
      this.post(paneId, user)
      this.control(paneId, cmd.op)
      return true
    }
    this.post(paneId, user)
    if (this.deps.remote) {
      this.post(paneId, makeMessage(`computer:${String(this.seq)}:remote`, 'assistant', '@computer runs on the Mac Mini only. Send it from Relay on the Mini.'))
      return true
    }
    if (this.active && !this.active.done) {
      this.post(
        paneId,
        makeMessage(`computer:${String(this.seq)}:busy`, 'assistant', `Already working on “${this.active.spec.task}”. Send \`@computer stop\` first.`),
      )
      return true
    }
    const route = this.deps.route(cmd.task, this.deps.chatAgentOf(file))
    const spec: RunSpec = { id: `${this.stamp()}-${String(this.seq)}`, paneId, mode: cmd.mode, task: route.task, route }
    this.start(spec, file)
    return true
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private stamp(): string {
    return new Date(this.now()).toISOString().replace(/[-:]/g, '').replace(/\..*/, '')
  }

  private post(paneId: string, row: ChatMessage): void {
    const list = this.rows.get(paneId) ?? []
    const i = list.findIndex((r) => r.id === row.id)
    const next = i >= 0 ? list.map((r, j) => (j === i ? row : r)) : [...list, row]
    this.rows.set(paneId, next)
    this.deps.emit(paneId, this.files.get(paneId) ?? null, next)
  }

  private control(paneId: string, op: 'stop' | 'next' | 'skip'): void {
    const run = this.active
    const id = `computer:${String(this.seq)}:ctl`
    if (!run || run.done) {
      this.post(paneId, makeMessage(id, 'assistant', 'Nothing is running.'))
      return
    }
    if (op === 'stop') {
      run.abort.abort()
      if (run.pending) this.answer(run, 'Cancel')
      this.post(paneId, makeMessage(id, 'assistant', `Stopping “${run.spec.task}”.`))
      return
    }
    if (!run.walk) {
      this.post(paneId, makeMessage(id, 'assistant', '`next` and `skip` work in a walkthrough only.'))
      return
    }
    run.walk(op)
  }

  private answer(run: Run, pick: string): void {
    const ask = run.pending
    if (!ask) return
    run.pending = null
    const row = this.rows.get(run.spec.paneId)?.find((r) => r.id === ask.rowId)
    if (row) this.post(run.spec.paneId, { ...row, text: row.text.replace(/\n*\[\[replies:[^\]]*\]\]\s*$/, `\n\n_You chose: ${pick}_`) })
    ask.resolve(pick)
  }

  private progressRow(run: Run, status: string): ChatMessage {
    const { assistant } = run.spec.route
    const head = `**${assistant.title} · @computer** ${MODE_LABEL[run.spec.mode]}: ${run.spec.task}`
    const lines = run.lines.map((l, i) => `${i + 1}. ${l}`)
    const pics = run.images.map((p) => imageLine(p.file, p.caption))
    return makeMessage(`computer:${run.spec.id}:progress`, 'assistant', [head, '', ...lines, ...(pics.length ? ['', ...pics] : []), '', `_${status}_`].join('\n'))
  }

  private start(spec: RunSpec, file: string | null): void {
    const run: Run = { spec, file, abort: new AbortController(), lines: [], images: [], asks: 0, pending: null, walk: null, done: false }
    this.active = run
    const paneId = spec.paneId
    const refresh = (status = 'Working…'): void => this.post(paneId, this.progressRow(run, status))
    refresh('Starting…')
    this.deps.log?.(`computer ${spec.id}: ${spec.mode} as ${spec.route.assistant.id} (${spec.route.reason}): ${spec.task}`)
    const io: RunIO = {
      signal: run.abort.signal,
      stop: () => {
        run.abort.abort()
        if (run.pending) this.answer(run, 'Cancel')
      },
      progress: (line) => {
        run.lines.push(line)
        refresh()
      },
      image: (f, caption) => {
        run.images.push({ file: f, caption })
        refresh()
      },
      ask: (question, options, image) => {
        if (run.abort.signal.aborted) return Promise.resolve('Cancel')
        const rowId = `computer:${spec.id}:ask:${String(++run.asks)}`
        const text = [`**${spec.route.assistant.title}:** ${question}`, ...(image ? ['', imageLine(image, 'Now')] : []), '', `[[replies: ${options.join(' | ')}]]`].join('\n')
        this.post(paneId, makeMessage(rowId, 'assistant', text))
        refresh('Waiting for you…')
        const { promise, resolve } = Promise.withResolvers<string>()
        const timer = setTimeout(() => {
          if (run.pending?.rowId === rowId) this.answer(run, 'Cancel')
        }, this.deps.askTimeoutMs ?? ASK_TIMEOUT_MS)
        run.pending = {
          rowId,
          options,
          resolve: (a) => {
            clearTimeout(timer)
            refresh()
            resolve(a)
          },
        }
        return promise
      },
    }
    const finish = (result: AgentResult): void => {
      run.done = true
      if (this.active === run) this.active = null
      const word = { done: 'Done', stopped: 'Stopped', failed: 'Failed', budget: 'Stopped (budget)' }[result.outcome]
      this.post(paneId, this.progressRow(run, word))
      const body = [`**${spec.route.assistant.title}:** ${result.summary}`, ...(result.image ? ['', imageLine(result.image, 'Final')] : [])].join('\n')
      this.post(paneId, makeMessage(`computer:${spec.id}:done`, 'assistant', body))
      this.deps.log?.(`computer ${spec.id}: ${result.outcome}: ${result.summary}`)
    }
    void this.deps
      .launch(spec, io, (cb) => {
        run.walk = cb
      })
      .then(finish, (e: unknown) =>
        finish({ outcome: 'failed', summary: `Couldn't run it: ${e instanceof Error ? e.message : String(e)}`, image: null }),
      )
  }

  /** Stops the active run (app quit). */
  stopAll(): void {
    const run = this.active
    if (!run) return
    run.abort.abort()
    if (run.pending) this.answer(run, 'Cancel')
  }
}
