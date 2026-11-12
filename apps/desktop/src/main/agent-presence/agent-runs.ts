import { randomUUID } from 'node:crypto'
import { createActor, type Actor } from 'xstate'
import type { AgentRun, AgentRunOp } from '@evaos/contract'
import {
  ACTIVE_STATUS,
  agentRunMachine,
  runView,
  type RunWho,
} from '@evaos/shell-core/agent-run.machine'

/**
 * Agents' runs on the surfaces Isaac sees (a web page, a canvas board), one agentRunMachine per
 * surface key: who may act, Isaac's Take over / Hand back / Allow / Not now, the idle clock, and
 * actions waiting for his Allow. The surface draws each run (ring, caption, work card) through
 * `publish` and moves its cursor away through `hideCursor`. Shared by the browser drive and the
 * canvas drive (docs/agent-presence.md).
 */

/** What a surface shows of a run (AgentRun without the surface's own `background`). */
export type RunView = Omit<AgentRun, 'background'>

export interface RunSurface<K extends string> {
  publish(key: K, run: RunView): void
  hideCursor(key: K): void
}

/** How refusals name the surface and its wait action (`page`, `browser.wait`). */
export interface RunWords {
  noun: string
  wait: string
}

/** How long an action waits for Isaac's Allow before it answers `awaiting-approval`. */
export const ASK_WAIT_MS = 75_000

export interface Risk {
  label: string
}

interface Outcome {
  allowed: boolean
  paused?: boolean
  value?: unknown
  error?: unknown
}

interface Pending {
  run: () => Promise<unknown>
  settled: Array<(o: Outcome) => void>
}

interface Slot<W extends Owned> {
  actor: Actor<typeof agentRunMachine>
  who: W
  pending: Pending | null
  /** Isaac's last answer to an Allow row, for a wait that comes after it. */
  last: Outcome | null
  handback: Array<() => void>
  shown: string
  /** Goes up whenever the run stops being the agent's (Take over, finish): actions in flight end. */
  epoch: number
}

/**
 * Who acts, with the chat it acts from: plain chats all show as Eva, so the run belongs to the
 * chat's workspace when there is one, else to the face.
 */
export type Owned = RunWho & { workspace?: string | null }

const ownerOf = (w: Owned): string => w.workspace ?? `${w.id ?? ''}\0${w.name}`

export const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code })
}

/** Isaac's answer to `p`, or null when he has not answered within `ms`. */
function outcomeOf(p: Pending, ms: number): Promise<Outcome | null> {
  const { promise, resolve } = Promise.withResolvers<Outcome | null>()
  const timer = setTimeout(() => resolve(null), ms)
  p.settled.push((o) => {
    clearTimeout(timer)
    resolve(o)
  })
  return promise
}

export class AgentRuns<K extends string, W extends Owned> {
  private slots = new Map<K, Slot<W>>()

  constructor(
    private readonly surface: RunSurface<K>,
    private readonly words: RunWords,
    private readonly now: () => number = Date.now,
  ) {}

  /** The run on `key` as the surface shows it, or null when no agent has one there. */
  view(key: K): RunView | null {
    const s = this.slots.get(key)
    return s ? runView(s.actor.getSnapshot()) : null
  }

  /** Who last acted on `key` (with whatever the drive carries, like its cursor face). */
  who(key: K): W | null {
    return this.slots.get(key)?.who ?? null
  }

  keys(): K[] {
    return [...this.slots.keys()]
  }

  /**
   * The run on `key`, made idle for `who` when there is none (a page an agent opened shows its
   * face before it acts).
   */
  private slot(key: K, who: W, since: number): Slot<W> {
    const had = this.slots.get(key)
    if (had) return had
    const slot = { who, pending: null, last: null, handback: [], shown: '', epoch: 0 } as Omit<
      Slot<W>,
      'actor'
    > as Slot<W>
    const machine = agentRunMachine.provide({
      actions: {
        hideCursor: () => this.surface.hideCursor(key),
        releasePending: (_, params) => this.release(slot, { allowed: false, ...params }),
        runPending: () => this.runPending(slot),
        resumeWaiters: () => {
          for (const w of slot.handback.splice(0)) w()
        },
      },
    })
    slot.actor = createActor(machine, { input: { who, since } })
    this.slots.set(key, slot)
    slot.actor.subscribe((snap) => {
      const run = runView(snap)
      const text = JSON.stringify(run)
      if (text === slot.shown) return
      slot.shown = text
      this.surface.publish(key, run)
    })
    slot.actor.start()
    return slot
  }

  /** Records an idle run for `who` on `key` (no-op when one exists). */
  seed(key: K, who: W, since: number): void {
    this.slot(key, who, since)
  }

  /** Forgets `key` (the page closed, the board went away). */
  drop(key: K): void {
    const s = this.slots.get(key)
    if (!s) return
    s.epoch++
    this.release(s, { allowed: false })
    s.actor.stop()
    this.slots.delete(key)
  }

  /**
   * The run's epoch on `key`: an action notes it when it begins and goes on only while it is
   * unchanged and the run is working (Isaac took over or the run ended in between otherwise).
   */
  epoch(key: K): number {
    return this.slots.get(key)?.epoch ?? -1
  }

  private release(slot: Slot<W>, o: Outcome): void {
    const p = slot.pending
    if (!p) return
    slot.pending = null
    slot.last = { allowed: o.allowed, ...(o.paused ? { paused: true } : {}) }
    for (const s of p.settled.splice(0)) s(o)
  }

  private runPending(slot: Slot<W>): void {
    const p = slot.pending
    if (!p) return
    slot.pending = null
    slot.last = { allowed: true }
    void p.run().then(
      (value) => {
        for (const s of p.settled.splice(0)) s({ allowed: true, value })
      },
      (error: unknown) => {
        for (const s of p.settled.splice(0)) s({ allowed: true, error })
      },
    )
  }

  /**
   * Fails, changing nothing, when `who` may not act on `key` now: Isaac drives the surface, an
   * Allow is waiting, or another agent (another chat) is mid-run there.
   */
  admit(key: K, who: W): void {
    const slot = this.slots.get(key)
    if (!slot) return
    const cur = runView(slot.actor.getSnapshot())
    const { noun, wait } = this.words
    if (ACTIVE_STATUS[cur.status] && ownerOf(slot.who) !== ownerOf(who)) {
      fail('busy', `${cur.name} is driving this ${noun}`)
    }
    if (cur.status === 'paused') {
      fail(
        'paused-by-isaac',
        `Isaac took over this ${noun}. ${wait} until handback, then go on from what the ${noun} shows`,
      )
    }
    if (cur.status === 'ask') {
      fail(
        'awaiting-approval',
        `Waiting for Isaac to allow: ${cur.ask?.label ?? 'an action'}. ${wait} until approval`,
      )
    }
  }

  /** Starts (or goes on with) `who`'s run on `key`: it becomes `working`. Fails as `admit` does. */
  begin(key: K, who: W, caption?: string): void {
    this.admit(key, who)
    const slot = this.slot(key, who, this.now())
    slot.who = who
    slot.actor.send({ type: 'run.begin', who, caption, now: this.now() })
  }

  /** The agent's own caption (`auto` false), or the drive's, which never replaces the agent's. */
  caption(key: K, text: string, auto: boolean): void {
    this.slots.get(key)?.actor.send({ type: 'run.caption', text, auto })
  }

  /** An action finished: the idle clock starts again. */
  touch(key: K): void {
    this.slots.get(key)?.actor.send({ type: 'run.touch' })
  }

  /**
   * Runs `act` now, or, when it is risky, once Isaac allows it. Answers its value; throws
   * `declined-by-isaac`, `paused-by-isaac`, or `awaiting-approval` when he has not answered
   * within ASK_WAIT_MS (the action still runs if he allows it later).
   */
  async guarded<T>(key: K, risk: Risk | null, act: () => Promise<T>): Promise<T> {
    const slot = this.slots.get(key)
    if (!risk || !slot) return act()
    const pending: Pending = { run: act, settled: [] }
    slot.pending = pending
    slot.actor.send({ type: 'run.ask', id: randomUUID().slice(0, 8), label: risk.label })
    const outcome = await outcomeOf(pending, ASK_WAIT_MS)
    const { noun, wait } = this.words
    if (outcome === null) {
      return fail(
        'awaiting-approval',
        `Isaac has not answered "${risk.label}" yet. ${wait} until approval; it runs when he allows it`,
      )
    }
    if (outcome.paused) {
      return fail('paused-by-isaac', `Isaac took over this ${noun} instead. ${wait} until handback`)
    }
    if (!outcome.allowed) {
      return fail(
        'declined-by-isaac',
        `Isaac said not now to "${risk.label}". Do not retry it; tell him where things stand`,
      )
    }
    if (outcome.error !== undefined) throw outcome.error
    return outcome.value as T
  }

  /** Isaac's controls: Take over, Hand back, Allow, Not now, dismiss. */
  op(key: K, op: AgentRunOp): void {
    const slot = this.slots.get(key)
    if (!slot) return
    const a = slot.actor
    switch (op) {
      case 'takeOver':
        slot.epoch++
        a.send({ type: 'isaac.takeOver' })
        return
      case 'handBack':
        a.send({ type: 'isaac.handBack' })
        return
      case 'allow':
        a.send({ type: 'isaac.allow' })
        return
      case 'deny':
        a.send({ type: 'isaac.deny', now: this.now() })
        return
      case 'dismiss':
        a.send({ type: 'isaac.dismiss' })
        return
    }
  }

  /** Isaac's own input on the surface: he takes over a run that is working or asking. */
  isaacInput(key: K): void {
    const s = this.view(key)?.status
    if (s === 'working' || s === 'ask') this.op(key, 'takeOver')
  }

  /** Ends `who`'s run with `summary`; fails when another agent is mid-run there. */
  finish(key: K, who: W, summary: string, outcome: 'done' | 'stopped'): void {
    const slot = this.slot(key, who, this.now())
    const cur = runView(slot.actor.getSnapshot())
    if (ACTIVE_STATUS[cur.status] && ownerOf(slot.who) !== ownerOf(who)) {
      fail('busy', `${cur.name} is driving this ${this.words.noun}`)
    }
    slot.epoch++
    slot.who = who
    slot.actor.send({ type: 'run.finish', who, summary, outcome, now: this.now() })
  }

  /** True once Isaac hands back (at once when he does not hold it), false after `ms`. */
  async waitHandback(key: K, ms: number): Promise<boolean> {
    const slot = this.slots.get(key)
    if (!slot || this.view(key)?.status !== 'paused') return true
    const { promise, resolve } = Promise.withResolvers<boolean>()
    const back = (): void => resolve(true)
    slot.handback.push(back)
    const timer = setTimeout(() => {
      slot.handback = slot.handback.filter((w) => w !== back)
      resolve(false)
    }, ms)
    const met = await promise
    clearTimeout(timer)
    return met
  }

  /** Isaac's answer to the waiting Allow (or his last one): null while unanswered after `ms`. */
  async waitApproval(key: K, ms: number): Promise<{ allowed: boolean } | 'none' | null> {
    const slot = this.slots.get(key)
    if (!slot) return 'none'
    const answered = (o: Outcome): { allowed: boolean } => ({ allowed: o.allowed && !o.paused })
    if (!slot.pending) return slot.last ? answered(slot.last) : 'none'
    const o = await outcomeOf(slot.pending, ms)
    return o === null ? null : answered(o)
  }
}
