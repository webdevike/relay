import type { WebContents } from 'electron'
import { CURSOR_SCRIPT, type CursorOp } from './agent-cursor'
import { ELEMENT_INFO, FIND_BY_TEXT, type ElementInfo } from './agent-guard'
import { PICKER_SCRIPT, describeElement, type PickOp, type PickResult } from './annotate-picker'

/**
 * CDP control of one page through `webContents.debugger`, main-process only: what the agent
 * drive (agent-drive.ts) reads and does in a page. It attaches lazily and treats a `detach`
 * (DevTools closing, crash) as normal: the next call re-attaches. DevTools and this client
 * coexist on Electron 44 (multi-client CDP).
 *
 * Input is real (Input.dispatch*): pages see trusted events, exactly as from Isaac's mouse and
 * keyboard. Elements are named by CDP backend node ids (`n123` refs in browser.read), stable for
 * as long as the node lives, so nothing is written into the page's DOM to find them again.
 *
 * Navigation is not done here: `load` is the host's `navigate()`, the one place that applies the
 * guest protocol allow-list and keeps the tab state in step, so an agent handing this class a
 * `file:` or `chrome:` URL gets the same blocked card as the address bar.
 */
export class PageControl {
  private enabled = false
  /** The isolated world the cursor lives in, per document (a navigation drops it). */
  private world: number | null = null
  /** The viewport a page off screen lays out at (see viewport), null when it follows its view. */
  private emulated: { width: number; height: number } | null = null

  constructor(
    private readonly wc: WebContents,
    private readonly load: (url: string) => void,
  ) {
    wc.debugger.on('detach', () => {
      this.enabled = false
      this.world = null
      this.emulated = null
    })
  }

  /**
   * A page off screen has no real viewport (its hidden view is 0 by 0 to the page), so nothing
   * lays out where clicks land: give it `size` while the agent drives it there; null hands the
   * viewport back to the view once it is on screen.
   */
  async viewport(size: { width: number; height: number } | null): Promise<void> {
    if (size === null) {
      if (this.emulated === null || !this.wc.debugger.isAttached()) return
      this.emulated = null
      await this.send('Emulation.clearDeviceMetricsOverride')
      return
    }
    if (this.emulated?.width === size.width && this.emulated.height === size.height) return
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: size.width,
      height: size.height,
      deviceScaleFactor: 0,
      mobile: false,
    })
    this.emulated = { ...size }
  }

  ensureAttached(): void {
    if (!this.wc.debugger.isAttached()) this.wc.debugger.attach('1.3')
  }

  /** One CDP command; a page that never answers (a hung renderer) fails after `timeoutMs`. */
  async send<T = unknown>(method: string, params: object = {}, timeoutMs = 15_000): Promise<T> {
    this.ensureAttached()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            Object.assign(new Error(`The page did not answer ${method}`), { code: 'timeout' }),
          ),
        timeoutMs,
      )
    })
    try {
      return (await Promise.race([this.wc.debugger.sendCommand(method, params), timeout])) as T
    } finally {
      clearTimeout(timer)
    }
  }

  private async ready(): Promise<void> {
    this.ensureAttached()
    if (this.enabled) return
    await this.send('DOM.enable')
    await this.send('Accessibility.enable')
    this.enabled = true
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const res = await this.send<{
      result?: { value?: T }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ??
          res.exceptionDetails.text ??
          'evaluate failed',
      )
    }
    return res.result?.value as T
  }

  readText(): Promise<string> {
    return this.evaluate<string>('document.body.innerText')
  }

  async click(selector: string): Promise<boolean> {
    return this.evaluate<boolean>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`,
    )
  }

  navigate(url: string): void {
    this.load(url)
  }

  // Finding elements -------------------------------------------------------------------------

  /** The backend node id of what `expression` evaluates to (an element), or null. */
  private async nodeOf(expression: string): Promise<number | null> {
    await this.ready()
    const res = await this.send<{
      result?: { objectId?: string; subtype?: string }
      exceptionDetails?: { text?: string }
    }>('Runtime.evaluate', { expression, returnByValue: false })
    if (res.exceptionDetails) {
      throw Object.assign(new Error(res.exceptionDetails.text ?? 'bad selector'), {
        code: 'invalid-params',
      })
    }
    const id = res.result?.objectId
    if (!id || res.result?.subtype === 'null') return null
    const d = await this.send<{ node: { backendNodeId: number } }>('DOM.describeNode', {
      objectId: id,
    })
    void this.send('Runtime.releaseObject', { objectId: id }).catch(() => undefined)
    return d.node.backendNodeId
  }

  bySelector(selector: string): Promise<number | null> {
    return this.nodeOf(`document.querySelector(${JSON.stringify(selector)})`)
  }

  byText(text: string): Promise<number | null> {
    return this.nodeOf(`(${FIND_BY_TEXT})(${JSON.stringify(text)})`)
  }

  async atPoint(x: number, y: number): Promise<number | null> {
    await this.ready()
    try {
      const r = await this.send<{ backendNodeId: number }>('DOM.getNodeForLocation', {
        x: Math.round(x),
        y: Math.round(y),
        ignorePointerEventsNone: true,
      })
      return r.backendNodeId
    } catch {
      return null
    }
  }

  /** Scrolls the node into view and answers its center in viewport CSS px. */
  async center(node: number): Promise<{ x: number; y: number }> {
    await this.ready()
    await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node }).catch(() => undefined)
    const r = await this.send<{ quads: number[][] }>('DOM.getContentQuads', {
      backendNodeId: node,
    }).catch(() => ({ quads: [] as number[][] }))
    const q = r.quads.find((x) => x.length === 8)
    if (!q) {
      throw Object.assign(new Error('That element is not visible on the page'), {
        code: 'not-visible',
      })
    }
    return { x: (q[0]! + q[2]! + q[4]! + q[6]!) / 4, y: (q[1]! + q[3]! + q[5]! + q[7]!) / 4 }
  }

  /** What an element is (label, form, link), for the guardrail and the agent's answer. */
  async info(node: number): Promise<ElementInfo> {
    await this.ready()
    const r = await this.send<{ object: { objectId: string } }>('DOM.resolveNode', {
      backendNodeId: node,
    })
    try {
      const v = await this.send<{ result: { value: ElementInfo } }>('Runtime.callFunctionOn', {
        objectId: r.object.objectId,
        functionDeclaration: ELEMENT_INFO,
        returnByValue: true,
      })
      return v.result.value
    } finally {
      void this.send('Runtime.releaseObject', { objectId: r.object.objectId }).catch(
        () => undefined,
      )
    }
  }

  /** The focused element's info (where typed keys go), null for the page itself. */
  async focused(): Promise<ElementInfo | null> {
    const node = await this.nodeOf(
      '(document.activeElement && document.activeElement !== document.body ? document.activeElement : null)',
    )
    return node === null ? null : this.info(node)
  }

  async focus(node: number): Promise<void> {
    await this.ready()
    await this.send('DOM.focus', { backendNodeId: node })
  }

  // Reading ----------------------------------------------------------------------------------

  /** Headings and interactive elements as one line each, refs first. */
  async outline(max = 600): Promise<{ lines: string[]; truncated: boolean }> {
    await this.ready()
    const { nodes } = await this.send<{ nodes: AxNode[] }>(
      'Accessibility.getFullAXTree',
      {},
      20_000,
    )
    const lines: string[] = []
    let truncated = false
    for (const n of nodes) {
      const line = outlineLine(n)
      if (line === null) continue
      if (lines.length >= max) {
        truncated = true
        break
      }
      lines.push(line)
    }
    return { lines, truncated }
  }

  async text(maxChars: number): Promise<{ text: string; truncated: boolean }> {
    const t = await this.evaluate<string>('document.body ? document.body.innerText : ""')
    return { text: t.slice(0, maxChars), truncated: t.length > maxChars }
  }

  async html(
    selector: string | undefined,
    maxChars: number,
  ): Promise<{ html: string; truncated: boolean }> {
    const expr =
      selector === undefined
        ? 'document.documentElement.outerHTML'
        : `(document.querySelector(${JSON.stringify(selector)}) || {outerHTML: ''}).outerHTML`
    const h = await this.evaluate<string>(expr)
    return { html: h.slice(0, maxChars), truncated: h.length > maxChars }
  }

  /**
   * PNG of the page as it renders. capturePage paints a page that is off screen too (stayHidden
   * keeps it hidden after); a page that gives no frame falls back to CDP's surface capture.
   */
  async screenshot(): Promise<{ png: string; width: number; height: number }> {
    const img = await this.wc.capturePage(undefined, { stayHidden: true })
    if (!img.isEmpty()) {
      const { width, height } = img.getSize()
      return { png: img.toPNG().toString('base64'), width, height }
    }
    const m = await this.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>(
      'Page.getLayoutMetrics',
    )
    const r = await this.send<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'png', fromSurface: true },
      20_000,
    )
    return {
      png: r.data,
      width: Math.round(m.cssVisualViewport.clientWidth),
      height: Math.round(m.cssVisualViewport.clientHeight),
    }
  }

  // Input ------------------------------------------------------------------------------------

  async mouseClick(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    const at = { x, y, button: 'left', clickCount: 1 }
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', buttons: 1, ...at })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...at })
  }

  async wheel(x: number, y: number, dy: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy })
  }

  async insertText(text: string): Promise<void> {
    await this.send('Input.insertText', { text })
  }

  async press(spec: string): Promise<void> {
    const k = parseKey(spec)
    const base = {
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.keyCode,
      nativeVirtualKeyCode: k.keyCode,
      modifiers: k.modifiers,
    }
    // A key that types (no Ctrl/Meta) sends its text with keyDown, so Enter submits forms.
    const types = k.text !== '' && (k.modifiers & (MOD.Ctrl | MOD.Meta)) === 0
    await this.send('Input.dispatchKeyEvent', {
      type: types ? 'keyDown' : 'rawKeyDown',
      ...base,
      ...(types ? { text: k.text, unmodifiedText: k.text } : {}),
    })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  /** Selects the content of the focused field, so typing replaces it. */
  async selectFocused(): Promise<void> {
    await this.evaluate(
      `(() => { const el = document.activeElement; if (!el) return; if (typeof el.select === 'function') el.select(); else if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r) } })()`,
    )
  }

  async scrollBy(dy: number): Promise<void> {
    await this.evaluate(`window.scrollBy({ top: ${JSON.stringify(dy)}, behavior: 'instant' })`)
  }

  async scrollTo(to: 'top' | 'bottom'): Promise<void> {
    await this.evaluate(
      to === 'top'
        ? `window.scrollTo({ top: 0, behavior: 'instant' })`
        : `window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })`,
    )
  }

  // The agent's cursor ------------------------------------------------------------------------

  /**
   * Shows, moves, clicks or hides the agent's cursor, drawn inside the page (a native page
   * paints over anything the shell draws). It lives in an isolated world: page scripts can't
   * reach its code, and the page's Trusted Types and inline-script rules don't apply to it.
   */
  async cursor(op: CursorOp): Promise<number> {
    const expression = `(${CURSOR_SCRIPT})(${JSON.stringify(op)})`
    for (let attempt = 0; attempt < 2; attempt++) {
      const contextId = await this.isolatedWorld()
      try {
        const r = await this.send<{ result?: { value?: unknown } }>(
          'Runtime.evaluate',
          { expression, contextId, returnByValue: true },
          5000,
        )
        return typeof r?.result?.value === 'number' ? r.result.value : 0
      } catch {
        // The document changed under the cached world: make a new one once.
        this.world = null
      }
    }
    return 0
  }

  /**
   * Runs Isaac's note picker (annotate-picker.ts) in the cursor's isolated world, so page scripts
   * never see it. `pick` resolves once he sends or cancels, or fails when the page goes away
   * under it (navigation, crash) or after `timeoutMs`.
   */
  async pick(op: PickOp, timeoutMs: number): Promise<PickResult> {
    const expression = `(${PICKER_SCRIPT})(${JSON.stringify(op)}, ${String(describeElement)})`
    for (let attempt = 0; ; attempt++) {
      const contextId = await this.isolatedWorld()
      try {
        const r = await this.send<{
          result?: { value?: PickResult }
          exceptionDetails?: { text?: string; exception?: { description?: string } }
        }>(
          'Runtime.evaluate',
          { expression, contextId, returnByValue: true, awaitPromise: true },
          timeoutMs,
        )
        if (r.exceptionDetails) {
          throw new Error(
            r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'pick failed',
          )
        }
        return r.result?.value ?? { cancelled: true }
      } catch (e) {
        // A world cached for an earlier document: make a new one once.
        if (attempt > 0 || !/Cannot find context/i.test(e instanceof Error ? e.message : '')) {
          throw e
        }
        this.world = null
      }
    }
  }

  private async isolatedWorld(): Promise<number> {
    if (this.world !== null) return this.world
    const tree = await this.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree')
    const w = await this.send<{ executionContextId: number }>('Page.createIsolatedWorld', {
      frameId: tree.frameTree.frame.id,
      worldName: 'relay-agent-cursor',
      grantUniveralAccess: false,
    })
    this.world = w.executionContextId
    return this.world
  }
}

interface AxValue {
  value?: unknown
}
interface AxNode {
  ignored?: boolean
  role?: AxValue
  name?: AxValue
  value?: AxValue
  backendDOMNodeId?: number
  properties?: Array<{ name: string; value: AxValue }>
}

/** Roles an agent acts on: they get a ref line in the outline. */
const ACTIONABLE: Record<string, true> = {
  button: true,
  link: true,
  textbox: true,
  searchbox: true,
  combobox: true,
  listbox: true,
  option: true,
  checkbox: true,
  radio: true,
  switch: true,
  slider: true,
  spinbutton: true,
  tab: true,
  menuitem: true,
  menuitemcheckbox: true,
  menuitemradio: true,
  treeitem: true,
  textarea: true,
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** One outline line for an AX node: `## Heading` or `[n12] button "Buy" (disabled)`; else null. */
export function outlineLine(n: AxNode): string | null {
  if (n.ignored || n.backendDOMNodeId === undefined) return null
  const role = String(n.role?.value ?? '')
  const name = clip(
    String(n.name?.value ?? '')
      .replace(/\s+/g, ' ')
      .trim(),
    120,
  )
  const prop = (k: string): unknown => n.properties?.find((p) => p.name === k)?.value.value
  if (role === 'heading') {
    if (name === '') return null
    const level = Number(prop('level') ?? 2)
    return `${'#'.repeat(Math.min(Math.max(level, 1), 6))} ${name}`
  }
  if (!Object.hasOwn(ACTIONABLE, role)) return null
  const bits = [`[n${n.backendDOMNodeId}] ${role} ${JSON.stringify(name)}`]
  const value = n.value?.value
  if (value !== undefined && value !== '' && value !== name) {
    bits.push(`value=${JSON.stringify(clip(String(value), 120))}`)
  }
  const checked = prop('checked')
  if (checked === true || checked === 'true') bits.push('(checked)')
  if (prop('disabled') === true) bits.push('(disabled)')
  if (prop('focused') === true) bits.push('(focused)')
  return bits.join(' ')
}

/** CDP key modifier bits. */
export const MOD = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 } as const

const NAMED: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
}

const MOD_NAMES: Record<string, number> = {
  alt: MOD.Alt,
  option: MOD.Alt,
  ctrl: MOD.Ctrl,
  control: MOD.Ctrl,
  meta: MOD.Meta,
  cmd: MOD.Meta,
  command: MOD.Meta,
  shift: MOD.Shift,
}

export interface KeySpec {
  key: string
  code: string
  keyCode: number
  text: string
  modifiers: number
}

/**
 * `Enter`, `a`, `Meta+a`, `Shift+Tab` as one CDP key: its key and code, the Windows key code
 * Chromium wants, the text it types and the modifier bits. Unknown names fail `invalid-params`.
 */
export function parseKey(spec: string): KeySpec {
  const parts = spec.split('+')
  // A bare "+" (or "Shift++") is the plus key itself.
  const last = spec.endsWith('++') || spec === '+' ? '+' : parts.at(-1)!
  const mods = spec === '+' ? [] : parts.slice(0, spec.endsWith('++') ? -2 : -1)
  let modifiers = 0
  for (const m of mods) {
    const bit = MOD_NAMES[m.toLowerCase()]
    if (bit === undefined) {
      throw Object.assign(new Error(`Unknown modifier "${m}" in "${spec}"`), {
        code: 'invalid-params',
      })
    }
    modifiers |= bit
  }
  const named = NAMED[last] ?? NAMED[last.charAt(0).toUpperCase() + last.slice(1).toLowerCase()]
  if (named) {
    const key = named.code === 'Space' ? ' ' : named.code
    return { key, code: named.code, keyCode: named.keyCode, text: named.text ?? '', modifiers }
  }
  if ([...last].length !== 1) {
    throw Object.assign(new Error(`Unknown key "${last}"`), { code: 'invalid-params' })
  }
  const upper = last.toUpperCase()
  const letter = /^[A-Z]$/.test(upper)
  const digit = /^[0-9]$/.test(last)
  const key = modifiers & MOD.Shift && letter ? upper : last
  return {
    key,
    code: letter ? `Key${upper}` : digit ? `Digit${last}` : '',
    keyCode: letter || digit ? upper.charCodeAt(0) : 0,
    text: key,
    modifiers,
  }
}
