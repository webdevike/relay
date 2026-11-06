import { z } from 'zod'
import type { AgentResult, RunIO } from './agent'
import type { Brain } from './brain'
import type { Desktop, Snapshot, WindowInfo } from './desktop'
import type { Judge } from './judge'
import type { Presenter } from './presenter'
import type { WalkControl } from './runs'

/**
 * `@computer walk` (SPEC.md): plan the steps once, then for each one point at its control, caption
 * it and say it in the assistant's voice, and wait for Isaac to do it. The window is re-read every
 * POLL_MS; the step is done when the judge says its `done_when` holds. `next`/`skip` move on by hand.
 */

export const PlanSchema = z.object({
  app: z.string().min(1),
  intro: z.string().default(''),
  steps: z
    .array(
      z.object({
        instruction: z.string().min(1),
        target: z.string().default(''),
        done_when: z.string().min(1),
      }),
    )
    .min(1)
    .max(10),
  outro: z.string().default('Nice, that is all of it.'),
})
export type WalkPlan = z.infer<typeof PlanSchema>

export const PLAN_TOOL = {
  name: 'plan_walk',
  description:
    'The walkthrough: which app, a one-line intro, the steps in order, a one-line outro.',
  parameters: {
    type: 'object',
    properties: {
      app: {
        type: 'string',
        description: 'App name or bundle id to do it in (e.g. "Calculator", "Arc", "Linear").',
      },
      intro: { type: 'string', description: 'One short spoken line before step 1.' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            instruction: {
              type: 'string',
              description:
                'What Isaac does, one imperative line under 70 characters, spoken and shown as the caption.',
            },
            target: {
              type: 'string',
              description:
                'The visible label of the control to point at (button title, field name, menu name).',
            },
            done_when: {
              type: 'string',
              description:
                "What the app's window shows once the step is done, checkable from its controls and values.",
            },
          },
          required: ['instruction', 'target', 'done_when'],
        },
      },
      outro: { type: 'string', description: 'One short spoken line at the end.' },
    },
    required: ['app', 'intro', 'steps', 'outro'],
  },
} as const

export function planInstructions(assistant: string, today: string): string {
  return [
    `You are ${assistant}, planning a walkthrough on Isaac's Mac. Today is ${today}. Isaac does every step himself; you point at the control, show one caption and say it.`,
    'Plan 2 to 8 steps in the app where the task happens. Each instruction names exactly one action on one visible control. done_when must be visible in that window afterwards (a value, a selected tab, a field that now holds text), not a feeling.',
    'When a ticket is given and it has QA steps or steps to reproduce, walk those in order. Otherwise walk the task as asked.',
    'Plain words, no em dashes. Call plan_walk once.',
  ].join('\n')
}

export interface WalkOptions {
  task: string
  assistant: { id: string; title: string }
  desktop: Desktop
  planner: Brain
  judge: Judge
  presenter: Presenter
  io: RunIO
  control: (cb: (c: WalkControl) => void) => void
  /** Ticket text when the task names one (read from Linear). */
  ticket: string | null
  pollMs?: number
  stepTimeoutMs?: number
}

const POLL_MS = 700
const STEP_TIMEOUT_MS = 3 * 60_000
const DONE_P = 0.85

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

export async function runWalk(o: WalkOptions): Promise<AgentResult> {
  const { desktop, presenter, io, judge } = o
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
  await settle(presenter.caption('Planning the steps…').landed, 1500)
  const windows = (await desktop.windows()).map((w) => `${w.app}: ${w.title}`).join('\n')
  const turn = await o.planner.turn(
    [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `Task: walk Isaac through ${o.task}\n\n${o.ticket ? `Ticket:\n${o.ticket}\n\n` : ''}Windows on screen:\n${windows}`,
          },
        ],
      },
    ],
    io.signal,
  )
  const call = turn.calls.find((c) => c.name === 'plan_walk')
  if (!call) return end('failed', `I couldn't plan it: ${turn.text || 'no plan came back'}`)
  const plan = PlanSchema.parse(call.args)
  io.progress(`Plan: ${plan.steps.length} steps in ${plan.app}`)

  const { pid, windows: wins } = await desktop.openApp(plan.app)
  if (wins.length === 0) return end('failed', `${plan.app} has no window I can show you.`)
  // Walk: Isaac does the steps, so the app comes forward.
  await desktop.front(wins[0]!.windowId)
  if (plan.intro) await settle(presenter.caption(plan.intro, true).spoken, 8000)

  const results: string[] = []
  for (const [i, step] of plan.steps.entries()) {
    if (io.signal.aborted)
      return end('stopped', `Stopped at step ${i + 1} of ${plan.steps.length}.`)
    const n = `${i + 1}/${plan.steps.length}`
    let win = await frontWindowOf(desktop, pid)
    if (!win) return end('failed', `${plan.app} closed its window at step ${n}.`)
    let snap = await desktop.read(win.windowId)
    if (
      (await judge.holds(step.done_when, snap.title, snap.tree, io.signal).catch(() => 0)) >= DONE_P
    ) {
      io.progress(`Step ${n}: ${step.instruction} (already done)`)
      results.push('already')
      continue
    }
    const options = targets(snap)
    const picked = await judge
      .pick(
        `Isaac's next step: "${step.instruction}". Which control should he use${step.target ? ` (it reads like "${step.target}")` : ''}?`,
        snap.title,
        options,
        io.signal,
      )
      .catch(() => ({ choice: 'none', p: 0 }))
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
  const done = results.filter((r) => r === 'done' || r === 'already').length
  return end(
    'done',
    `Walked you through ${plan.steps.length} steps in ${plan.app}; ${done} showed done in the app.`,
    plan.outro,
  )
}
