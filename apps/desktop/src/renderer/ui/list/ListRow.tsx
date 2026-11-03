import {
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
  type SyntheticEvent,
} from 'react'
import { useListLayout } from './list-context'

/** A row was opened: a click, a middle click (with `middleClick`), Enter or Space. */
export type ActivateEvent = MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>

export interface ListRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Line 1: the thing's name. Truncates to one line. */
  title: ReactNode
  /** The full text on hover, for a title or meta that truncates. */
  tooltip?: string
  /** An icon (drawn in a tile when comfortable), an avatar or a status mark. */
  leading?: ReactNode
  /** Comfortable rows draw `leading` in a tile; false for avatars and portraits. */
  tile?: boolean
  /** Line 2 when comfortable, dim text after the title when compact. */
  meta?: ReactNode
  /** Right side: status pills, the age, a switch. Not drawn in columns mode (use cells). */
  trailing?: ReactNode
  /** Hover and focus revealed controls over the right end. Their clicks never open the row. */
  actions?: ReactNode
  /** Columns mode: one node per column after the first, in column order. */
  cells?: readonly ReactNode[]
  /** The open or selected item. */
  active?: boolean
  /** Inactive (disabled job, finished, test call): drawn dimmer, still interactive. */
  dim?: boolean
  /** The title wraps instead of truncating (a sentence, like a proposal or a decision). */
  multiline?: boolean
  /** Click, Enter or Space on the row (and a middle click with `middleClick`). */
  onActivate?: (e: ActivateEvent) => void
  /** A middle click also activates (the event's button 1 asks for a new tab). */
  middleClick?: boolean
  /** The row's menu at a viewport point: right click, Shift+F10 or the context-menu key. */
  onMenu?: (x: number, y: number) => void
  ref?: Ref<HTMLDivElement>
  'data-testid'?: string
}

const stop = (e: SyntheticEvent): void => e.stopPropagation()

/**
 * One row of a ListView (option B): a leading icon tile, the title over a meta line, and trailing
 * pills and age, on a hairline divider. Compact rows (option A) put everything on one line;
 * columns rows (option C) lay the cells on the list's grid. Density and columns come from the
 * enclosing ListView.
 */
export function ListRow({
  title,
  tooltip,
  leading,
  tile = true,
  meta,
  trailing,
  actions,
  cells,
  active,
  dim,
  multiline,
  onActivate,
  middleClick,
  onMenu,
  className,
  onClick,
  onAuxClick,
  onMouseDown,
  onKeyDown,
  onContextMenu,
  ref,
  ...rest
}: ListRowProps) {
  const { density, columns } = useListLayout()
  const interactive = onActivate !== undefined || onClick !== undefined
  const grid = columns !== null

  const main = (
    <>
      {leading !== undefined ? (
        <span
          className="eva-list-leading"
          data-tile={(tile && density === 'comfortable') || undefined}
        >
          {leading}
        </span>
      ) : null}
      <span className="eva-list-text">
        <span className="eva-list-title">{title}</span>
        {meta !== undefined && meta !== null && meta !== '' ? (
          <span className="eva-list-meta">{meta}</span>
        ) : null}
      </span>
    </>
  )

  return (
    <div
      ref={ref}
      title={tooltip}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      {...rest}
      className={`eva-list-row${className ? ` ${className}` : ''}`}
      data-list-row=""
      data-density={density}
      data-grid={grid || undefined}
      data-active={active || undefined}
      data-dim={dim || undefined}
      data-multiline={multiline || undefined}
      data-interactive={interactive || undefined}
      onClick={(e) => {
        onClick?.(e)
        if (!e.defaultPrevented) onActivate?.(e)
      }}
      onAuxClick={(e) => {
        onAuxClick?.(e)
        if (e.defaultPrevented || !middleClick || e.button !== 1) return
        e.preventDefault()
        onActivate?.(e)
      }}
      onMouseDown={(e) => {
        onMouseDown?.(e)
        // A middle press would start autoscroll before the auxclick.
        if (middleClick && e.button === 1) e.preventDefault()
      }}
      onContextMenu={(e) => {
        onContextMenu?.(e)
        if (e.defaultPrevented || !onMenu) return
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e)
        if (e.defaultPrevented || e.target !== e.currentTarget) return
        if (onMenu && ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu')) {
          e.preventDefault()
          // Mantine menus close on any keydown outside them, this one included: open next task.
          const r = e.currentTarget.getBoundingClientRect()
          setTimeout(() => onMenu(r.left + 16, r.bottom), 0)
        } else if (interactive && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          if (onActivate) onActivate(e)
          else e.currentTarget.click()
        }
      }}
    >
      {grid ? (
        <>
          <span className="eva-list-cell eva-list-main" data-align="start">
            {main}
          </span>
          {columns.slice(1).map((c, i) => (
            <span key={c.id} className="eva-list-cell" data-align={c.align ?? 'center'}>
              {cells?.[i] ?? null}
            </span>
          ))}
        </>
      ) : (
        <>
          {main}
          {trailing !== undefined && trailing !== null ? (
            <span className="eva-list-trailing">{trailing}</span>
          ) : null}
        </>
      )}
      {actions ? (
        <span
          className="eva-list-actions"
          onClick={stop}
          onAuxClick={stop}
          onKeyDown={stop}
          onPointerDown={stop}
          onContextMenu={stop}
        >
          {actions}
        </span>
      ) : null}
    </div>
  )
}
