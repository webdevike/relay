import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import type { Brain, InputItem, ToolCall, ToolSpec } from './brain'
import type { RunPlan } from './brief'
import {
  clickTarget,
  describeStep,
  drawnOnly,
  StepSchema,
  toScreen,
  type Control,
  type Desktop,
  type Snapshot,
  type Step,
} from './desktop'
import type { Locator } from './locate'
import type { Presenter } from './presenter'
import { gate } from './safety'

/** What a run reports to its chat while it works. */
export interface RunIO {
  /** One numbered progress line. */
  progress(line: string): void
  /** The plan the run starts from, shown collapsed on its row. */
  plan(plan: RunPlan): void
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
  /** Finds a click's target in the window's picture when the window has no control for it. */
  locator?: Locator | null
  io: RunIO
  /** Where screenshots go, and which ones the chat gets. */
  shots: { dir: string; want: Shots }
  limits?: { actions?: number; ms?: number; turns?: number }
  /** The plan the run starts from (its brief is in the brain's instructions); live captions its intro. */
  plan?: RunPlan | null
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
  if (
    /\bscreenshots?\s+(?:of\s+)?(?:each|every)\b|\beach step\b.*\bscreenshot|\bscreenshots\b/i.test(
      task,
    )
  )
    return 'each'
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
    name: 'open_url',
    description:
      'Open a link in the background (no focus change): https pages and local servers (http://127.0.0.1:5390) in the default browser, linear://ecard-systems/issue/<KEY> shows that Linear issue in the Linear app, x-apple.systempreferences: panes. Answers the windows on screen; then read the one that shows it. Faster and surer than searching inside an app.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'open_file',
    description:
      'Open a document by its full path (or ~/...) in the background (no focus change), in `app` when given ("TextEdit"), else its default app. Documents only: never programs or scripts. Answers the windows on screen; then read the one that shows it.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, app: { type: 'string' } },
      required: ['path'],
    },
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
      'Run a batch of steps in one window, in order, stopping at the first failure; answers the fresh controls (new refs: old ones are dead). Batch every step you can predict. Steps: click/double_click/right_click {ref}, or {target} when the window has no control for it (custom-drawn apps: the text or a short description of what to click, found in a fresh picture of the window, and a picture after comes back); type {text, ref?} (into the field ref, else the focused field); set_value {ref, text}; key {key, modifiers?} (return, tab, escape, space, delete, up, down, left, right...); hotkey {keys: ["cmd","n"]}; menu {path: ["File","New"]}; scroll {direction, amount?, ref?}; wait {ms}. Keys go to the panel in front of the window when one is up (Quick Look, a sheet), and each says whether the window changed after it. `reason` is one short line for Isaac ("Entering 12 x 7").',
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
      'Ask Isaac a question in the chat and wait for his answer (free-form; `options` are optional tap chips, 2 to 4 short ones, and he may type anything instead). Waits up to 10 minutes. Use it for any question you need him to answer: ambiguous task, which one, missing detail, or before anything irreversible; act also asks him by itself before risky steps.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' } },
      },
      required: ['question'],
    },
  },
  {
    name: 'finish',
    description:
      'End the run with a short summary for Isaac: what you did and what you found (the answer, the value read, where things are now). Say plainly if something did not work.',
    parameters: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    },
  },
]

export function instructions(o: {
  assistant: string
  mode: 'headless' | 'live' | 'walk'
  today: string
  /** The plan's brief and steps (brief.ts planContext): what the task refers to in its chat. */
  context?: string
}): string {
  return [
    `You are ${o.assistant}, running Relay's @computer agent on Isaac's Mac (his real, signed-in apps). Today is ${o.today}.`,
    o.mode === 'live'
      ? 'Mode live: Isaac is watching. Your cursor is drawn on screen for every step, so keep batches short and purposeful.'
      : "Mode headless: you work in the background through Accessibility. Never bring a window forward and never move Isaac's mouse; he keeps using the Mac while you work.",
    'How to work: open_app (or list_windows) to find the window, read it, then act in batches against the refs of the latest read. Each act answers the fresh controls; re-read only when you need something it did not show. Prefer the accessibility tree; use a screenshot only when the tree cannot answer. When a link reaches the thing directly (a Linear issue key: linear://ecard-systems/issue/ENG-123; a web page or local server), use open_url instead of searching in the app; a document with a known path opens with open_file.',
    'Windows without controls: some apps draw their own UI (Bambu Studio, games, canvases) and their read has no refs; it comes with the window picture instead. Click there by `target`, what the control shows ("Slice plate"), and check the picture the act answers. A key whose act says NOTHING CHANGED did not land: say so instead of pressing it again and again.',
    "Safety: anything that sends, posts, deletes, buys, pays, submits, publishes, shares, invites or accepts needs Isaac's OK: act asks him by itself and refuses if he says no; do not try another way around a refusal. Never type passwords or secrets; if a login is needed, stop and say so. In messaging apps never type a name and Return in one batch. Stay inside the task: no exploring.",
    'Read-only tasks: look and report; do not change anything.',
    'Finish with the finish tool: two or three plain sentences, the answer first. No em dashes.',
    ...(o.context ? ['', o.context] : []),
  ].join('\n')
}

const OpenAppArgs = z.object({ app: z.string().min(1) })
const OpenUrlArgs = z.object({ url: z.string().min(1) })
const OpenFileArgs = z.object({ path: z.string().min(1), app: z.string().optional() })
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
  const tree =
    snap.tree.length > TREE_CAP
      ? `${snap.tree.slice(0, TREE_CAP)}\n… (cut: pass query to narrow)`
      : snap.tree
  return `window_id=${snap.windowId} app=${snap.app} title="${snap.title}" refs=${snap.controls.size}${snap.truncated ? ' (truncated)' : ''}\n${tree}`
}

interface Exec {
  text: string
  image?: Buffer
  finish?: string
}

const CLICKS: Partial<Record<Step['type'], true>> = {
  click: true,
  double_click: true,
  right_click: true,
}
/** A click on a picture has a moment to show its effect before the picture after. */
const VISION_SETTLE_MS = 600
const DRAWN_NOTE =
  '\n\nThis window shows no accessible controls (it draws its own). Its picture is attached: click what you see with {"type":"click","target":"<the text it shows, or a short description>"}; act finds it in a fresh picture and answers a picture after.'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

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

  const savePicture = (
    pic: { app: string; image: Buffer | null },
    caption: string,
    post: boolean,
  ): string | null => {
    if (!pic.image) return null
    const file = path.join(
      o.shots.dir,
      `${String(++shotN).padStart(2, '0')}-${pic.app.replace(/[^\w-]+/g, '_')}.png`,
    )
    fs.writeFileSync(file, pic.image)
    if (post) io.image(file, caption)
    return file
  }

  /** A read with no controls (a custom-drawn window): its picture, and how to click in it. */
  const drawn = async (snap: Snapshot): Promise<{ note: string; image?: Buffer }> => {
    if (!drawnOnly(snap)) return { note: '' }
    const image =
      snap.image ??
      (await desktop.shot(snap.windowId).then(
        (s) => s.image,
        () => null,
      ))
    return image ? { note: DRAWN_NOTE, image } : { note: DRAWN_NOTE }
  }

  /**
   * The vision fallback for one click: a fresh picture, the locator finds `target` in it, the gate
   * judges what is there (asking Isaac unless this step was asked about already), the cursor glides
   * there (live), the pixel is clicked, and a fresh picture says whether the window changed.
   */
  const byPicture = async (
    windowId: number,
    step: Step,
    target: string,
    reason: string,
    asked: boolean,
  ): Promise<{ note: string; after: Buffer | null } | { declined: string }> => {
    const locator = o.locator
    if (!locator) throw new Error('no vision here to find it in the picture')
    const find = async () => {
      const shot = await desktop.shot(windowId)
      const found = await locator.locate(shot.image, shot, target, io.signal)
      if (!found) throw new Error(`could not find “${target}” in the window's picture`)
      return { shot, found }
    }
    let { shot, found } = await find()
    const verb = step.type.replace('_', ' ')
    const v = gate({ ...step, target: `${target} ${found.label}` }, undefined, shot.app, o.task)
    if (v.kind === 'refuse') throw new Error(`refused: ${v.why}`)
    if (v.kind === 'ask' && !asked) {
      const what = `${verb} “${found.label || target}”`
      const answer = await io.ask(
        `${reason || 'Next step'} in ${shot.app}: ${what}. OK?`,
        ['Approve', 'Cancel'],
        savePicture(shot, 'Before', false),
      )
      if (answer !== 'Approve') return { declined: what }
      io.progress(`You approved: ${what}`)
      // Minutes may have passed: look again, and click only the same thing.
      const approved = found.label.toLowerCase()
      ;({ shot, found } = await find())
      if (found.label.toLowerCase() !== approved)
        throw new Error(`the picture changed (now “${found.label}”); nothing clicked`)
    }
    const cx = found.x + found.w / 2
    const cy = found.y + found.h / 2
    if (presenter) {
      const at = toScreen(shot, cx, cy)
      await settle(presenter.click(at.x, at.y, reason || `${verb} “${found.label}”`).landed)
    }
    let how: 'background' | 'in front'
    try {
      how = await desktop.clickAt(
        shot,
        cx,
        cy,
        step.type as 'click' | 'double_click' | 'right_click',
        o.mode === 'live',
      )
    } catch (e) {
      if (o.mode === 'live') throw e
      throw new Error(
        `${errText(e)}. Headless cannot click in this window; Isaac can run it with @computer live`,
      )
    }
    await sleep(VISION_SETTLE_MS)
    const after = await desktop.shot(windowId).catch(() => null)
    const changed = !after
      ? 'could not take a picture after it'
      : shot.image.equals(after.image)
        ? 'NOTHING CHANGED in the picture after it'
        : 'the window changed'
    if (after && o.shots.want === 'each') savePicture(after, `After ${verb} ${found.label}`, true)
    return {
      note: `found “${found.label}” in the picture, clicked it ${how} at (${Math.round(cx)}, ${Math.round(cy)}); ${changed}`,
      after: after?.image ?? null,
    }
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
        return {
          text:
            wins
              .filter((w) => w.title || w.app)
              .map((w) => `window_id=${w.windowId} ${w.app}: ${w.title}`)
              .join('\n') || 'No windows on screen.',
        }
      }
      case 'open_app': {
        const { app } = OpenAppArgs.parse(call.args)
        const { windows } = await desktop.openApp(app)
        if (windows.length === 0)
          return {
            text: `${app} is running but has no window on screen yet; call list_windows in a moment.`,
          }
        // Front to back, but an untitled helper window can sit in front (Calculator's, 2026-11-06,
        // which cua-driver can neither front nor resolve): the app's titled window is its window.
        const first = windows.find((w) => w.title) ?? windows[0]!
        lastWindow = first.windowId
        if (o.mode === 'live') await desktop.front(first.windowId)
        io.progress(`Opened ${first.app}${o.mode === 'headless' ? ' in the background' : ''}`)
        const snap = await desktop.read(first.windowId)
        const list = windows.map((w) => `window_id=${w.windowId} ${w.app}: ${w.title}`).join('\n')
        const d = await drawn(snap)
        return {
          text: `${list}\n\n${render(snap)}${d.note}`,
          ...(d.image ? { image: d.image } : {}),
        }
      }
      case 'open_url':
      case 'open_file': {
        const file = call.name === 'open_file' ? OpenFileArgs.parse(call.args) : null
        const what = file ? file.path : OpenUrlArgs.parse(call.args).url
        const { windows, landed } = file
          ? await desktop.openFile(file.path, file.app)
          : await desktop.openUrl(what)
        if (landed) lastWindow = landed.windowId
        if (landed && o.mode === 'live') await desktop.front(landed.windowId)
        io.progress(`Opened ${what}${o.mode === 'headless' ? ' in the background' : ''}`)
        const list =
          windows
            .filter((w) => w.title || w.app)
            .map((w) => `window_id=${w.windowId} ${w.app}: ${w.title}`)
            .join('\n') || 'No windows on screen.'
        return {
          text: landed
            ? `It landed in window_id=${landed.windowId} ${landed.app}: ${landed.title}\n\nAll windows:\n${list}`
            : `No window changed yet (it may still be loading, or it was open already).\n\nAll windows:\n${list}`,
        }
      }
      case 'read_window': {
        const a = ReadArgs.parse(call.args)
        const snap = await desktop.read(a.window_id, {
          ...(a.query ? { query: a.query } : {}),
          screenshot: a.screenshot === true,
        })
        lastWindow = a.window_id
        const pic =
          a.screenshot === true
            ? savePicture(snap, snap.title || snap.app, o.shots.want === 'each')
            : null
        if (pic && snap.image) return { text: render(snap), image: snap.image }
        // A query that matched nothing is not a drawn window.
        const d = a.query ? { note: '' } : await drawn(snap)
        return { text: `${render(snap)}${d.note}`, ...(d.image ? { image: d.image } : {}) }
      }
      case 'act': {
        const a = ActArgs.parse(call.args)
        let snap = desktop.last(a.window_id) ?? (await desktop.read(a.window_id))
        lastWindow = a.window_id
        // A click's control: its ref, else the control labelled like its target; none means the
        // picture finds it (vision), and the gate reads its target instead.
        const controlOf = (s: Step): Control | undefined => {
          if (!CLICKS[s.type]) return s.ref === undefined ? undefined : snap.controls.get(s.ref)
          const t = clickTarget(s, snap)
          return t.kind === 'ax' ? t.control : undefined
        }
        const verdicts = a.steps
          .map((s) => ({ step: s, control: controlOf(s) }))
          .map((x) => ({ ...x, v: gate(x.step, x.control, snap.app, o.task) }))
        const refused = verdicts.filter((x) => x.v.kind === 'refuse')
        if (refused.length > 0) {
          const why = refused
            .map(
              (x) => `${describeStep(x.step, x.control)}: ${x.v.kind === 'refuse' ? x.v.why : ''}`,
            )
            .join('; ')
          io.progress(`Refused: ${why}`)
          return {
            text: `REFUSED, nothing ran: ${why}. Do not try another way; finish and tell Isaac.`,
          }
        }
        const risky = verdicts.filter((x) => x.v.kind === 'ask')
        if (risky.length > 0) {
          const pic = await desktop
            .read(a.window_id, { screenshot: true })
            .then((s) => savePicture(s, 'Before', false))
            .catch(() => null)
          const what = risky.map((x) => (x.v.kind === 'ask' ? x.v.why : '')).join(', ')
          const answer = await io.ask(
            `${a.reason || 'Next step'} in ${snap.app}: ${what}. OK?`,
            ['Approve', 'Cancel'],
            pic,
          )
          if (answer !== 'Approve') {
            io.progress(`You said no to: ${what}`)
            return {
              text: `Isaac declined (${what}). Nothing ran. Do not retry it; finish and say so.`,
            }
          }
          io.progress(`You approved: ${what}`)
          snap = desktop.last(a.window_id) ?? snap
        }
        const log: string[] = []
        let ok = 0
        let picture: Buffer | null = null
        for (const [i, step] of a.steps.entries()) {
          if (io.signal.aborted) break
          if (actions >= limits.actions) {
            budgetHit = true
            log.push(`${i + 1}. not run: action budget (${limits.actions}) used up`)
            break
          }
          const t = CLICKS[step.type] ? clickTarget(step, snap) : null
          const control = controlOf(step)
          const said = describeStep(step, control)
          if (t?.kind === 'vision') {
            try {
              const r = await byPicture(
                a.window_id,
                step,
                t.target,
                a.reason,
                verdicts[i]?.v.kind === 'ask',
              )
              if ('declined' in r) {
                io.progress(`You said no to: ${r.declined}`)
                log.push(`${i + 1}. ${said}: Isaac declined (${r.declined}); nothing more ran`)
                break
              }
              actions++
              ok++
              picture = r.after ?? picture
              log.push(`${i + 1}. ${said}: ok (${r.note})`)
              // The click needed a cua-driver capture, which stales the refs: read again for the
              // steps after it that use one.
              if (a.steps.slice(i + 1).some((s) => s.ref !== undefined))
                snap = await desktop.read(a.window_id).catch(() => snap)
            } catch (e) {
              log.push(`${i + 1}. ${said}: FAILED ${errText(e)}`)
              break
            }
            continue
          }
          if (presenter) {
            const f = control?.frame
            if (f && CLICKS[step.type])
              await settle(presenter.click(f.x + f.w / 2, f.y + f.h / 2, a.reason || said).landed)
            else if (f) await settle(presenter.point(f, a.reason || said).landed)
            else await settle(presenter.caption(a.reason || said).landed)
          }
          try {
            const note = await desktop.act(a.window_id, step, { inFront: o.mode === 'live' })
            actions++
            ok++
            log.push(`${i + 1}. ${said}: ok${note ? ` (${note})` : ''}`)
          } catch (e) {
            log.push(`${i + 1}. ${said}: FAILED ${errText(e)}`)
            break
          }
        }
        io.progress(
          `${a.reason || 'Acted'}${ok < a.steps.length ? ` (${ok}/${a.steps.length} steps ran)` : ''}`,
        )
        const after = await readAfter(snap)
        const d = picture ? { note: '', image: picture } : await drawn(after)
        return {
          text: `Ran ${ok}/${a.steps.length} steps. A step marked ok was delivered; check the controls below (or the picture) for the effect.\n${log.join('\n')}\n\nAfter:\n${render(after)}${d.note}`,
          ...(d.image ? { image: d.image } : {}),
        }
      }
      case 'ask_isaac': {
        const a = AskArgs.parse(call.args)
        const options = a.options && a.options.length >= 2 ? a.options.slice(0, 4) : []
        const answer = await io.ask(a.question, options, null)
        if (answer === 'Cancel')
          return { text: 'Isaac did not answer (cancelled or timed out). Finish and say so.' }
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
      image = await desktop
        .read(lastWindow, { screenshot: true })
        .then((s) => savePicture(s, 'Final', false))
        .catch(() => null)
    }
    if (presenter) {
      await settle(presenter.caption(summary.split(/(?<=[.!?])\s/)[0] ?? summary).landed)
      await sleep(2500)
      presenter.hide()
    }
    return { outcome, summary, image }
  }

  presenter?.assistant(o.assistant.id)
  if (presenter) await settle(presenter.caption(o.plan?.intro || `On it: ${o.task}`).landed)
  let items: InputItem[] = [
    { role: 'user', content: [{ type: 'input_text', text: `Task from Isaac: ${o.task}` }] },
  ]
  for (let turn = 0; turn < limits.turns; turn++) {
    if (io.signal.aborted) return end('stopped', 'Stopped. Nothing else will run.')
    if (now() - started > limits.ms)
      return end(
        'budget',
        `Out of time after ${Math.round(limits.ms / 60_000)} minutes; stopped where it was.`,
      )
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
      items.push({
        role: 'user',
        content: images.map((b) => ({
          type: 'input_image' as const,
          image_url: `data:image/png;base64,${b.toString('base64')}`,
        })),
      })
    }
    if (budgetHit)
      return end('budget', `Used the ${limits.actions}-action budget; stopped where it was.`)
  }
  return end('budget', 'Too many model turns; stopped where it was.')
}
