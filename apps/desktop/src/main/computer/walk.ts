import type { AgentResult, RunIO } from './agent'
import type { RunPlan } from './brief'
import type { Desktop, Snapshot, WindowInfo } from './desktop'
import type { Judge } from './judge'
import type { Presenter } from './presenter'
import type { WalkControl } from './runs'

/**
 * `@computer walk` (SPEC.md): the run's plan (brief.ts: the assistant's own, or written from the
 * chat) is the step list. Open where it happens (its URL, file or app), then for each step point at
 * its control, caption it and say it in the assistant's words, and wait for Isaac to do it. The
 * window is re-read every POLL_MS; the step is done when the judge says its `done_when` holds.
 * `next`/`skip` move on by hand.
 */

export interface WalkOptions {
  plan: RunPlan
  assistant: { id: string; title: string }
  desktop: Desktop
  judge: Judge
  presenter: Presenter
  io: RunIO
  control: (cb: (c: WalkControl) => void) => void
  pollMs?: number
  stepTimeoutMs?: number
}

const POLL_MS = 700
const STEP_TIMEOUT_MS = 3 * 60_000
const DONE_P = 0.85
/** A look step: how long its line may play, then how long it stays up (`next` cuts it short). */
const LOOK_SPEAK_MS = 12_000
const LOOK_HOLD_MS = 1500

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}
const settle = (p: Promise<void>, ms: number): Promise<void> => Promise.race([p, sleep(ms)])

/** The app's front window (cua-driver lists front to back). */
async function frontWindowOf(desktop: Desktop, pid: number): Promise<WindowInfo | null> {
  return (await desktop.windows()).find((w) => w.pid === pid) ?? null
}

/** Controls a step can point at: labelled, with a frame, as `r<ref>` options. */
function targets(snap: Snapshot): Record<string, string> {
  const out: Record<string, string> = {}
  let n = 0
  for (const c of snap.controls.values()) {
    if (
      !c.frame ||
      c.frame.w < 2 ||
      c.frame.h < 2 ||
      /AXWindow|AXGroup|AXScrollArea|AXSplitGroup/.test(c.role)
    )
      continue
    if (n++ >= 250) break
    out[`r${String(c.ref)}`] = c.line.replace(/ \[actions=[^\]]*\]/, '').slice(0, 160)
  }
  out.none = 'No control on screen fits this step.'
  return out
}

/** Where the plan happens, opened and in front: its URL, else its file, else its app. */
async function openWhere(
  desktop: Desktop,
  plan: RunPlan,
): Promise<{ pid: number; window: WindowInfo; app: string } | string> {
  if (plan.url || plan.file) {
    const { landed, windows } = plan.url
      ? await desktop.openUrl(plan.url)
      : await desktop.openFile(plan.file, plan.app || undefined)
    // Already open in a tab or window: nothing changed, so take the app's window instead.
    const win =
      landed ??
      (plan.app ? windows.find((w) => w.app.toLowerCase() === plan.app.toLowerCase()) : undefined)
    if (win) return { pid: win.pid, window: win, app: win.app }
    if (!plan.app) return `${plan.url || plan.file} opened, but no window showed it.`
  }
  if (!plan.app) return 'the plan did not say where to do it.'
  const { pid, windows } = await desktop.openApp(plan.app)
  const first = windows[0]
  return first
    ? { pid, window: first, app: first.app }
    : `${plan.app} has no window I can show you.`
}

export async function runWalk(o: WalkOptions): Promise<AgentResult> {
  const { desktop, presenter, io, judge, plan } = o
  const pollMs = o.pollMs ?? POLL_MS
  let control: WalkControl | null = null
  o.control((c) => {
    control = c
  })
  const end = async (
    outcome: AgentResult['outcome'],
    summary: string,
    say?: string,
  ): Promise<AgentResult> => {
    if (say) await settle(presenter.caption(say, true).spoken, 8000)
    presenter.hide()
    return { outcome, summary, image: null }
  }

  presenter.assistant(o.assistant.id)
  if (plan.steps.length === 0) return end('failed', "I couldn't plan the steps for this one.")
  const where = await openWhere(desktop, plan)
  if (typeof where === 'string') return end('failed', `I couldn't start: ${where}`)
  const { pid } = where
  io.progress(`Walking ${plan.steps.length} steps in ${where.app}`)
  // Walk: Isaac does the steps, so the app comes forward.
  await desktop.front(where.window.windowId)
  if (plan.intro) await settle(presenter.caption(plan.intro, true).spoken, 8000)

  const results: string[] = []
  for (const [i, step] of plan.steps.entries()) {
    if (io.signal.aborted)
      return end('stopped', `Stopped at step ${i + 1} of ${plan.steps.length}.`)
    const n = `${i + 1}/${plan.steps.length}`
    // A step with nothing for Isaac to do (pointing at a change) is shown, said, and moved past.
    const look = step.done_when.trim() === ''
    let win = await frontWindowOf(desktop, pid)
    if (!win) return end('failed', `${where.app} closed its window at step ${n}.`)
    let snap = await desktop.read(win.windowId)
    // Both questions are about the same read: ask them together, a judge call each is seconds.
    const [already, picked] = await Promise.all([
      look ? 0 : judge.holds(step.done_when, snap.title, snap.tree, io.signal).catch(() => 0),
      judge
        .pick(
          `Isaac's next step: "${step.instruction}". Which control should he use${step.target ? ` (it reads like "${step.target}")` : ''}?`,
          snap.title,
          targets(snap),
          io.signal,
        )
        .catch(() => ({ choice: 'none', p: 0 })),
    ])
    if (already >= DONE_P) {
      io.progress(`Step ${n}: ${step.instruction} (already done)`)
      results.push('already')
      continue
    }
    const frame =
      picked.choice === 'none'
        ? null
        : (snap.controls.get(Number(picked.choice.slice(1)))?.frame ?? null)
    io.progress(`Step ${n}: ${step.instruction}`)
    const shown = frame
      ? presenter.point(frame, step.instruction, {
          speak: step.instruction,
          step: i + 1,
          of: plan.steps.length,
        })
      : presenter.caption(step.instruction, true)
    let outcome: 'done' | 'next' | 'skip' | 'timeout' | 'stopped' = 'timeout'
    if (look) {
      control = null
      await settle(shown.spoken, LOOK_SPEAK_MS)
      for (let t = 0; t < LOOK_HOLD_MS && !io.signal.aborted; t += pollMs) {
        const c: WalkControl | null = control
        if (c) break
        await sleep(pollMs)
      }
      if (io.signal.aborted) return end('stopped', `Stopped at step ${n}.`)
      results.push('shown')
      io.progress(`Step ${n} shown`)
      continue
    }
    for (let waits = 0; outcome === 'timeout'; waits++) {
      if (waits > 0) {
        const a = await io.ask(
          `Still with me on step ${n} (“${step.instruction}”)?`,
          ['Keep waiting', 'Skip', 'Stop'],
          null,
        )
        if (a === 'Stop' || a === 'Cancel') return end('stopped', `Stopped at step ${n}.`)
        if (a === 'Skip') {
          outcome = 'skip'
          break
        }
      }
      control = null
      const started = Date.now()
      let lastCheck = 0
      while (Date.now() - started < (o.stepTimeoutMs ?? STEP_TIMEOUT_MS)) {
        await sleep(pollMs)
        if (io.signal.aborted) {
          outcome = 'stopped'
          break
        }
        const c: WalkControl | null = control
        if (c) {
          outcome = c
          break
        }
        // The model judge is slower: check it less often than Jev.
        if (judge.name !== 'jev' && Date.now() - lastCheck < 2500) continue
        lastCheck = Date.now()
        win = (await frontWindowOf(desktop, pid)) ?? win
        try {
          snap = await desktop.read(win.windowId)
        } catch {
          continue
        }
        if (
          (await judge.holds(step.done_when, snap.title, snap.tree, io.signal).catch(() => 0)) >=
          DONE_P
        ) {
          outcome = 'done'
          break
        }
      }
    }
    if (outcome === 'stopped') return end('stopped', `Stopped at step ${n}.`)
    results.push(outcome === 'done' ? 'done' : outcome === 'skip' ? 'skipped' : 'moved on')
    // Her line may still be playing when he is quick; the next step takes over.
    await settle(shown.spoken, 300)
    io.progress(
      `Step ${n} ${outcome === 'done' ? 'done' : outcome === 'skip' ? 'skipped' : 'moved on'}`,
    )
  }
  const done = results.filter((r) => r === 'done' || r === 'already' || r === 'shown').length
  return end(
    'done',
    `Walked you through ${plan.steps.length} steps in ${where.app}; ${done} showed done in the app.`,
    plan.outro,
  )
}
