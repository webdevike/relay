/**
 * The note picker Isaac uses on a page (browser.annotate): hover highlights an element, a click
 * picks it, a drag marks a region. PageControl.pick runs PICKER_SCRIPT in the agent cursor's
 * isolated world, so page scripts never see its code or state, only an inert host element
 * (`#relay-note-picker`) whose closed shadow root holds the drawing. The host takes pointer events
 * only while picking; once the mark is made `pick` answers it and the host keeps just the mark's
 * outline until `clear`. The note itself is written in the shell (NoteComposer), never here:
 * neither the closed shadow root nor the isolated world keeps keyboard events from the page's
 * own window and document listeners, so a field in the page would show the page every key.
 */

import type { NoteElement } from '@evaos/contract'

/**
 * `pick` opens the picker in `color` (clearing one already open, whose pick answers cancelled);
 * `clear` closes the picker or removes the mark, answering once the page painted without it.
 * Mode `design` (Design Mode, design-mode.ts) shows no hint, finds elements inside open shadow
 * roots, and once it answers draws no mark but keeps the page's pointer until the next `pick`
 * replaces it or `clear` closes it, so a click between two picks never reaches the page. It takes
 * the pointer events on the window in the capture phase, ahead of the page's document listeners
 * (outside-click handlers, hover tracking). A design pick never replaces a note's picker: it
 * answers cancelled, so a note opened while Design Mode works on its last pick wins.
 */
export type PickOp = { op: 'pick'; color: string; mode?: 'note' | 'design' } | { op: 'clear' }

/** A box in viewport CSS px. */
export interface PickBox {
  x: number
  y: number
  w: number
  h: number
}

export type PickResult =
  | { cancelled: true }
  | {
      cancelled: false
      /** The picked element; absent for a dragged region. */
      element?: NoteElement
      /** The element's box or the dragged region, unclamped. */
      box: PickBox
      /** The viewport's size in CSS px (innerWidth, innerHeight). */
      viewport: { width: number; height: number }
      /** Shift was down on the click or the drag's release (Design Mode adds to its selection). */
      shift: boolean
      /** Where the click or the drag's release was, in viewport CSS px. */
      at: { x: number; y: number }
    }

/**
 * What an element is, as the note describes it: its tag, role (explicit or implied), accessible
 * label, visible text and a CSS selector that finds it again. Self-contained: it runs in the page.
 */
export function describeElement(el: Element): NoteElement {
  const clip = (s: string, n: number): string => {
    const t = s.replace(/\s+/g, ' ').trim()
    return t.length > n ? `${t.slice(0, n - 1)}…` : t
  }
  const tag = el.tagName.toLowerCase()
  const attr = (k: string): string => (el.getAttribute(k) ?? '').trim()
  const implied = (): string => {
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : ''
    if (tag === 'input') {
      const type = (attr('type') || 'text').toLowerCase()
      if (type === 'checkbox' || type === 'radio') return type
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image')
        return 'button'
      if (type === 'range') return 'slider'
      if (type === 'search') return 'searchbox'
      return type === 'hidden' ? '' : 'textbox'
    }
    if (/^h[1-6]$/.test(tag)) return 'heading'
    const roles: Record<string, string> = {
      button: 'button',
      select: 'combobox',
      textarea: 'textbox',
      img: 'img',
      nav: 'navigation',
      main: 'main',
      header: 'banner',
      footer: 'contentinfo',
      aside: 'complementary',
      form: 'form',
      table: 'table',
      ul: 'list',
      ol: 'list',
      li: 'listitem',
      dialog: 'dialog',
      article: 'article',
      section: 'region',
    }
    return Object.hasOwn(roles, tag) ? roles[tag]! : ''
  }
  const role = attr('role') || implied()
  const labelled = attr('aria-labelledby')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
    .join(' ')
  const labels = 'labels' in el && el.labels instanceof NodeList ? el.labels : null
  const fieldLabel = labels && labels.length > 0 ? (labels[0]!.textContent ?? '') : ''
  const label = clip(
    attr('aria-label') ||
      labelled ||
      fieldLabel ||
      attr('alt') ||
      attr('placeholder') ||
      attr('title'),
    200,
  )
  const inner = 'innerText' in el ? el.innerText : undefined
  // A field's value stays out (it may be a password); its label says what it is.
  const field = tag === 'input' || tag === 'textarea' || tag === 'select'
  const text = field ? '' : clip(typeof inner === 'string' ? inner : (el.textContent ?? ''), 400)

  const doc = el.ownerDocument
  const unique = (sel: string): boolean => {
    try {
      return doc.querySelectorAll(sel).length === 1
    } catch {
      return false
    }
  }
  const quoted = (v: string): string => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const anchor = (node: Element): string | null => {
    const id = node.getAttribute('id')
    if (id) {
      const sel = /^[A-Za-z_][\w-]*$/.test(id) ? `#${id}` : `[id=${quoted(id)}]`
      if (unique(sel)) return sel
    }
    const testId = node.getAttribute('data-testid')
    if (testId) {
      const sel = `[data-testid=${quoted(testId)}]`
      if (unique(sel)) return sel
    }
    return null
  }
  const selectorOf = (): string | undefined => {
    const parts: string[] = []
    let node: Element | null = el
    while (node && node.nodeType === 1) {
      const own = anchor(node)
      if (own) {
        parts.unshift(own)
        break
      }
      const name = node.tagName.toLowerCase()
      const parent: Element | null = node.parentElement
      if (!parent || name === 'html' || name === 'body') {
        parts.unshift(name)
        break
      }
      const same = [...parent.children].filter((c) => c.tagName === node!.tagName)
      parts.unshift(same.length > 1 ? `${name}:nth-of-type(${same.indexOf(node) + 1})` : name)
      node = parent
    }
    const sel = parts.join(' > ')
    return sel.length <= 400 ? sel : undefined
  }
  const selector = selectorOf()
  return {
    tag: tag.slice(0, 40),
    ...(role ? { role: role.slice(0, 60) } : {}),
    ...(label ? { label } : {}),
    ...(text ? { text } : {}),
    ...(selector ? { selector } : {}),
  }
}

/** `function (op, describe) { ... }` run in the isolated world (see PageControl.pick). */
export const PICKER_SCRIPT = String(function (
  op: PickOp,
  describe: (el: Element) => NoteElement,
): PickResult | Promise<PickResult> {
  interface Picker {
    /** Closes the picker or removes the mark; resolves once the page painted without it. */
    close(): Promise<void>
    design: boolean
  }
  const w = globalThis as unknown as { __relayNotePicker?: Picker }
  if (op.op === 'clear') {
    const open = w.__relayNotePicker
    return open ? open.close().then(() => ({ cancelled: true })) : { cancelled: true }
  }
  const design = op.mode === 'design'
  // A note's picker keeps the page from Design Mode (see PickOp).
  if (design && w.__relayNotePicker && !w.__relayNotePicker.design) return { cancelled: true }
  // One picker per page: a new one clears the open one, whose pick answers cancelled.
  void w.__relayNotePicker?.close()

  const host = document.createElement('div')
  host.id = 'relay-note-picker'
  host.setAttribute('aria-hidden', 'true')
  host.style.setProperty('all', 'initial')
  host.style.setProperty('position', 'fixed')
  host.style.setProperty('inset', '0')
  host.style.setProperty('z-index', '2147483647')
  host.style.setProperty('pointer-events', 'auto')
  host.style.setProperty('cursor', 'crosshair')
  host.style.setProperty('--c', op.color)
  const root = host.attachShadow({ mode: 'closed' })
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(`
    .hint { font: 13px/1.4 -apple-system, system-ui, sans-serif; }
    .box { position: fixed; display: none; box-sizing: border-box; border: 2px solid var(--c);
      border-radius: 4px; background: color-mix(in srgb, var(--c) 10%, transparent); pointer-events: none; }
    .box.on { display: block; }
    .box.drag { border-style: dashed; }
    .tag { position: absolute; left: -2px; bottom: 100%; margin-bottom: 4px; padding: 1px 6px;
      border-radius: 4px; background: var(--c); color: #fff; font: 500 11px/16px -apple-system, system-ui, sans-serif;
      white-space: nowrap; }
    .tag:empty { display: none; }
    .hint { position: fixed; left: 50%; bottom: 12px; transform: translateX(-50%); padding: 6px 12px;
      box-sizing: border-box; max-width: calc(100% - 24px); width: max-content; text-align: center;
      border-radius: 8px; border: 1px solid rgba(0,0,0,.18); background: #fff; color: #1f2328;
      pointer-events: none; }
    @media (prefers-color-scheme: dark) {
      .hint { background: #1f2328; color: #e6edf3; border-color: rgba(255,255,255,.18); }
    }
  `)
  root.adoptedStyleSheets = [sheet]
  const box = document.createElement('div')
  box.className = 'box'
  const tag = document.createElement('div')
  tag.className = 'tag'
  box.append(tag)
  const hint = document.createElement('div')
  hint.className = 'hint'
  hint.textContent = 'Click something or drag over an area. Esc cancels.'
  // Design Mode says what to do in its inspector.
  root.append(box, ...(design ? [] : [hint]))
  document.documentElement.append(host)

  let resolve: (r: PickResult) => void = () => undefined
  const done = new Promise<PickResult>((r) => (resolve = r))
  let picked = false
  let hovered: Element | null = null
  let down: { x: number; y: number } | null = null
  let dragging = false
  /** The click that ends a pick still has to be kept from the page (see mark). */
  let eatClick = false

  const show = (b: PickBox, label: string, drag: boolean): void => {
    box.style.left = `${b.x}px`
    box.style.top = `${b.y}px`
    box.style.width = `${b.w}px`
    box.style.height = `${b.h}px`
    box.classList.add('on')
    box.classList.toggle('drag', drag)
    tag.textContent = label
  }
  const under = (x: number, y: number): Element | null => {
    // A shadow root's hit test sees the host too.
    const below = (els: Element[]): Element | null =>
      els.find((e) => e !== host && !host.contains(e)) ?? null
    let el = below(document.elementsFromPoint(x, y))
    // Design Mode edits what is inside a web component too (open shadow roots).
    for (let depth = 0; design && depth < 20 && el?.shadowRoot; depth++) {
      const inner = below(el.shadowRoot.elementsFromPoint(x, y))
      if (!inner || inner === el) break
      el = inner
    }
    return el
  }
  const boxOf = (el: Element): PickBox => {
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  }
  const dragBox = (a: { x: number; y: number }, b: { x: number; y: number }): PickBox => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  })
  const swallow = (e: Event): void => {
    e.preventDefault()
    e.stopPropagation()
  }

  const onMove = (e: Event): void => {
    if (!(e instanceof MouseEvent)) return
    // An answered design pick keeps the pointer from the page until the next pick.
    if (picked && !design) return
    swallow(e)
    if (picked) return
    if (down) {
      if (!dragging && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) dragging = true
      if (dragging) show(dragBox(down, { x: e.clientX, y: e.clientY }), '', true)
      return
    }
    const el = under(e.clientX, e.clientY)
    if (el === hovered) return
    hovered = el
    if (el) show(boxOf(el), el.tagName.toLowerCase(), false)
    else box.classList.remove('on')
  }
  const onDown = (e: Event): void => {
    if (!(e instanceof MouseEvent) || (picked && !design)) return
    if (picked || e.button !== 0) {
      if (design) swallow(e)
      return
    }
    swallow(e)
    down = { x: e.clientX, y: e.clientY }
    dragging = false
  }
  const onUp = (e: Event): void => {
    if (!(e instanceof MouseEvent) || (picked && !design)) return
    if (picked || !down) {
      if (design) swallow(e)
      return
    }
    swallow(e)
    const start = down
    down = null
    const end = { shift: e.shiftKey, at: { x: e.clientX, y: e.clientY } }
    if (dragging) {
      const b = dragBox(start, end.at)
      if (b.w >= 4 && b.h >= 4) return mark({ box: b, ...end })
      dragging = false
      return
    }
    const el = under(e.clientX, e.clientY)
    if (!el) return
    mark({ element: describe(el), box: boxOf(el), ...end })
  }

  /**
   * Keeps the mark's outline and answers it; the shell takes the note. From here the page gets
   * its pointer and keys back: the host stays only to draw the mark. A design pick draws no mark
   * (Design Mode outlines its selection itself) and keeps the pointer (see PickOp).
   */
  const mark = (m: {
    element?: NoteElement
    box: PickBox
    shift: boolean
    at: { x: number; y: number }
  }): void => {
    picked = true
    eatClick = true
    setTimeout(() => (eatClick = false), 0)
    if (design) {
      box.classList.remove('on')
    } else {
      show(m.box, m.element?.tag ?? '', !m.element)
      hint.remove()
      host.style.setProperty('pointer-events', 'none')
      host.style.removeProperty('cursor')
    }
    window.removeEventListener('keydown', onKey, true)
    resolve({
      cancelled: false,
      ...(m.element ? { element: m.element } : {}),
      box: m.box,
      viewport: { width: innerWidth, height: innerHeight },
      shift: m.shift,
      at: m.at,
    })
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    swallow(e)
    void close()
  }
  // Pointer events keep their default (it fires the mouse events picking uses); wheels scroll.
  const swallowPicking = (e: Event): void => {
    if (picked && !eatClick && !design) return
    e.stopPropagation()
    if (e.type === 'contextmenu') e.preventDefault()
  }
  // Design Mode takes the pointer on the window, ahead of the page's own listeners (see PickOp).
  const target: EventTarget = design ? window : host
  const quiet = ['click', 'dblclick', 'contextmenu', 'pointerdown', 'pointerup']
  if (design) {
    quiet.push('auxclick', 'pointermove', 'pointerover', 'pointerout', 'mouseover', 'mouseout')
  }
  const listeners: Array<[string, (e: Event) => void]> = [
    ['mousemove', onMove],
    ['mousedown', onDown],
    ['mouseup', onUp],
    ...quiet.map((type): [string, (e: Event) => void] => [type, swallowPicking]),
  ]
  for (const [type, fn] of listeners) target.addEventListener(type, fn, true)
  window.addEventListener('keydown', onKey, true)

  const close = (): Promise<void> => {
    if (w.__relayNotePicker !== picker) return Promise.resolve()
    delete w.__relayNotePicker
    window.removeEventListener('keydown', onKey, true)
    for (const [type, fn] of listeners) target.removeEventListener(type, fn, true)
    host.remove()
    // Still picking: the pick answers cancelled (after a mark this does nothing).
    resolve({ cancelled: true })
    // Two frames so a screenshot that follows shows the page without the mark.
    const painted = Promise.withResolvers<void>()
    let left = 2
    const tick = (): void => {
      if (--left <= 0) painted.resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    setTimeout(painted.resolve, 120)
    return painted.promise
  }
  const picker: Picker = { close, design }
  w.__relayNotePicker = picker
  return done
})
