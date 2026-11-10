import { useEffect, useState, type RefObject } from 'react'
import { Tooltip, UnstyledButton } from '@mantine/core'
import { IconPin } from '@tabler/icons-react'
import { EvaPopover } from '../overlay'
import { PinsList } from './PinsList'
import type { PinsScopeValue } from './pins-scope'
import '../context/context.css'
import './pins.css'

/** Width of the rail, and the air between it and the message column (pins.css keeps the same numbers). */
export const RAIL_W = 232
export const RAIL_GAP = 48
/** Room kept right of the rail for the log's scrollbar. */
export const RAIL_EDGE = 16

/** Whether a chat `width` px wide has a gutter right of its message column (`column` px) the rail fits in. */
export function railFits(width: number, column: number): boolean {
  return width >= column + 2 * (RAIL_GAP + RAIL_W + RAIL_EDGE)
}

/** True while the element in `ref` is wide enough for a gutter rail (`fits`, the pin rail's by default); follows resizes. */
export function useRailFits(
  ref: RefObject<HTMLElement | null>,
  fits: (width: number, column: number) => boolean = railFits,
): boolean {
  const [ok, setOk] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const measure = (): void => {
      const column = parseFloat(getComputedStyle(el).getPropertyValue('--eva-chat-column-w'))
      setOk(fits(el.clientWidth, Number.isFinite(column) ? column : 780))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, fits])
  return ok
}

/**
 * The pinned column in the chat's right gutter, aligned with the message column. It is not part of
 * the scrolling log: scrolling the chat never moves it, and when the pins outgrow the height only
 * the rail scrolls. Shown only while there is something pinned.
 */
export function PinsRail({ scope }: { scope: PinsScopeValue }) {
  if (scope.pins.length === 0) return null
  return (
    <aside className="eva-pins-rail" aria-label="Pinned" data-testid="pins-rail">
      <div className="eva-pins-title">Pinned</div>
      <PinsList scope={scope} />
    </aside>
  )
}

/** The chat header's pin count: where the rail does not fit, it opens the same list in a popover. */
export function PinsButton({ scope }: { scope: PinsScopeValue }) {
  const [open, setOpen] = useState(false)
  const count = scope.pins.length
  useEffect(() => {
    if (count === 0) setOpen(false)
  }, [count])
  if (count === 0) return null
  return (
    <EvaPopover
      opened={open}
      onChange={setOpen}
      position="bottom-end"
      width={320}
      testid="pins-button-target"
    >
      <EvaPopover.Target>
        <Tooltip label="Pinned" position="bottom" openDelay={400} disabled={open}>
          <UnstyledButton
            className="eva-header-btn eva-ctx-btn eva-pins-btn"
            data-testid="pins-button"
            data-open={open ? 'true' : undefined}
            aria-label={`Pinned, ${count}`}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <IconPin size={15} stroke={1.5} aria-hidden />
            <span className="eva-pins-count">{count}</span>
          </UnstyledButton>
        </Tooltip>
      </EvaPopover.Target>
      <EvaPopover.Dropdown>
        <div className="eva-pins-pop" data-testid="pins-popover">
          <div className="eva-pins-title">Pinned</div>
          <PinsList scope={scope} onOpened={() => setOpen(false)} />
        </div>
      </EvaPopover.Dropdown>
    </EvaPopover>
  )
}
