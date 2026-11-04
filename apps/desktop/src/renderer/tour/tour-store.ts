import { createStore } from 'zustand'

/** One spotlight: the control it points at and what the agent says about it. */
export interface Spot {
  target: string
  caption: string
  title?: string
  step?: { n: number; of: number }
  /** Ends on its own at this time (ms since epoch). */
  until: number
}

export const tourStore = createStore<{ spot: Spot | null }>(() => ({ spot: null }))

const DEFAULT_MS = 15_000

/** Visible on screen (a laid-out box), not a hidden copy in a background pane. */
const visible = (el: HTMLElement): boolean => {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 && el.getClientRects().length > 0
}

/** The control a tour target names: its data-tour, else its data-testid, the first on screen. */
export function findTarget(target: string): HTMLElement | null {
  const v = CSS.escape(target)
  for (const sel of [`[data-tour="${v}"]`, `[data-testid="${v}"]`]) {
    for (const el of document.querySelectorAll<HTMLElement>(sel)) if (visible(el)) return el
  }
  return null
}

/** A control's name as Isaac reads it: its label, else its text. */
export function labelOf(el: HTMLElement): string {
  const label =
    el.getAttribute('aria-label') ??
    el.getAttribute('title') ??
    (el instanceof HTMLInputElement ? el.placeholder || el.value : el.innerText)
  return label.replace(/\s+/g, ' ').trim().slice(0, 80)
}

/**
 * Spotlights `spot.target` (scrolled into view) until Isaac clicks, presses Escape, the next
 * spotlight or `ms`. Throws `not-found` when it is not on screen.
 */
export function showSpotlight(spot: Omit<Spot, 'until'> & { ms?: number }): {
  target: string
  label: string
  rect: { x: number; y: number; width: number; height: number }
} {
  const el = findTarget(spot.target)
  if (el === null) {
    throw Object.assign(
      new Error(
        `No control ${spot.target} on screen; describe lists the controls (open its page first)`,
      ),
      { code: 'not-found' },
    )
  }
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  const { ms, ...rest } = spot
  tourStore.setState({ spot: { ...rest, until: Date.now() + (ms ?? DEFAULT_MS) } })
  const r = el.getBoundingClientRect()
  return {
    target: spot.target,
    label: labelOf(el),
    rect: {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    },
  }
}

export function clearSpotlight(): void {
  tourStore.setState({ spot: null })
}
