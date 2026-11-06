import { z } from 'zod'
import { parseBackground } from '@evaos/chat-core/background'
import { computerPlanBlocks, stripComputerPlan } from '@evaos/chat-core/computer-plan'
import { isNothingToReport } from '@evaos/chat-core/quiet'
import { parseSession } from '@evaos/chat-core/session'
import type { AgentResult } from './agent'
import type { Brain, ToolSpec } from './brain'
import type { ComputerMode } from './command'

/**
 * The plan a run starts from (SPEC.md "Context and plan"). In an assistant's own thread the
 * assistant writes it: a hidden request goes into its omp session and it answers in its voice with
 * a `computer-plan` block, read back from the session file. Anywhere else, or when the assistant
 * is busy or slow, a planner call (medium effort) writes it from the chat's last turns.
 */

export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
}

/** Messages of the chat a brief reads (user and assistant, oldest first). */
export const BRIEF_TURNS = 30
const TURN_CHARS = 1500
const MENTIONS_MAX = 10
/** How long the assistant's own session gets to answer before the planner writes the plan. */
export const PLAN_WAIT_MS = 25_000

const TOKENS = /\n*[ \t]*\[\[(?:replies|ask-label|pin):[^\]\n]*\]\][ \t]*/g

/**
 * The chat's last `max` messages as plain text: what Isaac typed and what the assistant said,
 * without tools, thinking, background lines (jobs, heartbeats, earlier plan requests), quiet
 * `(nothing to report)` replies, plan blocks or reply tokens. Each is cut to TURN_CHARS.
 */
export function chatTurns(sessionText: string, max = BRIEF_TURNS): ChatTurn[] {
  const out: ChatTurn[] = []
  for (const m of parseSession(sessionText).messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    if (m.role === 'user' && parseBackground(m.text) !== null) continue
    const text = stripComputerPlan(m.text).replace(TOKENS, '').trim()
    if (text === '' || isNothingToReport(text)) continue
    out.push({
      role: m.role,
      text: text.length > TURN_CHARS ? `${text.slice(0, TURN_CHARS)}…` : text,
    })
  }
  return out.slice(-max)
}

/** Places the chat named: web and local-server URLs, and files (paths, or bare document names). */
export interface Mentions {
  urls: string[]
  files: string[]
}

const URL_RE = /\bhttps?:\/\/[^\s<>()[\]"'`]+/g
const HOST_PORT = /(?<![\w/.:-])(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/g
const PORT_WORD = /\bport\s+(\d{3,5})\b/gi
const PATH_RE = /(?<![\w/.])((?:~|\/Users|\/tmp|\/private|\/Volumes)\/[^\s`'"<>()[\]]+)/g
const DOC_RE =
  /(?<![\w/.-])([\w][\w.-]{0,80}\.(?:txt|md|rtf|rtfd|pdf|docx?|pages|numbers|key|csv|tsv|json|html?|png|jpe?g|gif|mov|mp4|xlsx?|pptx?))(?![\w-])/gi
const TRAILING = /[.,;:!?]+$/

/** Newest first, each once, at most MENTIONS_MAX of a kind. */
export function mentionsIn(turns: readonly ChatTurn[]): Mentions {
  const urls: string[] = []
  const files: string[] = []
  const add = (list: string[], v: string): void => {
    const clean = v.replace(TRAILING, '')
    if (clean !== '' && !list.includes(clean) && list.length < MENTIONS_MAX) list.push(clean)
  }
  for (const t of [...turns].reverse()) {
    for (const m of t.text.matchAll(URL_RE)) add(urls, m[0])
    for (const m of t.text.matchAll(HOST_PORT)) {
      const port = m[1]!
      if (!urls.some((u) => new RegExp(`:${port}(?!\\d)`).test(u)))
        add(urls, `http://127.0.0.1:${port}`)
    }
    for (const m of t.text.matchAll(PORT_WORD)) {
      const port = m[1]!
      if (!urls.some((u) => new RegExp(`:${port}(?!\\d)`).test(u)))
        add(urls, `http://127.0.0.1:${port}`)
    }
    const paths = [...t.text.matchAll(PATH_RE)].map((m) => m[1]!.replace(TRAILING, ''))
    for (const p of paths) add(files, p)
    for (const m of t.text.matchAll(DOC_RE)) {
      const name = m[1]!.replace(TRAILING, '')
      // A bare name already inside a path or URL said in the same message adds nothing.
      if (!paths.some((p) => p.endsWith(`/${name}`)) && !/\bhttps?:\/\//.test(name))
        add(files, name)
    }
  }
  return { urls, files }
}

/** The chat as the planner reads it: who said what, then the places it named. */
export function chatContext(turns: readonly ChatTurn[], assistant: string): string {
  if (turns.length === 0) return 'The chat is empty: the task is all there is.'
  const said = turns.map((t) => `${t.role === 'user' ? 'Isaac' : assistant}: ${t.text}`)
  const { urls, files } = mentionsIn(turns)
  const places = [
    ...(urls.length > 0 ? [`URLs and local servers: ${urls.join(', ')}`] : []),
    ...(files.length > 0 ? [`Files: ${files.join(', ')}`] : []),
  ]
  return [
    `The chat (last ${String(turns.length)} messages, oldest first):`,
    said.join('\n\n'),
    ...(places.length > 0 ? ['', 'Named in the chat (newest first):', ...places] : []),
  ].join('\n')
}

const StepSchema = z.object({
  instruction: z.string().min(1),
  target: z.string().catch(''),
  done_when: z.string().catch(''),
})

export const PlanSchema = z.object({
  brief: z.string().catch(''),
  app: z.string().catch(''),
  url: z.string().catch(''),
  file: z.string().catch(''),
  intro: z.string().catch(''),
  steps: z
    .array(z.unknown())
    .catch([])
    .transform((list) => list.flatMap((s) => StepSchema.safeParse(s).data ?? []).slice(0, 10)),
  outro: z.string().catch(''),
})

/** What a run starts from, and who wrote it: the assistant in its own thread, or the planner from the chat. */
export type RunPlan = z.infer<typeof PlanSchema> & {
  by: 'assistant' | 'chat'
  /** The assistant's own words to Isaac around the plan (shown in its thread already). */
  said: string
}

export const PLAN_TOOL: ToolSpec = {
  name: 'plan_run',
  description:
    'The run plan: a brief for the hands, where it happens, the steps in order, a spoken intro and outro.',
  parameters: {
    type: 'object',
    properties: {
      brief: {
        type: 'string',
        description:
          'At most 200 words: the goal, where (app, URL or file), what to show or do step by step, and the facts it needs from the chat.',
      },
      app: { type: 'string', description: 'Mac app it happens in, or "".' },
      url: {
        type: 'string',
        description: 'Web page or local server to open (http://127.0.0.1:5390), or "".',
      },
      file: { type: 'string', description: 'A document\'s full path to open, or "".' },
      intro: { type: 'string', description: 'One short spoken line before the first step.' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            instruction: { type: 'string' },
            target: { type: 'string' },
            done_when: { type: 'string' },
          },
          required: ['instruction', 'target', 'done_when'],
        },
      },
      outro: { type: 'string', description: 'One short spoken line at the end.' },
    },
    required: ['brief', 'app', 'url', 'file', 'intro', 'steps', 'outro'],
  },
}

const MODE_PHRASE: Record<ComputerMode, string> = {
  headless: 'do it in the background (no focus change, Isaac keeps working)',
  live: 'do it live while Isaac watches your cursor',
  walk: 'walk Isaac through it: he does each step while you point, caption and say it',
}

const STEPS_RULE: Record<ComputerMode, string> = {
  headless:
    'steps: up to 8 short steps the hands follow, in order (instruction only; target and done_when may be "").',
  live: 'steps: up to 8 short steps the hands follow, in order (instruction only; target and done_when may be "").',
  walk: "steps: 2 to 8 steps Isaac does himself, each exactly one action on one visible control: instruction (imperative, under 70 characters, in your voice: it is the caption and is spoken), target (that control's visible label), done_when (what the window shows once it is done, checkable from its controls and values). To show changes on a page, make each change one step whose target is the element that changed. A ticket with QA steps or steps to reproduce: walk those in order.",
}

const WHERE_RULE =
  'app, url, file: where it happens ("" when not known). url for a web page or local server, with its port (http://127.0.0.1:5390); file for a document\'s full path; app for a Mac app (the browser the chat used, TextEdit, Linear...).'

/** The planner's instructions (no assistant session to ask, or it did not answer). */
export function planInstructions(o: {
  assistant: string
  profile: string
  mode: ComputerMode
  today: string
}): string {
  return [
    `You are ${o.assistant}, Isaac's ${o.profile || 'personal'} assistant, planning a run of Relay's @computer on his Mac (his real, signed-in apps). Today is ${o.today}. Isaac sent the task in a chat; the chat is given and the task refers to it.`,
    `Mode: ${MODE_PHRASE[o.mode]}.`,
    'Work out from the chat exactly what the task means: which prototype, file, page or app, where it is (URL with its port, full file path) and what to show or do. Never invent a place the chat does not give; when it does not say, plan to find it (the windows on screen, the browser) and say so in the brief.',
    'brief: at most 200 words for the hands that will do it: the goal, where, what to show or do step by step, and the facts it needs from the chat (names, paths, ports, what changed).',
    WHERE_RULE,
    STEPS_RULE[o.mode],
    'intro and outro: one short line each in your voice (shown and spoken in live and walk).',
    'Plain words, no em dashes. Call plan_run once.',
  ].join('\n')
}

/**
 * The hidden request that asks the chat's own assistant to plan: a background line in its thread
 * (`[From <Title>'s background jobs]`, a quiet row in the chat). It answers in its voice and ends
 * with the `computer-plan` block Relay reads and hides.
 */
export function assistantPlanRequest(o: {
  runId: string
  task: string
  mode: ComputerMode
  assistant: string
  windows: string
  ticket: string | null
}): string {
  const shape = JSON.stringify({
    run: o.runId,
    brief: '...',
    app: '',
    url: '',
    file: '',
    intro: '...',
    steps: [{ instruction: '...', target: '', done_when: '' }],
    outro: '...',
  })
  return [
    `[From ${o.assistant}'s background jobs] @computer: Isaac asked you, in this thread, to ${MODE_PHRASE[o.mode]}: "${o.task}"`,
    '',
    "You own this run. Relay's computer-use loop is your hands and starts the moment you answer, so do not open apps, click or drive the Mac yourself (a quick look at a file to get a fact right is fine). Plan it from what you know of this thread.",
    'Answer Isaac with one short line in your own voice saying what you are about to do, then end your reply with this block exactly (Relay reads it and hides it from the chat):',
    '```computer-plan',
    shape,
    '```',
    'brief: at most 200 words for the hands: the goal, where, what to show or do step by step, and the facts they need from this thread (names, paths, ports, what changed).',
    WHERE_RULE,
    STEPS_RULE[o.mode],
    'intro and outro: one short line each in your voice; live and walk show and speak them.',
    `Keep "run": "${o.runId}" as is. No em dashes.`,
    ...(o.ticket ? ['', `Ticket:\n${o.ticket.slice(0, 3000)}`] : []),
    '',
    `Windows on Isaac's screen now:\n${o.windows || '(none listed)'}`,
  ].join('\n')
}

/** The plan run `runId` asked for, from the assistant's reply in the session; null until it is there. */
export function planFromSession(sessionText: string, runId: string): RunPlan | null {
  const messages = parseSession(sessionText).messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'assistant' || !m.text.includes('```computer-plan')) continue
    for (const body of computerPlanBlocks(m.text)) {
      let raw: unknown
      try {
        raw = JSON.parse(body)
      } catch {
        continue
      }
      if (!z.object({ run: z.literal(runId) }).safeParse(raw).success) continue
      return { ...PlanSchema.parse(raw), by: 'assistant', said: stripComputerPlan(m.text).trim() }
    }
  }
  return null
}

export interface PlanOptions {
  runId: string
  task: string
  mode: ComputerMode
  assistant: { title: string; profile: string }
  /**
   * The chat is this assistant's own thread: `ask` sends it the hidden request (false when it is
   * busy or unreachable) and `read` is its session file now, where the answer lands.
   */
  own: { ask(text: string): Promise<boolean>; read(): string | null } | null
  /** The chat's session file text; null for a draft. */
  chat: string | null
  planner: Brain
  /** `App: title` lines of the windows on screen. */
  windows: string
  ticket: string | null
  signal: AbortSignal
  waitMs?: number
  pollMs?: number
  log?: (line: string) => void
}

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/**
 * The run's plan: from the assistant's own session when the chat is its thread and it answers
 * within `waitMs`, else from the planner over the chat's last turns. Null when stopped or the
 * planner gave none.
 */
export async function planRun(o: PlanOptions): Promise<RunPlan | null> {
  const waitMs = o.waitMs ?? PLAN_WAIT_MS
  if (o.own) {
    const asked = await o.own
      .ask(
        assistantPlanRequest({
          runId: o.runId,
          task: o.task,
          mode: o.mode,
          assistant: o.assistant.title,
          windows: o.windows,
          ticket: o.ticket,
        }),
      )
      .catch(() => false)
    if (asked) {
      const until = Date.now() + waitMs
      while (Date.now() < until && !o.signal.aborted) {
        await sleep(o.pollMs ?? 500)
        const text = o.own.read()
        const plan = text === null ? null : planFromSession(text, o.runId)
        if (plan) return plan
      }
      o.log?.(`${o.runId}: ${o.assistant.title} did not plan within ${String(waitMs)} ms`)
    } else {
      o.log?.(`${o.runId}: ${o.assistant.title} is busy or unreachable`)
    }
  }
  if (o.signal.aborted) return null
  const input = [
    `Task from Isaac: ${o.task}`,
    chatContext(o.chat ? chatTurns(o.chat) : [], o.assistant.title),
    ...(o.ticket ? [`Ticket:\n${o.ticket}`] : []),
    `Windows on screen:\n${o.windows || '(none listed)'}`,
  ].join('\n\n')
  const turn = await o.planner.turn(
    [{ role: 'user', content: [{ type: 'input_text', text: input }] }],
    o.signal,
  )
  const call = turn.calls.find((c) => c.name === PLAN_TOOL.name)
  return call ? { ...PlanSchema.parse(call.args), by: 'chat', said: '' } : null
}

/** The plan as the hands' system context: the brief, where, and the steps. */
export function planContext(plan: RunPlan, assistant: string): string {
  const where = [
    plan.url && `URL: ${plan.url}`,
    plan.file && `File: ${plan.file}`,
    plan.app && `App: ${plan.app}`,
  ].filter(Boolean)
  const steps = plan.steps.map((s, i) => `${String(i + 1)}. ${s.instruction}`)
  return [
    `Context from the chat the task was sent in (${plan.by === 'assistant' ? `${assistant}'s own plan` : 'a brief written from the chat'}): resolve what the task refers to with it, not by guessing.`,
    plan.brief || '(no brief)',
    ...(where.length > 0 ? [`Where: ${where.join('; ')}`] : []),
    ...(steps.length > 0 ? ['Planned steps:', ...steps] : []),
  ].join('\n')
}

/**
 * How the run went, as a background line into the assistant's own thread: its reply is the
 * summary Isaac sees, in its voice, and the result stays in its context for later turns.
 */
export function reportRequest(o: {
  assistant: string
  task: string
  result: AgentResult
  lines: readonly string[]
  pictures: readonly string[]
}): string {
  const steps = o.lines.slice(-20).map((l, i) => `${String(i + 1)}. ${l}`)
  return [
    `[From ${o.assistant}'s background jobs] @computer finished (${o.result.outcome}): ${o.result.summary}`,
    `Task: "${o.task}"`,
    ...(steps.length > 0 ? ['What your hands did:', ...steps] : []),
    ...(o.pictures.length > 0
      ? ['Pictures (local files):', ...o.pictures.map((p) => `![Picture](<${p}>)`)]
      : []),
    '',
    `Tell Isaac how it went in one to three sentences in your own voice, the answer first. Relay already shows him the steps; never reply "(nothing to report)" to this line.${o.pictures.length > 0 ? ' End with the picture lines exactly as given.' : ''} No em dashes.`,
  ].join('\n')
}
