import { Fragment, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import { mentionSpans } from '@evaos/contract'
import type { Mentionable } from '@relay/canvas-live/mentions'

/** What the backdrop copies from the field so its text lands on the field's text exactly. */
const MIRRORED = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-transform',
  'text-indent',
  'tab-size',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'box-sizing',
] as const

/**
 * The inline chips of a plain textarea: while the text @mentions one of `people`, the text is drawn
 * by this layer under the field (the field's own text goes transparent, its caret and selection
 * stay), with each mention as a pill. It follows the field's size, padding and scroll. Renders
 * nothing (and leaves the field alone) when there is no mention. Its parent must be positioned
 * and hold the field; it marks itself on the parent with `data-mentions`.
 */
export function MentionBackdrop({
  text,
  field,
  people,
}: {
  text: string
  field: RefObject<HTMLTextAreaElement | null>
  people: readonly Mentionable[]
}) {
  const spans = useMemo(() => mentionSpans(text, people), [text, people])
  const back = useRef<HTMLDivElement>(null)
  const shown = spans.length > 0
  useLayoutEffect(() => {
    const el = field.current
    const b = back.current
    const host = b?.parentElement
    if (!el || !b || !host) return
    host.dataset.mentions = 'true'
    const follow = (): void => {
      const cs = getComputedStyle(el)
      for (const p of MIRRORED) b.style.setProperty(p, cs.getPropertyValue(p))
      const r = el.getBoundingClientRect()
      const h = host.getBoundingClientRect()
      b.style.top = `${r.top - h.top}px`
      b.style.left = `${r.left - h.left}px`
      b.style.width = `${r.width}px`
      b.style.height = `${r.height}px`
      b.scrollTop = el.scrollTop
    }
    follow()
    const ro = new ResizeObserver(follow)
    ro.observe(el)
    el.addEventListener('scroll', follow)
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', follow)
      delete host.dataset.mentions
    }
  }, [field, shown])
  if (!shown) return null
  let at = 0
  const parts = spans.map((s) => {
    const before = text.slice(at, s.start)
    at = s.end
    return (
      <Fragment key={s.start}>
        {before}
        <mark className="eva-at-chip" data-testid="composer-mention-chip">
          {text.slice(s.start, s.end)}
        </mark>
      </Fragment>
    )
  })
  return (
    <div ref={back} className="eva-at-backdrop" aria-hidden data-testid="composer-mentions">
      {parts}
      {text.slice(at)}
      {/* A trailing newline needs a character after it to take its line, as the field does. */}
      {'\u200b'}
    </div>
  )
}
