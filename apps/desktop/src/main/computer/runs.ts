import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import type { WidgetSpec } from '@evaos/chat-core/widget'
import { ChatMessageSchema, makeMessage, type ChatMessage } from '@evaos/chat-core/message'
import type { AgentResult, RunIO } from './agent'
import type { RunPlan } from './brief'
import { HELP_TEXT, parseComputer, type ComputerMode } from './command'
import type { RouteDecision } from './route'

/** One `@computer` run as the chat sees it. */
export interface RunSpec {
  id: string
  paneId: string
  mode: ComputerMode
  task: string
  route: RouteDecision
  /** The chat's session file, null for a draft. */
  file: string | null
  /**
   * The chat is the answering assistant's own thread: it plans the run in its session, its
   * questions are its plain bubbles, and its reply to the run's report is the summary.
   */
  ownThread: boolean
}

/** What a walkthrough hears from the chat while it runs. */
export type WalkControl = 'next' | 'skip'

/** Where a session's `@computer` rows are kept across launches, by session file. */
export interface RowStore {
  load(file: string): ChatMessage[]
  save(file: string, rows: ChatMessage[]): void
}

export interface RunsDeps {
  /** The pane's rows changed (the full list for that pane). */
  emit(paneId: string, file: string | null, rows: ChatMessage[]): void
  /** The pane's session file, null for a draft. */
  fileOf(paneId: string): string | null
  /** The assistant whose thread `file` is, else null. */
  chatAgentOf(file: string | null): string | null
  route(task: string, chatAgent: string | null): RouteDecision
  /** Runs the agent; resolves with how it ended. Walk runs hear next/skip through `control`. */
  launch(
    spec: RunSpec,
    io: RunIO,
    control: (cb: (c: WalkControl) => void) => void,
  ): Promise<AgentResult>
  /** A thin client (MacBook): `@computer` runs on the Mini only. */
  remote: boolean
  store?: RowStore
  now?: () => number
  /** How long an ask waits for Isaac before it counts as Cancel. */
  askTimeoutMs?: number
  /**
   * Tells the assistant of an own-thread run how it went (brief.ts reportRequest); true when its
   * session took it, so its reply is the summary. False or absent: the run posts the summary.
   */
  report?(spec: RunSpec, result: AgentResult, lines: string[], pictures: string[]): Promise<boolean>
  log?: (line: string) => void
}

interface Ask {
  rowId: string
  options: string[]
  resolve: (answer: string) => void
}

interface Run {
  spec: RunSpec
  /** When Isaac sent it: every row of the run carries it, so the chat places the run there. */
  at: number
  abort: AbortController
  lines: string[]
  images: Array<{ file: string; caption: string }>
  plan: RunPlan | null
  asks: number
  pending: Ask | null
  walk: ((c: WalkControl) => void) | null
  done: boolean
}

const ASK_TIMEOUT_MS = 10 * 60_000
const MODE_LABEL: Record<ComputerMode, string> = {
  headless: 'in the background',
  live: 'live',
  walk: 'walkthrough',
}
const OUTCOME_WORD: Record<AgentResult['outcome'], string> = {
  done: 'Done',
  stopped: 'Stopped',
  failed: 'Failed',
  budget: 'Stopped (budget)',
}

/** A markdown image line for a local PNG (the chat serves absolute paths through relay-media). */
const imageLine = (file: string, caption: string): string =>
  `![${caption.replace(/[[\]]/g, '')}](<${file}>)`

/** A widget as the chat renders it: a `ui` fence inside the row's markdown. */
const uiBlock = (w: WidgetSpec): string => `\`\`\`ui\n${JSON.stringify(w)}\n\`\`\``

/** The run's plan, collapsed: "Plan: <its first sentence>", opening to the brief and steps. */
function planWidget(plan: RunPlan, assistant: string): WidgetSpec {
  const first = plan.brief.trim().split(/(?<=[.!?])\s/)[0] ?? ''
  const lead =
    first.length > 120 ? `${first.slice(0, 119)}…` : first || `${String(plan.steps.length)} steps`
  const where = [plan.url, plan.file, plan.app].filter(Boolean).join(' · ')
  return {
    widget: 'collapse',
    title: `Plan: ${lead}`,
    open: false,
    children: [
      ...(plan.brief.trim() ? [{ widget: 'text' as const, text: plan.brief.trim() }] : []),
      ...(where
        ? [{ widget: 'text' as const, text: `Where: ${where}`, style: 'muted' as const }]
        : []),
      ...(plan.steps.length > 0
        ? [
            {
              widget: 'list' as const,
              style: 'number' as const,
              items: plan.steps.map((s) => s.instruction),
            },
          ]
        : []),
      {
        widget: 'text',
        text: plan.by === 'assistant' ? `Planned by ${assistant}` : 'Planned from the chat',
        style: 'muted',
      },
    ],
  }
}

/**
 * `@computer` in the chat: catches the command in `chat.send`, keeps every pane's run rows, asks
 * Isaac through reply chips and runs one agent at a time on this Mac. Every row carries `at`, the
 * time Isaac sent the command, so the chat places each run in its timeline (computer-rows.ts
 * placeRows); a finished run folds into one collapsible row; rows of a session are saved by file.
 */
export class ComputerRuns {
  /** Rows by slot: the session file, or `pane:<id>` while a pane is a draft without one. */
  private rows = new Map<string, ChatMessage[]>()
  /** Each pane's slot, as of the last time it asked or sent. */
  private slots = new Map<string, string>()
  private active: Run | null = null
  private seq = 0

  constructor(private deps: RunsDeps) {}

  /**
   * The rows of the pane's session (any pane on that file, and earlier launches through the store),
   * or the draft pane's own. A draft's rows join its session file once it has one.
   */
  rowsFor(paneId: string, file: string | null): ChatMessage[] {
    const draft = `pane:${paneId}`
    if (file === null) {
      this.slots.set(paneId, draft)
      return this.rows.get(draft) ?? []
    }
    this.slots.set(paneId, file)
    let list = this.rows.get(file)
    if (!list) {
      list = this.deps.store?.load(file) ?? []
      this.rows.set(file, list)
    }
    const moved = this.rows.get(draft)
    if (moved) {
      this.rows.delete(draft)
      list = [...list, ...moved]
      this.rows.set(file, list)
      this.deps.store?.save(file, list)
    }
    return list
  }

  private list(paneId: string): ChatMessage[] {
    return this.rows.get(this.slots.get(paneId) ?? `pane:${paneId}`) ?? []
  }

  /** True when `text` was `@computer` business (or a reply to a pending ask) and must not reach the agent. */
  intercept(paneId: string, text: string): boolean {
    const run = this.active
    const pending = run?.pending
    const cmd = parseComputer(text)
    if (run && pending && run.spec.paneId === paneId) {
      const typed = text.trim()
      const pick = pending.options.find((o) => o.toLowerCase() === typed.toLowerCase())
      if (pick) {
        this.answer(run, pick)
        return true
      }
      // Any other plain message answers the question the run is waiting on, in words.
      // `@computer ...` and `/...` stay commands; everything else goes to omp as usual.
      if (!cmd && typed !== '' && !typed.startsWith('/')) {
        this.reply(run, pending, typed)
        return true
      }
    }
    if (!cmd) return false
    const file = this.deps.fileOf(paneId)
    // The session's earlier runs (saved ones too), so a new one adds to them.
    const before = this.rowsFor(paneId, file)
    const at = this.now()
    // Unique among the session's rows, saved ones from earlier launches included (seq restarts).
    const taken = new Set(before.map((r) => r.id))
    let key = `${this.stamp(at)}-${String(++this.seq)}`
    while (taken.has(`computer:${key}:cmd`)) key = `${this.stamp(at)}-${String(++this.seq)}`
    const reply = (kind: string, body: string): void =>
      this.post(paneId, makeMessage(`computer:${key}:${kind}`, 'assistant', body, { at }))
    this.post(paneId, makeMessage(`computer:${key}:cmd`, 'user', text.trim(), { at }))
    if (cmd.kind === 'help') {
      reply('help', HELP_TEXT)
      return true
    }
    if (cmd.kind === 'control') {
      this.control(cmd.op, (body) => reply('ctl', body))
      return true
    }
    if (this.deps.remote) {
      reply('remote', '@computer runs on the Mac Mini only. Send it from Relay on the Mini.')
      return true
    }
    if (this.active && !this.active.done) {
      reply('busy', `Already working on “${this.active.spec.task}”. Send \`@computer stop\` first.`)
      return true
    }
    const chatAgent = this.deps.chatAgentOf(file)
    const route = this.deps.route(cmd.task, chatAgent)
    this.start(
      {
        id: key,
        paneId,
        mode: cmd.mode,
        task: route.task,
        route,
        file,
        ownThread: chatAgent !== null && route.assistant.id === chatAgent,
      },
      at,
    )
    return true
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private stamp(at: number): string {
    return new Date(at).toISOString().replace(/[-:]/g, '').replace(/\..*/, '')
  }

  /** Replaces the pane's session rows, tells the chat and saves them with the session. */
  private set(paneId: string, next: ChatMessage[]): void {
    const slot = this.slots.get(paneId) ?? `pane:${paneId}`
    this.rows.set(slot, next)
    const file = slot.startsWith('pane:') ? null : slot
    if (file !== null) this.deps.store?.save(file, next)
    this.deps.emit(paneId, file, next)
  }

  private post(paneId: string, row: ChatMessage): void {
    const list = this.list(paneId)
    const i = list.findIndex((r) => r.id === row.id)
    this.set(paneId, i >= 0 ? list.map((r, j) => (j === i ? row : r)) : [...list, row])
  }

  private control(op: 'stop' | 'next' | 'skip', say: (body: string) => void): void {
    const run = this.active
    if (!run || run.done) return say('Nothing is running.')
    if (op === 'stop') {
      run.abort.abort()
      if (run.pending) this.answer(run, 'Cancel')
      return say(`Stopping “${run.spec.task}”.`)
    }
    if (!run.walk) return say('`next` and `skip` work in a walkthrough only.')
    run.walk(op)
  }

  private answer(run: Run, pick: string, typed?: string): void {
    const ask = run.pending
    if (!ask) return
    run.pending = null
    const row = this.list(run.spec.paneId).find((r) => r.id === ask.rowId)
    if (row)
      this.post(run.spec.paneId, {
        ...row,
        text: `${row.text.replace(/\n*\[\[replies:[^\]]*\]\]\s*$/, '')}\n\n_You ${typed === undefined ? 'chose' : 'answered'}: ${typed ?? pick}_`,
      })
    ask.resolve(pick)
  }

  /** Isaac's typed answer: shown under the run's question, then handed to the run like a tapped chip. */
  private reply(run: Run, ask: Ask, text: string): void {
    const paneId = run.spec.paneId
    this.post(paneId, makeMessage(`${ask.rowId}:reply`, 'user', text, { at: run.at }))
    // An approval asked with chips takes yes/no in words; anything else it gets verbatim.
    const approval = ask.options.includes('Approve') && ask.options.includes('Cancel')
    const pick = approval
      ? /^(y|yes|yep|yeah|ok|okay|sure|go|go ahead|do it|approve|approved)[.!]*$/i.test(text)
        ? 'Approve'
        : /^(n|no|nope|stop|cancel|don'?t)[.!]*$/i.test(text)
          ? 'Cancel'
          : text
      : text
    this.answer(run, pick, text)
  }

  private progressRow(run: Run, status: string): ChatMessage {
    const { spec } = run
    const who = spec.route.assistant.title
    // In its own thread the assistant is the one doing it; elsewhere the row says it is @computer.
    const head = spec.ownThread
      ? `**${who}** · ${MODE_LABEL[spec.mode]}: ${spec.task}`
      : `**${who} · @computer** ${MODE_LABEL[spec.mode]}: ${spec.task}`
    const plan = run.plan ? ['', uiBlock(planWidget(run.plan, who))] : []
    const lines = run.lines.map((l, i) => `${i + 1}. ${l}`)
    const pics = run.images.map((p) => imageLine(p.file, p.caption))
    return makeMessage(
      `computer:${spec.id}:progress`,
      'assistant',
      [head, ...plan, '', ...lines, ...(pics.length ? ['', ...pics] : []), '', `_${status}_`].join(
        '\n',
      ),
      { at: run.at },
    )
  }

  /**
   * A finished run as one collapsed row that opens to its task, plan, steps and pictures. Titled
   * with who, how it ended and the answer; in the assistant's own thread its reply is the answer,
   * so the row is only "What I did".
   */
  private finishedRow(run: Run, result: AgentResult): ChatMessage {
    const { spec } = run
    const word = OUTCOME_WORD[result.outcome]
    // The answer's first sentence is the line; the whole summary sits inside when it says more.
    const lead = result.summary.trim().split(/(?<=[.!?])\s/)[0] || word
    const title = spec.ownThread
      ? `What I did${result.outcome === 'done' ? '' : ` · ${word}`} (${String(run.lines.length)} steps)`
      : `${spec.route.assistant.title} · @computer${result.outcome === 'done' ? '' : ` · ${word}`}: ${lead}`
    const pics = [
      ...run.images,
      ...(result.image ? [{ file: result.image, caption: 'Final' }] : []),
    ]
    const children: WidgetSpec[] = [
      { widget: 'text', text: `${MODE_LABEL[spec.mode]}: ${spec.task}`, style: 'muted' },
      ...(run.plan ? [planWidget(run.plan, spec.route.assistant.title)] : []),
      ...(run.lines.length > 0
        ? [{ widget: 'list' as const, style: 'number' as const, items: run.lines.slice(-50) }]
        : []),
      ...(result.summary.trim() && (spec.ownThread || result.summary.trim() !== lead)
        ? [{ widget: 'text' as const, text: result.summary.trim() }]
        : []),
      ...(pics.length > 0
        ? [
            {
              widget: 'gallery' as const,
              images: pics.map((p) => ({ src: p.file, caption: p.caption })),
            },
          ]
        : []),
    ]
    return makeMessage(
      `computer:${spec.id}:done`,
      'assistant',
      uiBlock({ widget: 'collapse', title, open: false, children }),
      { at: run.at },
    )
  }

  private start(spec: RunSpec, at: number): void {
    const run: Run = {
      spec,
      at,
      abort: new AbortController(),
      lines: [],
      images: [],
      plan: null,
      asks: 0,
      pending: null,
      walk: null,
      done: false,
    }
    this.active = run
    const paneId = spec.paneId
    const refresh = (status = 'Working…'): void => {
      if (!run.done) this.post(paneId, this.progressRow(run, status))
    }
    refresh(spec.ownThread ? `${spec.route.assistant.title} is planning…` : 'Planning…')
    this.deps.log?.(
      `computer ${spec.id}: ${spec.mode} as ${spec.route.assistant.id} (${spec.route.reason}): ${spec.task}`,
    )
    const io: RunIO = {
      signal: run.abort.signal,
      stop: () => {
        run.abort.abort()
        if (run.pending) this.answer(run, 'Cancel')
      },
      plan: (plan) => {
        run.plan = plan
        refresh()
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
        const text = [
          // Its own thread: the assistant's plain bubble. Elsewhere it says who is asking.
          spec.ownThread ? question : `**${spec.route.assistant.title}:** ${question}`,
          ...(image ? ['', imageLine(image, 'Now')] : []),
          ...(options.length > 0 ? ['', `[[replies: ${options.join(' | ')}]]`] : []),
        ].join('\n')
        this.post(paneId, makeMessage(rowId, 'assistant', text, { at }))
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
    void this.deps
      .launch(spec, io, (cb) => {
        run.walk = cb
      })
      .then(
        (result) => this.finish(run, result),
        (e: unknown) =>
          this.finish(run, {
            outcome: 'failed',
            summary: `Couldn't run it: ${e instanceof Error ? e.message : String(e)}`,
            image: null,
          }),
      )
  }

  /**
   * The run's progress row becomes its one finished row, in the same place. Elsewhere its asks fold
   * into it; in the assistant's own thread they stay (they are its bubbles), and the assistant hears
   * how it went (`report`) and answers Isaac itself. When it cannot be told, the run says it.
   */
  private finish(run: Run, result: AgentResult, report = true): void {
    if (run.done) return
    run.done = true
    if (this.active === run) this.active = null
    const { paneId, id } = run.spec
    const final = this.finishedRow(run, result)
    const own = `computer:${id}:`
    const next: ChatMessage[] = []
    for (const r of this.list(paneId)) {
      if (r.id === `${own}progress`) next.push(final)
      else if (run.spec.ownThread || !r.id.startsWith(`${own}ask:`)) next.push(r)
    }
    if (!next.includes(final)) next.push(final)
    this.set(paneId, next)
    this.deps.log?.(`computer ${id}: ${result.outcome}: ${result.summary}`)
    if (!run.spec.ownThread) return
    const pictures = [...run.images.map((p) => p.file), ...(result.image ? [result.image] : [])]
    const told =
      report && this.deps.report
        ? this.deps.report(run.spec, result, run.lines, pictures).catch(() => false)
        : Promise.resolve(false)
    void told.then((ok) => {
      if (ok) return
      const text = [
        result.summary.trim() || OUTCOME_WORD[result.outcome],
        ...pictures.map((p) => imageLine(p, 'Picture')),
      ]
      this.post(
        paneId,
        makeMessage(`${own}summary`, 'assistant', text.join('\n\n'), { at: run.at }),
      )
    })
  }

  /** Stops the active run (app quit): its row says so at once, so a saved thread never shows it working. */
  stopAll(): void {
    const run = this.active
    if (!run) return
    run.abort.abort()
    if (run.pending) this.answer(run, 'Cancel')
    this.finish(
      run,
      { outcome: 'stopped', summary: 'Stopped when Relay quit.', image: null },
      false,
    )
  }
}

const SavedRows = z.array(ChatMessageSchema)

/** One JSON file per session under `dir` (`<config>/computer/threads`), named by the file's hash. */
export function fileRowStore(dir: string): RowStore {
  const jsonOf = (file: string): string =>
    path.join(dir, `${createHash('sha1').update(file).digest('hex')}.json`)
  return {
    load(file) {
      try {
        return SavedRows.parse(JSON.parse(fs.readFileSync(jsonOf(file), 'utf8')))
      } catch {
        return []
      }
    },
    save(file, rows) {
      fs.mkdirSync(dir, { recursive: true })
      const tmp = `${jsonOf(file)}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(rows))
      fs.renameSync(tmp, jsonOf(file))
    },
  }
}
