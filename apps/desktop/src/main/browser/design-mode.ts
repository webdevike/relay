import {
  DESIGN_STYLE_KEYS,
  type DesignItem,
  type DesignStyleKey,
  type EventChannel,
  type EventPayload,
} from '@evaos/contract'
import { matchesAppChord } from '@evaos/browser-core/hotkeys'
import { FORWARD_FROM_GUEST, chordOfInput } from '@evaos/shell-core'
import type { PickResult } from './annotate-picker'
import { DESIGN_GATE_CHANNEL, DESIGN_INPUT_EVENT } from '../../preload/guest-channel'
import type { Input } from 'electron'
import {
  DESIGN_COLOR,
  MAX_SELECTION,
  type DesignPage,
  type Fingerprint,
  type InspectedElement,
  type OverlayAnswer,
  type OverlayCommand,
  type OverlayItem,
} from './design-page'

/** The page's webContents events Design Mode follows, and the channel to its guest preload. */
export interface DesignContents {
  getURL(): string
  send(channel: string, ...args: unknown[]): void
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
  interceptInput(fn: (tabId: string, input: Input) => boolean): void
}

type DesignEvent = Extract<EventChannel, 'design.selection' | 'design.exit'>
export type DesignEmit = <K extends DesignEvent>(channel: K, payload: EventPayload<K>) => void

/** How often a selection is checked for changes the page made (a hot update, a reload). */
const POLL_MS = 700
/** A crop's long side, at most: more only costs the agent's context. */
const CROP_SIDE = 1200
/** Room around an element in its crop, so its edges read. */
const CROP_PAD = 6
/** One pick waits this long for Isaac, then the picker starts again. */
const PICK_TIMEOUT_MS = 30 * 60_000
/** A pick that failed (the page reloading under it) is tried again after this. */
const PICK_RETRY_MS = 500

type Picked = Extract<PickResult, { cancelled: false }>
interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface Session {
  tabId: string
  origin: string
  selectors: string[]
  /**
   * How each selected element looked (design-page.ts FINGERPRINT), by selector: a reload drops
   * the overlay, so the next document finds the selection by these (RESTORE).
   */
  prints: Map<string, Fingerprint>
  /** Dragged regions in the selection, after its elements: read once, when dragged. */
  regions: DesignItem[]
  regionSeq: number
  /** How the selection looked at its last read (OverlayAnswer.sig). */
  sig: string
  /** Page work in order: picks, reads and captures never interleave. */
  queue: Promise<void>
  busy: number
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

/** `box` padded and kept inside the viewport, or null when nothing of it shows. */
function cropRect(
  box: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
  pad: number,
): Rect | null {
  const x = Math.max(0, Math.floor(box.x - pad))
  const y = Math.max(0, Math.floor(box.y - pad))
  const right = Math.min(viewport.width, Math.ceil(box.x + box.width + pad))
  const bottom = Math.min(viewport.height, Math.ceil(box.y + box.height + pad))
  return right - x >= 2 && bottom - y >= 2 ? { x, y, width: right - x, height: bottom - y } : null
}

/**
 * Design Mode's page side, one session per page tab it is on in (the renderer's design-mode
 * machine turns it on and off). While it is on, the note picker (annotate-picker.ts, mode
 * `design`) takes Isaac's pointer in the page: it highlights what he hovers, a click picks the
 * element there (Shift adds or removes it) and a drag picks a region (Shift adds it). Keys stay
 * out of the page; Escape asks the renderer to end the mode. Each selection change is read in the
 * page (DESIGN_INSPECT), cropped from the page's pixels with the outlines hidden, and sent as a
 * `design.selection` event. While the mode is on it watches the selection: a hot update or a
 * reload of the same site brings a `refresh`; a different site or a closed tab ends the mode
 * (`design.exit`).
 */
export class DesignMode {
  private sessions = new Map<string, Session>()
  /** Each tab's latest mode change: the next waits for it, so a start and a stop never overlap. */
  private changes = new Map<string, Promise<void>>()

  constructor(
    private readonly host: DesignHost,
    private readonly emit: DesignEmit,
    private readonly pollMs = POLL_MS,
    private readonly retryMs = PICK_RETRY_MS,
  ) {
    host.interceptInput((tabId, input) => this.input(tabId, input))
    // Every closed page, on or not: the renderer drops that page's design actor on `closed`.
    host.onTabClosed((tab) => {
      this.end(tab.id)
      this.emit('design.exit', { tabId: tab.id, reason: 'closed' })
    })
  }

  isOn(tabId: string): boolean {
    return this.sessions.has(tabId)
  }

  /** Turns the mode on or off in page `tabId`, after any change of it still in flight. */
  set(tabId: string, on: boolean): Promise<void> {
    return this.serial(tabId, () => this.change(tabId, on))
  }

  /** Runs `fn` after tab `tabId`'s mode change in flight, so a start and a stop never overlap. */
  private async serial(tabId: string, fn: () => Promise<void>): Promise<void> {
    const next = (this.changes.get(tabId) ?? Promise.resolve()).catch(() => undefined).then(fn)
    this.changes.set(tabId, next)
    try {
      await next
    } finally {
      if (this.changes.get(tabId) === next) this.changes.delete(tabId)
    }
  }

  private async change(tabId: string, on: boolean): Promise<void> {
    if (!on) {
      const s = this.sessions.get(tabId)
      if (!s) return
      this.end(tabId)
      // After the page work in flight (an init still drawing), so nothing draws after the destroy.
      await s.queue
      await this.overlay(s, { op: 'destroy' }).catch(() => undefined)
      // The picker goes too; its open pick answers cancelled to a loop that has stopped.
      await this.page(s)
        .pick({ op: 'clear' }, 5000)
        .catch(() => undefined)
      return
    }
    const existing = this.sessions.get(tabId)
    if (existing) {
      await this.run(existing, async () => {
        const a = await this.overlay(existing, { op: 'select', items: [] })
        this.remember(existing, a)
        existing.regions = []
      })
      return
    }
    const wc = this.host.contents(tabId)
    if (!wc) throw Object.assign(new Error('That page is not open'), { code: 'no-page' })
    const s: Session = {
      tabId,
      origin: originOf(wc.getURL()),
      selectors: [],
      prints: new Map(),
      regions: [],
      regionSeq: 0,
      sig: '',
      queue: Promise.resolve(),
      busy: 0,
      stopped: false,
      poll: setInterval(() => this.check(s), this.pollMs),
      wc,
      onNavigate: (_e, url) => {
        if (originOf(url) === s.origin) return
        this.end(tabId)
        this.emit('design.exit', { tabId, reason: 'navigated' })
      },
      // A reload of the same site: gate and draw again, and find the selection in the new
      // document (its preload starts with the gate off).
      onReady: () => {
        this.gate(s, true)
        this.later(s, () => this.revive(s))
      },
    }
    this.sessions.set(tabId, s)
    wc.on('did-navigate', s.onNavigate)
    wc.on('dom-ready', s.onReady)
    this.gate(s, true)
    try {
      // Through the session's queue: skipped when the page closed or left the site first.
      await this.run(s, async () => {
        await this.overlay(s, { op: 'init', color: DESIGN_COLOR })
      })
    } catch (e) {
      // Only this session (the page may have ended it already).
      if (this.sessions.get(tabId) === s) this.end(tabId)
      throw Object.assign(new Error('Design Mode could not reach this page'), {
        code: 'page-unreachable',
        cause: e,
      })
    }
    void this.picking(s)
  }

  /** Sets the selection to `selectors` (the inspector removed one) and sends it. */
  async select(tabId: string, selectors: string[]): Promise<void> {
    const s = this.session(tabId)
    await this.run(s, async () => {
      const keep = selectors.slice(0, MAX_SELECTION)
      s.regions = s.regions.filter((r) => keep.includes(r.selector))
      const regions = new Set(s.regions.map((r) => r.selector))
      const items: OverlayItem[] = keep
        .filter((k) => !regions.has(k))
        .map((selector) => ({ selector, print: s.prints.get(selector) ?? null }))
      const a = await this.overlay(s, { op: 'select', items })
      await this.publish(s, a, 'pick')
    })
  }

  /**
   * Previews `property: value` on one selected element and sends the selection as it looks now.
   * Throws `style-rejected` (not valid CSS for it) or `element-missing` (not in the page now).
   */
  async style(
    tabId: string,
    selector: string,
    property: DesignStyleKey,
    value: string,
  ): Promise<void> {
    const s = this.session(tabId)
    await this.run(s, async () => {
      const r = await this.page(s).preview(selector, property, value)
      if (r === 'rejected')
        throw Object.assign(new Error(`"${clip(value, 60)}" is not a ${property} value`), {
          code: 'style-rejected',
        })
      if (r === 'missing')
        throw Object.assign(new Error('That element is not in the page right now'), {
          code: 'element-missing',
        })
      const a = await this.overlay(s, { op: 'status' })
      await this.publish(s, a, 'refresh')
    })
  }

  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.end(id)
  }

  // Input ------------------------------------------------------------------------------------

  /**
   * Isaac's key in tab `tabId`: true keeps it from the page (BrowserHost.interceptInput). Keys stay
   * out while the mode is on; his pointer goes on to the page, where the picker takes it.
   */
  private input(tabId: string, k: Input): boolean {
    if (!this.sessions.has(tabId)) return false
    if (k.type === 'keyDown' && k.key === 'Escape') {
      this.emit('design.exit', { tabId, reason: 'escape' })
      return true
    }
    // No typing, pasting or page shortcuts; Relay's own shortcuts and DevTools go on to
    // BrowserHost, which never hands them to the page.
    if (matchesAppChord(k) === 'devtools') return false
    const chord = chordOfInput(k)
    return !(chord && FORWARD_FROM_GUEST.has(chord))
  }

  /** Isaac's clicks and drags in the page, one pick after another while the mode is on. */
  private async picking(s: Session): Promise<void> {
    while (!s.stopped) {
      let r: PickResult
      try {
        r = await this.page(s).pick(
          { op: 'pick', color: DESIGN_COLOR, mode: 'design', input: DESIGN_INPUT_EVENT },
          PICK_TIMEOUT_MS,
        )
      } catch {
        // The page reloading under it, or a pick that waited too long: pick again.
        const wait = Promise.withResolvers<void>()
        setTimeout(wait.resolve, this.retryMs)
        await wait.promise
        continue
      }
      if (s.stopped) return
      if (r.cancelled) {
        // Another picker took the page (a note): the mode ends and its outlines go, after the
        // page work in flight; that picker stays.
        let ended = false
        await this.serial(s.tabId, async () => {
          if (this.sessions.get(s.tabId) !== s) return
          this.end(s.tabId)
          ended = true
          await s.queue
          await this.overlay(s, { op: 'destroy' }).catch(() => undefined)
        }).catch(() => undefined)
        if (ended) this.emit('design.exit', { tabId: s.tabId, reason: 'escape' })
        return
      }
      const picked = r
      await this.run(s, () => this.picked(s, picked)).catch(() => undefined)
    }
  }

  /** A click picks the element there, a drag the region; Shift adds to the selection. */
  private async picked(s: Session, r: Picked): Promise<void> {
    if (!r.shift) s.regions = []
    if (r.element) {
      const a = await this.overlay(s, {
        op: 'pick',
        x: r.at.x,
        y: r.at.y,
        add: r.shift,
        max: MAX_SELECTION - s.regions.length,
      })
      await this.publish(s, a, 'pick')
      return
    }
    const a = await this.overlay(s, r.shift ? { op: 'status' } : { op: 'select', items: [] })
    if (a.selectors.length + s.regions.length < MAX_SELECTION) {
      const box = { x: r.box.x, y: r.box.y, width: r.box.w, height: r.box.h }
      const rect = cropRect(box, r.viewport, 0)
      const [crop = null] = rect ? await this.captures(s, [rect]) : []
      const w = Math.round(box.width)
      const h = Math.round(box.height)
      s.regions.push({
        kind: 'region',
        selector: `region-${++s.regionSeq}`,
        label: `Region ${w}x${h}`,
        missing: false,
        text: '',
        html: '',
        box,
        source: null,
        component: null,
        styles: {},
        crop,
      })
    }
    await this.publish(s, a, 'pick')
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
    const items: OverlayItem[] = s.selectors.map((selector) => ({
      selector,
      print: s.prints.get(selector) ?? null,
    }))
    const a = await this.overlay(s, { op: 'select', items })
    await this.publish(s, a, 'refresh')
  }

  /** The selection as the overlay answered it: its paths, their prints and how it looks. */
  private remember(s: Session, a: OverlayAnswer): void {
    s.selectors = a.selectors
    s.prints = new Map()
    a.selectors.forEach((selector, i) => {
      const print = a.prints[i]
      if (print) s.prints.set(selector, print)
    })
    s.sig = a.sig
  }

  /**
   * Reads the elements `a` names, crops each and sends them, then the regions, to the renderer.
   * An answer from a document without the overlay (a reload under it) changes nothing: the
   * selection and its prints wait for the new document's `select`.
   */
  private async publish(s: Session, a: OverlayAnswer, reason: 'pick' | 'refresh'): Promise<void> {
    if (!a.ready) return
    this.remember(s, a)
    // Only what the overlay found: a path whose element it did not recognize reads as missing.
    const read = await this.page(s).inspect(a.selectors.map((sel, i) => (a.found[i] ? sel : null)))
    const rects = read.items.map((el) => (el ? cropRect(el.box, read, CROP_PAD) : null))
    const crops = rects.some((r) => r !== null) ? await this.captures(s, rects) : []
    if (s.stopped) return
    const items = a.selectors.map((selector, i) =>
      this.item(selector, read.items[i] ?? null, crops[i] ?? null),
    )
    this.emit('design.selection', {
      tabId: s.tabId,
      items: [...items, ...s.regions],
      reason,
    })
  }

  /** The page's pixels in each rect as it paints them: the outlines are hidden for the captures. */
  private async captures(
    s: Session,
    rects: Array<Rect | null>,
  ): Promise<Array<DesignItem['crop']>> {
    const page = this.page(s)
    await this.overlay(s, { op: 'visible', on: false })
    try {
      // Two frames so the hidden outlines are off the surface the capture copies.
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
        kind: 'element',
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
      kind: 'element',
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

  /** `run` for work nobody awaits (the poll, a reload): its failure is only logged. */
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
    this.gate(s, false)
    this.sessions.delete(tabId)
  }

  /**
   * The guest preload's pointer gate (preload/guest.ts) in the page's document: while on, no
   * listener of the page's sees Isaac's pointer and the picker gets it from the gate.
   */
  private gate(s: Session, on: boolean): void {
    try {
      s.wc.send(DESIGN_GATE_CHANNEL, on)
    } catch {
      // The page closed.
    }
  }
}
