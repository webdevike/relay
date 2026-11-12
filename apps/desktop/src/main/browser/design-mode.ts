import {
  DESIGN_STYLE_KEYS,
  type DesignItem,
  type DesignStyleKey,
  type EventChannel,
  type EventPayload,
} from '@evaos/contract'
import type { PageInput } from './browser-host'
import {
  DESIGN_COLOR,
  MAX_SELECTION,
  type DesignPage,
  type InspectAnswer,
  type InspectedElement,
  type OverlayAnswer,
  type OverlayCommand,
} from './design-page'

/** The page's webContents events Design Mode follows. */
export interface DesignContents {
  getURL(): string
  on(event: 'did-navigate', fn: (event: unknown, url: string) => void): unknown
  on(event: 'dom-ready', fn: () => void): unknown
  off(event: 'did-navigate', fn: (event: unknown, url: string) => void): unknown
  off(event: 'dom-ready', fn: () => void): unknown
}

/** What Design Mode needs of the browser host (BrowserHost). */
export interface DesignHost {
  page(tabId: string): DesignPage
  contents(tabId: string): DesignContents | undefined
  onTabClosed(cb: (tab: { id: string }) => void): void
  interceptInput(fn: (tabId: string, input: PageInput) => boolean): void
}

type DesignEvent = Extract<EventChannel, 'design.selection' | 'design.exit'>
export type DesignEmit = <K extends DesignEvent>(channel: K, payload: EventPayload<K>) => void

/** How often a selection is checked for changes the page made (a hot update, a reload). */
const POLL_MS = 700
/** A crop's long side, at most: more only costs the agent's context. */
const CROP_SIDE = 1200
/** Room around an element in its crop, so its edges read. */
const CROP_PAD = 6

interface Session {
  tabId: string
  origin: string
  selectors: string[]
  /** How the selection looked at its last read (OverlayAnswer.sig). */
  sig: string
  /** Page work in order: picks, reads and captures never interleave. */
  queue: Promise<void>
  busy: number
  /** The latest pointer position not drawn yet, or a pending leave. */
  hoverAt: { x: number; y: number } | 'leave' | null
  hovering: boolean
  stopped: boolean
  poll: ReturnType<typeof setInterval>
  wc: DesignContents
  onNavigate: (event: unknown, url: string) => void
  onReady: () => void
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s)

/** The last step of a selector path without positions, to name an element that is gone. */
function labelOf(selector: string): string {
  const step = selector.split(/\s*>+\s*/).at(-1) ?? selector
  return clip(step.replace(/:nth-[a-z-]+\([^)]*\)/g, ''), 200)
}

/**
 * Design Mode's page side, one session per page tab it is on in (the renderer's design-mode
 * machine turns it on and off): Isaac's mouse in the page moves the in-page highlight instead of
 * reaching the page, a click picks (Shift adds or removes), Escape asks the renderer to end the
 * mode. Each selection change is read in the page (DESIGN_INSPECT), cropped from the page's
 * pixels with the highlight hidden, and sent as a `design.selection` event. While the mode is on
 * it watches the selection: a hot update or a reload of the same site brings a `refresh`; a
 * different site or a closed tab ends the mode (`design.exit`).
 */
export class DesignMode {
  private sessions = new Map<string, Session>()
  /**
   * Whether Shift is down, from the last key event in a page or the shell (keyState): Electron's
   * before-mouse-event carries no modifiers, so a Shift-click reads it here.
   */
  private shift = false

  constructor(
    private readonly host: DesignHost,
    private readonly emit: DesignEmit,
    private readonly pollMs = POLL_MS,
  ) {
    host.interceptInput((tabId, input) => this.input(tabId, input))
    host.onTabClosed((tab) => {
      if (!this.sessions.has(tab.id)) return
      this.end(tab.id)
      this.emit('design.exit', { tabId: tab.id, reason: 'closed' })
    })
  }

  isOn(tabId: string): boolean {
    return this.sessions.has(tabId)
  }

  /** A key event in the shell (the page's own arrive through `input`). */
  keyState(input: { shift?: boolean }): void {
    this.shift = input.shift === true
  }

  async set(tabId: string, on: boolean): Promise<void> {
    if (!on) {
      const s = this.sessions.get(tabId)
      if (!s) return
      this.end(tabId)
      await this.overlay(s, { op: 'destroy' }).catch(() => undefined)
      return
    }
    const existing = this.sessions.get(tabId)
    if (existing) {
      await this.run(existing, async () => {
        const a = await this.overlay(existing, { op: 'select', selectors: [] })
        existing.selectors = a.selectors
        existing.sig = a.sig
      })
      return
    }
    const wc = this.host.contents(tabId)
    if (!wc) throw Object.assign(new Error('That page is not open'), { code: 'no-page' })
    const s: Session = {
      tabId,
      origin: originOf(wc.getURL()),
      selectors: [],
      sig: '',
      queue: Promise.resolve(),
      busy: 0,
      hoverAt: null,
      hovering: false,
      stopped: false,
      poll: setInterval(() => this.check(s), this.pollMs),
      wc,
      onNavigate: (_e, url) => {
        if (originOf(url) === s.origin) return
        this.end(tabId)
        this.emit('design.exit', { tabId, reason: 'navigated' })
      },
      // A reload of the same site: draw again and find the selection in the new document.
      onReady: () => this.later(s, () => this.revive(s)),
    }
    this.sessions.set(tabId, s)
    wc.on('did-navigate', s.onNavigate)
    wc.on('dom-ready', s.onReady)
    try {
      await this.overlay(s, { op: 'init', color: DESIGN_COLOR })
    } catch (e) {
      this.end(tabId)
      throw Object.assign(new Error('Design Mode could not reach this page'), {
        code: 'page-unreachable',
        cause: e,
      })
    }
  }

  /** Sets the selection to `selectors` (the inspector removed one) and sends it. */
  async select(tabId: string, selectors: string[]): Promise<void> {
    const s = this.session(tabId)
    await this.run(s, async () => {
      const a = await this.overlay(s, {
        op: 'select',
        selectors: selectors.slice(0, MAX_SELECTION),
      })
      await this.publish(s, a, 'pick')
    })
  }

  /** Previews `property: value` on one selected element and sends the selection as it looks now. */
  async style(
    tabId: string,
    selector: string,
    property: DesignStyleKey,
    value: string,
  ): Promise<void> {
    const s = this.session(tabId)
    await this.run(s, async () => {
      await this.page(s).preview(selector, property, value)
      const a = await this.overlay(s, { op: 'status' })
      await this.publish(s, a, 'refresh')
    })
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.end(id)
  }

  // Input ------------------------------------------------------------------------------------

  /** Isaac's input in tab `tabId`: true keeps it from the page (BrowserHost.interceptInput). */
  private input(tabId: string, input: PageInput): boolean {
    if (input.kind === 'key') this.keyState(input.input)
    const s = this.sessions.get(tabId)
    if (!s) return false
    if (input.kind === 'key') {
      if (input.input.type !== 'keyDown' || input.input.key !== 'Escape') return false
      this.emit('design.exit', { tabId, reason: 'escape' })
      return true
    }
    const m = input.mouse
    switch (m.type) {
      // The page still scrolls; the highlight follows its element.
      case 'mouseWheel':
        return false
      case 'mouseMove':
        s.hoverAt = { x: m.x, y: m.y }
        void this.pumpHover(s)
        return true
      case 'mouseLeave':
        s.hoverAt = 'leave'
        void this.pumpHover(s)
        return true
      case 'mouseDown':
        if (m.button === 'left') {
          const add = this.shift
          this.later(s, async () => {
            const a = await this.overlay(s, { op: 'pick', x: m.x, y: m.y, add, max: MAX_SELECTION })
            await this.publish(s, a, 'pick')
          })
        }
        return true
      default:
        return true
    }
  }

  /** Draws the newest pointer position only; moves that arrive meanwhile replace it. */
  private async pumpHover(s: Session): Promise<void> {
    if (s.hovering) return
    s.hovering = true
    try {
      while (s.hoverAt !== null && !s.stopped) {
        const at = s.hoverAt
        s.hoverAt = null
        const cmd: OverlayCommand = at === 'leave' ? { op: 'unhover' } : { op: 'hover', ...at }
        await this.overlay(s, cmd).catch(() => undefined)
      }
    } finally {
      s.hovering = false
    }
  }

  // Reading ----------------------------------------------------------------------------------

  /** A selection change the page made itself: read it again when its elements look different. */
  private check(s: Session): void {
    if (s.stopped || s.busy > 0 || s.selectors.length === 0) return
    this.later(s, async () => {
      const a = await this.overlay(s, { op: 'status' })
      // Not drawn: a new document dom-ready has not revived yet.
      if (!a.ready || a.sig === s.sig) return
      await this.publish(s, a, 'refresh')
    })
  }

  private async revive(s: Session): Promise<void> {
    await this.overlay(s, { op: 'init', color: DESIGN_COLOR })
    if (s.selectors.length === 0) return
    const a = await this.overlay(s, { op: 'select', selectors: s.selectors })
    await this.publish(s, a, 'refresh')
  }

  /** Reads the selection `a` names, crops each element and sends it to the renderer. */
  private async publish(s: Session, a: OverlayAnswer, reason: 'pick' | 'refresh'): Promise<void> {
    s.selectors = a.selectors
    s.sig = a.sig
    const page = this.page(s)
    const read = await page.inspect(a.selectors)
    const crops = await this.crops(s, read)
    if (s.stopped) return
    const items = a.selectors.map((selector, i) =>
      this.item(selector, read.items[i] ?? null, crops[i] ?? null),
    )
    this.emit('design.selection', { tabId: s.tabId, items, reason })
  }

  /** Each element's pixels as the page paints them: the highlight is hidden for the captures. */
  private async crops(s: Session, read: InspectAnswer): Promise<Array<DesignItem['crop']>> {
    const page = this.page(s)
    const rects = read.items.map((el) => {
      if (!el) return null
      const x = Math.max(0, Math.floor(el.box.x - CROP_PAD))
      const y = Math.max(0, Math.floor(el.box.y - CROP_PAD))
      const right = Math.min(read.width, Math.ceil(el.box.x + el.box.width + CROP_PAD))
      const bottom = Math.min(read.height, Math.ceil(el.box.y + el.box.height + CROP_PAD))
      return right - x >= 2 && bottom - y >= 2
        ? { x, y, width: right - x, height: bottom - y }
        : null
    })
    if (rects.every((r) => r === null)) return rects.map(() => null)
    await this.overlay(s, { op: 'visible', on: false })
    try {
      // Two frames so the hidden highlight is off the surface the capture copies.
      await page.settle()
      const out: Array<DesignItem['crop']> = []
      for (const r of rects) out.push(r ? await page.capture(r, CROP_SIDE).catch(() => null) : null)
      return out
    } finally {
      await this.overlay(s, { op: 'visible', on: true }).catch(() => undefined)
    }
  }

  /** One item as the contract has it; the page's strings are clipped, never trusted for size. */
  private item(
    selector: string,
    el: InspectedElement | null,
    crop: DesignItem['crop'],
  ): DesignItem {
    if (!el) {
      return {
        selector,
        label: labelOf(selector),
        missing: true,
        text: '',
        html: '',
        box: { x: 0, y: 0, width: 0, height: 0 },
        source: null,
        component: null,
        styles: {},
        crop: null,
      }
    }
    const styles: DesignItem['styles'] = {}
    for (const k of DESIGN_STYLE_KEYS) {
      const v = el.styles[k]
      if (typeof v === 'string') styles[k] = clip(v, 400)
    }
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    const line = (v: unknown): number | null =>
      typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null
    const src = el.source
    return {
      selector,
      label: clip(String(el.label), 200),
      missing: false,
      text: clip(String(el.text), 400),
      html: clip(String(el.html), 2000),
      box: {
        x: n(el.box.x),
        y: n(el.box.y),
        width: Math.max(0, n(el.box.width)),
        height: Math.max(0, n(el.box.height)),
      },
      source:
        src && typeof src.file === 'string' && src.file !== ''
          ? {
              file: clip(src.file, 1024),
              line: line(src.line),
              column: line(src.column),
              via: src.via,
            }
          : null,
      component: typeof el.component === 'string' && el.component ? clip(el.component, 200) : null,
      styles,
      crop,
    }
  }

  // Plumbing ---------------------------------------------------------------------------------

  private session(tabId: string): Session {
    const s = this.sessions.get(tabId)
    if (!s)
      throw Object.assign(new Error('Design Mode is off in that page'), { code: 'design-off' })
    return s
  }

  private page(s: Session): DesignPage {
    return this.host.page(s.tabId)
  }

  private overlay(s: Session, cmd: OverlayCommand): Promise<OverlayAnswer> {
    return this.page(s).overlay(cmd)
  }

  /** Runs `fn` after the session's earlier page work; a failure is logged, not thrown at input. */
  private run(s: Session, fn: () => Promise<void>): Promise<void> {
    s.busy++
    const next = s.queue.then(async () => {
      if (s.stopped) return
      await fn()
    })
    s.queue = next
      .catch((e: unknown) => {
        console.warn('[design]', e instanceof Error ? e.message : e)
      })
      .finally(() => {
        s.busy--
      })
    return next
  }

  /** `run` for work nobody awaits (input, the poll, a reload): its failure is only logged. */
  private later(s: Session, fn: () => Promise<void>): void {
    this.run(s, fn).catch(() => undefined)
  }

  private end(tabId: string): void {
    const s = this.sessions.get(tabId)
    if (!s) return
    s.stopped = true
    clearInterval(s.poll)
    s.wc.off('did-navigate', s.onNavigate)
    s.wc.off('dom-ready', s.onReady)
    this.sessions.delete(tabId)
  }
}
