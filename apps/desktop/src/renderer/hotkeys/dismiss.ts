import { useEffect, useRef } from 'react'

/** Esc ladder priority bands (D-12): higher runs first. */
export const DISMISS_PRIORITY = {
  overlay: 100,
  /** A canvas selection clears before the sidebar sub-page closes. */
  selection: 50,
  subPageBack: 10,
} as const

interface Entry {
  priority: number
  fn: () => void
  seq: number
}

const stack: Entry[] = []
let seq = 0

function add(priority: number, fn: () => void): () => void {
  const entry: Entry = { priority, fn, seq: seq++ }
  stack.push(entry)
  return () => {
    const i = stack.indexOf(entry)
    if (i >= 0) stack.splice(i, 1)
  }
}

/** Registers a dismisser while `active`; Esc pops the topmost one (D-12). */
export function useDismissable(priority: number, fn: () => void, active = true): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!active) return
    return add(priority, () => ref.current())
  }, [priority, active])
}

/** Runs the highest-priority dismisser (ties: most recent). Returns true when one ran. */
export function dismissTop(): boolean {
  let best: Entry | undefined
  for (const e of stack) {
    if (!best || e.priority > best.priority || (e.priority === best.priority && e.seq > best.seq))
      best = e
  }
  if (!best) return false
  best.fn()
  return true
}
