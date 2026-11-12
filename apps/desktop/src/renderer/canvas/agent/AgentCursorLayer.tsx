import { useStore, useStoreApi } from '@xyflow/react'
import { useEffect, useRef, type RefObject } from 'react'
import type { CanvasCursorOp } from '@evaos/contract'
import { drawAgentCursor } from '@evaos/shell-core/agent-cursor'
import type { Box } from '../comment-model'
import { aimOnScreen, type Aim, type Transform } from './cursor-model'

/** The board's agent cursor, for the board's driver. */
export interface CursorLayer {
  /** Draws a step of main's against the cards as drawn now; answers its ms on screen. */
  cursor: (op: CanvasCursorOp) => number
  /** Keeps the cursor on card `node` while the agent carries it (its anchor when it was there). */
  hold: (node: string) => void
}

/**
 * The agent's cursor over a board (shell-core drawAgentCursor in an overlay the size of the
 * board): screen-sized at any zoom. It keeps what it points at in flow terms, so while parked it
 * follows pans, zooms and the card moving; a pan drops the trail, which would point at nothing.
 * Render it inside the board's React Flow, outside the viewport transform.
 */
export function AgentCursorLayer({
  handle,
  boxes,
}: {
  handle: RefObject<CursorLayer | null>
  boxes: ReadonlyMap<string, Box>
}) {
  const el = useRef<HTMLDivElement>(null)
  const store = useStoreApi()
  const transform = useStore((s) => s.transform)
  const boxesRef = useRef(boxes)
  boxesRef.current = boxes
  /** What the cursor points at; null while hidden. */
  const aim = useRef<Aim | null>(null)
  /** When the glide in flight lands (performance.now ms). */
  const busyUntil = useRef(0)
  /** The board moved under a glide: the cursor catches up once it lands. */
  const stale = useRef(false)
  const lastTransform = useRef<Transform>(transform)
  const landTimer = useRef<number | undefined>(undefined)

  /** Puts the parked cursor back on what it aims at; `clear` drops the trail first. */
  const follow = useRef((clear: boolean): void => {
    const host = el.current
    const a = aim.current
    if (!host || !a) return
    const p = aimOnScreen(a, boxesRef.current, store.getState().transform)
    if (!p) return
    drawAgentCursor({ op: 'show', x: p.x, y: p.y, clear }, host)
    host.dataset['at'] = `${Math.round(p.x)},${Math.round(p.y)}`
  })

  useEffect(() => {
    handle.current = {
      cursor: (op) => {
        const host = el.current
        if (!host) return 0
        if (op.op === 'hide') {
          aim.current = null
          window.clearTimeout(landTimer.current)
          busyUntil.current = 0
          host.dataset['state'] = 'hidden'
          return drawAgentCursor({ op: 'hide' }, host)
        }
        const t = store.getState().transform
        const next: Aim = { node: op.node, anchor: op.anchor, at: op.at }
        const named = op.node !== undefined || op.at !== undefined
        // A step that names nothing the board has stays where the cursor is.
        if (named && aimOnScreen(next, boxesRef.current, t)) aim.current = next
        const p = aim.current ? aimOnScreen(aim.current, boxesRef.current, t) : null
        if (!p) return 0
        const ms = drawAgentCursor(
          {
            op: op.op,
            x: p.x,
            y: p.y,
            ...(op.lead === undefined ? {} : { lead: op.lead }),
            ...(op.color === undefined ? {} : { color: op.color }),
            ...(op.avatar === undefined ? {} : { avatar: op.avatar }),
            ...(op.initial === undefined ? {} : { initial: op.initial }),
          },
          host,
        )
        host.dataset['state'] = 'shown'
        host.dataset['aim'] = aim.current?.node ?? ''
        host.dataset['at'] = `${Math.round(p.x)},${Math.round(p.y)}`
        window.clearTimeout(landTimer.current)
        busyUntil.current = performance.now() + ms
        if (ms > 0) {
          landTimer.current = window.setTimeout(() => {
            busyUntil.current = 0
            if (stale.current) follow.current(true)
            stale.current = false
          }, ms + 100)
        }
        return ms
      },
      hold: (node) => {
        if (aim.current?.node !== node) aim.current = { node, anchor: 'center' }
      },
    }
    return () => {
      handle.current = null
      window.clearTimeout(landTimer.current)
    }
  }, [handle, store])

  // Parked, the cursor stays on what it points at as the board pans, zooms or the card moves.
  useEffect(() => {
    const moved = lastTransform.current.some((v, i) => v !== transform[i])
    lastTransform.current = transform
    if (!aim.current) return
    if (performance.now() < busyUntil.current) {
      stale.current ||= moved
      return
    }
    follow.current(moved)
  }, [transform, boxes])

  return (
    <div
      ref={el}
      className="eva-cv-agent-cursor"
      data-testid="canvas-agent-cursor"
      data-state="hidden"
      aria-hidden
    />
  )
}
