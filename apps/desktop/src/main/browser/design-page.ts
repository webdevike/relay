import type { PageControl } from './page-control'

/**
 * The page side of Design Mode (design-mode.ts runs these through PageControl):
 *
 * - DESIGN_OVERLAY runs in an isolated world, like the agent cursor: it draws the hover highlight
 *   and the numbered selection outlines inside the page (a native page paints over anything the
 *   shell draws) and keeps each selected element found by its selector, so a hot update that
 *   replaces the node or a reload that rebuilds the page finds it again.
 * - DESIGN_INSPECT runs in the page's own world, read-only: React keeps its fibers (component,
 *   `_debugSource`, `_debugStack`) as properties of the page's DOM objects, which an isolated
 *   world can't see.
 *
 * Each is a standalone function serialized into the page: no module values, no imports. Shared
 * helpers are passed in as arguments (a minified build renames module functions, so a reference
 * by name would break only in the packaged app).
 *
 * SELECTOR_PATH and RESOLVE follow TasteCode's browser annotations (browser-annotations.ts,
 * github.com/Leonxlnx/tastecode, Apache-2.0; see THIRD_PARTY_NOTICES.md): id when unique, else tag,
 * two classes an agent can search the source for and `:nth-of-type`, through shadow roots as
 * `host >>> inner`.
 */

/** The outline color: quiet, readable on light and dark pages. */
export const DESIGN_COLOR = '#4c6ef5'

/** At most this many elements in one selection (and one request). */
export const MAX_SELECTION = 8

export const SELECTOR_PATH = String(function selectorPath(
  element: Element,
  depth?: number,
  bare?: boolean,
): string {
  const level = depth ?? 0
  if (level > 20) return '[unavailable-shadow-path]'
  const parts: string[] = []
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.localName === 'html' && parts.length > 0) break
    const root = current.getRootNode() as Document | ShadowRoot
    if (
      current.id &&
      current.id.length <= 512 &&
      root.querySelectorAll('#' + CSS.escape(current.id)).length === 1
    ) {
      parts.unshift('#' + CSS.escape(current.id))
      break
    }
    if (parts.length >= 64) break
    const name = current.localName
    const classes = bare
      ? ''
      : Array.from(current.classList)
          .filter((value) => /^[A-Za-z_-][\w-]{0,39}$/.test(value))
          .slice(0, 2)
          .map((value) => '.' + CSS.escape(value))
          .join('')
    const parent = current.parentElement
    const siblings = parent ? Array.from(parent.children).filter((s) => s.localName === name) : []
    const position =
      siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')' : ''
    parts.unshift(CSS.escape(name) + classes + position)
  }
  const root = element.getRootNode()
  const host = root instanceof ShadowRoot ? root.host : null
  const path = (host ? selectorPath(host, level + 1, bare) + ' >>> ' : '') + parts.join(' > ')
  // Over the contract's 2048 (DesignSelectorSchema): once more without classes; a pick still
  // over it is ignored.
  return path.length > 2048 && !bare && level === 0 ? selectorPath(element, 0, true) : path
})

/**
 * The element a selector path names now, or null. A path whose `:nth-of-type` went stale (a hot
 * update added a sibling) still finds its element when the path without positions is unique.
 */
export const RESOLVE = String(function resolve(selector: string): Element | null {
  const find = (path: string): Element | null => {
    let root: Document | ShadowRoot = document
    let element: Element | null = null
    const steps = path.split(' >>> ')
    for (let index = 0; index < steps.length; index++) {
      try {
        element = root.querySelector(steps[index]!)
      } catch {
        return null
      }
      if (!element) return null
      if (index < steps.length - 1) {
        if (!element.shadowRoot) return null
        root = element.shadowRoot
      }
    }
    return element
  }
  const exact = find(selector)
  if (exact) return exact
  if (selector.includes(' >>> ') || !selector.includes(':nth-of-type(')) return null
  const loose = selector.replace(/:nth-of-type\(\d+\)/g, '')
  try {
    const all = document.querySelectorAll(loose)
    return all.length === 1 ? all[0]! : null
  } catch {
    return null
  }
})

/** One command to the in-page overlay. Coordinates are viewport CSS px. */
export type OverlayCommand =
  | { op: 'init'; color: string }
  | { op: 'hover'; x: number; y: number }
  | { op: 'unhover' }
  | { op: 'pick'; x: number; y: number; add: boolean; max: number }
  | { op: 'select'; selectors: string[] }
  | { op: 'status' }
  | { op: 'visible'; on: boolean }
  | { op: 'destroy' }

/** What a command answers: the selection's paths, and a signature of how its elements look. */
export interface OverlayAnswer {
  ready: boolean
  selectors: string[]
  sig: string
}

/** `function (cmd, selectorPath, resolve)` run in the isolated world (PageControl.inWorld). */
export const DESIGN_OVERLAY = String(function (
  cmd: OverlayCommand,
  selectorPath: (element: Element) => string,
  resolve: (selector: string) => Element | null,
): OverlayAnswer {
  interface Picked {
    selector: string
    element: Element | null
    frame: HTMLElement
  }
  interface Overlay {
    host: HTMLElement
    root: ShadowRoot
    hover: HTMLElement
    tag: HTMLElement
    hovered: Element | null
    picked: Picked[]
    frame: number
    /** A number per element node seen, so a hot update that swaps the node changes the sig. */
    ids: WeakMap<Element, number>
    seq: number
    /** Counts DOM changes inside a selected element (a child's image or text), for the sig. */
    rev: number
    watch: MutationObserver
  }
  const g = globalThis as unknown as { __relayDesign?: Overlay }
  const deepAt = (x: number, y: number): Element | null => {
    let element = document.elementFromPoint(x, y)
    for (let depth = 0; depth < 20 && element && element.shadowRoot; depth++) {
      const inner: Element | null = element.shadowRoot.elementFromPoint(x, y)
      if (!inner || inner === element) break
      element = inner
    }
    return element
  }
  const place = (frame: HTMLElement, element: Element | null): void => {
    const rect = element && element.isConnected ? element.getBoundingClientRect() : null
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      frame.style.display = 'none'
      return
    }
    frame.style.display = 'block'
    frame.style.transform = 'translate(' + rect.x + 'px,' + rect.y + 'px)'
    frame.style.width = rect.width + 'px'
    frame.style.height = rect.height + 'px'
  }
  const label = (element: Element): string => {
    const cls = Array.from(element.classList).slice(0, 2)
    return (
      element.localName + (element.id ? '#' + element.id : cls.length ? '.' + cls.join('.') : '')
    )
  }
  const answer = (o: Overlay | undefined): OverlayAnswer => {
    if (!o) return { ready: false, selectors: [], sig: '' }
    const idOf = (e: Element): number => {
      let id = o.ids.get(e)
      if (id === undefined) {
        id = ++o.seq
        o.ids.set(e, id)
      }
      return id
    }
    const sig = o.picked
      .map((p) => {
        const e = p.element
        if (!e || !e.isConnected) return 'missing'
        const r = e.getBoundingClientRect()
        const s = getComputedStyle(e)
        return [
          idOf(e),
          Array.from(e.attributes)
            .map((a) => a.name + '=' + a.value)
            .join(' ')
            .slice(0, 2000),
          Math.round(r.width),
          Math.round(r.height),
          s.color,
          s.backgroundColor,
          s.fontFamily,
          s.fontSize,
          s.fontWeight,
          s.lineHeight,
          s.letterSpacing,
          s.padding,
          s.margin,
          s.border,
          s.borderRadius,
          s.gap,
          s.display,
          s.opacity,
          s.boxShadow,
          (e.textContent || '').slice(0, 120),
        ].join('|')
      })
      .join('\n')
    return { ready: true, selectors: o.picked.map((p) => p.selector), sig: o.rev + '\n' + sig }
  }

  let o = g.__relayDesign
  if (cmd.op === 'destroy') {
    if (o) {
      cancelAnimationFrame(o.frame)
      o.watch.disconnect()
      o.host.remove()
      delete g.__relayDesign
    }
    return answer(undefined)
  }
  if (cmd.op === 'status') return answer(o && o.host.isConnected ? o : undefined)
  if (!o || !o.host.isConnected) {
    if (cmd.op !== 'init') return answer(undefined)
    // A document that dropped the old host (a framework replaced <html>): stop its watch.
    if (o) {
      cancelAnimationFrame(o.frame)
      o.watch.disconnect()
    }
    const host = document.createElement('relay-design')
    host.setAttribute(
      'style',
      'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;',
    )
    const root = host.attachShadow({ mode: 'closed' })
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(
      [
        ':host { all: initial; }',
        '.f { position: fixed; left: 0; top: 0; display: none; box-sizing: border-box; pointer-events: none; border-radius: 2px; }',
        '.h { border: 1px solid var(--c); background: color-mix(in srgb, var(--c) 8%, transparent); }',
        '.s { border: 2px solid var(--c); }',
        '.t, .n { position: absolute; font: 500 11px/16px ui-sans-serif, system-ui, sans-serif; color: #fff; background: var(--c); padding: 0 5px; border-radius: 3px; white-space: nowrap; }',
        '.t { left: -1px; top: -19px; max-width: 280px; overflow: hidden; text-overflow: ellipsis; }',
        '.n { left: -2px; top: -18px; min-width: 16px; text-align: center; border-radius: 3px 3px 0 0; padding: 0 4px; }',
      ].join('\n'),
    )
    root.adoptedStyleSheets = [sheet]
    const hover = document.createElement('div')
    hover.className = 'f h'
    const tag = document.createElement('span')
    tag.className = 't'
    hover.appendChild(tag)
    root.appendChild(hover)
    ;(document.documentElement || document.body).appendChild(host)
    const made: Overlay = {
      host,
      root,
      hover,
      tag,
      hovered: null,
      picked: [],
      frame: 0,
      ids: new WeakMap(),
      seq: 0,
      rev: 0,
      watch: new MutationObserver((records) => {
        for (const r of records) {
          if (made.picked.some((p) => p.element !== null && p.element.contains(r.target))) {
            made.rev++
            return
          }
        }
      }),
    }
    made.watch.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
    const tick = (): void => {
      if (!made.host.isConnected) return
      const t = made.hovered
      place(made.hover, t)
      made.tag.style.top = t && t.getBoundingClientRect().y < 20 ? '1px' : '-19px'
      for (const p of made.picked) {
        if (!p.element || !p.element.isConnected) p.element = resolve(p.selector)
        place(p.frame, p.element)
        // The number sits above the element, never over its content; inside its top edge when
        // the element touches the top of the viewport.
        const badge = p.frame.firstElementChild
        if (badge instanceof HTMLElement && p.element)
          badge.style.top = p.element.getBoundingClientRect().y < 18 ? '-2px' : '-18px'
      }
      made.frame = requestAnimationFrame(tick)
    }
    made.frame = requestAnimationFrame(tick)
    g.__relayDesign = made
    o = made
  }
  const ov = o
  const frameFor = (n: number): HTMLElement => {
    const frame = document.createElement('div')
    frame.className = 'f s'
    const badge = document.createElement('span')
    badge.className = 'n'
    badge.textContent = String(n)
    frame.appendChild(badge)
    ov.root.appendChild(frame)
    return frame
  }
  const setPicked = (list: Array<{ selector: string; element: Element | null }>): void => {
    for (const p of ov.picked) p.frame.remove()
    ov.picked = list.map((p, i) => ({ ...p, frame: frameFor(i + 1) }))
  }
  switch (cmd.op) {
    case 'init':
      ov.host.style.setProperty('--c', cmd.color)
      ov.hover.style.setProperty('--c', cmd.color)
      break
    case 'hover': {
      const element = deepAt(cmd.x, cmd.y)
      ov.hovered = element === document.documentElement ? null : element
      ov.tag.textContent = ov.hovered ? label(ov.hovered) : ''
      place(ov.hover, ov.hovered)
      break
    }
    case 'unhover':
      ov.hovered = null
      place(ov.hover, null)
      break
    case 'pick': {
      const element = deepAt(cmd.x, cmd.y)
      if (!element || element === document.documentElement) break
      const selector = selectorPath(element)
      if (selector.length > 2048) break
      const keep = ov.picked.map((p) => ({ selector: p.selector, element: p.element }))
      const at = keep.findIndex((p) => p.element === element || p.selector === selector)
      if (cmd.add) {
        if (at >= 0) keep.splice(at, 1)
        else if (keep.length < cmd.max) keep.push({ selector, element })
        setPicked(keep)
      } else {
        setPicked([{ selector, element }])
      }
      break
    }
    case 'select':
      setPicked(cmd.selectors.map((selector) => ({ selector, element: resolve(selector) })))
      break
    case 'visible':
      ov.host.style.display = cmd.on ? '' : 'none'
      break
  }
  return answer(ov)
})

/** What DESIGN_INSPECT reads for one selector (null: not in the page now). */
export interface InspectedElement {
  label: string
  text: string
  html: string
  box: { x: number; y: number; width: number; height: number }
  source: {
    file: string
    line: number | null
    column: number | null
    via: 'react-source' | 'react-stack' | 'data-attribute'
  } | null
  component: string | null
  styles: Record<string, string>
}

/** What DESIGN_INSPECT answers: the viewport, and per selector its element (null: gone). */
export interface InspectAnswer {
  width: number
  height: number
  items: Array<InspectedElement | null>
}

/** `function (selectors, styleKeys, resolve)` run in the page's own world, read-only. */
export const DESIGN_INSPECT = String(function (
  selectors: string[],
  styleKeys: string[],
  resolve: (selector: string) => Element | null,
): InspectAnswer {
  type Src = InspectedElement['source']
  interface Fiber {
    type?: unknown
    return?: Fiber | null
    _debugOwner?: Fiber | null
    _debugSource?: { fileName?: string; lineNumber?: number; columnNumber?: number } | null
    _debugStack?: { stack?: string } | null
  }
  const nameOf = (type: unknown): string | null => {
    if (typeof type === 'function') {
      const fn = type as { displayName?: string; name?: string }
      return fn.displayName || fn.name || null
    }
    if (type && typeof type === 'object') {
      const t = type as {
        displayName?: string
        render?: { displayName?: string; name?: string }
        type?: { displayName?: string; name?: string }
      }
      return (
        t.displayName ||
        (t.render && (t.render.displayName || t.render.name)) ||
        (t.type && (t.type.displayName || t.type.name)) ||
        null
      )
    }
    return null
  }
  const num = (v: string | null | undefined): number | null => {
    const n = v ? parseInt(v, 10) : NaN
    return Number.isFinite(n) ? n : null
  }
  const fromLoc = (loc: string): Src => {
    const m = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(loc.trim())
    if (!m || !m[1]) return null
    return { file: m[1], line: num(m[2]), column: num(m[3]), via: 'data-attribute' }
  }
  const fromAttributes = (element: Element): { source: Src; component: string | null } => {
    let source: Src = null
    let component: string | null = null
    let e: Element | null = element
    for (let i = 0; e && i < 8 && (!source || !component); i++, e = e.parentElement) {
      if (!source) {
        const loc = e.getAttribute('data-source') || e.getAttribute('data-source-loc')
        const rel = e.getAttribute('data-inspector-relative-path')
        const sentry = e.getAttribute('data-sentry-source-file')
        if (loc) source = fromLoc(loc)
        else if (rel)
          source = {
            file: rel,
            line: num(e.getAttribute('data-inspector-line')),
            column: num(e.getAttribute('data-inspector-column')),
            via: 'data-attribute',
          }
        else if (sentry) source = { file: sentry, line: null, column: null, via: 'data-attribute' }
      }
      if (!component) {
        component =
          e.getAttribute('data-component') ||
          e.getAttribute('data-sentry-component') ||
          e.getAttribute('data-component-name')
      }
    }
    return { source, component }
  }
  const appFrame = (stack: string): Src => {
    for (const line of stack.split('\n')) {
      const m = /((?:https?|file):\/\/[^\s()]+?):(\d+):(\d+)\)?\s*$/.exec(line)
      if (!m) continue
      const url = m[1]!
      if (/\/node_modules\/|\/\.vite\/deps\/|\/@react-refresh|react-dom|jsx-dev-runtime/.test(url))
        continue
      let file = url
      try {
        file = decodeURIComponent(new URL(url).pathname).replace(/^\/@fs/, '')
      } catch {
        /* keep the URL */
      }
      return { file, line: num(m[2]), column: num(m[3]), via: 'react-stack' }
    }
    return null
  }
  const fromReact = (element: Element): { source: Src; component: string | null } => {
    const key = Object.keys(element).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
    )
    const host = key ? ((element as unknown as Record<string, Fiber>)[key] ?? null) : null
    if (!host) return { source: null, component: null }
    let source: Src = null
    for (let f: Fiber | null | undefined = host, i = 0; f && i < 30 && !source; f = f.return, i++) {
      const d = f._debugSource
      if (d && d.fileName)
        source = {
          file: d.fileName,
          line: typeof d.lineNumber === 'number' ? d.lineNumber : null,
          column: typeof d.columnNumber === 'number' ? d.columnNumber : null,
          via: 'react-source',
        }
    }
    if (!source) {
      for (
        let f: Fiber | null | undefined = host, i = 0;
        f && i < 30 && !source;
        f = f.return, i++
      ) {
        const st = f._debugStack
        if (st && typeof st.stack === 'string') source = appFrame(st.stack)
      }
    }
    let component: string | null = null
    for (
      let f: Fiber | null | undefined = host._debugOwner, i = 0;
      f && i < 30 && !component;
      i++
    ) {
      component = nameOf(f.type)
      f = f._debugOwner || f.return
    }
    for (let f: Fiber | null | undefined = host.return, i = 0; f && i < 60 && !component; i++) {
      component = nameOf(f.type)
      f = f.return
    }
    return { source, component }
  }
  const items = selectors.map((selector): InspectedElement | null => {
    const element = resolve(selector)
    if (!element) return null
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    const styles: Record<string, string> = {}
    for (const k of styleKeys) styles[k] = style.getPropertyValue(k).slice(0, 400)
    const cls = Array.from(element.classList).slice(0, 2)
    const attrs = fromAttributes(element)
    const react = fromReact(element)
    const html = element.outerHTML
    return {
      label:
        element.localName + (element.id ? '#' + element.id : cls.length ? '.' + cls.join('.') : ''),
      text: (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400),
      html: html.length > 1500 ? html.slice(0, 1500) + '…' : html,
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      // A data attribute is the project's own exact record; React's stack frame is approximate.
      source:
        react.source && react.source.via === 'react-source'
          ? react.source
          : attrs.source || react.source,
      component: react.component || attrs.component,
      styles,
    }
  })
  return { width: innerWidth, height: innerHeight, items }
})

/** The isolated world the overlay lives in. */
const WORLD = 'relay-design'

/** What Design Mode does in one page (design-mode.ts); `designPage` runs it over PageControl. */
export interface DesignPage {
  overlay(cmd: OverlayCommand): Promise<OverlayAnswer>
  inspect(selectors: string[]): Promise<InspectAnswer>
  /**
   * An inline style on the element `selector` names: the edit Isaac previews. `missing`: no such
   * element now; `rejected`: the page's CSS did not take the value (the declaration is invalid).
   */
  preview(selector: string, property: string, value: string): Promise<'ok' | 'missing' | 'rejected'>
  /** Waits until the page painted what changed last (two frames, at most a moment). */
  settle(): Promise<void>
  capture(
    rect: { x: number; y: number; width: number; height: number },
    maxSide: number,
  ): Promise<{ png: string; width: number; height: number } | null>
}

export function designPage(
  pc: Pick<PageControl, 'inWorld' | 'evaluate' | 'capture'>,
  styleKeys: readonly string[],
): DesignPage {
  return {
    overlay: (cmd) =>
      pc.inWorld<OverlayAnswer>(
        WORLD,
        `(${DESIGN_OVERLAY})(${JSON.stringify(cmd)}, ${SELECTOR_PATH}, ${RESOLVE})`,
      ),
    inspect: (selectors) =>
      pc.evaluate<InspectAnswer>(
        `(${DESIGN_INSPECT})(${JSON.stringify(selectors)}, ${JSON.stringify(styleKeys)}, ${RESOLVE})`,
      ),
    preview: async (selector, property, value) => {
      const r = await pc.evaluate<string>(
        `((resolve, property, value) => { const e = resolve(${JSON.stringify(selector)}); if (!e || !e.style) return 'missing'; if (value.trim() !== '' && !CSS.supports(property, value)) return 'rejected'; e.style.setProperty(property, value); return 'ok' })(${RESOLVE}, ${JSON.stringify(property)}, ${JSON.stringify(value)})`,
      )
      return r === 'missing' || r === 'rejected' ? r : 'ok'
    },
    settle: async () => {
      await pc.inWorld(
        WORLD,
        '(() => { const { promise, resolve } = Promise.withResolvers(); setTimeout(resolve, 120); requestAnimationFrame(() => requestAnimationFrame(resolve)); return promise })()',
      )
    },
    capture: (rect, maxSide) => pc.capture(rect, maxSide),
  }
}
