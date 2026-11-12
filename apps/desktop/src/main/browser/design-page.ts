import { DESIGN_MAX_SELECTION } from '@evaos/contract'
import type { PickOp, PickResult } from './annotate-picker'
import type { PageControl } from './page-control'

/**
 * The page side of Design Mode (design-mode.ts runs these through PageControl):
 *
 * - DESIGN_OVERLAY runs in an isolated world, like the agent cursor: it draws the numbered
 *   selection outlines inside the page (a native page paints over anything the shell draws) and
 *   keeps each selected element found by its selector and fingerprint, so a hot update that
 *   replaces the node or a reload that rebuilds the page finds it again. Hover, clicks and drags
 *   are the note picker's (annotate-picker.ts, mode `design`), in the agent cursor's world.
 * - DESIGN_INSPECT runs in the page's own world, read-only: React keeps its fibers (component,
 *   `_debugSource`, `_debugStack`) as properties of the page's DOM objects, which an isolated
 *   world can't see.
 *
 * Each is a standalone function serialized into the page: no module values, no imports. Shared
 * helpers are passed in as arguments (a minified build renames module functions, so a reference
 * by name would break only in the packaged app).
 *
 * SELECTOR_PATH follows TasteCode's browser annotations (browser-annotations.ts,
 * github.com/Leonxlnx/tastecode, Apache-2.0; see THIRD_PARTY_NOTICES.md): an anchor when unique,
 * else tag, two classes an agent can search the source for and `:nth-of-type`, through shadow
 * roots as `host >>> inner`.
 *
 * A path names its element alone when it is made, but not after the page changes: one made while
 * a list showed a single card names the first card once the list is whole again. So each pick
 * also keeps a FINGERPRINT (tag, text, its parent's text, classes, a few attributes, position,
 * size), main keeps it across reloads, and RESTORE finds the element by both.
 */

/** The outline color: quiet, readable on light and dark pages. */
export const DESIGN_COLOR = '#4c6ef5'

/** At most this many elements and regions in one selection (and one request). */
export const MAX_SELECTION = DESIGN_MAX_SELECTION

/** The note picker's host (annotate-picker.ts): never a pick target, hidden for crops. */
const PICKER_HOST = 'relay-note-picker'

/**
 * A path that names `element` alone in its root: from the nearest ancestor (or itself) with a
 * unique id, test id, aria-label or name, down through tag, two classes and `:nth-of-type`. A path
 * that names anything else too is replaced by the element's `:nth-child` chain from body. Through
 * shadow roots as `host >>> inner`, each step checked in its own root.
 */
export const SELECTOR_PATH = String(function selectorPath(
  element: Element,
  depth?: number,
  bare?: boolean,
): string {
  const level = depth ?? 0
  if (level > 20) return '[unavailable-shadow-path]'
  const root = element.getRootNode() as Document | ShadowRoot
  /** `e` by a stable attribute of its own, when no other element in the root has it. */
  const anchor = (e: Element): string | null => {
    const tries: string[] = []
    // A generated id (React's useId: `:r1:`, `«r1»`) changes between renders.
    if (e.id && e.id.length <= 200 && !/^(:.*:|«.*»)$/.test(e.id))
      tries.push('#' + CSS.escape(e.id))
    for (const name of [
      'data-testid',
      'data-test-id',
      'data-test',
      'data-cy',
      'aria-label',
      'name',
    ]) {
      const v = e.getAttribute(name)
      if (!v || v.length > 200 || /[\n\r\f]/.test(v)) continue
      // A label or a field name is only stable on its own kind of element.
      const tag = name === 'aria-label' || name === 'name' ? CSS.escape(e.localName) : ''
      tries.push(tag + '[' + name + '="' + v.replace(/[\\"]/g, '\\$&') + '"]')
    }
    for (const sel of tries) {
      try {
        if (root.querySelectorAll(sel).length === 1) return sel
      } catch {
        // Not a selector this engine takes: the next one.
      }
    }
    return null
  }
  const parts: string[] = []
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.localName === 'html' && parts.length > 0) break
    const own = anchor(current)
    if (own) {
      parts.unshift(own)
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
    const parent = current.parentNode as ParentNode | null
    const siblings = parent ? Array.from(parent.children).filter((s) => s.localName === name) : []
    const position =
      siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')' : ''
    parts.unshift(CSS.escape(name) + classes + position)
  }
  let path = parts.join(' > ')
  let named: NodeListOf<Element> | null = null
  try {
    named = root.querySelectorAll(path)
  } catch {
    named = null
  }
  if (!named || named.length !== 1 || named[0] !== element) {
    const chain: string[] = []
    for (let current: Element | null = element; current; current = current.parentElement) {
      const name = current.localName
      if (name === 'body' || name === 'html') {
        chain.unshift(name)
        break
      }
      const parent = current.parentNode as ParentNode | null
      const index = parent ? Array.from(parent.children).indexOf(current) + 1 : 1
      chain.unshift(CSS.escape(name) + ':nth-child(' + index + ')')
    }
    path = chain.join(' > ')
  }
  const host = root instanceof ShadowRoot ? root.host : null
  const full = (host ? selectorPath(host, level + 1, bare) + ' >>> ' : '') + path
  // Over the contract's 2048 (DesignSelectorSchema): once more without classes; a pick still
  // over it is ignored.
  return full.length > 2048 && !bare && level === 0 ? selectorPath(element, 0, true) : full
})

/**
 * The element a selector path names now, only when it names one: never the first of several.
 * Main-world reads and previews use it with the overlay's paths, which RESTORE keeps unique.
 */
export const RESOLVE = String(function resolve(selector: string): Element | null {
  let root: Document | ShadowRoot = document
  let element: Element | null = null
  const steps = selector.split(' >>> ')
  for (let index = 0; index < steps.length; index++) {
    let all: NodeListOf<Element>
    try {
      all = root.querySelectorAll(steps[index]!)
    } catch {
      return null
    }
    if (all.length !== 1) return null
    element = all[0]!
    if (index < steps.length - 1) {
      if (!element.shadowRoot) return null
      root = element.shadowRoot
    }
  }
  return element
})

/** How a selected element looked when it was picked or last found (FINGERPRINT). */
export interface Fingerprint {
  tag: string
  /** Its classes in order, space separated. */
  classes: string
  /** Its text, whitespace collapsed, lowercased, the first 160 characters. */
  text: string
  /** Its parent's text, the same way: tells apart children alike in cards that are not. */
  context: string
  /** id, test id, name, aria-label, role, type, href, src, alt and title as `name=value`. */
  attrs: string
  /** Its place among its parent's children of its tag (from 1), and how many there are. */
  index: number
  siblings: number
  /** Its size in CSS px, rounded. */
  w: number
  h: number
}

/** `element`'s Fingerprint, in the page. */
export const FINGERPRINT = String(function fingerprintOf(element: Element): Fingerprint {
  const text = (e: Node | null): string =>
    ((e && e.textContent) || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 160)
  const parent = element.parentNode as ParentNode | null
  const same = parent
    ? Array.from(parent.children).filter((s) => s.localName === element.localName)
    : [element]
  const attrs: string[] = []
  for (const name of [
    'id',
    'data-testid',
    'name',
    'aria-label',
    'role',
    'type',
    'href',
    'src',
    'alt',
    'title',
  ]) {
    const v = element.getAttribute(name)
    if (v !== null) attrs.push(name + '=' + v.slice(0, 100))
  }
  const r = element.getBoundingClientRect()
  return {
    tag: element.localName,
    classes: Array.from(element.classList).join(' ').slice(0, 200),
    text: text(element),
    context: text(element.parentElement),
    attrs: attrs.join(' ').slice(0, 600),
    index: same.indexOf(element) + 1,
    siblings: same.length,
    w: Math.round(r.width),
    h: Math.round(r.height),
  }
})

/** What RESTORE found: `exact` when the path still names it alone; `strong` when its text agrees. */
export interface Restored {
  element: Element
  exact: boolean
  strong: boolean
}

/**
 * The element `selector` named when `print` was taken, in the page as it is now, or null. The
 * elements the path names, the path without positions names, and those sharing the print's tag
 * and first class are weighed: first by text (the same beats close, an edit), then by attributes,
 * parent's text, classes, position, size and whether the path names it alone; the one best match
 * wins. Several equally good, or none whose text agrees: null, never the first of them. The path's
 * own element whose text changed past recognizing (new copy) still binds when its classes,
 * position and parent's text agree, as a weak match (the overlay looks again for a strong one).
 * Without a print only a path that names one element finds it.
 */
export const RESTORE = String(function restore(
  selector: string,
  print: Fingerprint | null,
  fingerprintOf: (element: Element) => Fingerprint,
): Restored | null {
  const all = (root: Document | ShadowRoot, sel: string): Element[] => {
    try {
      return Array.from(root.querySelectorAll(sel))
    } catch {
      return []
    }
  }
  const strip = (sel: string): string => sel.replace(/:nth-(?:of-type|child)\(\d+\)/g, '')
  const steps = selector.split(' >>> ')
  let roots: Array<Document | ShadowRoot> = [document]
  let single = true
  for (let i = 0; i < steps.length - 1; i++) {
    let hosts = roots.flatMap((r) => all(r, steps[i]!))
    if (hosts.length !== 1) single = false
    if (hosts.length === 0 && print) hosts = roots.flatMap((r) => all(r, strip(steps[i]!)))
    const next: ShadowRoot[] = []
    for (const h of hosts) if (h.shadowRoot && next.length < 50) next.push(h.shadowRoot)
    if (next.length === 0) return null
    roots = next
  }
  const last = steps[steps.length - 1]!
  const named = roots.flatMap((r) => all(r, last))
  const exact = single && named.length === 1 ? named[0]! : null
  if (!print) return exact ? { element: exact, exact: true, strong: true } : null

  const candidates: Element[] = []
  const add = (list: Element[]): void => {
    for (const e of list) {
      if (candidates.length >= 400) return
      if (e.localName === print.tag && !candidates.includes(e)) candidates.push(e)
    }
  }
  add(named)
  for (const r of roots) add(all(r, strip(last)))
  const first = print.classes.split(' ').find((c) => /^[A-Za-z_-][\w-]*$/.test(c))
  if (first) for (const r of roots) add(all(r, CSS.escape(print.tag) + '.' + CSS.escape(first)))

  /** The same text, edited a little (most of it kept at its start and end), or appended to. */
  const near = (a: string, b: string): boolean => {
    if (!a || !b) return false
    if ((a.length >= 4 && b.includes(a)) || (b.length >= 4 && a.includes(b))) return true
    const m = Math.min(a.length, b.length)
    let p = 0
    while (p < m && a[p] === b[p]) p++
    let s = 0
    while (s < m - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
    return (p + s) / Math.max(a.length, b.length) >= 0.6
  }
  const sorted = (c: string): string => c.split(' ').filter(Boolean).sort().join(' ')
  const classes = sorted(print.classes)
  const scored = candidates.map((e) => {
    const f = fingerprintOf(e)
    const tier = f.text === print.text ? 2 : near(print.text, f.text) ? 1 : 0
    const score =
      (f.attrs === print.attrs ? 4 : 0) +
      (f.context === print.context ? 3 : near(print.context, f.context) ? 2 : 0) +
      (sorted(f.classes) === classes ? 2 : 0) +
      (f.index === print.index ? 1 : 0) +
      (f.siblings === print.siblings ? 1 : 0) +
      (Math.abs(f.w - print.w) <= 2 && Math.abs(f.h - print.h) <= 2 ? 1 : 0)
    return { e, f, tier, score }
  })
  const top = scored.reduce((t, s) => Math.max(t, s.tier), 0)
  if (top === 0) {
    const own = exact ? scored.find((s) => s.e === exact) : undefined
    const same =
      own &&
      sorted(own.f.classes) === classes &&
      own.f.index === print.index &&
      (own.f.context === print.context || near(print.context, own.f.context))
    return own && same ? { element: own.e, exact: true, strong: false } : null
  }
  // The path's own element counts as evidence too, not as the answer: a card's child alike in
  // every card is told apart by its card's text when a card was inserted before it.
  const tier = scored
    .filter((s) => s.tier === top)
    .map((s) => ({ e: s.e, score: s.score + (s.e === exact ? 2 : 0) }))
  const best = tier.reduce((b, s) => Math.max(b, s.score), -1)
  const winners = tier.filter((s) => s.score === best)
  if (winners.length !== 1) return null
  return { element: winners[0]!.e, exact: winners[0]!.e === exact, strong: true }
})

/** One selected element as main keeps it: its path, and how it looked (null: never seen). */
export interface OverlayItem {
  selector: string
  print: Fingerprint | null
}

/** One command to the in-page overlay. Coordinates are viewport CSS px. */
export type OverlayCommand =
  | { op: 'init'; color: string }
  | { op: 'pick'; x: number; y: number; add: boolean; max: number }
  | { op: 'select'; items: OverlayItem[] }
  | { op: 'status' }
  | { op: 'visible'; on: boolean }
  | { op: 'destroy' }

/**
 * What a command answers: the selection's paths, each one's fingerprint (main keeps them for the
 * next document), whether each one's element is in the page now, and a signature of how its
 * elements look.
 */
export interface OverlayAnswer {
  ready: boolean
  selectors: string[]
  prints: Array<Fingerprint | null>
  found: boolean[]
  sig: string
}

/**
 * `function (cmd, selectorPath, restore, fingerprintOf, pickerHost)` run in the isolated world
 * (PageControl.inWorld).
 */
export const DESIGN_OVERLAY = String(function (
  cmd: OverlayCommand,
  selectorPath: (element: Element) => string,
  restore: (
    selector: string,
    print: Fingerprint | null,
    fingerprintOf: (element: Element) => Fingerprint,
  ) => Restored | null,
  fingerprintOf: (element: Element) => Fingerprint,
  pickerHost: string,
): OverlayAnswer {
  interface Bound {
    selector: string
    print: Fingerprint | null
    element: Element | null
    /** Found by its text too; a weak one (only its path agreed) is looked for again. */
    strong: boolean
  }
  interface Picked extends Bound {
    frame: HTMLElement
  }
  interface Overlay {
    host: HTMLElement
    root: ShadowRoot
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
    // Under the note picker's host, which takes the pointer while Design Mode is on (a shadow
    // root's hit test sees that host too).
    const below = (els: Element[]): Element | null => els.find((e) => e.id !== pickerHost) ?? null
    let element = below(document.elementsFromPoint(x, y))
    for (let depth = 0; depth < 20 && element && element.shadowRoot; depth++) {
      const inner = below(element.shadowRoot.elementsFromPoint(x, y))
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
  const WATCH: MutationObserverInit = {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  }
  /** `node` is `element` or inside it, through shadow roots too. */
  const within = (node: Node, element: Element): boolean => {
    for (let n: Node | null = node; n; n = n instanceof ShadowRoot ? n.host : n.parentNode) {
      if (n === element) return true
    }
    return false
  }
  /**
   * The document watch misses shadow roots: watch the ones the element lives in and the open ones
   * inside it (the first 2000 descendants), so a change there refreshes it too.
   */
  const watchRoots = (o: Overlay, element: Element): void => {
    for (
      let root = element.getRootNode();
      root instanceof ShadowRoot;
      root = root.host.getRootNode()
    )
      o.watch.observe(root, WATCH)
    if (element.shadowRoot) o.watch.observe(element.shadowRoot, WATCH)
    const inner = element.querySelectorAll('*')
    for (let i = 0; i < inner.length && i < 2000; i++) {
      const shadow = inner[i]!.shadowRoot
      if (shadow) o.watch.observe(shadow, WATCH)
    }
  }
  /**
   * Finds `p`'s element in the page as it is now (RESTORE): a strong find takes its look as the
   * print, and one its path no longer names alone gets a path that does.
   */
  const find = (p: Bound): void => {
    const r = restore(p.selector, p.print, fingerprintOf)
    p.element = r ? r.element : null
    p.strong = r ? r.strong : false
    if (!r) return
    if (r.strong) p.print = fingerprintOf(r.element)
    if (!r.exact) {
      const next = selectorPath(r.element)
      if (next.length <= 2048) p.selector = next
    }
  }
  const answer = (o: Overlay | undefined): OverlayAnswer => {
    if (!o) return { ready: false, selectors: [], prints: [], found: [], sig: '' }
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
    return {
      ready: true,
      selectors: o.picked.map((p) => p.selector),
      prints: o.picked.map((p) => p.print),
      found: o.picked.map((p) => p.element !== null && p.element.isConnected),
      sig: o.rev + '\n' + sig,
    }
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
        '.s { border: 2px solid var(--c); }',
        '.n { position: absolute; left: -2px; top: -18px; min-width: 16px; padding: 0 4px; font: 500 11px/16px ui-sans-serif, system-ui, sans-serif; color: #fff; background: var(--c); text-align: center; border-radius: 3px 3px 0 0; white-space: nowrap; }',
      ].join('\n'),
    )
    root.adoptedStyleSheets = [sheet]
    ;(document.documentElement || document.body).appendChild(host)
    const made: Overlay = {
      host,
      root,
      picked: [],
      frame: 0,
      ids: new WeakMap(),
      seq: 0,
      rev: 0,
      watch: new MutationObserver((records) => {
        for (const r of records) {
          if (made.picked.some((p) => p.element !== null && within(r.target, p.element))) {
            made.rev++
            return
          }
        }
      }),
    }
    made.watch.observe(document, WATCH)
    let ticks = 0
    const tick = (): void => {
      if (!made.host.isConnected) return
      ticks++
      for (const p of made.picked) {
        // Replaced: found again at once. Not in the page yet, or bound weakly: looked for a few
        // times a second (the page may still be rendering it).
        if (
          (p.element && !p.element.isConnected) ||
          (!p.element && ticks % 10 === 0) ||
          (p.element && !p.strong && ticks % 30 === 0)
        ) {
          const was = p.element
          find(p)
          if (p.element && p.element !== was) watchRoots(made, p.element)
        }
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
  const setPicked = (list: Bound[]): void => {
    for (const p of ov.picked) p.frame.remove()
    ov.picked = list.map((p, i) => ({ ...p, frame: frameFor(i + 1) }))
    for (const p of ov.picked) if (p.element) watchRoots(ov, p.element)
  }
  switch (cmd.op) {
    case 'init':
      ov.host.style.setProperty('--c', cmd.color)
      break
    case 'pick': {
      const element = deepAt(cmd.x, cmd.y)
      if (!element || element === document.documentElement) break
      const selector = selectorPath(element)
      if (selector.length > 2048) break
      const picked: Bound = { selector, print: fingerprintOf(element), element, strong: true }
      const keep: Bound[] = ov.picked.map(({ frame: _, ...p }) => p)
      const at = keep.findIndex((p) => p.element === element || p.selector === selector)
      if (cmd.add) {
        if (at >= 0) keep.splice(at, 1)
        else if (keep.length < cmd.max) keep.push(picked)
        setPicked(keep)
      } else {
        setPicked([picked])
      }
      break
    }
    case 'select':
      setPicked(
        cmd.items.map((item) => {
          const p: Bound = {
            selector: item.selector,
            print: item.print,
            element: null,
            strong: false,
          }
          find(p)
          return p
        }),
      )
      break
    case 'visible':
      ov.host.style.display = cmd.on ? '' : 'none'
      // The picker's hover box stays out of the crops too (the page shares its DOM); opacity,
      // so the picker still takes the pointer meanwhile.
      document.getElementById(pickerHost)?.style.setProperty('opacity', cmd.on ? '' : '0')
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

/**
 * `function (selectors, styleKeys, resolve)` run in the page's own world, read-only. A null
 * selector (one the overlay did not find) reads as null.
 */
export const DESIGN_INSPECT = String(function (
  selectors: Array<string | null>,
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
    const element = selector === null ? null : resolve(selector)
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
  /** Reads each selector's element; null ones (not found by the overlay) read as null. */
  inspect(selectors: Array<string | null>): Promise<InspectAnswer>
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
  /** The note picker in mode `design` (annotate-picker.ts): Isaac's next click or drag. */
  pick(op: PickOp, timeoutMs: number): Promise<PickResult>
}

export function designPage(
  pc: Pick<PageControl, 'inWorld' | 'evaluate' | 'capture' | 'pick'>,
  styleKeys: readonly string[],
): DesignPage {
  return {
    overlay: (cmd) =>
      pc.inWorld<OverlayAnswer>(
        WORLD,
        `(${DESIGN_OVERLAY})(${JSON.stringify(cmd)}, ${SELECTOR_PATH}, ${RESTORE}, ${FINGERPRINT}, ${JSON.stringify(PICKER_HOST)})`,
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
    pick: (op, timeoutMs) => pc.pick(op, timeoutMs),
  }
}
