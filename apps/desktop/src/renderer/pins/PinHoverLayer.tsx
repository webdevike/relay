import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { IconPin } from '@tabler/icons-react'
import type { PinKind } from '@evaos/chat-core/artifacts'
import { inferPinKind, pinLabelOf, pinOfText } from '@evaos/chat-core/pins'
import { usePinsScope } from './pins-scope'
import './pins.css'

/** What a floating pin button would pin, and where it floats (viewport px). */
export interface PinTarget {
  mode: 'selection' | 'inline'
  note: { kind: PinKind; label: string; value: string; source?: string }
  /** The text's box; the button sits at its top right (selection: above its start). */
  rect: { left: number; right: number; top: number; bottom: number }
}

/** Longest stretch of text a hovered number's label takes from before it. */
const CONTEXT_CHARS = 40
/** A number worth a pin is at least this long; "1." in a list or "2" in prose is not. */
const MIN_NUMBER_CHARS = 3
const NUMBER = /[+-]?[$€£]?\d[\d,_]*(?:\.\d+)?%?/g

/** The bubble key of the message `node` is in, from the `data-pin-source` of its bubble. */
export function sourceOf(node: Node | null): string | undefined {
  const el = node instanceof Element ? node : (node?.parentElement ?? null)
  return el?.closest<HTMLElement>('[data-pin-source]')?.dataset['pinSource']
}

/** The number under a point in rendered prose (not a link or code span, which have their own), or null. */
export function numberAt(x: number, y: number): PinTarget | null {
  const caret = document.caretRangeFromPoint?.(x, y)
  const node = caret?.startContainer
  if (!caret || node?.nodeType !== Node.TEXT_NODE) return null
  const parent = node.parentElement
  if (!parent?.closest('.eva-md, .eva-bubble') || parent.closest('a, code, pre, button'))
    return null
  const text = node.textContent ?? ''
  for (const m of text.matchAll(NUMBER)) {
    const start = m.index
    const end = start + m[0].length
    if (caret.startOffset < start || caret.startOffset > end) continue
    const before = text[start - 1]
    const after = text[end]
    // Part of a word or a key (ENG-6545, v2, 12px): not an inline number.
    if (
      (before !== undefined && /[\p{L}\p{N}_-]/u.test(before)) ||
      (after !== undefined && /[\p{L}_]/u.test(after))
    ) {
      return null
    }
    if (m[0].replace(/[^\d]/g, '').length < 1 || m[0].length < MIN_NUMBER_CHARS) return null
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    const box = range.getBoundingClientRect()
    if (x < box.left - 2 || x > box.right + 2 || y < box.top - 2 || y > box.bottom + 2) return null
    const context = text.slice(Math.max(0, start - CONTEXT_CHARS), start).replace(/[\s:=,(]+$/, '')
    const label = pinLabelOf(context.split(/[.!?]\s/).pop() ?? '', CONTEXT_CHARS)
    const source = sourceOf(node)
    return {
      mode: 'inline',
      note: {
        kind: 'number',
        label: label === 'Pin' ? 'Number' : label,
        value: m[0],
        ...(source === undefined ? {} : { source }),
      },
      rect: box,
    }
  }
  return null
}

/** The link or inline code span under `el`, as a pin target. */
export function inlineTarget(el: Element): PinTarget | null {
  const a = el.closest<HTMLAnchorElement>('.eva-md a[href], .eva-bubble a[href]')
  const source = sourceOf(el)
  const withSource = source === undefined ? {} : { source }
  if (a !== null) {
    const href = a.getAttribute('href') ?? ''
    if (!/^https?:\/\//.test(href)) return null
    const text = (a.textContent ?? '').trim()
    const label = text === '' || text === href ? hostLabel(href) : pinLabelOf(text)
    return {
      mode: 'inline',
      note: { kind: inferPinKind(href), label, value: href, ...withSource },
      rect: a.getBoundingClientRect(),
    }
  }
  const code = el.closest<HTMLElement>('.eva-md code, .eva-bubble code')
  if (code !== null && code.closest('pre') === null) {
    const value = (code.textContent ?? '').trim()
    const note = pinOfText(value, {})
    if (note === null || value.length < 2) return null
    const kind = note.kind === 'text' ? 'code' : note.kind
    return {
      mode: 'inline',
      note: { ...note, kind, ...withSource },
      rect: code.getBoundingClientRect(),
    }
  }
  return null
}

function hostLabel(href: string): string {
  try {
    const u = new URL(href)
    return pinLabelOf(`${u.host}${u.pathname === '/' ? '' : u.pathname}`)
  } catch {
    return pinLabelOf(href)
  }
}

/** The selected text of one message, as a pin target (kind code when the selection sits in code). */
export function selectionTarget(sel: Selection | null): PinTarget | null {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const source = sourceOf(sel.anchorNode)
  if (source === undefined || sourceOf(sel.focusNode) !== source) return null
  const text = sel.toString()
  const range = sel.getRangeAt(0)
  const base = range.commonAncestorContainer
  const el = base instanceof Element ? base : base.parentElement
  const inCode = el?.closest('code, pre') != null
  const note = pinOfText(text, inCode ? { kind: 'code' } : {})
  if (note === null) return null
  return { mode: 'selection', note: { ...note, source }, rect: range.getBoundingClientRect() }
}

/**
 * The small floating pin of the chat: "Pin selection" above text Isaac selected in a message, and a
 * tiny pin that appears on a hovered link, code span or inline number. Mounted once per chat body;
 * both read the DOM, so the markdown renderer stays untouched.
 */
export function PinHoverLayer({ bodyRef }: { bodyRef: RefObject<HTMLElement | null> }) {
  const scope = usePinsScope()
  const [target, setTarget] = useState<PinTarget | null>(null)
  const selecting = useRef(false)
  const hide = useRef<number | undefined>(undefined)
  const enabled = scope !== null && scope.up

  useEffect(() => {
    const body = bodyRef.current
    if (body === null || !enabled) return
    /** Shows an inline target (a selection in front keeps its place); the same one again changes nothing. */
    const show = (t: PinTarget): void => {
      clearTimeout(hide.current)
      hide.current = undefined
      setTarget((cur) =>
        cur?.mode === 'selection' ||
        (cur?.note.value === t.note.value &&
          cur.rect.left === t.rect.left &&
          cur.rect.top === t.rect.top)
          ? cur
          : t,
      )
    }
    /** Drops an inline target shortly after the pointer left it, so it can move onto the button. */
    const later = (): void => {
      if (hide.current !== undefined) return
      hide.current = window.setTimeout(() => {
        hide.current = undefined
        setTarget((t) => (t?.mode === 'inline' ? null : t))
      }, 260)
    }
    const onOver = (e: MouseEvent): void => {
      if (selecting.current || !(e.target instanceof Element)) return
      const t = inlineTarget(e.target)
      if (t === null) later()
      else show(t)
    }
    let last = 0
    const onMove = (e: MouseEvent): void => {
      const now = performance.now()
      if (selecting.current || now - last < 60 || !(e.target instanceof Element)) return
      last = now
      if (e.target.closest('a, code, pre, button')) return
      const t = numberAt(e.clientX, e.clientY)
      if (t === null) later()
      else show(t)
    }
    const onDown = (): void => {
      selecting.current = true
    }
    const onUp = (): void => {
      selecting.current = false
      // The selection settles after the mouseup.
      requestAnimationFrame(() => {
        const t = selectionTarget(window.getSelection())
        if (t !== null) setTarget(t)
      })
    }
    const onSelection = (): void => {
      if (window.getSelection()?.isCollapsed === true)
        setTarget((t) => (t?.mode === 'selection' ? null : t))
    }
    const onWheel = (): void => setTarget((t) => (t?.mode === 'inline' ? null : t))
    body.addEventListener('mouseover', onOver)
    body.addEventListener('mouseleave', later)
    body.addEventListener('mousemove', onMove)
    body.addEventListener('mousedown', onDown)
    body.addEventListener('mouseup', onUp)
    body.addEventListener('wheel', onWheel, { passive: true })
    document.addEventListener('selectionchange', onSelection)
    return () => {
      clearTimeout(hide.current)
      hide.current = undefined
      body.removeEventListener('mouseover', onOver)
      body.removeEventListener('mouseleave', later)
      body.removeEventListener('mousemove', onMove)
      body.removeEventListener('mousedown', onDown)
      body.removeEventListener('mouseup', onUp)
      body.removeEventListener('wheel', onWheel)
      document.removeEventListener('selectionchange', onSelection)
    }
  }, [bodyRef, enabled])

  if (!enabled || target === null) return null
  const tiny = target.mode === 'inline'
  const left = tiny ? target.rect.right + 4 : target.rect.left
  const top = tiny ? target.rect.top - 22 : target.rect.top - 30
  return createPortal(
    <button
      type="button"
      className="eva-pin-float"
      data-tiny={tiny ? 'true' : undefined}
      data-testid={tiny ? 'pin-inline' : 'pin-selection'}
      style={{ left: Math.max(4, left), top: Math.max(4, top) }}
      aria-label={tiny ? `Pin ${target.note.label}` : 'Pin selection'}
      title={tiny ? 'Pin' : undefined}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={() => {
        clearTimeout(hide.current)
        hide.current = undefined
      }}
      onMouseLeave={() => {
        if (tiny) setTarget(null)
      }}
      onClick={() => {
        scope.pin(target.note)
        setTarget(null)
        window.getSelection()?.removeAllRanges()
      }}
    >
      <IconPin size={13} stroke={1.5} aria-hidden />
      {tiny ? null : 'Pin selection'}
    </button>,
    document.body,
  )
}
