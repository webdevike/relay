import { randomUUID } from 'node:crypto'
import { normalize } from '@evaos/browser-core/address'
import type { AgentIdentity, AgentTabOp, AgentTabStatus, TabAgent } from '@evaos/contract'
import type { WebContents } from 'electron'
import { riskOf, type ElementInfo, type Risk } from './agent-guard'
import { CURSOR_LEAD_MS, type CursorOp } from './agent-cursor'
import type { BrowserHost } from './browser-host'
import type { PageControl } from './page-control'

/**
 * Agents driving pages in Isaac's own browser (his tabs, his signed-in session), with him in
 * charge. One runtime per driven tab:
 * - An action (navigate, click, type, press, scroll, caption) makes the caller the tab's agent
 *   and its status `working`: the tab shows its face, a ring and its caption, and its cursor
 *   glides to what it clicks. Reading and screenshots change nothing on screen.
 * - Isaac's own click, scroll or key in the tab, or Take over, pauses it: actions fail
 *   `paused-by-isaac` until he hands back (browser.wait until handback).
 * - A purchase, send, submit or delete (riskOf, or the agent's declared intent) waits in `ask`
 *   for his Allow: the action runs only then, even when the agent's own call already gave up
 *   after ASK_WAIT_MS (`awaiting-approval`; browser.wait until approval). Not now stops it.
 * - browser.done ends the run (done or stopped, with a summary); a run nobody touches for
 *   IDLE_MS goes idle on its own, so a forgotten ring never stays.
 */

/** How long an action waits for Isaac's Allow before it answers `awaiting-approval`. */
export const ASK_WAIT_MS = 75_000
/** A working run with no action for this long goes idle. */
export const IDLE_MS = 120_000
/** How long a click or key waits for a load it started. */
const LOAD_WAIT_MS = 15_000

/** Who drives, as the drive draws it: identity plus the portrait SVG its cursor carries. */
export interface DriveIdentity extends AgentIdentity {
  avatar: string | null
}

/** The host surface the drive uses (BrowserHost; a fake in tests). */
export type DriveHost = Pick<
  BrowserHost,
  | 'agentOf'
  | 'setAgent'
  | 'allTabs'
  | 'isShown'
  | 'driveView'
  | 'driveViewport'
  | 'acting'
  | 'onUserInput'
  | 'navigate'
  | 'back'
  | 'forward'
  | 'reload'
> & {
  pageControl(tabId: string): DrivePage
}

/** What the drive does in a page (PageControl; a fake in tests). */
export type DrivePage = Pick<
  PageControl,
  | 'bySelector'
  | 'byText'
  | 'atPoint'
  | 'center'
  | 'info'
  | 'focused'
  | 'outline'
  | 'text'
  | 'html'
  | 'screenshot'
  | 'mouseClick'
  | 'insertText'
  | 'press'
  | 'selectFocused'
  | 'scrollBy'
  | 'scrollTo'
  | 'cursor'
  | 'viewport'
  | 'evaluate'
>

/** What an action names: a ref from browser.read, a selector, visible text, or a point. */
export interface Target {
  ref?: string
  selector?: string
  text?: string
  x?: number
  y?: number
}

export interface Intent {
  kind: Risk['kind']
  label: string
}

interface Outcome {
  allowed: boolean
  /** Isaac took over instead of answering. */
  paused?: boolean
  value?: unknown
  error?: unknown
}

interface Pending {
  id: string
  risk: Risk
  run: () => Promise<unknown>
  settled: Array<(o: Outcome) => void>
}

interface Runtime {
  pending: Pending | null
  idle: NodeJS.Timeout | undefined
  /** The caption is the drive's own (`Clicking "Buy"`), so the next action may replace it. */
  autoCaption: boolean
  handback: Array<() => void>
  /** The identity it drives as, for the cursor's face. */
  who: DriveIdentity | null
  /** Isaac's last answer to an Allow row, for a browser.wait that comes after it. */
  last: Outcome | null
}

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code })
}

const ACTIVE: Record<AgentTabStatus, boolean> = {
  working: true,
  paused: true,
  ask: true,
  done: false,
  stopped: false,
  idle: false,
}

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/** True once the page stops loading (at once when it is not loading), false after `ms`. */
function loaded(wc: WebContents, ms: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  if (wc.isDestroyed() || !wc.isLoading()) resolve(true)
  else {
    const t = setTimeout(() => resolve(false), ms)
    wc.once('did-stop-loading', () => {
      clearTimeout(t)
      resolve(true)
    })
  }
  return promise
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

const quote = (s: string): string => `"${s.length > 48 ? `${s.slice(0, 47)}…` : s}"`

export class AgentDrive {
  private runs = new Map<string, Runtime>()

  constructor(
    private readonly host: DriveHost,
    /** Who the calling session is (its assistant's face and color), by its scope. */
    private readonly identify: (scope: string | undefined) => Promise<DriveIdentity>,
    private readonly now: () => number = Date.now,
  ) {
    host.onUserInput((tabId) => this.isaacInput(tabId))
  }

  private rt(tabId: string): Runtime {
    let r = this.runs.get(tabId)
    if (!r) {
      r = {
        pending: null,
        idle: undefined,
        autoCaption: false,
        handback: [],
        who: null,
        last: null,
      }
      this.runs.set(tabId, r)
    }
    return r
  }

  private agent(tabId: string): TabAgent | undefined {
    if (!this.host.allTabs().some((t) => t.state.id === tabId)) {
      fail('not-found', `No page ${tabId}; browser.tabs lists them`)
    }
    return this.host.agentOf(tabId)
  }

  private patch(tabId: string, p: Partial<TabAgent>): void {
    const cur = this.host.agentOf(tabId)
    if (cur) this.host.setAgent(tabId, { ...cur, ...p })
  }

  private touch(tabId: string): void {
    const r = this.rt(tabId)
    clearTimeout(r.idle)
    r.idle = setTimeout(() => {
      r.idle = undefined
      if (this.host.agentOf(tabId)?.status !== 'working') return
      this.patch(tabId, { status: 'idle', caption: '' })
      void this.cursorOp(tabId, { op: 'hide' })
    }, IDLE_MS)
  }

  /**
   * Starts (or continues) the caller's run in the tab: it becomes the tab's agent, `working`.
   * Fails when Isaac drives it, an Allow is waiting, or another agent is mid-run there.
   */
  private async begin(tabId: string, scope: string | undefined, caption?: string): Promise<void> {
    const cur = this.agent(tabId)
    const who = await this.identify(scope)
    if (cur && ACTIVE[cur.status] && (cur.id !== who.id || cur.name !== who.name)) {
      fail('busy', `${cur.name} is driving this page`)
    }
    if (cur?.status === 'paused') {
      fail(
        'paused-by-isaac',
        'Isaac took over this page. browser.wait until handback, then go on from what the page shows',
      )
    }
    if (cur?.status === 'ask') {
      fail(
        'awaiting-approval',
        `Waiting for Isaac to allow: ${cur.ask?.label ?? 'an action'}. browser.wait until approval`,
      )
    }
    const fresh = !cur || !ACTIVE[cur.status]
    const r = this.rt(tabId)
    r.who = who
    if (caption !== undefined) r.autoCaption = false
    this.host.setAgent(tabId, {
      id: who.id,
      name: who.name,
      color: who.color,
      status: 'working',
      caption: caption ?? (fresh ? '' : (cur?.caption ?? '')),
      background: cur?.background ?? false,
      ask: null,
      since: fresh || !cur ? this.now() : cur.since,
      ended: null,
    })
    this.touch(tabId)
  }

  /** A caption the drive writes for the agent (`Clicking "Add to cart"`), never over its own. */
  private autoCaption(tabId: string, text: string): void {
    const r = this.rt(tabId)
    const cur = this.host.agentOf(tabId)
    if (!cur || (cur.caption !== '' && !r.autoCaption)) return
    r.autoCaption = true
    this.patch(tabId, { caption: text })
  }

  private async cursorOp(tabId: string, op: CursorOp): Promise<number> {
    const who = this.runs.get(tabId)?.who
    const face =
      op.op === 'hide' || !who
        ? {}
        : {
            color: who.color,
            initial: who.name.slice(0, 1),
            ...(who.avatar ? { avatar: who.avatar } : {}),
          }
    try {
      return await this.host.pageControl(tabId).cursor({ ...op, ...face })
    } catch {
      // A page between documents has no world to draw in; the next step draws it.
      return 0
    }
  }

  /** The tab's page, live, laid out at a real viewport even while it is off screen. */
  private async page(tabId: string): Promise<{ pc: DrivePage; wc: WebContents }> {
    const wc = this.host.driveView(tabId).webContents
    const pc = this.host.pageControl(tabId)
    await pc.viewport(this.host.isShown(tabId) ? null : this.host.driveViewport())
    return { pc, wc }
  }

  /** The backend node a target names, or null for a bare point. */
  private async node(pc: DrivePage, t: Target): Promise<number | null> {
    if (t.ref !== undefined) return Number(t.ref.replace(/^n/, ''))
    if (t.selector !== undefined) {
      return (await pc.bySelector(t.selector)) ?? fail('not-found', `Nothing matches ${t.selector}`)
    }
    if (t.text !== undefined) {
      return (
        (await pc.byText(t.text)) ?? fail('not-found', `No visible ${quote(t.text)} on the page`)
      )
    }
    return null
  }

  private async point(
    pc: DrivePage,
    t: Target,
  ): Promise<{ node: number | null; x: number; y: number }> {
    const node = await this.node(pc, t)
    if (node !== null) return { node, ...(await pc.center(node)) }
    if (t.x === undefined || t.y === undefined) return fail('invalid-params', 'Give a target')
    return { node: await pc.atPoint(t.x, t.y), x: t.x, y: t.y }
  }

  /** Glides the cursor to x,y (on screen, Isaac sees it travel) and clicks there. */
  private async clickAt(tabId: string, pc: DrivePage, x: number, y: number): Promise<void> {
    const ms = await this.cursorOp(tabId, { op: 'move', x, y, lead: CURSOR_LEAD_MS })
    if (ms > 0 && this.host.isShown(tabId)) await sleep(ms)
    await this.cursorOp(tabId, { op: 'click', x, y })
    await this.host.acting(tabId, () => pc.mouseClick(x, y))
  }

  /** Lets a load the last input started finish (bounded), so answers describe the new page. */
  private async settle(wc: WebContents): Promise<void> {
    await sleep(150)
    if (wc.isDestroyed() || !wc.isLoading()) return
    await loaded(wc, LOAD_WAIT_MS)
  }

  private where(wc: WebContents): { url: string; title: string } {
    return wc.isDestroyed() ? { url: '', title: '' } : { url: wc.getURL(), title: wc.getTitle() }
  }

  private async pageText(pc: DrivePage): Promise<string> {
    try {
      return (await pc.text(40_000)).text
    } catch {
      return ''
    }
  }

  /**
   * Runs `act` now, or, when it is risky, once Isaac allows it. Answers its value; throws
   * `declined-by-isaac`, `paused-by-isaac`, or `awaiting-approval` when he has not answered
   * within ASK_WAIT_MS (the action still runs if he allows it later).
   */
  private async guarded<T>(tabId: string, risk: Risk | null, act: () => Promise<T>): Promise<T> {
    if (!risk) return act()
    const r = this.rt(tabId)
    const pending: Pending = { id: randomUUID().slice(0, 8), risk, run: act, settled: [] }
    r.pending = pending
    clearTimeout(r.idle)
    this.patch(tabId, { status: 'ask', ask: { id: pending.id, label: risk.label } })
    const outcome = await outcomeOf(pending, ASK_WAIT_MS)
    if (outcome === null) {
      return fail(
        'awaiting-approval',
        `Isaac has not answered "${risk.label}" yet. browser.wait until approval; it runs when he allows it`,
      )
    }
    if (outcome.paused) {
      return fail(
        'paused-by-isaac',
        'Isaac took over this page instead. browser.wait until handback',
      )
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

  private settlePending(tabId: string, o: Omit<Outcome, 'value' | 'error'>): Pending | null {
    const r = this.runs.get(tabId)
    const p = r?.pending ?? null
    if (!r || !p) return null
    r.pending = null
    r.last = { allowed: o.allowed, ...(o.paused ? { paused: true } : {}) }
    if (!o.allowed) for (const s of p.settled.splice(0)) s(o)
    return p
  }

  // Isaac ---------------------------------------------------------------------------------------

  private isaacInput(tabId: string): void {
    const a = this.host.agentOf(tabId)
    if (a?.status === 'working' || a?.status === 'ask') this.op(tabId, 'takeOver')
  }

  /** Isaac's controls on the tab: Take over, Hand back, Allow, Not now, dismiss. */
  op(tabId: string, op: AgentTabOp): void {
    const a = this.host.agentOf(tabId)
    if (!a) return
    const r = this.rt(tabId)
    switch (op) {
      case 'takeOver':
        if (a.status !== 'working' && a.status !== 'ask') return
        this.settlePending(tabId, { allowed: false, paused: true })
        clearTimeout(r.idle)
        this.patch(tabId, { status: 'paused', ask: null })
        void this.cursorOp(tabId, { op: 'hide' })
        return
      case 'handBack':
        if (a.status !== 'paused') return
        this.patch(tabId, { status: 'working' })
        this.touch(tabId)
        for (const w of r.handback.splice(0)) w()
        return
      case 'allow': {
        if (a.status !== 'ask') return
        const p = this.settlePending(tabId, { allowed: true })
        this.patch(tabId, { status: 'working', ask: null })
        this.touch(tabId)
        if (!p) return
        void p.run().then(
          (value) => {
            for (const s of p.settled.splice(0)) s({ allowed: true, value })
          },
          (error: unknown) => {
            for (const s of p.settled.splice(0)) s({ allowed: true, error })
          },
        )
        return
      }
      case 'deny': {
        if (a.status !== 'ask') return
        const label = a.ask?.label ?? 'that'
        this.settlePending(tabId, { allowed: false })
        clearTimeout(r.idle)
        this.patch(tabId, {
          status: 'stopped',
          ask: null,
          caption: `Stopped before: ${label}`,
          ended: this.now(),
        })
        void this.cursorOp(tabId, { op: 'hide' })
        return
      }
      case 'dismiss':
        if (a.status !== 'done' && a.status !== 'stopped') return
        this.patch(tabId, { status: 'idle', caption: '' })
        return
    }
  }

  // Agent actions -------------------------------------------------------------------------------

  tabs(): {
    tabs: Array<{
      tabId: string
      url: string
      title: string
      loading: boolean
      scope: string
      agent?: Pick<TabAgent, 'name' | 'status' | 'caption'>
    }>
  } {
    return {
      tabs: this.host.allTabs().map(({ state, scope }) => ({
        tabId: state.id,
        url: state.url,
        title: state.title,
        loading: state.loading,
        scope,
        ...(state.agent
          ? {
              agent: {
                name: state.agent.name,
                status: state.agent.status,
                caption: state.agent.caption,
              },
            }
          : {}),
      })),
    }
  }

  async read(
    tabId: string,
    mode: 'outline' | 'text' | 'html' = 'outline',
    selector: string | undefined,
    maxChars = 20_000,
  ): Promise<object> {
    this.agent(tabId)
    const { pc, wc } = await this.page(tabId)
    const at = this.where(wc)
    if (mode === 'text') return { ...at, ...(await pc.text(maxChars)) }
    if (mode === 'html') return { ...at, ...(await pc.html(selector, maxChars)) }
    const o = await pc.outline()
    let text = o.lines.join('\n')
    const cut = text.length > maxChars
    if (cut) text = text.slice(0, maxChars)
    return { ...at, outline: text, truncated: o.truncated || cut }
  }

  async screenshot(tabId: string): Promise<{ png: string; width: number; height: number }> {
    this.agent(tabId)
    return (await this.page(tabId)).pc.screenshot()
  }

  async navigate(
    tabId: string,
    to: { url?: string; go?: 'back' | 'forward' | 'reload' },
    caption: string | undefined,
    scope: string | undefined,
  ): Promise<object> {
    await this.begin(tabId, scope, caption)
    const { wc } = await this.page(tabId)
    if (to.url !== undefined) {
      const url = normalize(to.url) ?? fail('invalid-params', 'Give an address')
      this.autoCaption(tabId, `Opening ${new URL(url).host || url}`)
      this.host.navigate(tabId, url)
    } else if (to.go === 'back') this.host.back(tabId)
    else if (to.go === 'forward') this.host.forward(tabId)
    else this.host.reload(tabId)
    await this.settle(wc)
    return this.where(wc)
  }

  async click(
    tabId: string,
    target: Target,
    intent: Intent | undefined,
    caption: string | undefined,
    scope: string | undefined,
  ): Promise<object> {
    await this.begin(tabId, scope, caption)
    const { pc, wc } = await this.page(tabId)
    const { node, x, y } = await this.point(pc, target)
    const info = node === null ? null : await pc.info(node).catch(() => null)
    if (info?.label) this.autoCaption(tabId, `Clicking ${quote(info.label)}`)
    const risk = riskOf(info, intent, intent ? '' : await this.pageText(pc))
    await this.guarded(tabId, risk, async () => {
      // The page may have moved while Isaac decided: aim again at the element.
      const at = node !== null && risk ? await pc.center(node).catch(() => ({ x, y })) : { x, y }
      await this.clickAt(tabId, pc, at.x, at.y)
      await this.settle(wc)
    })
    this.touch(tabId)
    return { clicked: describe(info), ...this.where(wc) }
  }

  async type(
    tabId: string,
    field: Target,
    p: { text: string; clear?: boolean; submit?: boolean },
    intent: Intent | undefined,
    caption: string | undefined,
    scope: string | undefined,
  ): Promise<object> {
    await this.begin(tabId, scope, caption)
    const { pc, wc } = await this.page(tabId)
    const named = field.ref ?? field.selector ?? field.text ?? field.x
    let info: ElementInfo | null = null
    if (named !== undefined) {
      const { node, x, y } = await this.point(pc, field)
      info = node === null ? null : await pc.info(node).catch(() => null)
      await this.clickAt(tabId, pc, x, y)
    }
    info = (await pc.focused().catch(() => null)) ?? info
    this.autoCaption(tabId, info?.label ? `Typing in ${quote(info.label)}` : 'Typing')
    await this.host.acting(tabId, async () => {
      if (p.clear) {
        await pc.selectFocused()
        if (p.text === '') await pc.press('Backspace')
      }
      if (p.text !== '') await pc.insertText(p.text)
    })
    if (p.submit) {
      const risk = riskOf(info, intent, intent ? '' : await this.pageText(pc), true)
      await this.guarded(tabId, risk, async () => {
        await this.host.acting(tabId, () => pc.press('Enter'))
        await this.settle(wc)
      })
    }
    this.touch(tabId)
    return { typed: p.text.length, into: describe(info), ...this.where(wc) }
  }

  async press(
    tabId: string,
    key: string,
    intent: Intent | undefined,
    caption: string | undefined,
    scope: string | undefined,
  ): Promise<object> {
    await this.begin(tabId, scope, caption)
    const { pc, wc } = await this.page(tabId)
    const name = key.split('+').at(-1)!.toLowerCase()
    let risk: Risk | null = intent ? riskOf(null, intent) : null
    if (!risk && (name === 'enter' || name === 'space' || name === ' ')) {
      const f = await pc.focused().catch(() => null)
      const text = f ? await this.pageText(pc) : ''
      risk = f?.editable ? riskOf(f, undefined, text, name === 'enter') : riskOf(f, undefined, text)
    }
    await this.guarded(tabId, risk, async () => {
      await this.host.acting(tabId, () => pc.press(key))
      await this.settle(wc)
    })
    this.touch(tabId)
    return { pressed: key, ...this.where(wc) }
  }

  async scroll(
    tabId: string,
    p: { dy?: number; to?: 'top' | 'bottom'; ref?: string; selector?: string; text?: string },
    caption: string | undefined,
    scope: string | undefined,
  ): Promise<object> {
    await this.begin(tabId, scope, caption)
    const { pc, wc } = await this.page(tabId)
    this.autoCaption(tabId, 'Scrolling')
    await this.host.acting(tabId, async () => {
      if (p.dy !== undefined) await pc.scrollBy(p.dy)
      else if (p.to !== undefined) await pc.scrollTo(p.to)
      else {
        const node = await this.node(pc, p)
        if (node !== null) await pc.center(node)
      }
    })
    this.touch(tabId)
    const y = await pc.evaluate<number>('Math.round(window.scrollY)').catch(() => 0)
    return { scrollY: y, ...this.where(wc) }
  }

  async caption(tabId: string, text: string, scope: string | undefined): Promise<object> {
    await this.begin(tabId, scope, text)
    return { caption: text }
  }

  async done(
    tabId: string,
    summary: string,
    outcome: 'done' | 'stopped' = 'done',
    scope: string | undefined,
  ): Promise<object> {
    const cur = this.agent(tabId)
    const who = await this.identify(scope)
    if (cur && ACTIVE[cur.status] && (cur.id !== who.id || cur.name !== who.name)) {
      fail('busy', `${cur.name} is driving this page`)
    }
    this.settlePending(tabId, { allowed: false })
    const r = this.rt(tabId)
    clearTimeout(r.idle)
    r.idle = undefined
    this.host.setAgent(tabId, {
      id: who.id,
      name: who.name,
      color: who.color,
      status: outcome,
      caption: summary,
      background: cur?.background ?? false,
      ask: null,
      since: cur?.since ?? this.now(),
      ended: this.now(),
    })
    await this.cursorOp(tabId, { op: 'hide' })
    return { status: outcome }
  }

  /** browser.wait: answers `{met, status}` once the condition holds, else at the timeout. */
  async wait(
    tabId: string,
    until: 'load' | 'handback' | 'approval' | 'text' | 'selector',
    value: string | undefined,
    timeoutMs = 30_000,
  ): Promise<{ met: boolean; status: AgentTabStatus | null; allowed?: boolean }> {
    this.agent(tabId)
    const status = (): AgentTabStatus | null => this.host.agentOf(tabId)?.status ?? null
    const deadline = this.now() + timeoutMs
    const r = this.rt(tabId)
    if (until === 'handback') {
      if (status() !== 'paused') return { met: true, status: status() }
      const { promise, resolve } = Promise.withResolvers<boolean>()
      const back = (): void => resolve(true)
      r.handback.push(back)
      const timer = setTimeout(() => {
        r.handback = r.handback.filter((w) => w !== back)
        resolve(false)
      }, timeoutMs)
      const met = await promise
      clearTimeout(timer)
      return { met, status: status() }
    }
    if (until === 'approval') {
      const answered = (
        o: Outcome | null,
      ): { met: boolean; status: AgentTabStatus | null; allowed?: boolean } =>
        o === null
          ? { met: true, status: status() }
          : { met: true, status: status(), allowed: o.allowed && !o.paused }
      if (!r.pending) return answered(r.last)
      const o = await outcomeOf(r.pending, timeoutMs)
      return o === null ? { met: false, status: status() } : answered(o)
    }
    const { pc, wc } = await this.page(tabId)
    if (until === 'load') return { met: await loaded(wc, timeoutMs), status: status() }
    const probe =
      until === 'text'
        ? `document.body ? document.body.innerText.includes(${JSON.stringify(value)}) : false`
        : `!!document.querySelector(${JSON.stringify(value)})`
    for (;;) {
      if (await pc.evaluate<boolean>(probe).catch(() => false))
        return { met: true, status: status() }
      if (this.now() >= deadline) return { met: false, status: status() }
      await sleep(250)
    }
  }
}

function describe(info: ElementInfo | null): object | null {
  if (!info) return null
  return {
    tag: info.tag,
    label: info.label,
    ...(info.href ? { href: info.href } : {}),
  }
}
