import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Tooltip, UnstyledButton } from '@mantine/core'
import { IconLayoutSidebarRightExpand } from '@tabler/icons-react'
import type { AgentCard } from '@evaos/contract'
import { EvaDrawer } from '../overlay'
import { useOccludeBrowser } from '../overlay/overlay-store'
import { parseNumber, usePref } from '../ui-prefs'
import { TicketView } from './TicketView'

export const PANEL_MIN = 380
const PANEL_DEFAULT = 560
/** The board keeps at least this much beside the panel; a narrower page gets the drawer instead. */
export const BOARD_MIN = 480
const STEP = 16
const parsePanelWidth = parseNumber(0, 4000)

/**
 * The card's side panel. Beside the board (the board shrinks and stays live; drag the edge to
 * resize, double-click it for the default width, collapse it to a strip) or, on a page too narrow
 * for both, an overlay drawer.
 */
export function AgentPanel({
  card,
  now,
  narrow,
  pageWidth,
  collapsed,
  onCollapse,
  onClose,
}: {
  card: AgentCard | null
  now: number
  narrow: boolean
  pageWidth: number
  collapsed: boolean
  onCollapse: (collapsed: boolean) => void
  onClose: () => void
}) {
  const [width, setWidth] = usePref('agents.panelWidth', PANEL_DEFAULT, parsePanelWidth)
  const [dragging, setDragging] = useState(false)
  const widthRef = useRef(width)
  widthRef.current = width
  useOccludeBrowser(dragging)

  if (narrow)
    return (
      <EvaDrawer
        opened={card !== null}
        onClose={onClose}
        size={Math.min(PANEL_DEFAULT, pageWidth)}
        testid="agents-drawer"
      >
        {card ? <TicketView key={card.id} card={card} now={now} /> : null}
      </EvaDrawer>
    )
  if (card === null) return null

  const max = Math.max(PANEL_MIN, pageWidth - BOARD_MIN)
  const shown = Math.min(Math.max(width, PANEL_MIN), max)
  const resize = (px: number): void => {
    setWidth(Math.round(Math.min(Math.max(px, PANEL_MIN), max)))
  }
  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const start = shown
    const move = (ev: PointerEvent): void => resize(start - (ev.clientX - startX))
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('eva-resizing')
      setDragging(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    document.body.classList.add('eva-resizing')
    setDragging(true)
  }

  if (collapsed)
    return (
      <aside className="eva-ab-side eva-ab-side-collapsed" data-testid="agents-panel-strip">
        <Tooltip label="Expand panel" openDelay={300} position="left">
          <UnstyledButton
            className="eva-ab-tv-iconbtn"
            aria-label="Expand panel"
            data-testid="agents-panel-expand"
            onClick={() => onCollapse(false)}
          >
            <IconLayoutSidebarRightExpand size={15} stroke={1.5} />
          </UnstyledButton>
        </Tooltip>
        <span className="eva-ab-side-label">{card.key ?? card.title}</span>
      </aside>
    )

  return (
    <aside className="eva-ab-side" style={{ width: shown }} data-testid="agents-side">
      <div
        className={`eva-ab-sash${dragging ? ' is-dragging' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuenow={shown}
        aria-valuemin={PANEL_MIN}
        aria-valuemax={max}
        tabIndex={0}
        data-testid="agents-panel-sash"
        onPointerDown={onResizeStart}
        onDoubleClick={() => resize(PANEL_DEFAULT)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
          e.preventDefault()
          resize(widthRef.current + (e.key === 'ArrowLeft' ? STEP : -STEP))
        }}
      />
      <TicketView
        key={card.id}
        card={card}
        now={now}
        onClose={onClose}
        onCollapse={() => onCollapse(true)}
      />
    </aside>
  )
}
