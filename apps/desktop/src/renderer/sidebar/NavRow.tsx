import { IconChevronRight } from '@tabler/icons-react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { navIcon } from './icons'

export interface NavRowProps {
  slug: string
  title: string
  icon: string
  active: boolean
  count?: string | null
  countTestid?: string
  /** A dot in place of the count (the badge style Dot). */
  dot?: boolean
  chevron?: boolean
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void
  /** The row's menu at a viewport point: right click or the context-menu key. */
  onMenu?: (x: number, y: number) => void
}

export function NavRow({
  slug,
  title,
  icon,
  active,
  count,
  countTestid,
  dot,
  chevron,
  onClick,
  onMenu,
}: NavRowProps) {
  const Glyph = navIcon(icon)
  return (
    <button
      type="button"
      className="eva-sb-row"
      data-testid={`nav-${slug}`}
      data-active={active ? 'true' : undefined}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      onContextMenu={(e) => {
        if (!onMenu) return
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
      onKeyDown={(e) => {
        if (!onMenu || !((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu')) return
        e.preventDefault()
        const r = e.currentTarget.getBoundingClientRect()
        // Mantine menus close on a keydown outside them, this one included: open next task.
        setTimeout(() => onMenu(r.left + 16, r.bottom), 0)
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return
        e.preventDefault()
        onClick(e)
      }}
    >
      <Glyph size={16} aria-hidden />
      <span className="eva-sb-row-label">{title}</span>
      {count ? (
        <span className="eva-sb-count" data-testid={countTestid}>
          {count}
        </span>
      ) : dot ? (
        <span className="eva-sb-dot" data-testid={countTestid} aria-label="Has updates" />
      ) : null}
      {chevron ? <IconChevronRight size={14} aria-hidden className="eva-sb-chev" /> : null}
    </button>
  )
}
