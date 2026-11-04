import { invoke, on } from '../ipc'

// One subscription to main's pty output, fanned out to the terminal view that owns each pty.

export interface PtyHandlers {
  data(data: string): void
  exit(code: number | null): void
}

const handlers = new Map<string, PtyHandlers>()
/** Output that arrived between a pty starting in main and its view subscribing. */
const early = new Map<string, { chunks: string[]; exit?: number | null }>()
/** Ptys this window ended; late output for them is dropped, not held. */
const ended = new Set<string>()
let started = false

function ensureStarted(): void {
  if (started) return
  started = true
  on('terminal.data', ({ id, data }) => {
    const h = handlers.get(id)
    if (h) {
      h.data(data)
      return
    }
    if (ended.has(id)) return
    const e = early.get(id) ?? { chunks: [] }
    e.chunks.push(data)
    early.set(id, e)
  })
  on('terminal.exit', ({ id, code }) => {
    const h = handlers.get(id)
    if (h) {
      h.exit(code)
      return
    }
    if (ended.has(id)) return
    const e = early.get(id) ?? { chunks: [] }
    e.exit = code
    early.set(id, e)
  })
}

/** Routes pty `id`'s output to `h` (earlier output first); returns the unsubscribe. */
export function subscribe(id: string, h: PtyHandlers): () => void {
  ensureStarted()
  handlers.set(id, h)
  const held = early.get(id)
  if (held) {
    early.delete(id)
    for (const chunk of held.chunks) h.data(chunk)
    if (held.exit !== undefined) h.exit(held.exit)
  }
  return () => {
    if (handlers.get(id) === h) handlers.delete(id)
  }
}

/** Ends pty `id` in main and drops anything still held for it. */
export function killPty(id: string): void {
  ended.add(id)
  early.delete(id)
  void invoke('terminal.kill', { id })
}
