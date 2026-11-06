import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import type { Brain, InputItem, ToolCall, ToolSpec } from './brain'
import { describeStep, StepSchema, type Desktop, type Snapshot } from './desktop'
import type { Presenter } from './presenter'
import { gate } from './safety'

/** What a run reports to its chat while it works. */
export interface RunIO {
  /** One numbered progress line. */
  progress(line: string): void
  /** A picture under the progress lines. */
  image(file: string, caption: string): void
  /** Asks Isaac in the chat; answers the option he picked ('Cancel' on stop or timeout). */
  ask(question: string, options: string[], image: string | null): Promise<string>
  readonly signal: AbortSignal
  /** Ends the run (Esc on the overlay), like `@computer stop`. */
  stop(): void
}

export type Shots = 'none' | 'final' | 'each'

export interface AgentOptions {
  task: string
  mode: 'headless' | 'live'
  assistant: { id: string; title: string }
  desktop: Desktop
  brain: Brain
  presenter: Presenter | null
  io: RunIO
  /** Where screenshots go, and which ones the chat gets. */
  shots: { dir: string; want: Shots }
  limits?: { actions?: number; ms?: number; turns?: number }
  now?: () => number
}

export interface AgentResult {
  outcome: 'done' | 'stopped' | 'failed' | 'budget'
  summary: string
  image: string | null
}

export const LIMITS = { actions: 30, ms: 6 * 60_000, turns: 40 }
const TREE_CAP = 14_000

/** Which pictures the task asks for: none, the final window, or every step. */
export function shotsWanted(task: string): Shots {
  if (/\bscreenshots?\s+(?:of\s+)?(?:each|every)\b|\beach step\b.*\bscreenshot|\bscreenshots\b/i.test(task)) return 'each'
  return /\b(screenshot|screen shot|show me|picture)\b/i.test(task) ? 'final' : 'none'
}

export const TOOLS: readonly ToolSpec[] = [
  {
    name: 'open_app',
    description:
      'Launch or reuse a Mac app in the background (no focus change) by name ("Calculator") or bundle id. Answers its windows, and the controls of its first window.',
    parameters: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] },
  },
  {
    name: 'list_windows',
    description: 'On-screen windows of every app: window_id, app, title.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'read_window',
    description:
      'Read one window: its controls as numbered refs ([12] AXButton (Save)). `query` filters big trees (keeps matching controls). `screenshot: true` adds a picture of the window (use only when the tree cannot answer, or Isaac asked for a picture).',
    parameters: {
      type: 'object',
      properties: {
        window_id: { type: 'integer' },
        query: { type: 'string' },
        screenshot: { type: 'boolean' },
      },
      required: ['window_id'],
    },
  },
  {
    name: 'act',
    description:
      'Run a batch of steps in one window, in order, stopping at the first failure; answers the fresh controls (new refs: old ones are dead). Batch every step you can predict. Steps: click/double_click/right_click {ref}; type {text, ref?} (into the field ref, else the focused field); set_value {ref, text}; key {key, modifiers?} (return, tab, escape, delete, up, down...); hotkey {keys: ["cmd","n"]}; menu {path: ["File","New"]}; scroll {direction, amount?, ref?}; wait {ms}. `reason` is one short line for Isaac ("Entering 12 x 7").',
    parameters: {
      type: 'object',
      properties: {
        window_id: { type: 'integer' },
        reason: { type: 'string' },
        steps: { type: 'array', items: { type: 'object' } },
      },
      required: ['window_id', 'reason', 'steps'],
    },
  },
  {
    name: 'ask_isaac',
    description:
      'Ask Isaac a question in the chat and wait for his answer (2 to 4 short options). Use it when the task is ambiguous or before anything irreversible; act also asks him by itself before risky steps.',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
      required: ['question'],
    },
  },
  {
    name: 'finish',
    description:
      'End the run with a short summary for Isaac: what you did and what you found (the answer, the value read, where things are now). Say plainly if something did not work.',
    parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
  },
]

export function instructions(o: { assistant: string; mode: 'headless' | 'live' | 'walk'; today: string }): string {
  return [
    `You are ${o.assistant}, running Relay's @computer agent on Isaac's Mac (his real, signed-in apps). Today is ${o.today}.`,
    o.mode === 'live'
      ? 'Mode live: Isaac is watching. Your cursor is drawn on screen for every step, so keep batches short and purposeful.'
      : "Mode headless: you work in the background through Accessibility. Never bring a window forward and never move Isaac's mouse; he keeps using the Mac while you work.",
    'How to work: open_app (or list_windows) to find the window, read it, then act in batches against the refs of the latest read. Each act answers the fresh controls; re-read only when you need something it did not show. Prefer the accessibility tree; use a screenshot only when the tree cannot answer.',
    'Safety: anything that sends, posts, deletes, buys, pays, submits, publishes, shares, invites or accepts needs Isaac\'s OK: act asks him by itself and refuses if he says no; do not try another way around a refusal. Never type passwords or secrets; if a login is needed, stop and say so. In messaging apps never type a name and Return in one batch. Stay inside the task: no exploring.',
    'Read-only tasks: look and report; do not change anything.',
    'Finish with the finish tool: two or three plain sentences, the answer first. No em dashes.',
  ].join('\n')
}

const OpenAppArgs = z.object({ app: z.string().min(1) })
const ReadArgs = z.object({
  window_id: z.number().int(),
  query: z.string().optional(),
  screenshot: z.boolean().optional(),
})
const ActArgs = z.object({
  window_id: z.number().int(),
  reason: z.string().default(''),
  steps: z.array(StepSchema).min(1).max(20),
})
const AskArgs = z.object({ question: z.string().min(1), options: z.array(z.string()).optional() })
const FinishArgs = z.object({ summary: z.string() })

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/** Waits for the cursor at most `ms`: a stuck presenter never holds the run. */
const settle = (p: Promise<void>, ms = 2500): Promise<void> => Promise.race([p, sleep(ms)])

function render(snap: Snapshot): string {
  const tree = snap.tree.length > TREE_CAP ? `${snap.tree.slice(0, TREE_CAP)}\n… (cut: pass query to narrow)` : snap.tree
  return `window_id=${snap.windowId} app=${snap.app} title="${snap.title}" refs=${snap.controls.size}${snap.truncated ? ' (truncated)' : ''}\n${tree}`
}

interface Exec {
  text: string
  image?: Buffer
  finish?: string
}

/** The headless and live loop: the model picks tools, the gate and Isaac decide what is risky. */
export async function runAgent(o: AgentOptions): Promise<AgentResult> {
  const now = o.now ?? Date.now
  const limits = { ...LIMITS, ...o.limits }
  const started = now()
  let actions = 0
  let budgetHit = false
  let shotN = 0
  let lastWindow: number | null = null
  const { desktop, io, presenter } = o
  fs.mkdirSync(o.shots.dir, { recursive: true })

  const savePicture = (snap: Snapshot, caption: string, post: boolean): string | null => {
    if (!snap.image) return null
    const file = path.join(o.shots.dir, `${String(++shotN).padStart(2, '0')}-${snap.app.replace(/[^\w-]+/g, '_')}.png`)
    fs.writeFileSync(file, snap.image)
    if (post) io.image(file, caption)
    return file
  }

  /** A window that swapped on navigation (System Settings): read the same app's first window instead. */
  const readAfter = async (snap: Snapshot): Promise<Snapshot> => {
    try {
      return await desktop.read(snap.windowId)
    } catch {
      const next = (await desktop.windows()).find((w) => w.pid === snap.pid)
      if (!next) throw new Error(`${snap.app} has no window on screen any more`)
      lastWindow = next.windowId
      return desktop.read(next.windowId)
    }
  }

  const exec = async (call: ToolCall): Promise<Exec> => {
    switch (call.name) {
      case 'list_windows': {
        const wins = await desktop.windows()
        return { text: wins.filter((w) => w.title || w.app).map((w) => `window_id=${w.windowId} ${w.app}: ${w.title}`).join('\n') || 'No windows on screen.' }
      }
      case 'open_app': {
        const { app } = OpenAppArgs.parse(call.args)
        const { windows } = await desktop.openApp(app)
        if (windows.length === 0) return { text: `${app} is running but has no window on screen yet; call list_windows in a moment.` }
        const first = windows[0]!
        lastWindow = first.windowId
        if (o.mode === 'live') await desktop.front(first.windowId)
        io.progress(`Opened ${first.app}${o.mode === 'headless' ? ' in the background' : ''}`)
        const snap = await desktop.read(first.windowId)
        const list = windows.map((w) => `window_id=${w.windowId} ${w.app}: ${w.title}`).join('\n')
        return { text: `${list}\n\n${render(snap)}` }
      }
      case 'read_window': {
        const a = ReadArgs.parse(call.args)
        const snap = await desktop.read(a.window_id, {
          ...(a.query ? { query: a.query } : {}),
          screenshot: a.screenshot === true,
        })
        lastWindow = a.window_id
        const pic = a.screenshot === true ? savePicture(snap, snap.title || snap.app, o.shots.want === 'each') : null
        return pic && snap.image ? { text: render(snap), image: snap.image } : { text: render(snap) }
      }
      case 'act': {
        const a = ActArgs.parse(call.args)
        let snap = desktop.last(a.window_id) ?? (await desktop.read(a.window_id))
        lastWindow = a.window_id
        const verdicts = a.steps.map((s) => ({ step: s, control: s.ref === undefined ? undefined : snap.controls.get(s.ref) })).map((x) => ({ ...x, v: gate(x.step, x.control, snap.app, o.task) }))
        const refused = verdicts.filter((x) => x.v.kind === 'refuse')
        if (refused.length > 0) {
          const why = refused.map((x) => `${describeStep(x.step, x.control)}: ${x.v.kind === 'refuse' ? x.v.why : ''}`).join('; ')
          io.progress(`Refused: ${why}`)
          return { text: `REFUSED, nothing ran: ${why}. Do not try another way; finish and tell Isaac.` }
        }
        const risky = verdicts.filter((x) => x.v.kind === 'ask')
        if (risky.length > 0) {
          const pic = await desktop.read(a.window_id, { screenshot: true }).then((s) => savePicture(s, 'Before', false)).catch(() => null)
          const what = risky.map((x) => (x.v.kind === 'ask' ? x.v.why : '')).join(', ')
          const answer = await io.ask(`${a.reason || 'Next step'} in ${snap.app}: ${what}. OK?`, ['Approve', 'Cancel'], pic)
          if (answer !== 'Approve') {
            io.progress(`You said no to: ${what}`)
            return { text: `Isaac declined (${what}). Nothing ran. Do not retry it; finish and say so.` }
          }
          io.progress(`You approved: ${what}`)
          snap = desktop.last(a.window_id) ?? snap
        }
        const log: string[] = []
        for (const [i, step] of a.steps.entries()) {
          if (io.signal.aborted) break
          if (actions >= limits.actions) {
            budgetHit = true
            log.push(`${i + 1}. not run: action budget (${limits.actions}) used up`)
            break
          }
          const control = step.ref === undefined ? undefined : snap.controls.get(step.ref)
          const said = describeStep(step, control)
          if (presenter) {
            const f = control?.frame
            if (f && ['click', 'double_click', 'right_click'].includes(step.type)) await settle(presenter.click(f.x + f.w / 2, f.y + f.h / 2, a.reason || said).landed)
            else if (f) await settle(presenter.point(f, a.reason || said).landed)
            else await settle(presenter.caption(a.reason || said).landed)
          }
          try {
            await desktop.act(a.window_id, step)
            actions++
            log.push(`${i + 1}. ${said}: ok`)
          } catch (e) {
            log.push(`${i + 1}. ${said}: FAILED ${e instanceof Error ? e.message : String(e)}`)
            break
          }
        }
        const ok = log.filter((l) => l.endsWith(': ok')).length
        io.progress(`${a.reason || 'Acted'}${ok < a.steps.length ? ` (${ok}/${a.steps.length} steps ran)` : ''}`)
        const after = await readAfter(snap)
        return { text: `Ran ${ok}/${a.steps.length} steps. A step marked ok was delivered; check the controls below for the effect.\n${log.join('\n')}\n\nAfter:\n${render(after)}` }
      }
      case 'ask_isaac': {
        const a = AskArgs.parse(call.args)
        const options = a.options && a.options.length >= 2 ? a.options.slice(0, 4) : ['Yes', 'No']
        const answer = await io.ask(a.question, options, null)
        io.progress(`You answered: ${answer}`)
        return { text: `Isaac answered: ${answer}` }
      }
      case 'finish':
        return { text: '', finish: FinishArgs.parse(call.args).summary }
      default:
        return { text: `Unknown tool ${call.name}` }
    }
  }

  const end = async (outcome: AgentResult['outcome'], summary: string): Promise<AgentResult> => {
    let image: string | null = null
    if (o.shots.want !== 'none' && lastWindow !== null) {
      image = await desktop.read(lastWindow, { screenshot: true }).then((s) => savePicture(s, 'Final', false)).catch(() => null)
    }
    if (presenter) {
      await settle(presenter.caption(summary.split(/(?<=[.!?])\s/)[0] ?? summary).landed)
      await sleep(2500)
      presenter.hide()
    }
    return { outcome, summary, image }
  }

  presenter?.assistant(o.assistant.id)
  if (presenter) await settle(presenter.caption(`On it: ${o.task}`).landed)
  let items: InputItem[] = [{ role: 'user', content: [{ type: 'input_text', text: `Task from Isaac: ${o.task}` }] }]
  for (let turn = 0; turn < limits.turns; turn++) {
    if (io.signal.aborted) return end('stopped', 'Stopped. Nothing else will run.')
    if (now() - started > limits.ms) return end('budget', `Out of time after ${Math.round(limits.ms / 60_000)} minutes; stopped where it was.`)
    let t
    try {
      t = await o.brain.turn(items, io.signal)
    } catch (e) {
      if (io.signal.aborted) return end('stopped', 'Stopped. Nothing else will run.')
      return end('failed', `The model call failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (t.calls.length === 0) return end('done', t.text || 'Done.')
    items = []
    const images: Buffer[] = []
    for (const call of t.calls) {
      if (io.signal.aborted) return end('stopped', 'Stopped. Nothing else will run.')
      let out: Exec
      try {
        out = await exec(call)
      } catch (e) {
        out = { text: `ERROR: ${e instanceof Error ? e.message : String(e)}` }
      }
      if (out.finish !== undefined) return end('done', out.finish)
      items.push({ type: 'function_call_output', call_id: call.callId, output: out.text })
      if (out.image) images.push(out.image)
    }
    if (images.length > 0) {
      items.push({ role: 'user', content: images.map((b) => ({ type: 'input_image' as const, image_url: `data:image/png;base64,${b.toString('base64')}` })) })
    }
    if (budgetHit) return end('budget', `Used the ${limits.actions}-action budget; stopped where it was.`)
  }
  return end('budget', 'Too many model turns; stopped where it was.')
}
