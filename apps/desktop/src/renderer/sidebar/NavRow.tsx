import { IconChevronRight } from '@tabler/icons-react'
import type { MouseEvent } from 'react'
import { navIcon } from './icons'

export interface NavRowProps {
  slug: string
  title: string
  icon: string
  active: boolean
  count?: string | null
  countTestid?: string
  chevron?: boolean
  onClick: (e: MouseEvent<HTMLButtonElement>) => void
}

export function NavRow({
  slug,
  title,
  icon,
  active,
  count,
  countTestid,
  chevron,
  onClick,
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
    >
      <Glyph size={16} aria-hidden />
      <span className="eva-sb-row-label">{title}</span>
      {count ? (
        <span className="eva-sb-count" data-testid={countTestid}>
          {count}
        </span>
      ) : null}
      {chevron ? <IconChevronRight size={14} aria-hidden className="eva-sb-chev" /> : null}
    </button>
  )
}
