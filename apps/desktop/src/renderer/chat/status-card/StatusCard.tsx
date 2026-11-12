import './status-card.css'
import { type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { IconChevronDown, IconX } from '@tabler/icons-react'
import { dismissCard, useDismissed } from './dismissed-cards'
import { setCardOpen, useCardOpen } from './open-cards'

export interface StatusCardProps {
  /** Stable id: a dismissed card stays gone under it, across reloads. */
  id: string
  /** The one line: what is going on. */
  line: ReactNode
  /** The line as a tooltip, when it can be cut off. */
  lineTitle?: string
  /** Face, icon or avatar in front of the line. */
  lead?: ReactNode
  /** Buttons that act on the card's subject (Join, Allow, Open board). They never toggle the card. */
  actions?: ReactNode
  /** The quiet end of the row: time, check, state. */
  meta?: ReactNode
  /** What the card says in full; the row opens and closes it on click. */
  details?: ReactNode
  /** Controlled open state; the card's own (kept across the transcript's remounts) when left out. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** What a click does on a card with no details (focus the page, open the chat). */
  onOpen?: (e: MouseEvent | KeyboardEvent) => void
  /** Accessible name and tooltip of the row. */
  label?: string
  /** Runs when Isaac dismisses the card, before it goes (close the page behind it). */
  onDismiss?: () => void
  /** False for a card that must stay until its subject is done. */
  dismissible?: boolean
  /** What the X says it does, when dismissing does more than hide the card. */
  dismissLabel?: string
  /** A border highlight that orbits while the work runs. */
  orbit?: boolean
  testId?: string
  style?: CSSProperties
  /** data-* hooks: state, status, tone. */
  data?: Record<`data-${string}`, string | boolean | undefined>
}

/**
 * The one-row status card Relay's chat uses for what a host or an agent put in it: a lead, one
 * line, optional actions and quiet meta, and a hover X that dismisses it for good. A card with
 * `details` opens them under the row on click; one with only `onOpen` goes there. The row is the
 * only tab stop of the card besides its own buttons; Enter or Space activates it, Delete
 * dismisses it.
 */
export function StatusCard({
  id,
  line,
  lineTitle,
  lead,
  actions,
  meta,
  details,
  open,
  onOpenChange,
  onOpen,
  label,
  onDismiss,
  dismissible = true,
  dismissLabel = 'Dismiss',
  orbit = false,
  testId,
  style,
  data,
}: StatusCardProps) {
  const dismissed = useDismissed(id)
  const own = useCardOpen(id)
  if (dismissed) return null
  const expandable = details !== undefined && details !== null && details !== false
  const isOpen = expandable && (open ?? own)
  const toggle = (): void => {
    const next = !isOpen
    if (open === undefined) setCardOpen(id, next)
    onOpenChange?.(next)
  }
  const activate = (e: MouseEvent | KeyboardEvent): void => {
    if (expandable) toggle()
    else onOpen?.(e)
  }
  const dismiss = (): void => {
    onDismiss?.()
    dismissCard(id)
  }
  const interactive = expandable || onOpen !== undefined
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return
    if ((e.key === 'Enter' || e.key === ' ') && interactive) {
      e.preventDefault()
      activate(e)
    } else if (dismissible && e.key === 'Delete') {
      e.preventDefault()
      dismiss()
    }
  }
  return (
    <div
      className="eva-status-card"
      data-testid={testId}
      data-open={isOpen || undefined}
      data-orbit={orbit || undefined}
      data-interactive={interactive || undefined}
      style={style}
      {...data}
    >
      <div
        className="eva-status-row"
        onClick={(e) => {
          const control = (e.target as Element).closest('button, a, input, textarea, select, label')
          if (interactive && control === null) activate(e)
        }}
      >
        <div
          className="eva-status-main"
          role={interactive ? 'button' : undefined}
          tabIndex={interactive ? 0 : undefined}
          aria-expanded={expandable ? isOpen : undefined}
          aria-label={label}
          title={label}
          onKeyDown={onKey}
        >
          {lead}
          <span className="eva-status-line" title={lineTitle}>
            {line}
          </span>
        </div>
        {actions ? <span className="eva-status-acts">{actions}</span> : null}
        {meta ? <span className="eva-status-meta">{meta}</span> : null}
        {expandable ? (
          <IconChevronDown
            className="eva-status-go eva-status-chevron"
            size={14}
            stroke={1.75}
            aria-hidden
          />
        ) : null}
        {dismissible ? (
          <button
            type="button"
            className="eva-status-x"
            aria-label={dismissLabel}
            title={dismissLabel}
            data-testid="status-card-dismiss"
            onClick={dismiss}
          >
            <IconX size={14} stroke={1.75} aria-hidden />
          </button>
        ) : null}
      </div>
      {isOpen ? <div className="eva-status-details">{details}</div> : null}
    </div>
  )
}
